#!/usr/bin/env node
import "dotenv/config";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { completeMetrics, completePages } from "./complete-results.js";
import { keywordExport } from "./keyword-export.js";
import {
  BULK_SYNC_LIMIT,
  buildBulkMetricsResponse,
  formatBulkMetricsText,
  formatBulkTaskText,
  type BulkExportLink,
} from "./bulk-response.js";
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
  normalizeStartedTask,
  parseSeedList,
} from "./expansion.js";
import {
  buildExpansionCompleteResponse,
  compactExpansionStatus,
  formatExpansionCompleteText,
  formatExpansionTaskText,
  isExpansionTerminal,
} from "./expansion-response.js";

function toolResult(data: unknown, isError = false, _toolName = "") {
  const structuredContent =
    data !== null && typeof data === "object" && !Array.isArray(data)
      ? data as Record<string, unknown>
      : { success: !isError, data };

  return {
    content: [{ type: "text" as const, text: JSON.stringify(data) }],
    structuredContent,
    ...(isError ? { isError: true } : {}),
  };
}

function writeBulkExports(data: unknown, toolName: string): BulkExportLink[] {
  const files = keywordExport(data, toolName);
  const dir = process.env.XIAOFLOW_EXPORT_DIR || path.join(os.tmpdir(), "xiaoflow-mcp-exports");
  fs.mkdirSync(dir, { recursive: true });
  const stamp = Date.now();
  const base = path.join(dir, `${toolName}-${stamp}`);
  const csvPath = `${base}.csv`;
  const jsonPath = `${base}.json`;
  fs.writeFileSync(csvPath, files.csv, "utf8");
  fs.writeFileSync(jsonPath, files.json, "utf8");
  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  return [
    { format: "csv", url: `file://${csvPath}`, row_count: files.rowCount, expires_at: expiresAt },
    { format: "json", url: `file://${jsonPath}`, row_count: files.rowCount, expires_at: expiresAt },
  ];
}

function bulkMetricsResult(
  data: unknown,
  toolName: string,
  opts: { min_volume?: number; max_volume?: number; preview_limit?: number } = {},
) {
  const exports = writeBulkExports(data, toolName);
  const payload = buildBulkMetricsResponse(data, toolName, exports, opts);
  return {
    content: [
      { type: "text" as const, text: formatBulkMetricsText(payload) },
      ...exports.map((file) => ({
        type: "resource_link" as const,
        uri: file.url,
        name: `${toolName}.${file.format}`,
        mimeType: file.format === "csv" ? "text/csv" : "application/json",
        description: `Complete ${file.row_count}-row result saved on disk`,
      })),
    ],
    structuredContent: payload,
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
        description: `Look up exact-match metrics for keywords. Returns complete keyword metrics (volume, CPC, competition) directly in structured data and preview tables. Supports lists of any size: ≤${BULK_SYNC_LIMIT} keywords run synchronously; larger lists create a background task that can be polled and paginated via get_bulk_keyword_lookup_status. History off by default.`,
        inputSchema: {
          type: "object",
          properties: {
            with_history: { type: "boolean", default: false, description: "Include monthly history only when explicitly true." },
            keywords: { type: "array", minItems: 1, items: { type: "string" }, description: `Keywords to analyze. Any size; >${BULK_SYNC_LIMIT} becomes a background task.` },
            history_months: { type: "integer", minimum: 1, maximum: 48, default: 12 },
            location: { type: "string" },
            language: { type: "string" },
            min_volume: { type: "integer", minimum: 0, description: "Optional filter for minimum volume." },
            max_volume: { type: "integer", minimum: 0, description: "Optional filter for maximum volume (e.g. 100 to list low-volume terms)." },
            preview_limit: { type: "integer", minimum: 0, maximum: 1000, default: 100, description: "How many keyword rows to include in the chat summary." },
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
            preview_limit: { type: "integer", minimum: 0, maximum: 1000, default: 100 },
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
          const summaryOpts = {
            min_volume: toolArgs.min_volume !== undefined ? Number(toolArgs.min_volume) : undefined,
            max_volume: toolArgs.max_volume !== undefined ? Number(toolArgs.max_volume) : undefined,
            preview_limit: toolArgs.preview_limit !== undefined ? Number(toolArgs.preview_limit) : undefined,
          };
          const forceAsync = toolArgs.force_async === true || toolArgs.force_async === "true";
          if (forceAsync || keywords.length > BULK_SYNC_LIMIT) {
            try {
              const response = await axiosInstance.post("/api/v1/keywords/bulk-lookup/tasks", {
                keywords,
                with_history: toolArgs.with_history ?? toolArgs.historical ?? false,
                history_months: toolArgs.history_months ?? 12,
                location_id: toolArgs.location ?? toolArgs.location_id ?? "us",
                language_id: toolArgs.language ?? toolArgs.language_id ?? "en",
              });
              const task = {
                task_id: response.data?.task_id,
                status: response.data?.status || "pending",
                total_keywords: keywords.length,
                completed_keywords: 0,
                progress: 0,
                result_count: 0,
                mode: "background_task",
              };
              return {
                content: [{ type: "text" as const, text: formatBulkTaskText(task) }],
                structuredContent: { success: true, tool: name, ...task },
              };
            } catch (err) {
              return toolResult({
                success: false,
                error: axiosErrorMessage(err, "Failed to create bulk lookup task"),
                hint: `Lists larger than ${BULK_SYNC_LIMIT} require the background bulk-lookup API.`,
              }, true);
            }
          }
          const data = await completeMetrics(keywords, async batch => (await axiosInstance.post("/api/v1/keywords/batch-metrics", keywordApiPayload({...toolArgs,keywords:batch,with_history:toolArgs.with_history ?? toolArgs.historical ?? false}))).data);
          return bulkMetricsResult(data, name, summaryOpts);
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
            const response = await axiosInstance.get(`/api/v1/keywords/bulk-lookup/tasks/${taskId}`);
            const task = (response.data?.task || response.data || {}) as Record<string, unknown>;
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
            const page = Math.max(1, Number(toolArgs.page || 1));
            const pageSize = Math.min(1000, Math.max(1, Number(toolArgs.page_size || toolArgs.size || 1000)));
            const allPages = (toolArgs.all_pages === true || toolArgs.all_pages === "true") && Number(task.result_count || 0) <= 2000;

            let pageRows: Record<string, unknown>[] = [];
            const total = Number(task.result_count || 0);

            if (allPages) {
              for (let p = 1; p === 1 || pageRows.length < total; p++) {
                const pageRes = await axiosInstance.get(`/api/v1/keywords/bulk-lookup/tasks/${taskId}`, {
                  params: { results: 1, page: p, size: pageSize },
                });
                const chunk = Array.isArray(pageRes.data?.data) ? pageRes.data.data : [];
                pageRows.push(...chunk);
                if (chunk.length < pageSize || p >= 5) break;
              }
            } else {
              const pageRes = await axiosInstance.get(`/api/v1/keywords/bulk-lookup/tasks/${taskId}`, {
                params: { results: 1, page, size: pageSize },
              });
              pageRows = Array.isArray(pageRes.data?.data) ? pageRes.data.data : [];
            }

            const result = bulkMetricsResult({ success: true, data: pageRows, task }, name, summaryOpts);
            const hasMore = (page * pageSize) < total;
            (result.structuredContent as Record<string, unknown>).page = page;
            (result.structuredContent as Record<string, unknown>).page_size = pageSize;
            (result.structuredContent as Record<string, unknown>).total = total;
            (result.structuredContent as Record<string, unknown>).has_more = hasMore;
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
            }, true);
          }
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
            const payload = { ...started, mode: "background_task", tool: name };
            return {
              content: [{ type: "text" as const, text: formatExpansionTaskText(payload) }],
              structuredContent: payload,
            };
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
            });
            const liveTask = liveRes.data?.data;
            if (!liveTask || typeof liveTask !== "object") {
              return toolResult({
                success: false,
                task_id: taskId,
                error: liveRes.data?.error || "Expansion task not found",
              }, true);
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
            });
            const task = (fullRes.data?.data || liveTask) as Record<string, unknown>;
            const rows = Array.isArray(task.results) ? (task.results as Record<string, unknown>[]) : [];
            const dataForExport: unknown = { success: true, data: rows, task };
            const exports = writeBulkExports(dataForExport, name);
            try {
              const csvRes = await axiosInstance.get(`/api/v1/keywords/bulk-generate/task/${taskId}/export`, {
                responseType: "text",
                headers: { Accept: "text/csv" },
                transformResponse: [(d) => d],
              });
              if (typeof csvRes.data === "string" && csvRes.data.length > 0) {
                fs.writeFileSync(exports[0].url.replace(/^file:\/\//, ""), csvRes.data, "utf8");
              }
            } catch {
              // Keep preview-derived CSV when the export endpoint is unavailable.
            }
            const total = Number(task.results_total ?? task.found_keywords_count ?? rows.length);
            exports.forEach((file) => { file.row_count = total || file.row_count; });
            const payload = buildExpansionCompleteResponse(task, rows, exports, summaryOpts);
            return {
              content: [
                { type: "text" as const, text: formatExpansionCompleteText(payload) },
                ...exports.map((file) => ({
                  type: "resource_link" as const,
                  uri: file.url,
                  name: `${name}.${file.format}`,
                  mimeType: file.format === "csv" ? "text/csv" : "application/json",
                  description: `Complete ${file.row_count}-row result saved on disk`,
                })),
              ],
              structuredContent: payload,
            };
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
