import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import {
  buildExpansionCompleteResponse,
  compactExpansionStatus,
  formatExpansionCompleteText,
  formatExpansionTaskText,
  isExpansionTerminal,
} from "../build/expansion-response.js";
import { normalizeExpansionStatus, normalizeStartedTask } from "../build/expansion.js";

test("expansion status helpers stay compact", () => {
  assert.equal(isExpansionTerminal("completed"), true);
  assert.equal(isExpansionTerminal("processing"), false);
  const started = normalizeStartedTask({ task_id: 12, status: "pending" }, ["ring"]);
  assert.equal(started.mode, "background_task");
  assert.match(started.next_action, /get_keyword_expansion_status/);
  const status = normalizeExpansionStatus(
    {
      id: 12,
      status: "processing",
      seeds: '["ring"]',
      found_keywords_count: 1200,
      results: Array.from({ length: 1200 }, (_, i) => ({ keyword: `k${i}`, search_volume: i })),
      progress: { percent: 40, current_depth: 2, max_iterations: 5 },
    },
    12,
    true,
  );
  assert.equal(status.results, undefined);
  assert.equal(status.keywords_count, 1200);
  assert.match(formatExpansionTaskText(compactExpansionStatus({
    id: 12,
    status: "processing",
    seeds: ["ring"],
    found_keywords_count: 1200,
    progress: { percent: 40 },
  }, 12)), /#12/);
});

test("completed expansion response embeds paged rows and exports", () => {
  const rows = Array.from({ length: 300 }, (_, i) => ({
    keyword: `kw ${i}`,
    search_volume: i * 10,
  }));
  const payload = buildExpansionCompleteResponse(
    {
      id: 9,
      status: "completed",
      seeds: ["seed"],
      results_total: 9000,
      results_truncated: true,
      found_keywords_count: 9000,
    },
    rows,
    [
      {
        format: "csv",
        url: "file:///tmp/x.csv",
        row_count: 9000,
        expires_at: "2099-01-01T00:00:00.000Z",
      },
    ],
    { preview_limit: 5 },
  );
  assert.equal(payload.mode, "summary_with_exports");
  assert.equal(payload.keywords_count, 9000);
  assert.equal(payload.data.length, 300);
  assert.equal(payload.summary.preview.length, 5);
  assert.equal(JSON.stringify(payload).includes('"kw 100"'), true);
  const text = formatExpansionCompleteText(payload);
  assert.match(text, /9000/);
  assert.match(text, /Downloads|file:\/\//);
  assert.ok(text.length < 12_000);
});

test("stdio expansion start and complete stay compact with file exports", async () => {
  const rows = Array.from({ length: 40 }, (_, i) => ({
    keyword: `expanded ${i}`,
    search_volume: i * 100,
  }));
  const exportDir = fs.mkdtempSync(path.join(os.tmpdir(), "xiaoflow-exp-"));
  const server = http.createServer(async (req, res) => {
    let raw = "";
    for await (const c of req) raw += c;
    res.setHeader("Content-Type", "application/json");
    if (req.method === "POST" && String(req.url).includes("/bulk-generate")) {
      res.end(JSON.stringify({ success: true, task_id: 55, status: "pending" }));
      return;
    }
    if (String(req.url).includes("/export")) {
      res.setHeader("Content-Type", "text/csv");
      res.end("Keyword,Search Volume\nexpanded 0,0\nexpanded 1,100\n");
      return;
    }
    if (String(req.url).includes("/task/55")) {
      const live = String(req.url).includes("live=1");
      res.end(
        JSON.stringify({
          success: true,
          data: {
            id: 55,
            status: live ? "completed" : "completed",
            seeds: '["seed"]',
            found_keywords_count: 40,
            results_total: 40,
            results_truncated: false,
            progress: { percent: 100, current_depth: 3, max_iterations: 5 },
            results: live ? [] : rows,
          },
        }),
      );
      return;
    }
    res.end(JSON.stringify({ success: true, data: [] }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const client = new Client({ name: "exp-test", version: "1" });
  try {
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: ["build/node.js"],
        env: {
          ...process.env,
          XIAOFLOW_API_KEY: "fixture",
          XIAOFLOW_API_URL: `http://127.0.0.1:${server.address().port}`,
          XIAOFLOW_EXPORT_DIR: exportDir,
        },
        stderr: "pipe",
      }),
    );
    const listed = await client.listTools();
    assert.equal(
      listed.tools.find((t) => t.name === "get_keyword_expansion_status").inputSchema.properties
        .include_results.default,
      true,
    );
    const started = await client.callTool({
      name: "start_keyword_expansion",
      arguments: { seeds: ["seed"] },
    });
    assert.equal(started.structuredContent.mode, "background_task");
    assert.equal(started.structuredContent.task_id, 55);
    assert.doesNotMatch(started.content[0].text, /expanded 39/);

    const done = await client.callTool({
      name: "get_keyword_expansion_status",
      arguments: { task_id: 55 },
    });
    assert.equal(done.structuredContent.mode, "summary_with_exports");
    assert.equal(done.structuredContent.keywords_count, 40);
    assert.ok(Array.isArray(done.structuredContent.results));
    assert.equal(done.structuredContent.results.length, 40);
    assert.match(done.content[0].text, /Downloads|file:\/\//);
    const csvPath = done.structuredContent.exports
      .find((f) => f.format === "csv")
      .url.replace(/^file:\/\//, "");
    assert.ok(fs.existsSync(csvPath));
    assert.match(fs.readFileSync(csvPath, "utf8"), /expanded 0/);
  } finally {
    await client.close();
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(exportDir, { recursive: true, force: true });
  }
});
