# XiaoFlow MCP Server (`xiaoflow-mcp-server`)

[![xiaoflow-mcp MCP server](https://glama.ai/mcp/servers/xiaoq-in/xiaoflow-mcp/badges/score.svg)](https://glama.ai/mcp/servers/xiaoq-in/xiaoflow-mcp)
[![xiaoflow-mcp MCP server](https://glama.ai/mcp/servers/xiaoq-in/xiaoflow-mcp/badges/card.svg)](https://glama.ai/mcp/servers/xiaoq-in/xiaoflow-mcp)

Official Model Context Protocol (MCP) server for **XiaoFlow AI SEO and keyword intelligence tools**.

Connect Large Language Models (LLMs) such as Claude Desktop, Cursor, Windsurf, and VS Code directly to XiaoFlow's search engine optimization, keyword discovery, and domain analytics.

**Remote endpoint:** `https://mcp.xiaoflow.com/mcp`

**Transport:** MCP Streamable HTTP with OAuth 2.1 / PKCE, plus stdio through the npm package

**Safety:** Read-only research tools, except asynchronous expansion task creation; no destructive tools

## Official listings

- [npm — `xiaoflow-mcp-server`](https://www.npmjs.com/package/xiaoflow-mcp-server)
- [Smithery — `xiaoflow/xiaoflow-mcp`](https://smithery.ai/servers/xiaoflow/xiaoflow-mcp)
- [Glama — `xiaoq-in/xiaoflow-mcp`](https://glama.ai/mcp/servers/xiaoq-in/xiaoflow-mcp)
- [GitHub — `xiaoq-in/xiaoflow-mcp`](https://github.com/xiaoq-in/xiaoflow-mcp)
- [Full setup guide and prompt templates](https://www.xiaoflow.com/mcp)

---

## ✨ Features & Capabilities

- 🔍 **Keyword Discovery**: Generate high-intent search keywords and SEO ideas from keyword, URL, or domain seeds.
- 📊 **Domain Analytics**: Analyze domain-level search performance, organic traffic metrics, and keyword distributions.
- 📈 **Search Trend Analysis**: Compare keyword demand, competition, CPC, and historical trends.
- 🔒 **Flexible Authentication**: Supports API Key authentication via query parameters (`?key=`), Bearer tokens, environment variables, or Web OAuth login.

---

## ⚡ Quick Start

### 1. Run via `npx` (stdio)

Run the server directly using `npx`:

```bash
npx -y xiaoflow-mcp-server
```

Pass your XiaoFlow API key via environment variable:

```bash
XIAOFLOW_API_KEY="YOUR_API_KEY" npx -y xiaoflow-mcp-server
```

---

### 2. Connect via Streamable HTTP with web login (recommended)

Use the canonical remote endpoint in clients that support remote MCP. The client
discovers XiaoFlow OAuth automatically and opens the browser for login and consent:

```text
https://mcp.xiaoflow.com/mcp
```

Legacy clients can still use `https://mcp.xiaoflow.com/sse?key=YOUR_API_KEY`.

---

## 💻 Client Integration Guides

### Cursor Setup

Add XiaoFlow MCP to Cursor:

- **Name**: `xiaoflow`
- **Type**: `http`
- **URL**: `https://mcp.xiaoflow.com/mcp`

Or click **Add to Cursor** directly on the [XiaoFlow MCP Portal](https://www.xiaoflow.com/mcp).

---

### Claude Desktop Setup

Add the following entry to your `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "xiaoflow": {
      "command": "npx",
      "args": ["-y", "xiaoflow-mcp-server"],
      "env": {
        "XIAOFLOW_API_KEY": "YOUR_API_KEY"
      }
    }
  }
}
```

---

### Windsurf, VS Code, and other remote clients

Use native HTTP configuration where available:

```json
{
  "mcpServers": {
    "xiaoflow": {
      "type": "http",
      "url": "https://mcp.xiaoflow.com/mcp"
    }
  }
}
```

For stdio-only clients, bridge to the OAuth-enabled remote endpoint:

```json
{
  "mcpServers": {
    "xiaoflow": {
      "command": "npx",
      "args": ["-y", "mcp-remote", "https://mcp.xiaoflow.com/mcp"]
    }
  }
}
```

---

## 🛠️ Available MCP Tools

| MCP Tool | Description | Key Input Parameters |
| :--- | :--- | :--- |
| `get_keyword_metrics` | Exact metrics and monthly history for one keyword | `keyword`, `history_months` (1–48), `location`, `language` |
| `get_related_keywords` | Related keywords with metrics/history and unlimited pagination | `seed`, `history_months`, `page`, `page_size` (max 1,000) |
| `bulk_keyword_metrics` | Complete exact metrics, automatically batched in groups of 1,000 | `keywords`, `with_history` (default false), `history_months`, `location`, `language` |
| `start_keyword_expansion` | Start round-based expansion from one or more seeds | `seeds`, `max_iterations`, include/exclude rules |
| `get_keyword_expansion_status` | Poll an expansion task and retrieve results | `task_id`, `include_results` |
| `analyze_url` | Analyze page or domain search visibility | `url`, `site`, `brand`, `location`, `language` |
| `get_domain_stats` | Overview search metrics & traffic trends for a domain | `domain`, `brand` (required: `0`=domain, `1`=brand) |
| `list_domain_keywords` | Retrieve paginated list of domain keywords | `domain`, `brand`, `page`, `page_size` |
| `get_keyword_details` | Retrieve keyword metrics for a 12, 24, or 48 month window | `slug`, `time_range`, `location`, `language` |


Every tool publishes:

- descriptions for every input parameter;
- a named JSON output schema, including success and error fields;
- MCP safety annotations (`readOnlyHint`, `destructiveHint`, `idempotentHint`, and `openWorldHint`);
- a human-readable tool title for MCP clients and directories.

## Example prompts

```text
Get US English metrics and 24 months of history for "AI SEO tools".
```

```text
Find every related keyword for "standing desk", 200 per page, and continue
until has_more is false. Return search volume, CPC, competition, intent, and history.
```

```text
Compare these 1,000 keywords over 48 months and rank them by search volume growth.
```

```text
Expand "home office" for four rounds, keep terms with at least 100 monthly
searches, and poll the task until it is complete.
```

---

## 🔑 Authentication

Obtain your API key from the [XiaoFlow MCP Dashboard](https://www.xiaoflow.com/mcp).

Supported authentication methods:

1. **Web Login OAuth (recommended)**: connect to `https://mcp.xiaoflow.com/mcp`; compatible clients discover OAuth, PKCE, and dynamic client registration automatically.
2. **Environment Variable**: set `XIAOFLOW_API_KEY` when running via `npx`.
3. **Authorization Header**: send `Authorization: Bearer YOUR_API_KEY`.
4. **Legacy Query Parameter**: append `?key=YOUR_API_KEY` to the legacy SSE URL.

## 🐳 Docker / Glama

The repository includes a production multi-stage `Dockerfile` for directory
build verification and stdio deployment:

```bash
docker build -t xiaoflow-mcp .
docker run --rm -i \
  -e XIAOFLOW_API_KEY="YOUR_API_KEY" \
  xiaoflow-mcp
```

The image runs as the unprivileged Node user, excludes local secrets and build
state, and writes MCP protocol messages only to stdout.

## 🔐 Security and data handling

- OAuth login occurs only on `www.xiaoflow.com`; MCP clients never receive your password.
- API keys and OAuth tokens are sent only to the configured XiaoFlow API endpoint.
- The server does not scan or upload project files.
- Tool calls query external XiaoFlow/Google Ads-backed data and may consume account credits.
- No tool deletes or modifies keyword or domain data.

Report vulnerabilities privately through the repository owner or the
[XiaoFlow contact page](https://www.xiaoflow.com/contact). Do not include tokens
or customer data in public issues.

## ✅ Quality and compatibility

- MCP protocol: Streamable HTTP and stdio
- Authentication: OAuth 2.1 with PKCE, Bearer API key
- Tool schemas: parameter descriptions, structured output schemas, annotations
- Optional discovery methods: resources and prompts return valid empty lists
- Runtime: Node.js 18+ (`node:20-alpine` in Docker)
- Continuous endpoint: `https://mcp.xiaoflow.com/mcp`

---

## 📄 License

MIT © [XiaoFlow](https://www.xiaoflow.com)

### Complete bulk results and files

`bulk_keyword_metrics` return all queried rows (up to 1,000 per request), rather than a 12-row report preview. Hosted MCP responses include CSV and JSON resource links plus `structuredContent.exports`. Download links are unguessable, valid for 24 hours, and return an attachment without requiring a separate API query. Historical trends are disabled by default; set `with_history: true` to request them. CSV contains the requested keyword metrics; JSON preserves the entire original result. Save the download itself to keep every row, regardless of the chat client's display limits.

The stdio server returns the full structured result and embedded `text/csv` and `application/json` resources, which clients can save locally. A remote MCP server cannot choose a path on your computer; the client saves the downloaded/resource file at your chosen location.

Regression checks: `npm run build && node --test tests/keyword-export.test.mjs`. To exercise hosted export storage and downloads locally, run Wrangler on port 8799 with `XIAOFLOW_API_URL=http://127.0.0.1:8899`, then `node tests/worker-export.integration.mjs`.

MCP results are now raw JSON, without chart images or dashboard widgets. Bulk
metrics have no MCP total-keyword ceiling: requests are split into API batches,
and discovery/domain keyword listings follow every reported result page.
Exports preserve all rows, monthly histories and additional metric fields. The
previous 8 MB export cap is removed. Upstream data availability, account credits
and platform transport/storage limits still apply; these are not silently bypassed.
