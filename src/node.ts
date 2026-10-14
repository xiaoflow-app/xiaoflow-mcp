#!/usr/bin/env node
import "dotenv/config";
import { completeMetrics, completePages } from "./complete-results.js";
import { inlineExportResources } from "./keyword-export.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ErrorCode,
  ListPromptsRequestSchema,
  ListResourcesRequestSchema,
  ListResourceTemplatesRequestSchema,
  ListToolsRequestSchema,
  McpError,
} from "@modelcontextprotocol/sdk/types.js";
import axios from "axios";
import { enhanceTools, SERVER_INFO } from "./tool-quality.js";
import {
  axiosErrorMessage,
  expansionStartPayload,
  normalizeExpansionStatus,
  normalizeStartedTask,
  parseSeedList,
} from "./expansion.js";

function toolResult(data: unknown, isError = false, toolName = "") {
  const structuredContent =
    data !== null && typeof data === "object" && !Array.isArray(data)
      ? data as Record<string, unknown>
      : { success: !isError, data };

  return {
    content: [{ type: "text" as const, text: JSON.stringify(data) }, ...(!isError && toolName.startsWith("bulk_keyword_") ? inlineExportResources(data, toolName) : [])],
    structuredContent,
    ...(isError ? { isError: true } : {}),
  };
}

function brandQueryParam(brand: unknown): 0 | 1 {
  if (brand === 1 || brand === "1" || brand === true) return 1;
  return 0;
}

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
    // Fall through to plain domain normalization.
  }
  return s.replace(/^www\./i, "").toLowerCase();
}

function createXiaoflowServer(apiKey: string, apiUrl: string): Server {
  const server = new Server(
    SERVER_INFO,
    { capabilities: { tools: {}, resources: {}, prompts: {} } }
  );

  const axiosInstance = axios.create({
    baseURL: apiUrl,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    params: {
      expanded: "true",
      limit: 1000,
    },
  });

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: enhanceTools([
      {
        name: "get_keyword_metrics",
        description: "Get exact-match base metrics and 1-48 months of monthly history for one keyword.",
        inputSchema: {
          type: "object",
          properties: {
            keyword: { type: "string" },
            history_months: { type: "integer", minimum: 1, maximum: 48, default: 12 },
            location: { type: "string" },
            language: { type: "string" },
          },
          required: ["keyword"],
        },
      },
      {
        name: "get_related_keywords",
        description: "Get all related keywords for a seed with metrics/history. Paginate until has_more=false; no total-result cap.",
        inputSchema: {
          type: "object",
          properties: {
            with_history: { type: "boolean", default: false, description: "Include monthly history only when explicitly true." },
              seed: { type: "string" },
            history_months: { type: "integer", minimum: 1, maximum: 48, default: 12 },
            page: { type: "integer", minimum: 1, default: 1 },
            page_size: { type: "integer", minimum: 1, default: 100 },
            location: { type: "string" },
            language: { type: "string" },
            force: { type: "boolean" },
          },
          required: ["seed"],
        },
      },
      {
        name: "bulk_keyword_metrics",
        description: "Get all exact-match base metrics, automatically batched in groups of 1,000. Monthly history is disabled by default.",
        inputSchema: {
          type: "object",
          properties: {
              with_history: { type: "boolean", default: false, description: "Include monthly history only when explicitly true." },
            keywords: { type: "array", minItems: 1, items: { type: "string" } },
            history_months: { type: "integer", minimum: 1, maximum: 48, default: 12 },
            location: { type: "string" },
            language: { type: "string" },
          },
          required: ["keywords"],
        },
      },
      {
        name: "start_keyword_expansion",
        description: "Start an asynchronous multi-round keyword expansion. Returns task_id and status only — never a related-keyword list. Poll get_keyword_expansion_status until completed/processed/failed.",
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
        name: "get_keyword_expansion_status",
        description: "Poll an expansion task by task_id. Returns status, progress percent, depth, and keyword counts. Complete result rows are included by default; set include_results=false only for a lightweight progress check.",
        inputSchema: {
          type: "object",
          properties: {
            task_id: { type: "integer" },
            include_results: { type: "boolean", default: true },
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
      {
        name: "get_quota",
        description: "Query account balance, remaining compute units (CU), used quota, and daily limits.",
        inputSchema: {
          type: "object",
          properties: {},
        },
      },
    ]),
  }));

  // MCP directories commonly probe every discovery method, including for
  // tool-only servers. Return protocol-valid empty collections.
  server.setRequestHandler(ListResourcesRequestSchema, async () => ({ resources: [] }));
  server.setRequestHandler(ListResourceTemplatesRequestSchema, async () => ({ resourceTemplates: [] }));
  server.setRequestHandler(ListPromptsRequestSchema, async () => ({ prompts: [] }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    const toolArgs = (args || {}) as Record<string, unknown>;

    try {
      switch (name) {
        case "get_keyword_metrics": {
          const keywords = Array.isArray(toolArgs.keywords) ? toolArgs.keywords : [toolArgs.keyword || toolArgs.seed].filter(Boolean);
          const data = await completeMetrics(keywords, async keywords => (await axiosInstance.post("/api/v1/keywords/batch-metrics", keywordApiPayload({...toolArgs,keywords,with_history:toolArgs.with_history ?? toolArgs.historical ?? false}))).data);
          return toolResult(data);
        }
        case "get_related_keywords": {
          const response = {data:await completePages(async page => (await axiosInstance.post("/api/v1/keywords/ideas", {...relatedKeywordPayload(toolArgs),page,page_size:1000})).data)};
          return toolResult(response.data);
        }
        case "bulk_keyword_metrics": {
          const keywords = Array.isArray(toolArgs.keywords) ? toolArgs.keywords : [];
          if (keywords.length < 1) {
            throw new McpError(ErrorCode.InvalidParams, "keywords must contain at least one item");
          }

          const data = await completeMetrics(keywords, async keywords => (await axiosInstance.post("/api/v1/keywords/batch-metrics", keywordApiPayload({...toolArgs,keywords,with_history:toolArgs.with_history ?? toolArgs.historical ?? false}))).data);
          return toolResult(data, false, name);
        }
        case "start_keyword_expansion": {
          const seeds = parseSeedList(toolArgs);
          if (seeds.length < 1) {
            throw new McpError(ErrorCode.InvalidParams, "seeds must contain at least one keyword");
          }
          try {
            const response = await axiosInstance.post(
              "/api/v1/keywords/bulk-generate",
              expansionStartPayload(toolArgs, seeds),
            );
            const started = normalizeStartedTask(response.data, seeds);
            if (!started) {
              return toolResult({
                success: false,
                error: response.data?.error || "Expansion task was not created",
              }, true);
            }
            return toolResult(started);
          } catch (err) {
            return toolResult({
              success: false,
              error: axiosErrorMessage(err, "Failed to start keyword expansion"),
            }, true);
          }
        }
        case "get_keyword_expansion_status": {
          const taskId = Number(toolArgs.task_id);
          if (!Number.isInteger(taskId) || taskId < 1) {
            throw new McpError(ErrorCode.InvalidParams, "task_id must be a positive integer");
          }
          const includeResults = toolArgs.include_results !== false && toolArgs.include_results !== "false";
          try {
            const response = await axiosInstance.get(`/api/v1/keywords/bulk-generate/task/${taskId}`, {
              params: includeResults ? { sync_metrics: "1" } : { live: "1", kick: "1" },
            });
            const task = response.data?.data;
            if (!task || typeof task !== "object") {
              return toolResult({
                success: false,
                task_id: taskId,
                error: response.data?.error || "Expansion task not found",
              }, true);
            }
            return toolResult(normalizeExpansionStatus(task, taskId, includeResults));
          } catch (err) {
            return toolResult({
              success: false,
              task_id: taskId,
              error: axiosErrorMessage(err, "Failed to fetch expansion status"),
            }, true);
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
            return toolResult(response.data);
          }
          const response = await axiosInstance.get("/api/v1/keywords", {
            params: apiQueryParams(toolArgs),
          });
          return toolResult(response.data);
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
          return toolResult(response.data);
        }
        case "list_domain_keywords": {
          const domain = normalizeDomainInput(String(toolArgs.domain || ""));
          const params = apiQueryParams(toolArgs);
          if (params.brand === undefined) {
            throw new McpError(ErrorCode.InvalidParams, "brand is required (0 or 1)");
          }
          const response = {data:await completePages(async page => (await axiosInstance.get(`/api/v1/websites/${encodeURIComponent(domain)}/keywords`, {params:{...params,page,page_size:1000}})).data)};
          return toolResult(response.data);
        }
        case "get_keyword_details": {
          const { slug, ...rest } = toolArgs;
          const response = await axiosInstance.post("/api/v1/keywords/batch-metrics", keywordApiPayload({
            ...rest,
            keyword: String(slug).replace(/-/g, " "),
          }));
          return toolResult(response.data);
        }
        case "get_quota": {
          const response = await axiosInstance.get("/api/v1/auth/quota");
          return toolResult(response.data);
        }
        default:
          throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`);
      }
    } catch (error: any) {
      if (error instanceof McpError) throw error;
      const errorMsg =
        error.response?.data?.message ||
        error.response?.data?.error ||
        error.message ||
        "Unknown API error";
      return toolResult({ success: false, error: `XiaoFlow API Error: ${errorMsg}` }, true);
    }
  });

  return server;
}

async function main() {
  const apiKey = process.env.XIAOFLOW_API_KEY || process.env.XIAOFLOW_MCP_API_KEY || "";
  const apiUrl = process.env.XIAOFLOW_API_URL || "https://api.xiaoflow.com";

  if (!apiKey) {
    console.error(
      "XIAOFLOW_API_KEY is not set. Create one at https://www.xiaoflow.com/user/api-keys or use login authorization to obtain a token."
    );
  }

  const server = createXiaoflowServer(apiKey, apiUrl);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error) => {
  console.error("Failed to start XiaoFlow MCP server:", error);
  process.exit(1);
});
