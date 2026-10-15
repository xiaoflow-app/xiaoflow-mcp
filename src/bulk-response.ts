import { keywordExport, keywordRows } from "./keyword-export.js";

export const BULK_SYNC_LIMIT = 2000;
export const BULK_PREVIEW_LIMIT = 20;

export type BulkExportLink = {
  format: string;
  url: string;
  row_count: number;
  expires_at: string;
};

function num(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function rowKeyword(row: Record<string, unknown>): string {
  return String(row.keyword ?? row.k ?? "").trim();
}

function rowVolume(row: Record<string, unknown>): number {
  return num(row.search_volume ?? row.v ?? 0);
}

/** Compact one row for optional chat preview (no history). */
export function compactKeywordRow(row: Record<string, unknown>) {
  return {
    keyword: rowKeyword(row),
    search_volume: rowVolume(row),
    top_of_page_bid_low: num(row.top_of_page_bid_low ?? row.l),
    top_of_page_bid_high: num(row.top_of_page_bid_high ?? row.h),
    competition: row.competition ?? row.co ?? null,
    competition_index: row.competition_index ?? row.i ?? null,
  };
}

export type BulkSummary = ReturnType<typeof summarizeKeywordRows>;

export function summarizeKeywordRows(
  rows: Record<string, unknown>[],
  opts: { min_volume?: number; max_volume?: number; preview_limit?: number } = {},
) {
  const minVolume = opts.min_volume;
  const maxVolume = opts.max_volume;
  const previewLimit = Math.max(0, Math.min(1000, opts.preview_limit ?? (opts.max_volume !== undefined ? 500 : BULK_PREVIEW_LIMIT)));

  const filtered = rows.filter((row) => {
    const volume = rowVolume(row);
    if (minVolume !== undefined && volume < minVolume) return false;
    if (maxVolume !== undefined && volume > maxVolume) return false;
    return true;
  });

  const volumes = filtered.map(rowVolume);
  const zero = volumes.filter((v) => v <= 0).length;
  const under100 = volumes.filter((v) => v > 0 && v < 100).length;
  const from100 = volumes.filter((v) => v >= 100 && v < 1000).length;
  const from1k = volumes.filter((v) => v >= 1000 && v < 10000).length;
  const from10k = volumes.filter((v) => v >= 10000).length;
  const totalVolume = volumes.reduce((sum, v) => sum + v, 0);

  const ranked = [...filtered].sort((a, b) => rowVolume(b) - rowVolume(a));
  const preview = ranked.slice(0, previewLimit).map(compactKeywordRow);
  // Low-volume hits for filtering workflows (default: volume < 100).
  const lowCap = maxVolume !== undefined ? maxVolume : 99;
  const lowHits = rows
    .filter((row) => {
      const volume = rowVolume(row);
      if (volume > lowCap) return false;
      if (minVolume !== undefined && volume < minVolume) return false;
      return true;
    })
    .sort((a, b) => rowVolume(a) - rowVolume(b));

  const filterHitLimit = Math.max(0, Math.min(1000, opts.preview_limit ?? 500));

  return {
    requested_rows: rows.length,
    matched_rows: filtered.length,
    volume_bands: {
      zero,
      under_100: under100,
      from_100_to_999: from100,
      from_1k_to_9999: from1k,
      from_10k_plus: from10k,
    },
    total_search_volume: totalVolume,
    avg_search_volume: filtered.length ? Math.round(totalVolume / filtered.length) : 0,
    preview,
    filter_hits: lowHits.slice(0, filterHitLimit).map(compactKeywordRow),
    filter_hit_count: lowHits.length,
  };
}

/** Complete bulk metrics payload with structured data rows and exports. */
export function buildBulkMetricsResponse(
  data: unknown,
  toolName: string,
  exports: BulkExportLink[],
  opts: {
    min_volume?: number;
    max_volume?: number;
    preview_limit?: number;
    page?: number;
    page_size?: number;
    include_data?: boolean;
  } = {},
) {
  const rows = keywordRows(data) as Record<string, unknown>[];
  const summary = summarizeKeywordRows(rows, opts);
  const files = keywordExport(data, toolName);

  const minVolume = opts.min_volume;
  const maxVolume = opts.max_volume;
  const filteredRows = (minVolume !== undefined || maxVolume !== undefined)
    ? rows.filter((r) => {
        const v = rowVolume(r);
        if (minVolume !== undefined && v < minVolume) return false;
        if (maxVolume !== undefined && v > maxVolume) return false;
        return true;
      })
    : rows;

  return {
    success: true,
    tool: toolName,
    mode: "summary_with_exports",
    row_count: rows.length,
    matched_count: filteredRows.length,
    total: rows.length,
    data: filteredRows,
    results: filteredRows,
    summary,
    exports,
    notice: exports.length
      ? "Full rows are returned in structured data array, with CSV/JSON exports attached."
      : "Full rows returned in structured data array.",
  };
}

export function formatBulkMetricsText(payload: {
  row_count?: number;
  summary: BulkSummary;
  exports?: BulkExportLink[];
  notice?: string;
  [key: string]: unknown;
}): string {
  const s = payload.summary;
  const bands = s.volume_bands;
  const rowCount = payload.row_count ?? s.requested_rows;
  const lines = [
    `## XiaoFlow bulk keyword metrics`,
    ``,
    `| Metric | Value |`,
    `| :--- | :--- |`,
    `| Rows | **${rowCount}** |`,
    `| Matched (after volume filter) | **${s.matched_rows}** |`,
    `| Total monthly volume | **${s.total_search_volume.toLocaleString()}** |`,
    `| Avg volume | **${s.avg_search_volume.toLocaleString()}** |`,
    `| Volume = 0 | ${bands.zero} |`,
    `| Volume 1–99 | ${bands.under_100} |`,
    `| Volume 100–999 | ${bands.from_100_to_999} |`,
    `| Volume 1k–9.9k | ${bands.from_1k_to_9999} |`,
    `| Volume 10k+ | ${bands.from_10k_plus} |`,
    ``,
  ];

  if (s.filter_hits && s.filter_hits.length > 0 && (s.matched_rows !== s.requested_rows || s.filter_hit_count > 0)) {
    lines.push(`### Filter Hits (${s.filter_hits.length} keywords matching volume criteria)`);
    lines.push(``);
    lines.push(`| Keyword | Volume | CPC | Competition |`);
    lines.push(`| :--- | :--- | :--- | :--- |`);
    for (const row of s.filter_hits) {
      lines.push(
        `| ${row.keyword} | ${row.search_volume} | $${Number(row.top_of_page_bid_low).toFixed(2)}–$${Number(row.top_of_page_bid_high).toFixed(2)} | ${row.competition ?? "—"} |`,
      );
    }
    lines.push(``);
  } else if (s.preview.length) {
    lines.push(`### Keywords Preview (${s.preview.length} rows)`);
    lines.push(``);
    lines.push(`| Keyword | Volume | CPC | Competition |`);
    lines.push(`| :--- | :--- | :--- | :--- |`);
    for (const row of s.preview) {
      lines.push(
        `| ${row.keyword} | ${row.search_volume} | $${Number(row.top_of_page_bid_low).toFixed(2)}–$${Number(row.top_of_page_bid_high).toFixed(2)} | ${row.competition ?? "—"} |`,
      );
    }
    lines.push(``);
  }

  if (payload.exports?.length) {
    lines.push(`### Downloads (complete result — save these files)`);
    for (const file of payload.exports) {
      lines.push(`- **${file.format.toUpperCase()}** (${file.row_count} rows, expires ${file.expires_at}): ${file.url}`);
    }
    lines.push(``);
  }

  lines.push(`> ${payload.notice}`);
  return lines.join("\n");
}

export function formatBulkTaskText(task: Record<string, unknown>): string {
  const id = task.task_id ?? task.id ?? "—";
  const status = String(task.status || "pending");
  const progress = num(task.progress);
  const total = num(task.total_keywords);
  const done = num(task.completed_keywords);
  const results = num(task.result_count);
  return [
    `## XiaoFlow background bulk lookup`,
    ``,
    `| Field | Value |`,
    `| :--- | :--- |`,
    `| Task | \`#${id}\` |`,
    `| Status | **${status}** (${progress}%) |`,
    `| Progress | ${done} / ${total} keywords |`,
    `| Result rows | ${results} |`,
    ``,
    task.error ? `> Error: ${task.error}\n` : "",
    `> Poll \`get_bulk_keyword_lookup_status(task_id=${id})\` until status is completed/failed.`,
    `> When completed, download CSV/JSON from the tool response — do not ask the model to reprint tens of thousands of rows.`,
    `> Website: https://www.xiaoflow.com/keywords/bulk-lookup`,
  ]
    .filter(Boolean)
    .join("\n");
}
