import { test } from "node:test";
import assert from "node:assert/strict";
import {
  BULK_SYNC_LIMIT,
  buildBulkMetricsResponse,
  formatBulkMetricsText,
  formatBulkTaskText,
  summarizeKeywordRows,
} from "../build/bulk-response.js";

test("summarizeKeywordRows bands and low-volume filter hits stay compact", () => {
  const rows = [
    { keyword: "a", search_volume: 0 },
    { keyword: "b", search_volume: 50 },
    { keyword: "c", search_volume: 500 },
    { keyword: "d", search_volume: 5000 },
    { keyword: "e", search_volume: 50000 },
  ];
  const summary = summarizeKeywordRows(rows, { preview_limit: 3 });
  assert.equal(summary.requested_rows, 5);
  assert.equal(summary.volume_bands.zero, 1);
  assert.equal(summary.volume_bands.under_100, 1);
  assert.equal(summary.preview.length, 3);
  assert.equal(summary.preview[0].keyword, "e");
  assert.equal(summary.filter_hit_count, 2);
  assert.ok(summary.filter_hits.every((row) => row.search_volume < 100));

  const filtered = summarizeKeywordRows(rows, { max_volume: 100, preview_limit: 10 });
  assert.equal(filtered.matched_rows, 2);
  assert.equal(filtered.filter_hit_count, 2);
});

test("buildBulkMetricsResponse embeds full structured data rows and keeps text preview readable", () => {
  const rows = Array.from({ length: 500 }, (_, i) => ({
    keyword: `kw ${i}`,
    search_volume: i,
  }));
  const payload = buildBulkMetricsResponse(
    { success: true, data: rows },
    "bulk_keyword_metrics",
    [
      {
        format: "csv",
        url: "https://example.test/a.csv",
        row_count: 500,
        expires_at: "2099-01-01T00:00:00.000Z",
      },
    ],
  );
  assert.equal(payload.mode, "summary_with_exports");
  assert.equal(payload.row_count, 500);
  assert.equal(payload.data.length, 500);
  assert.equal(payload.results.length, 500);
  assert.equal(payload.summary.preview.length, 20);
  assert.equal(JSON.stringify(payload).includes('"kw 499"'), true);
  assert.equal(JSON.stringify(payload).includes('"kw 100"'), true);
  const text = formatBulkMetricsText(payload);
  assert.match(text, /Rows \| \*\*500\*\*/);
  assert.match(text, /Downloads/);
  assert.ok(text.length < 8_000);
});

test("formatBulkTaskText points at status polling", () => {
  const text = formatBulkTaskText({
    task_id: 42,
    status: "processing",
    progress: 25,
    total_keywords: 47655,
    completed_keywords: 12000,
    result_count: 11900,
  });
  assert.match(text, /#42/);
  assert.match(text, /get_bulk_keyword_lookup_status/);
  assert.match(text, /47655/);
  assert.ok(BULK_SYNC_LIMIT >= 1000);
});
