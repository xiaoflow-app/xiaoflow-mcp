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

function isUnresolvedRow(row: Record<string, unknown>): boolean {
  return row.unresolved === true || row.status === "unresolved" || (row.v === null && row.search_volume === undefined);
}

function rowVolume(row: Record<string, unknown>): number | null {
  if (isUnresolvedRow(row)) return null;
  const raw = row.search_volume ?? row.v;
  if (raw === null || raw === undefined) return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : 0;
}

/** Compact one row for optional chat preview (no history). */
export function compactKeywordRow(row: Record<string, unknown>) {
  const unresolved = isUnresolvedRow(row);
  const v = rowVolume(row);
  return {
    keyword: rowKeyword(row),
    search_volume: unresolved ? null : (v ?? 0),
    status: unresolved ? "unresolved" : "resolved",
    top_of_page_bid_low: unresolved ? null : num(row.top_of_page_bid_low ?? row.l),
    top_of_page_bid_high: unresolved ? null : num(row.top_of_page_bid_high ?? row.h),
    competition: unresolved ? null : (row.competition ?? row.co ?? null),
    competition_index: unresolved ? null : (row.competition_index ?? row.i ?? null),
  };
}

export type BulkSummary = ReturnType<typeof summarizeKeywordRows>;

export function summarizeKeywordRows(
  rows: Record<string, unknown>[],
  opts: { min_volume?: number; max_volume?: number; preview_limit?: number } = {},
) {
  const minVolume = opts.min_volume;
  const maxVolume = opts.max_volume;
  const hasFilter = minVolume !== undefined || maxVolume !== undefined;
  const previewLimit = Math.max(0, Math.min(50, opts.preview_limit ?? (hasFilter ? 15 : BULK_PREVIEW_LIMIT)));

  const unresolvedRows: Record<string, unknown>[] = [];
  const resolvedRows: Record<string, unknown>[] = [];

  for (const row of rows) {
    if (isUnresolvedRow(row)) {
      unresolvedRows.push(row);
    } else {
      resolvedRows.push(row);
    }
  }

  const filtered = resolvedRows.filter((row) => {
    const volume = rowVolume(row);
    if (volume === null) return false;
    if (minVolume !== undefined && volume < minVolume) return false;
    if (maxVolume !== undefined && volume > maxVolume) return false;
    return true;
  });

  const volumes = resolvedRows.map((r) => rowVolume(r) ?? 0);
  const zero = volumes.filter((v) => v === 0).length;
  const under100 = volumes.filter((v) => v > 0 && v < 100).length;
  const from100 = volumes.filter((v) => v >= 100 && v < 1000).length;
  const from1k = volumes.filter((v) => v >= 1000 && v < 10000).length;
  const from10k = volumes.filter((v) => v >= 10000).length;
  const totalVolume = volumes.reduce((sum, v) => sum + v, 0);

  const ranked = [...filtered].sort((a, b) => (rowVolume(b) ?? 0) - (rowVolume(a) ?? 0));
  const preview = ranked.slice(0, previewLimit).map(compactKeywordRow);

  const filterHits = hasFilter
    ? [...filtered].sort((a, b) => (rowVolume(a) ?? 0) - (rowVolume(b) ?? 0)).slice(0, previewLimit).map(compactKeywordRow)
    : [];

  return {
    requested_rows: rows.length,
    resolved_rows: resolvedRows.length,
    unresolved_rows: unresolvedRows.length,
    matched_rows: hasFilter ? filtered.length : resolvedRows.length,
    volume_bands: {
      unresolved: unresolvedRows.length,
      zero,
      under_100: under100,
      from_100_to_999: from100,
      from_1k_to_9999: from1k,
      from_10k_plus: from10k,
    },
    total_search_volume: totalVolume,
    avg_search_volume: resolvedRows.length ? Math.round(totalVolume / resolvedRows.length) : 0,
    has_filter: hasFilter,
    preview,
    filter_hits: filterHits,
    filter_hit_count: hasFilter ? filtered.length : 0,
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

  const minVolume = opts.min_volume;
  const maxVolume = opts.max_volume;
  const filteredRows = (minVolume !== undefined || maxVolume !== undefined)
    ? rows.filter((r) => {
        const v = rowVolume(r);
        if (v === null) return false;
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
    `| Total keywords queried | **${rowCount}** |`,
    s.has_filter ? `| Matched filter criteria | **${s.matched_rows}** |` : `| Successfully resolved | **${s.resolved_rows}** |`,
    `| Total monthly search volume | **${s.total_search_volume.toLocaleString()}** |`,
    `| Avg monthly search volume | **${s.avg_search_volume.toLocaleString()}** |`,
  ];

  if (bands.unresolved > 0) {
    lines.push(`| ⚠️ Rate limited / Pending (queued) | **${bands.unresolved}** |`);
  }
  lines.push(
    `| Verified Volume = 0 | ${bands.zero} |`,
    `| Volume 1–99 | ${bands.under_100} |`,
    `| Volume 100–999 | ${bands.from_100_to_999} |`,
    `| Volume 1k–9.9k | ${bands.from_1k_to_9999} |`,
    `| Volume 10k+ | ${bands.from_10k_plus} |`,
    ``,
  );

  if (bands.unresolved > 0) {
    lines.push(`> ⚠️ **Google Ads Live Lookup Notice**: ${bands.unresolved} keywords could not be fetched immediately due to Google Ads temporary rate limit. They have been enqueued for background sync and marked as \`status="unresolved"\` with \`search_volume=null\`. Re-querying in 1–2 minutes will retrieve their updated data.`);
    lines.push(``);
  }

  if (s.has_filter && s.filter_hits.length > 0) {
    lines.push(`### Filter Hits (${s.filter_hit_count} matching keywords, showing top ${s.filter_hits.length})`);
    lines.push(``);
    lines.push(`| Keyword | Volume | CPC | Competition |`);
    lines.push(`| :--- | :--- | :--- | :--- |`);
    for (const row of s.filter_hits) {
      lines.push(
        `| ${row.keyword} | ${row.search_volume ?? "pending"} | $${Number(row.top_of_page_bid_low ?? 0).toFixed(2)}–$${Number(row.top_of_page_bid_high ?? 0).toFixed(2)} | ${row.competition ?? "—"} |`,
      );
    }
    if (s.filter_hit_count > s.filter_hits.length) {
      lines.push(``);
      lines.push(`*...and ${s.filter_hit_count - s.filter_hits.length} more matching keywords in downloads and structured data.*`);
    }
    lines.push(``);
  } else if (s.preview.length > 0) {
    lines.push(`### Preview (${s.preview.length} highest-volume keywords)`);
    lines.push(``);
    lines.push(`| Keyword | Volume | CPC | Competition |`);
    lines.push(`| :--- | :--- | :--- | :--- |`);
    for (const row of s.preview) {
      lines.push(
        `| ${row.keyword} | ${row.search_volume ?? "pending"} | $${Number(row.top_of_page_bid_low ?? 0).toFixed(2)}–$${Number(row.top_of_page_bid_high ?? 0).toFixed(2)} | ${row.competition ?? "—"} |`,
      );
    }
    if (s.matched_rows > s.preview.length) {
      lines.push(``);
      lines.push(`*...and ${s.matched_rows - s.preview.length} more keywords in downloads and structured data.*`);
    }
    lines.push(``);
  }

  if (payload.exports?.length) {
    lines.push(`### Complete Results Download`);
    for (const file of payload.exports) {
      lines.push(`- **${file.format.toUpperCase()}** (${file.row_count} rows, expires ${file.expires_at}): ${file.url}`);
    }
    lines.push(``);
  }

  lines.push(`> 💡 **AI Instructions**: Do NOT reprint hundreds of keyword rows in chat. Use the summary bands and point the user to the download links above.`);
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
