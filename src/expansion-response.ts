import {
  type BulkExportLink,
  buildBulkMetricsResponse,
  formatBulkMetricsText,
  summarizeKeywordRows,
} from "./bulk-response.js";
import { progressPercent, parseSeedsField } from "./expansion.js";

export function isExpansionTerminal(status: string): boolean {
  return ["completed", "processed", "failed"].includes(status);
}

export function formatExpansionTaskText(task: Record<string, unknown>): string {
  const id = task.task_id ?? task.id ?? "—";
  const status = String(task.status || "pending");
  const progress = progressPercent(task.progress, Number(task.progress) || 0);
  const seeds = parseSeedsField(task.seeds);
  const count = Number(task.keywords_count ?? task.found_keywords_count ?? task.result_count ?? 0);
  const depth = task.current_depth ?? (task.progress as { current_depth?: unknown } | undefined)?.current_depth;
  const maxIter = task.max_iterations ?? (task.progress as { max_iterations?: unknown } | undefined)?.max_iterations;
  const pending = task.pending_count ?? 0;
  const processed = task.processed_count ?? 0;

  return [
    `## XiaoFlow keyword expansion`,
    ``,
    `| Field | Value |`,
    `| :--- | :--- |`,
    `| Task | \`#${id}\` |`,
    `| Status | **${status}** (${progress}%) |`,
    `| Seeds | ${seeds.length ? seeds.slice(0, 8).join(", ") + (seeds.length > 8 ? ` (+${seeds.length - 8} more)` : "") : "—"} |`,
    `| Keywords found | **${count.toLocaleString()}** |`,
    (depth !== undefined && depth !== null) || (maxIter !== undefined && maxIter !== null)
      ? `| Depth | ${depth ?? "—"} / ${maxIter ?? "—"} |`
      : "",
    `| Queue | processed ${processed} · pending ${pending} |`,
    ``,
    task.error ? `> Error: ${task.error}\n` : "",
    isExpansionTerminal(status)
      ? `> When completed, download CSV/JSON from the tool response — do not reprint thousands of rows in chat.`
      : `> Poll \`get_keyword_expansion_status(task_id=${id})\` until status is completed/processed/failed.`,
    `> Website: https://www.xiaoflow.com/user/discovery?task=${id}`,
  ]
    .filter(Boolean)
    .join("\n");
}

export function buildExpansionCompleteResponse(
  task: Record<string, unknown>,
  rows: Record<string, unknown>[],
  exports: BulkExportLink[],
  opts: {
    min_volume?: number;
    max_volume?: number;
    preview_limit?: number;
    page?: number;
    page_size?: number;
    include_results?: boolean;
  } = {},
) {
  const taskId = Number(task.task_id ?? task.id);
  const total = Number(task.results_total ?? task.found_keywords_count ?? rows.length);
  const truncated = Boolean(task.results_truncated) || total > rows.length;
  const page = Math.max(1, Number(opts.page || 1));
  const pageSize = Math.min(1000, Math.max(1, Number(opts.page_size || 500)));

  const base = buildBulkMetricsResponse({ success: true, data: rows }, "get_keyword_expansion_status", exports, opts);
  const filteredRows = Array.isArray(base.data) ? (base.data as Record<string, unknown>[]) : rows;
  const pagedRows = filteredRows.slice((page - 1) * pageSize, page * pageSize);

  // Prefer authoritative task total when the API preview is truncated.
  base.row_count = total || base.row_count;
  base.summary.requested_rows = total || base.summary.requested_rows;
  base.tool = "get_keyword_expansion_status";
  return {
    ...base,
    mode: "summary_with_exports" as const,
    task_id: taskId,
    status: String(task.status || "completed"),
    progress: progressPercent(task.progress, 100),
    seeds: parseSeedsField(task.seeds),
    keywords_count: total,
    results_truncated: truncated,
    page,
    page_size: pageSize,
    total: filteredRows.length,
    has_more: page * pageSize < filteredRows.length,
    data: pagedRows,
    results: pagedRows,
    url: `https://www.xiaoflow.com/user/discovery?task=${taskId}`,
    notice: truncated
      ? "Structured results include discovered keywords. The attached CSV/JSON exports contain the complete dataset."
      : base.notice,
  };
}

export function formatExpansionCompleteText(
  payload: ReturnType<typeof buildExpansionCompleteResponse>,
): string {
  const head = [
    `## XiaoFlow keyword expansion complete`,
    ``,
    `| Field | Value |`,
    `| :--- | :--- |`,
    `| Task | \`#${payload.task_id}\` |`,
    `| Status | **${payload.status}** |`,
    `| Keywords found | **${payload.keywords_count.toLocaleString()}** |`,
    payload.results_truncated ? `| Total in DB | ${payload.keywords_count.toLocaleString()} (full set in CSV/JSON) |` : "",
    ``,
  ]
    .filter(Boolean)
    .join("\n");

  const body = formatBulkMetricsText({
    success: true,
    tool: "get_keyword_expansion_status",
    mode: "summary_with_exports",
    row_count: payload.row_count,
    summary: payload.summary,
    exports: payload.exports,
    notice: payload.notice,
  }).replace("## XiaoFlow bulk keyword metrics\n\n", "");

  const pagedRows = (payload.results || payload.data || []) as Record<string, unknown>[];
  let tableSection = "";
  if (pagedRows.length > 0 && !body.includes("### Filter Hits") && !body.includes("### Keywords Preview")) {
    const lines = [
      `### Discovered Keywords (${pagedRows.length} rows, Page ${payload.page ?? 1})`,
      ``,
      `| Keyword | Volume | CPC | Competition |`,
      `| :--- | :--- | :--- | :--- |`,
    ];
    for (const r of pagedRows.slice(0, 50)) {
      const kw = r.keyword || r.k || "";
      const vol = (r.search_volume ?? r.v ?? 0).toLocaleString();
      const low = Number(r.top_of_page_bid_low ?? r.l ?? 0).toFixed(2);
      const high = Number(r.top_of_page_bid_high ?? r.h ?? 0).toFixed(2);
      const comp = r.competition ?? r.co ?? "—";
      lines.push(`| **${kw}** | ${vol} | $${low}–$${high} | ${comp} |`);
    }
    lines.push(``);
    tableSection = lines.join("\n");
  }

  return `${head}${body}\n${tableSection}`.trim();
}

/** Strip heavy fields before any accidental JSON dump. */
export function compactExpansionStatus(task: Record<string, unknown>, taskId: number): Record<string, unknown> {
  const progress = task.progress;
  const progressObj = progress && typeof progress === "object" ? (progress as Record<string, unknown>) : {};
  return {
    success: true,
    tool: "get_keyword_expansion_status",
    mode: "background_task",
    task_id: Number(task.id ?? taskId),
    status: String(task.status || "pending"),
    progress: progressPercent(progress, 0),
    seeds: parseSeedsField(task.seeds),
    keywords_count: Number(task.found_keywords_count ?? progressObj.keywords_found ?? 0),
    current_depth: progressObj.current_depth ?? null,
    max_iterations: progressObj.max_iterations ?? null,
    pending_count: task.pending_count ?? progressObj.pending_count ?? 0,
    processed_count: task.processed_count ?? progressObj.processed_count ?? 0,
    results_total: task.results_total ?? task.found_keywords_count ?? 0,
    results_truncated: Boolean(task.results_truncated),
    error: task.error ?? null,
    url: `https://www.xiaoflow.com/user/discovery?task=${task.id ?? taskId}`,
  };
}

export { summarizeKeywordRows };
