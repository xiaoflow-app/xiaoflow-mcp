import { completeMetrics, completePages } from "./complete-results.js";
import { keywordExport } from "./keyword-export.js";
import {
  BULK_SYNC_LIMIT,
  buildBulkMetricsResponse,
  formatBulkMetricsText,
  formatBulkTaskText,
  type BulkExportLink,
} from "./bulk-response.js";
import {
  buildExpansionCompleteResponse,
  compactExpansionStatus,
  formatExpansionCompleteText,
  formatExpansionTaskText,
  isExpansionTerminal,
} from "./expansion-response.js";
import { MCP_APP_HTML_WIDGET } from "./app-widget.js";
import { formatXiaoFlowReport } from "./format-report.js";
import {
  axiosErrorMessage,
  expansionStartPayload,
  normalizeStartedTask,
  parseSeedList,
} from "./expansion.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListPromptsRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
  ListResourceTemplatesRequestSchema,
  ListToolsRequestSchema,
  ErrorCode,
  McpError,
} from "@modelcontextprotocol/sdk/types.js";
import axios from "axios";
import { Hono } from "hono";
import { DurableObject } from "cloudflare:workers";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { enhanceTools, SERVER_INFO } from "./tool-quality.js";

const sessionUiTracker = new Map<string, number>();

function canShowUiForSession(sessionKey: string, toolName: string, args: Record<string, unknown>): boolean {
  if (!KEYWORD_UI_TOOLS.has(toolName) || toolName.startsWith("bulk_keyword_")) return false;

  // Single keyword check: batch lookups (multiple keywords) do not display the single-keyword UI
  if (toolName === "get_keyword_metrics") {
    const rawKw = args.keywords || args.keyword || args.seed || [];
    const count = Array.isArray(rawKw) ? rawKw.length : (rawKw ? 1 : 0);
    if (count > 1) return false;
  }

  if (toolName === "get_related_keywords" || toolName === "discover_keywords") {
    const rawSeed = args.seeds || args.seed || args.keyword || [];
    const count = Array.isArray(rawSeed) ? rawSeed.length : (rawSeed ? 1 : 0);
    if (count > 1) return false;
  }

  // Session-once rule: ensure UI is only attached at most ONCE in the same conversation session
  const cleanKey = String(sessionKey || "default").trim();
  const currentCount = sessionUiTracker.get(cleanKey) || 0;
  if (currentCount >= 1) {
    return false;
  }

  sessionUiTracker.set(cleanKey, currentCount + 1);
  return true;
}

function toolResult(data: unknown, isError = false, toolName = "", attachUi = false) {
  const formattedText = isError ? JSON.stringify(data) : formatXiaoFlowReport(data, toolName);
  const structured = data && typeof data === "object" && !Array.isArray(data) ? (data as Record<string, unknown>) : { result: data };

  return {
    content: [{ type: "text" as const, text: formattedText }],
    structuredContent: structured,
    ...(isError ? { isError: true } : {}),
    ...(attachUi && !isError ? { _meta: widgetUiMeta(true) } : {}),
  };
}

const MCP_RESOURCE = "https://mcp.xiaoflow.com/mcp";
const MCP_SSE_RESOURCE = "https://mcp.xiaoflow.com/sse";
const AUTHORIZATION_SERVER = "https://www.xiaoflow.com";
const PROTECTED_RESOURCE_METADATA = "https://mcp.xiaoflow.com/.well-known/oauth-protected-resource";
const WIDGET_URI = "ui://xiaoflow/keyword-dashboard-v3";
const KEYWORD_UI_TOOLS = new Set([
  "get_keyword_metrics",
  "get_related_keywords",
  "discover_keywords",
  "bulk_keyword_metrics",
  "get_keyword_details",
]);

function widgetCsp() {
  return {
    connectDomains: ["https://api.xiaoflow.com", "https://mcp.xiaoflow.com", "https://www.xiaoflow.com"],
    resourceDomains: ["https://quickchart.io", "https://www.xiaoflow.com", "https://mcp.xiaoflow.com", "https://fonts.gstatic.com"],
  };
}

function widgetUiMeta(includeResourceUri = true) {
  const csp = widgetCsp();
  const ui: Record<string, unknown> = { csp };
  if (includeResourceUri) {
    ui.resourceUri = WIDGET_URI;
  }
  return {
    ui,
    "openai/widgetCSP": {
      connect_domains: csp.connectDomains,
      resource_domains: csp.resourceDomains,
    },
    ...(includeResourceUri ? { "openai/outputTemplate": WIDGET_URI } : {}),
  };
}

function brandQueryParam(brand: unknown): 0 | 1 {
  if (brand === 1 || brand === "1" || brand === true) return 1;
  return 0;
}

/** Map MCP tool args to API query params (location/language → backend getStandardParams). */
function apiQueryParams(args: Record<string, unknown>): Record<string, unknown> {
  const { brand, domain, site, keywords, ...rest } = args;
  const params: Record<string, unknown> = { ...rest };
  if (brand !== undefined) params.brand = brandQueryParam(brand);
  return params;
}

function keywordApiPayload(args: Record<string, unknown>): Record<string, unknown> {
  const payload: Record<string, unknown> = { ...args };
  if (payload.location !== undefined) {
    payload.gl = payload.location;
    delete payload.location;
  }
  if (payload.language !== undefined) {
    payload.hl = payload.language;
    delete payload.language;
  }
  if (payload.time_range !== undefined && payload.history_months === undefined) {
    const match = String(payload.time_range).match(/^(\d+)/);
    payload.history_months = match ? Number(match[1]) : 12;
    delete payload.time_range;
  }
  payload.history_months = Math.min(48, Math.max(1, Number(payload.history_months || 12)));
  payload.date_range = `${payload.history_months}m`;
  payload.with_history = payload.with_history !== false;
  payload.historical = payload.with_history;
  return payload;
}

function relatedKeywordPayload(args: Record<string, unknown>): Record<string, unknown> {
  const payload = keywordApiPayload({...args,with_history:args.with_history ?? false});
  if (payload.seed !== undefined && payload.keyword === undefined) {
    payload.keyword = payload.seed;
  }
  delete payload.seed;
  return payload;
}

function normalizeDomainInput(raw: string): string {
  const s = raw.trim();
  try {
    if (s.includes("://")) return new URL(s).hostname.replace(/^www\./i, "").toLowerCase();
  } catch {
    /* fall through */
  }
  return s.replace(/^www\./i, "").toLowerCase();
}

/**
 * Durable Object that maintains a single stateful MCP server session.
 * Optimized for Raw Fetch performance and reliability within Cloudflare.
 */
export class McpSession extends DurableObject {
  private transport?: HonoSseTransport;
  private server?: Server;
  private _env: any;

  constructor(ctx: any, env: any) {
    super(ctx, env);
    this._env = env;
  }

  async alarm() { await this.ctx.storage.deleteAll(); }

  private async storeExportFiles(csv: string, json: string, rowCount: number, name: string): Promise<BulkExportLink[]> {
    const id = this._env.MCP_SESSION.newUniqueId();
    const token = crypto.randomUUID().replaceAll('-', '') + crypto.randomUUID().replaceAll('-', '');
    const expiresAt = Date.now() + 24 * 60 * 60 * 1000;
    const stored = await this._env.MCP_SESSION.get(id).fetch(new Request('https://mcp.xiaoflow.com/__store_export', {
      method: 'POST',
      body: JSON.stringify({ token, expiresAt, csv, json }),
      headers: { 'Content-Type': 'application/json' },
    }));
    if (!stored.ok) throw new Error('Unable to save the complete export. Please retry.');
    return ['csv', 'json'].map(format => ({
      format,
      url: `https://mcp.xiaoflow.com/exports/${id.toString()}/${token}.${format}`,
      row_count: rowCount,
      expires_at: new Date(expiresAt).toISOString(),
    }));
  }

  private async bulkResult(
    data: unknown,
    name: string,
    opts: { min_volume?: number; max_volume?: number; preview_limit?: number } = {},
  ) {
    const files = keywordExport(data, name);
    const exports = await this.storeExportFiles(files.csv, files.json, files.rowCount, name);
    const payload = buildBulkMetricsResponse(data, name, exports, opts);
    const text = formatBulkMetricsText(payload);
    return {
      content: [
        { type: 'text' as const, text },
      ],
      structuredContent: payload,
    };
  }

  private exportResourceLinks(exports: BulkExportLink[], name: string) {
    return exports.map(file => ({
      type: 'resource_link' as const,
      uri: file.url,
      name: `${name}.${file.format}`,
      mimeType: file.format === 'csv' ? 'text/csv' : 'application/json',
      description: `Complete ${file.row_count}-row result; expires ${file.expires_at}`,
    }));
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const method = request.method;
    const pathname = url.pathname.replace(/\/$/, "").toLowerCase() || "/";

    console.log(`[DO ${this.ctx.id}] ${method} ${pathname} (Orig: ${url.pathname})`);

    const corsHeaders = getCorsHeaders(request);
    // These paths are reachable only through the Worker binding, not public routing.
    if (pathname === '/__store_export' && method === 'POST') {
      const files = await request.json() as { token:string;expiresAt:number;csv:string;json:string };
      if (!/^[a-f0-9]{64}$/.test(files.token) || files.expiresAt <= Date.now()) return new Response('Invalid export', {status:400});
      const encoder = new TextEncoder();
      const metadata: Record<string,unknown> = {token:files.token,expiresAt:files.expiresAt};
      for (const format of ['csv','json'] as const) {
        const bytes = encoder.encode(files[format]);
        const count = Math.ceil(bytes.length / 64000); metadata[format] = count;
        for (let i=0;i<count;i+=20) {
          const chunks: Record<string,Uint8Array> = {};
          for (let j=i;j<Math.min(i+20,count);j++) chunks[`${format}:${j}`]=bytes.slice(j*64000,(j+1)*64000);
          await this.ctx.storage.put(chunks);
        }
      }
      await this.ctx.storage.put('export', metadata);
      await this.ctx.storage.setAlarm(files.expiresAt);
      return new Response(null, {status:204});
    }
    if (pathname === '/__download_export' && (method === 'GET' || method === 'HEAD')) {
      const metadata = await this.ctx.storage.get<{token:string;expiresAt:number;csv:number;json:number}>('export');
      const format = url.searchParams.get('format');
      if (!metadata || metadata.expiresAt <= Date.now() || metadata.token !== url.searchParams.get('token') || (format !== 'csv' && format !== 'json')) return new Response('Export not found or expired', {status:404});
      let chunk = 0;
      const storage = this.ctx.storage;
      const stream = new ReadableStream<Uint8Array>({ async pull(controller) {
        if (chunk >= metadata[format]) { controller.close(); return; }
        const bytes = await storage.get<Uint8Array>(`${format}:${chunk++}`);
        if (!bytes) {controller.error(new Error('Export unavailable'));return;}
        controller.enqueue(bytes);
      } });
      return new Response(method === 'HEAD' ? null : stream, {headers:{'Content-Type':format==='csv'?'text/csv; charset=utf-8':'application/json; charset=utf-8','Content-Disposition':`attachment; filename="xiaoflow-keywords.${format}"`,'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer'}});
    }


    if (method === "OPTIONS" || method === "HEAD") {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    const isMcp = pathname === "/mcp";
    const isSse = pathname === "/sse";
    const isMessages = pathname === "/messages";
    const acceptHeader = (request.headers.get("Accept") || "").toLowerCase();
    const hasSessionHeader = request.headers.has("mcp-session-id") || request.headers.has("x-mcp-session-id") || url.searchParams.has("sessionId");

    // 1. SSE Handshake (supports BOTH GET /sse AND GET /mcp with event-stream or initial handshake)
    const isSseHandshake = (isMcp || isSse) && method === "GET" && (
      isSse ||
      acceptHeader.includes("text/event-stream") ||
      !hasSessionHeader
    );

    if (isSseHandshake) {
      const authHeader = request.headers.get("Authorization");
      let apiKey = request.headers.get("X-Xiaoflow-Api-Key") || url.searchParams.get("key") || "";

      if (!apiKey && authHeader && authHeader.startsWith("Bearer ")) {
        apiKey = authHeader.substring(7);
      }

      if (!apiKey) {
        return oauthErrorResponse("invalid_token", "Sign in with your XiaoFlow account to use MCP.", request);
      }

      const sessionId = this.ctx.id.toString();
      const externalBaseUrl = request.headers.get("X-External-Base-Url");
      const finalBaseUrl = externalBaseUrl || `${url.protocol}//${url.host}`;

      console.log(`[DO ${sessionId}] Handling SSE Handshake for key: ${apiKey?.substring(0, 8)}... (Path: ${pathname})`);

      // 1. Initialize transport and server
      this.transport = new HonoSseTransport(sessionId);
      this.server = this.createServerInstance(apiKey, sessionId);

      const encoder = new TextEncoder();
      const stream = new ReadableStream({
        start: async (controller) => {
          try {
            // Set the controller for the transport to use
            this.transport!.setController(controller, encoder);

            // CRITICAL: Flush headers and initial packet immediately to prove connection is alive
            controller.enqueue(encoder.encode(": ok\n\n"));
            console.log(`[DO ${sessionId}] SSE Stream established, ok sent`);

            // Send endpoint event - Absolute URL is safer. Clients can post to /messages, /sse, or /mcp with sessionId
            const messagesUrl = `${finalBaseUrl}/messages?sessionId=${sessionId}`;
            const endpointData = `event: endpoint\ndata: ${messagesUrl}\n\n`;
            controller.enqueue(encoder.encode(endpointData));
            console.log(`[DO ${sessionId}] Endpoint event sent: ${messagesUrl}`);

            // Connect server to transport - This will call transport.start()
            if (this.server && this.transport) {
              await this.server.connect(this.transport as any);
              console.log(`[DO ${sessionId}] MCP Server connected to transport`);
            }

            // Persistence
            if (apiKey) this.ctx.storage.put("apiKey", apiKey);

            // Keep-alive loop (Runs until stream is closed)
            const intervalId = setInterval(() => {
              try {
                controller.enqueue(encoder.encode(": keep-alive\n\n"));
              } catch (e) {
                clearInterval(intervalId);
              }
            }, 10000);

          } catch (e) {
            console.error(`[DO ${sessionId}] SSE Start Error:`, e);
            controller.error(e);
          }
        },
        cancel: () => {
          console.log(`[DO ${sessionId}] SSE Stream closed by client`);
          this.transport = undefined;
        }
      });

      return new Response(stream, {
        headers: {
          ...corsHeaders,
          "Content-Type": "text/event-stream; charset=utf-8",
          "Cache-Control": "no-cache, no-transform",
          "X-Content-Type-Options": "nosniff",
          "Connection": "keep-alive",
          "X-Mcp-Session-Id": sessionId
        },
      });
    }

    // 2. Message Input for active SSE session (POST /messages, or POST /sse?sessionId=..., or POST /mcp?sessionId=...)
    const isSseMessageInput = (isMessages || (isMcp || isSse)) && method === "POST" && (
      hasSessionHeader ||
      (this.transport !== undefined && isMessages)
    );

    if (isSseMessageInput && (this.transport || isMessages)) {
      console.log(`[DO ${this.ctx.id}] Incoming message to /messages`);
      if (!this.transport || !this.server) {
        console.warn(`[DO ${this.ctx.id}] Message received but no active transport/server`);
        const storedKey: string | undefined = await this.ctx.storage.get("apiKey");
        if (storedKey) {
            this.server = this.createServerInstance(storedKey, this.ctx.id.toString());
        }
        return new Response("Session state lost. Please reconnect SSE.", {
            status: 410,
            headers: { ...corsHeaders, "Content-Type": "text/plain" }
        });
      }

      try {
        const message = await request.json() as any;
        console.log(`[DO ${this.ctx.id}] JSON-RPC Request: ${message.method || 'unknown'}`);
        this.transport.onmessage?.(message);
        return new Response("OK", { headers: corsHeaders });
      } catch (e) {
        return new Response("Invalid JSON", { status: 400, headers: corsHeaders });
      }
    }

    // 3. Streamable HTTP transport: seamlessly handles BOTH /mcp AND /sse!
    if (isMcp || isSse) {
      const apiKey = request.headers.get("X-Xiaoflow-Api-Key") || extractAccessToken(request) || "";
      const sessionKey = request.headers.get("Mcp-Session-Id") || request.headers.get("X-Mcp-Session-Id") || url.searchParams.get("sessionId") || this.ctx.id.toString() || apiKey;

      const transport = new WebStandardStreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      });
      const server = this.createServerInstance(apiKey, sessionKey);
      await server.connect(transport);

      const reqHeaders = new Headers(request.headers);
      reqHeaders.set("Accept", "application/json, text/event-stream");
      const normalizedRequest = new Request(request, { headers: reqHeaders });

      const response = await transport.handleRequest(normalizedRequest);
      return withCors(response, request);
    }

    // Health Check / Diagnostics
    if (pathname === "/health" || pathname === "/") {
      return new Response(JSON.stringify({
        status: "OK",
        sessionId: this.ctx.id.toString(),
        mcpVersion: "1.3.1-DO",
        timestamp: new Date().toISOString()
      }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" }
      });
    }

    return new Response(`MCP DO Route Not Found: ${method} ${pathname}`, { status: 404, headers: corsHeaders });
  }

  private createServerInstance(apiKey: string, sessionKey: string = "default") {
    const server = new Server(
      SERVER_INFO,
      { capabilities: { tools: {}, resources: {}, prompts: {} } }
    );

    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (apiKey) {
      headers.Authorization = `Bearer ${apiKey}`;
    }
    const axiosInstance = axios.create({
      baseURL: this._env.XIAOFLOW_API_URL || "https://api.xiaoflow.com",
      headers,
      params: {
        expanded: "true",
        limit: 1000
      }
    });

    this.setupHandlers(server, axiosInstance, apiKey, sessionKey);
    return server;
  }

  private setupHandlers(server: Server, axiosInstance: any, apiKey: string = "", sessionKey: string = "default") {
    server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: enhanceTools([
        {
          name: "get_keyword_metrics",
          description: "Get exact-match base metrics and 1-48 months of monthly history for one keyword.",
          inputSchema: {
            type: "object",
            properties: {
              keyword: { type: "string", description: "Exact keyword text." },
              history_months: { type: "integer", minimum: 1, maximum: 48, default: 12 },
              location: { type: "string", description: "Geo ID or ISO country code, e.g. 2840 or US." },
              language: { type: "string", description: "Language ID or code, e.g. 1000 or en." },
            },
            required: ["keyword"],
          },
        },
        {
          name: "get_related_keywords",
          description: "Get all related keywords for a seed with metrics and optional 1-48 month history. Paginate until has_more=false; there is no total-result cap.",
          inputSchema: {
            type: "object",
            properties: {
              with_history: { type: "boolean", default: false, description: "Include monthly history only when explicitly true." },
              seed: { type: "string", description: "Seed keyword." },
              history_months: { type: "integer", minimum: 1, maximum: 48, default: 12 },
              page: { type: "integer", minimum: 1, default: 1 },
              page_size: { type: "integer", minimum: 1, default: 100 },
              location: { type: "string" },
              language: { type: "string" },
              force: { type: "boolean", description: "Request fresh discovery when cached coverage is insufficient." },
            },
            required: ["seed"],
          },
        },
        {
          name: "bulk_keyword_metrics",
          description: `Look up exact-match search volume, CPC, and competition for keyword lists. Supports up to ${BULK_SYNC_LIMIT} keywords synchronously (larger lists run as a background task). Complete results are returned in structured data and downloadable CSV/JSON files.
GUIDANCE FOR AI AGENTS:
- Do NOT split keyword lists into small 50-word batches; pass up to ${BULK_SYNC_LIMIT} keywords in one call.
- Do NOT output exhaustive markdown tables repeating hundreds of keywords in chat; summarize findings, volume distribution bands, and refer the user to the download links.`,
          inputSchema: {
            type: "object",
            properties: {
              with_history: { type: "boolean", default: false, description: "Include 12-48 month historical search volume (default false for speed)." },
              keywords: { type: "array", minItems: 1, items: { type: "string" }, description: `Keywords to analyze. Pass up to ${BULK_SYNC_LIMIT} in a single call without manual chunking.` },
              history_months: { type: "integer", minimum: 1, maximum: 48, default: 12 },
              location: { type: "string", description: "Google Ads geo target ID (e.g. 2840 for US) or country code." },
              language: { type: "string", description: "Google Ads language ID (e.g. 1000 for English) or language code." },
              min_volume: { type: "integer", minimum: 0, description: "Filter results by minimum monthly search volume." },
              max_volume: { type: "integer", minimum: 0, description: "Filter results by maximum monthly search volume (e.g. 99 for low-volume terms)." },
              preview_limit: { type: "integer", minimum: 0, maximum: 50, default: 15, description: "Number of rows to show in chat preview table (default 15, max 50). Full list is in downloads." },
              force_async: { type: "boolean", default: false, description: "Force background task even for small lists." },
            },
            required: ["keywords"],
          },
        },
        {
          name: "get_bulk_keyword_lookup_status",
          description: "Poll a background bulk_keyword_metrics task. When processing, returns progress. When completed, returns complete keyword metrics with pagination support (up to 1,000 keywords per page), volume filtering, and CSV/JSON download links.",
          inputSchema: {
            type: "object",
            properties: {
              task_id: { type: "integer", description: "Task id from bulk_keyword_metrics when mode=background_task." },
              page: { type: "integer", minimum: 1, default: 1, description: "Result page (1-based, up to 1,000 keywords per page)." },
              page_size: { type: "integer", minimum: 1, maximum: 1000, default: 1000, description: "Number of keyword rows per page (max 1000)." },
              min_volume: { type: "integer", minimum: 0, description: "Filter results by minimum search volume." },
              max_volume: { type: "integer", minimum: 0, description: "Filter results by maximum search volume (e.g. 100 to extract low-volume terms)." },
              all_pages: { type: "boolean", default: false, description: "Fetch all result pages if task has <= 2,000 rows." },
            },
            required: ["task_id"],
          },
        },
        {
          name: "start_keyword_expansion",
          description: "Start an asynchronous multi-round keyword expansion. Returns task_id + progress only. Poll get_keyword_expansion_status; when completed you get discovered keywords with volume, CPC, competition, and CSV/JSON download links.",
          inputSchema: {
            type: "object",
            properties: {
              seeds: { type: "array", minItems: 1, items: { type: "string" } },
              max_iterations: { type: "integer", minimum: 1, maximum: 10, default: 5 },
              min_search_volume: { type: "integer", minimum: 0, default: 0 },
              location_id: { type: "integer", default: 2840 },
              language_id: { type: "integer", default: 1000 },
              include_rules: { type: "array", items: { type: "string" } },
              exclude_rules: { type: "array", items: { type: "string" } },
            },
            required: ["seeds"],
          },
        },
        {
          name: "get_quota",
          description: "Check current XiaoFlow account credits, balance, remaining compute units (CU), used quota, daily limits, and tier. Call this tool whenever the user asks about remaining credits, balance, quota, account status, or available compute units.",
          inputSchema: {
            type: "object",
            properties: {},
          },
        },
        {
          name: "get_keyword_expansion_status",
          description: "Poll an asynchronous keyword expansion task. In-progress responses return depth, seed progress, and found keyword count. When completed/processed, returns the discovered keywords with metrics, pagination support (page/page_size), volume filtering, and CSV/JSON downloads.",
          inputSchema: {
            type: "object",
            properties: {
              task_id: { type: "integer" },
              page: { type: "integer", minimum: 1, default: 1, description: "Result page number." },
              page_size: { type: "integer", minimum: 1, maximum: 1000, default: 500, description: "Keywords per page (max 1000)." },
              min_volume: { type: "integer", minimum: 0, description: "Filter keywords by minimum monthly volume." },
              max_volume: { type: "integer", minimum: 0, description: "Filter keywords by maximum monthly volume." },
              preview_limit: { type: "integer", minimum: 0, maximum: 1000, default: 100 },
              include_results: { type: "boolean", default: true, description: "Include discovered keyword objects in the response." },
              live: { type: "boolean", default: false, description: "Nudge task processor and return current progress." },
            },
            required: ["task_id"],
          },
        },
        {
          name: "analyze_url",
          description: "Domain/site keyword discovery via /api/v1/websites (requires brand=0|1). Use site for full domain mapping; use url for a single page via /api/v1/keywords.",
          inputSchema: {
            type: "object",
            properties: {
              url: { type: "string", description: "Single page URL (uses /api/v1/keywords)." },
              site: { type: "string", description: "Domain for /api/v1/websites discovery." },
              brand: { type: "integer", enum: [0, 1], description: "0=domain keywords, 1=brand keywords (required with site)." },
              location: { type: "string", description: "Geo ID or ISO." },
              language: { type: "string", description: "Language ID or code." },
            },
          },
        },
        {
          name: "get_domain_stats",
          description: "Website overview metrics and traffic history. GET /api/v1/websites/:domain?brand=0|1",
          inputSchema: {
            type: "object",
            properties: {
              domain: { type: "string", description: "Domain (e.g. example.com)." },
              brand: { type: "integer", enum: [0, 1], description: "0=domain overview, 1=brand overview." },
              location: { type: "string", description: "Geo ID or ISO." },
              language: { type: "string", description: "Language ID or code." },
            },
            required: ["domain", "brand"],
          },
        },
        {
          name: "list_domain_keywords",
          description: "Paginated keyword list for a domain. GET /api/v1/websites/:domain/keywords?brand=0|1",
          inputSchema: {
            type: "object",
            properties: {
              domain: { type: "string" },
              brand: { type: "integer", enum: [0, 1] },
              location: { type: "string" },
              language: { type: "string" },
              page: { type: "integer" },
              page_size: { type: "integer" },
            },
            required: ["domain", "brand"],
          },
        },
        {
          name: "get_keyword_details",
          description: "Historical volume for a keyword slug.",
          inputSchema: {
            type: "object",
            properties: {
              slug: { type: "string" },
              time_range: { type: "string", enum: ["12m", "24m", "48m"] },
              location: { type: "string" },
              language: { type: "string" },
            },
            required: ["slug"],
          },
        },
      ]),
    }));

    const resourceDef = {
      uri: WIDGET_URI,
      name: "XiaoFlow Keyword Intelligence Dashboard",
      mimeType: "text/html;profile=mcp-app",
      description: "Interactive XiaoFlow keyword analytics dashboard with charts and table widgets",
      _meta: widgetUiMeta(true),
    };

    const templateDef = {
      uriTemplate: WIDGET_URI,
      name: "XiaoFlow Keyword Intelligence Dashboard",
      mimeType: "text/html;profile=mcp-app",
      description: "Interactive XiaoFlow keyword analytics dashboard with charts and table widgets",
      _meta: widgetUiMeta(true),
    };

    server.setRequestHandler(ListResourcesRequestSchema, async () => ({resources:[]}));
    server.setRequestHandler(ListResourceTemplatesRequestSchema, async () => ({resourceTemplates:[]}));
    server.setRequestHandler(ReadResourceRequestSchema, async () => { throw new McpError(ErrorCode.InvalidRequest, "Use the complete JSON data and CSV/JSON download resources returned by the tool."); });
    server.setRequestHandler(ListPromptsRequestSchema, async () => ({ prompts: [] }));

    server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;
      const toolArgs = (args || {}) as Record<string, unknown>;
      const effectiveKey = ((toolArgs.api_key as string) || (toolArgs.apiKey as string) || apiKey || "").trim();
      const reqConfig = effectiveKey ? { headers: { Authorization: `Bearer ${effectiveKey}` } } : {};
      const effectiveSessionKey = String((toolArgs.session_id as string) || (toolArgs.sessionId as string) || sessionKey || effectiveKey || "default").trim();
      const attachUi = false;
      try {
        switch (name) {
          case "get_keyword_metrics": {
            const keywords = Array.isArray(toolArgs.keywords) ? toolArgs.keywords : [toolArgs.keyword || toolArgs.seed].filter(Boolean);
            const data = await completeMetrics(keywords, async keywords => (await axiosInstance.post("/api/v1/keywords/batch-metrics", keywordApiPayload({...toolArgs,keywords,with_history:toolArgs.with_history ?? toolArgs.historical ?? false}),reqConfig)).data);
            return toolResult(data,false,name);
          }
          case "get_related_keywords": {
            const response = {data:await completePages(async page => (await axiosInstance.post("/api/v1/keywords/ideas", {...relatedKeywordPayload(toolArgs),page,page_size:1000},reqConfig)).data)};
            return toolResult(response.data, false, name, attachUi);
          }
          case "bulk_keyword_metrics": {
            const keywords = Array.isArray(toolArgs.keywords) ? toolArgs.keywords : [];
            if (keywords.length < 1) {
              throw new McpError(ErrorCode.InvalidParams, "keywords must contain at least one item");
            }
            const summaryOpts = {
              min_volume: toolArgs.min_volume !== undefined ? Number(toolArgs.min_volume) : undefined,
              max_volume: toolArgs.max_volume !== undefined ? Number(toolArgs.max_volume) : undefined,
              preview_limit: toolArgs.preview_limit !== undefined ? Number(toolArgs.preview_limit) : undefined,
            };
            const forceAsync = toolArgs.force_async === true || toolArgs.force_async === "true";
            if (forceAsync || keywords.length > BULK_SYNC_LIMIT) {
              try {
                const res = await axiosInstance.post(
                  "/api/v1/keywords/bulk-lookup/tasks",
                  {
                    keywords,
                    with_history: toolArgs.with_history ?? toolArgs.historical ?? false,
                    history_months: toolArgs.history_months ?? 12,
                    location_id: toolArgs.location ?? toolArgs.location_id ?? "us",
                    language_id: toolArgs.language ?? toolArgs.language_id ?? "en",
                  },
                  reqConfig,
                );
                const task = {
                  task_id: res.data?.task_id,
                  status: res.data?.status || "pending",
                  total_keywords: keywords.length,
                  completed_keywords: 0,
                  progress: 0,
                  result_count: 0,
                  mode: "background_task",
                  notice: `Created background task for ${keywords.length} keywords. Poll get_bulk_keyword_lookup_status — do not reprint rows in chat.`,
                };
                return {
                  content: [{ type: "text" as const, text: formatBulkTaskText(task) }],
                  structuredContent: { success: true, tool: name, ...task },
                };
              } catch (err) {
                return toolResult({
                  success: false,
                  error: axiosErrorMessage(err, "Failed to create bulk lookup task"),
                  hint: `Lists larger than ${BULK_SYNC_LIMIT} require the background bulk-lookup API. Authenticate with an API key and retry.`,
                }, true, name);
              }
            }
            const data = await completeMetrics(keywords, async batch => (await axiosInstance.post("/api/v1/keywords/batch-metrics", keywordApiPayload({...toolArgs,keywords:batch,with_history:toolArgs.with_history ?? toolArgs.historical ?? false}), reqConfig)).data);
            return this.bulkResult(data, name, summaryOpts);
          }
          case "get_bulk_keyword_lookup_status": {
            const taskId = Number(toolArgs.task_id);
            if (!Number.isInteger(taskId) || taskId < 1) {
              throw new McpError(ErrorCode.InvalidParams, "task_id must be a positive integer");
            }
            const summaryOpts = {
              min_volume: toolArgs.min_volume !== undefined ? Number(toolArgs.min_volume) : undefined,
              max_volume: toolArgs.max_volume !== undefined ? Number(toolArgs.max_volume) : undefined,
              preview_limit: toolArgs.preview_limit !== undefined ? Number(toolArgs.preview_limit) : undefined,
            };
            try {
              const res = await axiosInstance.get(`/api/v1/keywords/bulk-lookup/tasks/${taskId}`, reqConfig);
              const task = (res.data?.task || res.data || {}) as Record<string, unknown>;
              const status = String(task.status || "pending");
              if (status !== "completed") {
                const payload = {
                  success: true,
                  tool: name,
                  mode: "background_task",
                  task_id: taskId,
                  status,
                  progress: task.progress ?? 0,
                  total_keywords: task.total_keywords,
                  completed_keywords: task.completed_keywords,
                  result_count: task.result_count,
                  error: task.error ?? null,
                };
                return {
                  content: [{ type: "text" as const, text: formatBulkTaskText(payload) }],
                  structuredContent: payload,
                };
              }
              // Paginated retrieval of results so any size (even 50,000+ keywords) can be read smoothly
              const page = Math.max(1, Number(toolArgs.page || 1));
              const pageSize = Math.min(1000, Math.max(1, Number(toolArgs.page_size || toolArgs.size || 1000)));
              const allPages = (toolArgs.all_pages === true || toolArgs.all_pages === "true") && Number(task.result_count || 0) <= 2000;

              let pageRows: Record<string, unknown>[] = [];
              const total = Number(task.result_count || 0);

              if (allPages) {
                for (let p = 1; p === 1 || pageRows.length < total; p++) {
                  const pageRes = await axiosInstance.get(`/api/v1/keywords/bulk-lookup/tasks/${taskId}`, {
                    params: { results: 1, page: p, size: pageSize },
                    ...reqConfig,
                  });
                  const chunk = Array.isArray(pageRes.data?.data) ? pageRes.data.data : [];
                  pageRows.push(...chunk);
                  if (chunk.length < pageSize || p >= 5) break;
                }
              } else {
                const pageRes = await axiosInstance.get(`/api/v1/keywords/bulk-lookup/tasks/${taskId}`, {
                  params: { results: 1, page, size: pageSize },
                  ...reqConfig,
                });
                pageRows = Array.isArray(pageRes.data?.data) ? pageRes.data.data : [];
              }

              const result = await this.bulkResult({ success: true, data: pageRows, task }, name, summaryOpts);
              const hasMore = (page * pageSize) < total;
              (result.structuredContent as Record<string, unknown>).page = page;
              (result.structuredContent as Record<string, unknown>).page_size = pageSize;
              (result.structuredContent as Record<string, unknown>).total = total;
              const firstContent = result.content[0];
              if (hasMore && firstContent && "text" in firstContent) {
                firstContent.text += `\n\n> 📌 Showing page ${page} of ${Math.ceil(total / pageSize)} (${pageRows.length} keywords). Call \`get_bulk_keyword_lookup_status(task_id: ${taskId}, page: ${page + 1})\` to fetch the next page.`;
              }
              return result;
            } catch (err) {
              return toolResult({
                success: false,
                task_id: taskId,
                error: axiosErrorMessage(err, "Failed to fetch bulk lookup status"),
              }, true, name);
            }
          }
          case "start_keyword_expansion": {
            const seeds = parseSeedList(toolArgs);
            if (seeds.length < 1) {
              throw new McpError(ErrorCode.InvalidParams, "seeds must contain at least one keyword");
            }
            try {
              const res = await axiosInstance.post(
                "/api/v1/keywords/bulk-generate",
                expansionStartPayload(toolArgs, seeds),
                reqConfig,
              );
              const started = normalizeStartedTask(res.data, seeds);
              if (!started) {
                return toolResult({
                  success: false,
                  error: res.data?.error || "Expansion task was not created",
                }, true, name);
              }
              const payload = { ...started, mode: "background_task", tool: name };
              return {
                content: [{ type: "text" as const, text: formatExpansionTaskText(payload) }],
                structuredContent: payload,
              };
            } catch (err) {
              return toolResult({
                success: false,
                error: axiosErrorMessage(err, "Failed to start keyword expansion"),
              }, true, name);
            }
          }
          case "get_quota": {
            try {
              const res = await axiosInstance.get("/api/v1/auth/quota", reqConfig);
              return toolResult(res.data?.quota || res.data || { remaining: 0, used: 0, limit: 10, type: "guest" }, false, name);
            } catch (err: any) {
              return toolResult({ success: false, error: err.message || "Failed to fetch quota" }, true);
            }
          }
          case "get_keyword_expansion_status": {
            const taskId = Number(toolArgs.task_id);
            if (!Number.isInteger(taskId) || taskId < 1) {
              throw new McpError(ErrorCode.InvalidParams, "task_id must be a positive integer");
            }
            const summaryOpts = {
              min_volume: toolArgs.min_volume !== undefined ? Number(toolArgs.min_volume) : undefined,
              max_volume: toolArgs.max_volume !== undefined ? Number(toolArgs.max_volume) : undefined,
              preview_limit: toolArgs.preview_limit !== undefined ? Number(toolArgs.preview_limit) : undefined,
              page: toolArgs.page !== undefined ? Number(toolArgs.page) : 1,
              page_size: toolArgs.page_size !== undefined ? Number(toolArgs.page_size) : 500,
              include_results: toolArgs.include_results !== false,
            };
            try {
              const liveRes = await axiosInstance.get(`/api/v1/keywords/bulk-generate/task/${taskId}`, {
                params: { live: "1", kick: "1" },
                ...reqConfig,
              });
              const liveTask = liveRes.data?.data;
              if (!liveTask || typeof liveTask !== "object") {
                return toolResult({
                  success: false,
                  task_id: taskId,
                  error: liveRes.data?.error || "Expansion task not found",
                }, true, name);
              }
              const status = String(liveTask.status || "pending");
              if (!isExpansionTerminal(status) || (status === "failed" && !Number(liveTask.found_keywords_count))) {
                const payload = compactExpansionStatus(liveTask, taskId);
                if (toolArgs.live === true && Array.isArray(liveTask.results) && liveTask.results.length > 0) {
                  payload.current_results = liveTask.results.slice(0, 50);
                }
                return {
                  content: [{ type: "text" as const, text: formatExpansionTaskText(payload) }],
                  structuredContent: payload,
                };
              }

              const fullRes = await axiosInstance.get(`/api/v1/keywords/bulk-generate/task/${taskId}`, {
                params: { sync_metrics: "1" },
                ...reqConfig,
              });
              const task = (fullRes.data?.data || liveTask) as Record<string, unknown>;
              const rows = Array.isArray(task.results) ? (task.results as Record<string, unknown>[]) : [];
              const files = keywordExport({ success: true, data: rows, task }, name);
              let csv = files.csv;
              try {
                const csvRes = await axiosInstance.get(`/api/v1/keywords/bulk-generate/task/${taskId}/export`, {
                  ...reqConfig,
                  responseType: "text",
                  headers: { ...(reqConfig as { headers?: Record<string, string> }).headers, Accept: "text/csv" },
                  transformResponse: [(d: string) => d],
                });
                if (typeof csvRes.data === "string" && csvRes.data.length > 0) {
                  csv = csvRes.data;
                }
              } catch {
                // Fall back to preview-derived CSV when the export endpoint is unavailable.
              }
              const total = Number(task.results_total ?? task.found_keywords_count ?? files.rowCount);
              const exports = await this.storeExportFiles(csv, files.json, total || files.rowCount, name);
              const payload = buildExpansionCompleteResponse(task, rows, exports, summaryOpts);
              return {
                content: [
                  { type: "text" as const, text: formatExpansionCompleteText(payload) },
                ],
                structuredContent: payload,
              };
            } catch (err) {
              return toolResult({
                success: false,
                task_id: taskId,
                error: axiosErrorMessage(err, "Failed to fetch expansion status"),
              }, true, name);
            }
          }
          case "analyze_url": {
            const site = String(toolArgs.site || "").trim();
            const url = String(toolArgs.url || "").trim();
            if (site && !url) {
              const domain = normalizeDomainInput(site);
              const params = apiQueryParams(toolArgs);
              if (params.brand === undefined) params.brand = 0;
              const response = await axiosInstance.get("/api/v1/websites", {
                params: { ...params, site: domain },
              });
              return toolResult(response.data, false, name, attachUi);
            }
            const response = await axiosInstance.get("/api/v1/keywords", {
              params: apiQueryParams(toolArgs),
            });
            return toolResult(response.data, false, name, attachUi);
          }
          case "get_domain_stats": {
            const domain = normalizeDomainInput(String(toolArgs.domain || ""));
            const params = apiQueryParams(toolArgs);
            if (params.brand === undefined) {
              throw new McpError(ErrorCode.InvalidParams, "brand is required (0 or 1)");
            }
            const response = await axiosInstance.get(
              `/api/v1/websites/${encodeURIComponent(domain)}`,
              { params }
            );
            return toolResult(response.data, false, name, attachUi);
          }
          case "list_domain_keywords": {
            const domain = normalizeDomainInput(String(toolArgs.domain || ""));
            const params = apiQueryParams(toolArgs);
            if (params.brand === undefined) {
              throw new McpError(ErrorCode.InvalidParams, "brand is required (0 or 1)");
            }
            const response = {data:await completePages(async page => (await axiosInstance.get(`/api/v1/websites/${encodeURIComponent(domain)}/keywords`, {params:{...params,page,page_size:1000}})).data)};
            return toolResult(response.data, false, name, attachUi);
          }
          case "get_keyword_details": {
            const { slug, ...rest } = toolArgs;
            const response = await axiosInstance.post("/api/v1/keywords/batch-metrics", keywordApiPayload({
              ...rest,
              keyword: String(slug).replace(/-/g, " "),
            }));
            return toolResult(response.data, false, name, attachUi);
          }
          default:
            throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`);
        }
      } catch (error: any) {
        if (error instanceof McpError) throw error;
        const errorMsg = error.response?.data?.message || error.response?.data?.error || error.message || "Unknown API error";
        return toolResult({ success: false, error: `XiaoFlow API Error: ${errorMsg}` }, true);
      }
    });
  }
}

class HonoSseTransport {
  private controller?: ReadableStreamDefaultController;
  private encoder?: TextEncoder;
  public onmessage?: (message: any) => void;
  public onerror?: (error: Error) => void;
  public onclose?: () => void;

  constructor(private sessionId: string) {}

  setController(controller: ReadableStreamDefaultController, encoder: TextEncoder) {
    this.controller = controller;
    this.encoder = encoder;
  }

  async start() {
    console.log(`[DO ${this.sessionId}] [Transport] start() called`);
  }

  async send(message: any) {
    if (this.controller && this.encoder) {
      const data = `event: message\ndata: ${JSON.stringify(message)}\n\n`;
      try {
        this.controller.enqueue(this.encoder.encode(data));
        console.log(`[DO ${this.sessionId}] [Transport] Sent message: ${message.id || 'notify'}`);
      } catch (e) {
        console.error(`[DO ${this.sessionId}] [Transport] Error sending message:`, e);
        this.onclose?.();
      }
    } else {
        console.warn(`[DO ${this.sessionId}] [Transport] Attempted to send message but controller is missing`);
    }
  }

  async close() {
    console.log(`[DO ${this.sessionId}] [Transport] close() called`);
    this.onclose?.();
  }
}

const getCorsHeaders = (cOrReq: any) => {
  let origin: string | null = null;
  if (cOrReq instanceof Request) {
    origin = cOrReq.headers.get("Origin");
  } else if (cOrReq && cOrReq.req && typeof cOrReq.req.header === "function") {
    origin = cOrReq.req.header("Origin");
  }

  const allowedOrigin = origin || "*";

  return {
    "Access-Control-Allow-Origin": allowedOrigin,
    "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, Accept, Last-Event-ID, MCP-Protocol-Version, MCP-Session-Id, x-mcp-session-id",
    "Access-Control-Expose-Headers": "Content-Type, MCP-Protocol-Version, MCP-Session-Id, x-mcp-session-id, WWW-Authenticate",
  };
};

function withCors(response: Response, request: Request): Response {
  const headers = new Headers(response.headers);
  for (const [name, value] of Object.entries(getCorsHeaders(request))) {
    headers.set(name, value);
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function oauthErrorResponse(error = "invalid_token", description = "Authentication required.", requestOrPath?: Request | string): Response {
  let metadataUrl = PROTECTED_RESOURCE_METADATA;
  if (requestOrPath) {
    const p = typeof requestOrPath === "string" ? requestOrPath : new URL(requestOrPath.url).pathname;
    if (p.includes("/sse")) {
      metadataUrl = "https://mcp.xiaoflow.com/.well-known/oauth-protected-resource/sse";
    } else if (p.includes("/mcp")) {
      metadataUrl = "https://mcp.xiaoflow.com/.well-known/oauth-protected-resource/mcp";
    }
  }

  return new Response(JSON.stringify({
    error,
    error_description: description,
  }), {
    status: 401,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      "WWW-Authenticate": `Bearer resource_metadata="${metadataUrl}", scope="mcp", error="${error}"`,
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Expose-Headers": "WWW-Authenticate",
    },
  });
}

function bearerToken(request: Request): string {
  const authorization = request.headers.get("Authorization") || "";
  return authorization.toLowerCase().startsWith("bearer ")
    ? authorization.slice(7).trim()
    : "";
}

function extractAccessToken(request: Request): string {
  const url = new URL(request.url);
  return bearerToken(request)
    || (request.headers.get("X-Xiaoflow-Api-Key") || "").trim()
    || (url.searchParams.get("key") || "").trim();
}

async function requireUserToken(request: Request, env: Env): Promise<string | Response> {
  const token = extractAccessToken(request);
  if (!token) {
    return oauthErrorResponse("invalid_token", "Sign in with your XiaoFlow account to use MCP.", request);
  }
  const apiBaseUrl = env.XIAOFLOW_API_URL || "https://api.xiaoflow.com";
  const isValid = await validateAccessToken(token, apiBaseUrl);
  if (!isValid) {
    return oauthErrorResponse("invalid_token", "Access token is invalid or expired. Please sign in again.", request);
  }
  return token;
}

async function validateAccessToken(token: string, apiBaseUrl: string): Promise<boolean> {
  if (!token) return false;
  try {
    const response = await fetch(`${apiBaseUrl.replace(/\/$/, "")}/api/v1/user`, {
      headers: {
        "Authorization": `Bearer ${token}`,
        "Accept": "application/json",
      },
    });
    return response.ok;
  } catch (error) {
    console.error(JSON.stringify({
      event: "mcp_token_validation_failed",
      error: error instanceof Error ? error.message : String(error),
    }));
    return false;
  }
}

const app = new Hono<{ Bindings: Env }>();

const ICON_BASE64 = "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";
const ICON_BUFFER = Uint8Array.from(atob(ICON_BASE64), c => c.charCodeAt(0));


app.get("/.well-known/ai-plugin.json", (c) => c.json({
  schema_version: "v1",
  name_for_human: "XiaoFlow",
  name_for_model: "xiaoflow",
  description_for_human: "XiaoFlow Google Ads & SEO Keyword Intelligence.",
  description_for_model: "Research keyword metrics, related terms, monthly trends, and expansion opportunities with XiaoFlow.",
  auth: {
    type: "oauth",
    client_url: "https://mcp.xiaoflow.com/oauth/authorize",
    scope: "openid email mcp",
    authorization_url: "https://mcp.xiaoflow.com/oauth/token",
    authorization_content_type: "application/x-www-form-urlencoded"
  },
  api: {
    type: "openapi",
    url: "https://www.xiaoflow.com/openapi.json"
  },
  logo_url: "https://mcp.xiaoflow.com/icon.png",
  contact_email: "support@xiaoflow.com",
  legal_info_url: "https://www.xiaoflow.com/legal/privacy"
}, 200, {
  ...getCorsHeaders(c),
  "Cache-Control": "public, max-age=86400",
}));

app.get("/.well-known/mcp.json", (c) => c.json({
  name: "xiaoflow-mcp-server",
  title: "XiaoFlow Keyword Intelligence",
  version: "1.3.1",
  description: "XiaoFlow keyword research and expansion tools",
  icon: "https://mcp.xiaoflow.com/icon.png",
  logo_url: "https://mcp.xiaoflow.com/icon.png",
  icons: [
    {
      src: "https://mcp.xiaoflow.com/icon.png",
      mimeType: "image/png",
      sizes: ["256x256"]
    }
  ],
  server: {
    url: "https://mcp.xiaoflow.com/mcp",
    transport: "sse"
  }
}, 200, {
  ...getCorsHeaders(c),
  "Cache-Control": "public, max-age=86400",
}));

app.get("/icon.png", (c) => new Response(ICON_BUFFER, {
  headers: {
    "Content-Type": "image/png",
    "Cache-Control": "public, max-age=86400",
    "Access-Control-Allow-Origin": "*",
  }
}));

app.get("/logo.png", (c) => new Response(ICON_BUFFER, {
  headers: {
    "Content-Type": "image/png",
    "Cache-Control": "public, max-age=86400",
    "Access-Control-Allow-Origin": "*",
  }
}));

app.get("/favicon.ico", (c) => new Response(ICON_BUFFER, {
  headers: {
    "Content-Type": "image/png",
    "Cache-Control": "public, max-age=86400",
    "Access-Control-Allow-Origin": "*",
  }
}));

app.get("/apple-touch-icon.png", (c) => new Response(ICON_BUFFER, {
  headers: {
    "Content-Type": "image/png",
    "Cache-Control": "public, max-age=86400",
    "Access-Control-Allow-Origin": "*",
  }
}));


app.get("/.well-known/oauth-protected-resource", (c) => c.json({
  resource: MCP_RESOURCE,
  authorization_servers: ["https://mcp.xiaoflow.com"],
  scopes_supported: ["openid", "profile", "email", "mcp"],
  bearer_methods_supported: ["header"],
  client_id_metadata_document_supported: true,
  client_id_metadata_documents_supported: true,
  resource_documentation: "https://www.xiaoflow.com/mcp",
}, 200, {
  ...getCorsHeaders(c),
  "Cache-Control": "no-cache, no-store, must-revalidate",
}));

app.get("/.well-known/oauth-protected-resource/mcp", (c) => c.json({
  resource: MCP_RESOURCE,
  authorization_servers: ["https://mcp.xiaoflow.com"],
  scopes_supported: ["openid", "profile", "email", "mcp"],
  bearer_methods_supported: ["header"],
  client_id_metadata_document_supported: true,
  client_id_metadata_documents_supported: true,
  resource_documentation: "https://www.xiaoflow.com/mcp",
}, 200, {
  ...getCorsHeaders(c),
  "Cache-Control": "no-cache, no-store, must-revalidate",
}));

app.get("/.well-known/oauth-protected-resource/sse", (c) => c.json({
  resource: MCP_SSE_RESOURCE,
  authorization_servers: ["https://mcp.xiaoflow.com"],
  scopes_supported: ["openid", "profile", "email", "mcp"],
  bearer_methods_supported: ["header"],
  client_id_metadata_document_supported: true,
  client_id_metadata_documents_supported: true,
  resource_documentation: "https://www.xiaoflow.com/mcp",
}, 200, {
  ...getCorsHeaders(c),
  "Cache-Control": "no-cache, no-store, must-revalidate",
}));

app.get("/widget", (c) => new Response(MCP_APP_HTML_WIDGET, {
  status: 200,
  headers: {
    ...getCorsHeaders(c),
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store",
  },
}));

const oauthMetadata = (c: any) => c.json({
  issuer: "https://mcp.xiaoflow.com",
  authorization_endpoint: "https://mcp.xiaoflow.com/oauth/authorize",
  token_endpoint: `https://mcp.xiaoflow.com/oauth/token`,
  registration_endpoint: `https://mcp.xiaoflow.com/oauth/register`,
  userinfo_endpoint: "https://mcp.xiaoflow.com/oauth/userinfo",
  response_types_supported: ["code", "id_token", "token"],
  grant_types_supported: ["authorization_code", "refresh_token"],
  token_endpoint_auth_methods_supported: ["none", "client_secret_post", "client_secret_basic"],
  code_challenge_methods_supported: ["S256", "plain"],
  scopes_supported: ["openid", "profile", "email", "mcp"],
  subject_types_supported: ["public"],
  id_token_signing_alg_values_supported: ["HS256"],
  logo_uri: "https://mcp.xiaoflow.com/icon.png",
  service_documentation: "https://www.xiaoflow.com/mcp",
  client_id_metadata_document_supported: true,
  client_id_metadata_documents_supported: true,
  agent_auth: {
    skill: `${AUTHORIZATION_SERVER}/auth.md`,
    registration_endpoint: `https://mcp.xiaoflow.com/oauth/register`,
    authorization_endpoint: "https://mcp.xiaoflow.com/oauth/authorize",
    token_endpoint: `https://mcp.xiaoflow.com/oauth/token`,
  },
}, 200, {
  ...getCorsHeaders(c),
  "Cache-Control": "no-cache, no-store, must-revalidate",
});

app.get("/.well-known/oauth-authorization-server", oauthMetadata);
app.get("/.well-known/oauth-authorization-server/mcp", oauthMetadata);
app.get("/.well-known/openid-configuration", oauthMetadata);
app.get("/.well-known/openid-configuration/mcp", oauthMetadata);

app.all("/register", async (c) => {
  const method = c.req.method;
  const target = `${AUTHORIZATION_SERVER}/api/v1/mcp/oauth/register`;
  const response = await fetch(target, {
    method,
    headers: {
      "Content-Type": c.req.header("Content-Type") || "application/json",
      "Accept": "application/json",
    },
    body: ["GET", "HEAD"].includes(method) ? undefined : c.req.raw.body,
  });
  return withCors(response, c.req.raw);
});

app.all("/.well-known/oauth-authorization-server/register", async (c) => {
  const method = c.req.method;
  const target = `${AUTHORIZATION_SERVER}/api/v1/mcp/oauth/register`;
  const response = await fetch(target, {
    method,
    headers: {
      "Content-Type": c.req.header("Content-Type") || "application/json",
      "Accept": "application/json",
    },
    body: ["GET", "HEAD"].includes(method) ? undefined : c.req.raw.body,
  });
  return withCors(response, c.req.raw);
});

app.get("/.well-known/mcp/server-card.json", (c) => {
  const url = new URL(c.req.url);
  const baseUrl = `${url.protocol}//${url.host}`;
  return c.json({
    "$schema": "https://smithery.ai/server-card-schema.json",
    "name": "xiaoflow-mcp-server",
    "title": "XiaoFlow Keyword Intelligence",
    "description": "XiaoFlow AI SEO and keyword intelligence MCP Server",
    "version": "1.3.1",
    "homepage": "https://www.xiaoflow.com/mcp",
    "icon": "https://mcp.xiaoflow.com/icon.png",
    "protocolVersion": "2025-03-26",
    "capabilities": {
      "tools": {},
      "resources": {},
      "prompts": {}
    },
    "transport": {
      "type": "streamable-http",
      "endpoint": `${baseUrl}/mcp`
    },
    "configSchema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {}
    },
    "securitySchemes": {
      "oauth2": {
        "type": "oauth2",
        "description": "Authorize by logging into your XiaoFlow.com account",
        "flows": {
          "authorizationCode": {
            "authorizationUrl": `${baseUrl}/oauth/authorize`,
            "tokenUrl": `${baseUrl}/oauth/token`,
            "scopes": {}
          }
        }
      },
      "bearerAuth": {
        "type": "http",
        "scheme": "bearer",
        "bearerFormat": "API_KEY",
        "description": "Provide your XiaoFlow API key as a Bearer token"
      }
    }
  }, 200, getCorsHeaders(c));
});

app.get("/.well-known/mcp-server-card.json", (c) => {
  const url = new URL(c.req.url);
  const baseUrl = `${url.protocol}//${url.host}`;
  return c.json({
    "$schema": "https://smithery.ai/server-card-schema.json",
    "name": "xiaoflow-mcp-server",
    "title": "XiaoFlow Keyword Intelligence",
    "description": "XiaoFlow AI SEO and keyword intelligence MCP Server",
    "version": "1.3.1",
    "homepage": "https://www.xiaoflow.com/mcp",
    "icon": "https://mcp.xiaoflow.com/icon.png",
    "protocolVersion": "2025-03-26",
    "capabilities": {
      "tools": {},
      "resources": {},
      "prompts": {}
    },
    "transport": {
      "type": "streamable-http",
      "endpoint": `${baseUrl}/mcp`
    },
    "configSchema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {}
    },
    "securitySchemes": {
      "oauth2": {
        "type": "oauth2",
        "description": "Authorize by logging into your XiaoFlow.com account",
        "flows": {
          "authorizationCode": {
            "authorizationUrl": `${baseUrl}/oauth/authorize`,
            "tokenUrl": `${baseUrl}/oauth/token`,
            "scopes": {}
          }
        }
      },
      "bearerAuth": {
        "type": "http",
        "scheme": "bearer",
        "bearerFormat": "API_KEY",
        "description": "Provide your XiaoFlow API key as a Bearer token"
      }
    }
  }, 200, getCorsHeaders(c));
});

// OAuth compatibility routes. Standards-compliant clients discover the
// authorization server above; older clients may call these resource-host URLs.
app.get("/oauth/authorize", (c) => {
  const url = new URL(c.req.url);
  const target = new URL(`${AUTHORIZATION_SERVER}/mcp/authorize`);
  url.searchParams.forEach((value, key) => target.searchParams.set(key, value));
  return c.redirect(target.toString(), 302);
});

app.get("/authorize", (c) => c.redirect(`${AUTHORIZATION_SERVER}/mcp/authorize?${new URL(c.req.url).searchParams}`, 302));

app.all("/oauth/userinfo", async (c) => {
  const method = c.req.method;
  const target = `${AUTHORIZATION_SERVER}/api/v1/mcp/oauth/userinfo`;
  const response = await fetch(target, {
    method,
    headers: {
      "Content-Type": c.req.header("Content-Type") || "application/json",
      "Authorization": c.req.header("Authorization") || "",
      "Accept": "application/json",
    },
    body: ["GET", "HEAD"].includes(method) ? undefined : c.req.raw.body,
  });
  return withCors(response, c.req.raw);
});

app.all("/oauth/token", async (c) => {
  const method = c.req.method;
  const target = `${AUTHORIZATION_SERVER}/api/v1/mcp/oauth/token`;
  const rawBody = ["GET", "HEAD"].includes(method) ? undefined : await c.req.arrayBuffer();
  const headers: Record<string, string> = { "Accept": "application/json" };
  const ct = c.req.header("Content-Type");
  if (ct) headers["Content-Type"] = ct;
  const auth = c.req.header("Authorization");
  if (auth) headers["Authorization"] = auth;
  try {
    const response = await fetch(target, { method, headers, body: rawBody });
    return withCors(response, c.req.raw);
  } catch (err: any) {
    return c.json({ error: "token_proxy_error", message: err?.message }, 500);
  }
});

app.all("/oauth/register", async (c) => {
  const method = c.req.method;
  const target = `${AUTHORIZATION_SERVER}/api/v1/mcp/oauth/register`;
  const rawBody = ["GET", "HEAD"].includes(method) ? undefined : await c.req.arrayBuffer();
  const headers: Record<string, string> = { "Accept": "application/json" };
  const ct = c.req.header("Content-Type");
  if (ct) headers["Content-Type"] = ct;
  try {
    const response = await fetch(target, { method, headers, body: rawBody });
    return withCors(response, c.req.raw);
  } catch (err: any) {
    return c.json({ error: "register_proxy_error", message: err?.message }, 500);
  }
});

app.get("/", async (c) => {
    const accept = c.req.header("Accept") || "";
    if (accept.includes("text/html")) {
        return c.redirect("https://www.xiaoflow.com", 302);
    }
    try {
        const id = c.env.MCP_SESSION.newUniqueId();
        const obj = c.env.MCP_SESSION.get(id);
        const res = await obj.fetch(new Request("https://mcp.xiaoflow.com/health"));
        const data: any = await res.json();
        return c.json({
            status: "XiaoFlow MCP is Online",
            worker: "OnlineV2.4",
            durableObject: "Active",
            sessionId: data.sessionId,
            instructions: "Connect to /sse",
            streamableHttp: "/mcp",
            oauthProtectedResource: "/.well-known/oauth-protected-resource",
            timestamp: new Date().toISOString()
        }, 200, getCorsHeaders(c));
    } catch (err: any) {
        return c.json({ status: "Error", message: err.message }, 500, getCorsHeaders(c));
    }
});

export default {
    async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
        const url = new URL(request.url);
        const method = request.method;
        const pathname = url.pathname.replace(/\/$/, "").toLowerCase() || "/";

        if (method === "OPTIONS") {
            return new Response(null, { status: 204, headers: getCorsHeaders(request) });
        }

        const exportPath = url.pathname.match(/^\/exports\/([a-f0-9]{64})\/([a-f0-9]{64})\.(csv|json)$/);
        if (exportPath && (method === 'GET' || method === 'HEAD')) {
            try {
                const id = env.MCP_SESSION.idFromString(exportPath[1]);
                return env.MCP_SESSION.get(id).fetch(new Request(`https://mcp.xiaoflow.com/__download_export?token=${exportPath[2]}&format=${exportPath[3]}`, {method}));
            } catch { return new Response('Export not found', {status:404}); }
        }

        const isMcp = pathname === "/mcp";
        const isSse = pathname === "/sse";
        const isMessages = pathname === "/messages";

        // Fully unify both /mcp and /sse: both support Streamable HTTP and SSE transports
        if (isMcp || isSse) {
            const auth = await requireUserToken(request, env);
            if (auth instanceof Response) {
                return withCors(auth, request);
            }

            const sessionId = url.searchParams.get("sessionId") || request.headers.get("x-mcp-session-id") || request.headers.get("mcp-session-id");
            let id;
            if (sessionId) {
                try { id = env.MCP_SESSION.idFromString(sessionId); } catch { id = env.MCP_SESSION.newUniqueId(); }
            } else {
                id = env.MCP_SESSION.newUniqueId();
            }

            const obj = env.MCP_SESSION.get(id);
            const forwarded = new Request(request);
            forwarded.headers.set("X-External-Base-Url", `${url.protocol}//${url.host}`);
            forwarded.headers.set("X-Xiaoflow-Api-Key", auth);
            forwarded.headers.set("Authorization", `Bearer ${auth}`);
            return obj.fetch(forwarded);
        }

        if (isMessages) {
            const sessionId = url.searchParams.get("sessionId") || request.headers.get("x-mcp-session-id") || request.headers.get("mcp-session-id");
            let id;
            if (sessionId) {
                try { id = env.MCP_SESSION.idFromString(sessionId); } catch { id = env.MCP_SESSION.newUniqueId(); }
            } else {
                id = env.MCP_SESSION.newUniqueId();
            }

            const obj = env.MCP_SESSION.get(id);
            const baseUrl = `${url.protocol}//${url.host}`;
            const newRequest = new Request(request);
            newRequest.headers.set("X-External-Base-Url", baseUrl);

            return obj.fetch(newRequest);
        }

        return app.fetch(request, env, ctx);
    }
} satisfies ExportedHandler<Env>;
