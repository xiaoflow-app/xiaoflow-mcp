const quotaOutputSchema: JsonSchema = {
  type: "object",
  description: "User account credit balance and quota limits.",
  properties: {
    success: { type: "boolean" },
    remaining: { type: "integer", description: "Remaining compute units (CU)." },
    credits: { type: "integer", description: "Current credits balance." },
    used: { type: "integer", description: "Used compute units." },
    limit: { type: "integer", description: "Daily limit." },
    type: { type: "string", description: "User tier type." },
  },
  additionalProperties: true,
};

type JsonSchema = Record<string, unknown>;
type ToolDefinition = {
  name: string;
  title?: string;
  description: string;
  inputSchema: {
    type: "object";
    properties?: Record<string, JsonSchema>;
    required?: string[];
  };
  outputSchema?: JsonSchema;
  annotations?: {
    title?: string;
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
    idempotentHint?: boolean;
    openWorldHint?: boolean;
  };
};

const PARAMETER_DESCRIPTIONS: Record<string, string> = {
  keyword: "Exact keyword or seed phrase to research.",
  keywords: "Keywords to analyze. Pass up to 2,000 keywords in a single call without manual batching (larger lists become background tasks).",
  min_volume: "Optional minimum monthly search volume for summary filtering.",
  max_volume: "Optional maximum monthly search volume for low-volume filter hits.",
  preview_limit: "How many preview rows to include in the chat summary (default 15, max 50). Full list is in downloads.",
  force_async: "When true, always create a background bulk-lookup task.",
  seed: "Seed keyword used to discover related search terms.",
  seeds: "One to 20 seed keywords used as expansion starting points.",
  url: "Fully qualified page URL used as a keyword discovery seed.",
  site: "Root domain used for site-wide keyword discovery.",
  domain: "Normalized domain name without a path, for example example.com.",
  slug: "URL-safe keyword slug returned by a XiaoFlow keyword result.",
  brand: "Set to 0 for domain data or 1 for brand-focused data.",
  location: "Google Ads geo target ID or ISO country code, for example 2840 or US.",
  language: "Google Ads language ID or language code, for example 1000 or en.",
  location_id: "Google Ads numeric geo target ID; 2840 represents the United States.",
  language_id: "Google Ads numeric language ID; 1000 represents English.",
  history_months: "Number of monthly history points to return, from 1 through 48.",
  time_range: "Historical window to return: 12m, 24m, or 48m.",
  page: "One-based result page number (up to 1,000 keywords per page).",
  page_size: "Number of results per page (up to 1,000 keywords).",
  all_pages: "When true, automatically fetch all result pages if task has <= 2,000 rows.",
  force: "When true, request a live refresh instead of relying only on cached data.",
  max_iterations: "Maximum breadth-first expansion rounds, from 1 through 10.",
  min_search_volume: "Exclude discovered keywords below this monthly search volume.",
  include_rules: "Optional text rules; results must match at least one supplied rule.",
  exclude_rules: "Optional text rules; matching results are removed.",
  task_id: "Numeric task identifier returned by start_keyword_expansion or bulk_keyword_metrics.",
  include_results: "When true, include discovered keyword objects in the structured response.",
  live: "When true, nudge background task runner and return current progress / discovered keywords.",
};

const TITLES: Record<string, string> = {
  get_keyword_metrics: "Get Keyword Metrics",
  get_related_keywords: "Get Related Keywords",
  bulk_keyword_metrics: "Get Bulk Keyword Metrics",
  get_bulk_keyword_lookup_status: "Get Bulk Keyword Lookup Status",
  start_keyword_expansion: "Start Keyword Expansion",
  get_keyword_expansion_status: "Get Keyword Expansion Status",
  get_quota: "Get Account Balance & Quota",
  analyze_url: "Analyze URL or Site",
  get_domain_stats: "Get Domain Statistics",
  list_domain_keywords: "List Domain Keywords",
  get_keyword_details: "Get Keyword Details",
};

const historyPointSchema: JsonSchema = {
  type: "object",
  description: "Monthly historical search-volume observation.",
  properties: {
    year: { type: "integer", description: "Four-digit calendar year." },
    month: { type: "integer", minimum: 1, maximum: 12, description: "Calendar month number." },
    search_volume: { type: "integer", description: "Monthly search volume." },
  },
  required: ["year", "month", "search_volume"],
  additionalProperties: true,
};

const keywordSchema: JsonSchema = {
  type: "object",
  description: "Keyword metrics and optional monthly history.",
  properties: {
    keyword: { type: "string", description: "Keyword text." },
    slug: { type: "string", description: "URL-safe keyword identifier." },
    search_volume: { type: "integer", description: "Average monthly search volume." },
    competition_index: { type: "integer", description: "Paid-search competition index from 0 to 100." },
    competition: { type: "string", description: "Human-readable competition level." },
    top_of_page_bid_low: { type: "number", description: "Low top-of-page bid estimate." },
    top_of_page_bid_high: { type: "number", description: "High top-of-page bid estimate." },
    intent: { type: "string", description: "Inferred search intent." },
    history: { type: "array", description: "Monthly history in chronological order.", items: historyPointSchema },
  },
  required: ["keyword"],
  additionalProperties: true,
};

const keywordListOutput: JsonSchema = {
  type: "object",
  description: "Successful keyword result page.",
  properties: {
    success: { type: "boolean", description: "Whether the request completed successfully." },
    data: { type: "array", description: "Keyword results.", items: keywordSchema },
    total: { type: "integer", description: "Total known matching results." },
    page: { type: "integer", description: "Current one-based page." },
    next_page: { type: ["integer", "null"], description: "Next page number, or null when complete." },
    has_more: { type: "boolean", description: "Whether another result page is available." },
    error: { type: "string", description: "Human-readable error when success is false." },
    code: { type: "string", description: "Stable machine-readable error code." },
  },
  required: ["success"],
  additionalProperties: true,
};

const expansionStartOutput: JsonSchema = {
  type: "object",
  description: "Asynchronous keyword-expansion task creation result.",
  properties: {
    success: { type: "boolean", description: "Whether the task was accepted." },
    task_id: { type: "integer", description: "Task identifier used for polling." },
    status: { type: "string", description: "Initial task status." },
    error: { type: "string", description: "Human-readable error when task creation fails." },
  },
  required: ["success"],
  additionalProperties: true,
};

const expansionStatusOutput: JsonSchema = {
  type: "object",
  description: "Current state and discovered keyword results for an expansion task.",
  properties: {
    success: { type: "boolean", description: "Whether task status was retrieved." },
    task_id: { type: "integer", description: "Expansion task identifier." },
    status: { type: "string", description: "queued, running, completed, or failed." },
    progress: { type: "number", description: "Completion percentage from 0 to 100." },
    data: { type: "array", description: "Discovered keyword results.", items: keywordSchema },
    results: { type: "array", description: "Discovered keyword results (alias for data).", items: keywordSchema },
    total: { type: "integer", description: "Total discovered keywords." },
    page: { type: "integer", description: "Current result page number." },
    page_size: { type: "integer", description: "Results per page." },
    has_more: { type: "boolean", description: "Whether additional result pages exist." },
    error: { type: "string", description: "Task or request failure description." },
  },
  required: ["success"],
  additionalProperties: true,
};

const domainOutput: JsonSchema = {
  type: "object",
  description: "Domain visibility metrics or keyword results.",
  properties: {
    success: { type: "boolean", description: "Whether the request completed successfully." },
    domain: { type: "string", description: "Normalized domain name." },
    data: { description: "Domain metrics, trends, or keyword records.", oneOf: [{ type: "object" }, { type: "array", items: keywordSchema }] },
    total: { type: "integer", description: "Total matching domain keywords." },
    page: { type: "integer", description: "Current one-based page." },
    has_more: { type: "boolean", description: "Whether another page is available." },
    error: { type: "string", description: "Human-readable error when success is false." },
  },
  required: ["success"],
  additionalProperties: true,
};

const OUTPUT_SCHEMAS: Record<string, JsonSchema> = {
  get_keyword_metrics: keywordListOutput,
  get_related_keywords: keywordListOutput,
  bulk_keyword_metrics: keywordListOutput,
  get_bulk_keyword_lookup_status: keywordListOutput,
  start_keyword_expansion: expansionStartOutput,
  get_keyword_expansion_status: expansionStatusOutput,
  get_quota: quotaOutputSchema,
  analyze_url: domainOutput,
  get_domain_stats: domainOutput,
  list_domain_keywords: domainOutput,
  get_keyword_details: keywordListOutput,
};

export function enhanceTools(tools: ToolDefinition[]): ToolDefinition[] {
  return tools.map((tool) => {
    const properties = Object.fromEntries(
      Object.entries(tool.inputSchema.properties ?? {}).map(([name, schema]) => [
        name,
        {
          ...schema,
          description: schema.description ?? PARAMETER_DESCRIPTIONS[name] ?? `Value for ${name}.`,
        },
      ]),
    );
    const mutates = tool.name === "start_keyword_expansion" || tool.name === "bulk_keyword_metrics";
    const bulkCompact =
      tool.name === "bulk_keyword_metrics" ||
      tool.name === "get_bulk_keyword_lookup_status" ||
      tool.name === "start_keyword_expansion" ||
      tool.name === "get_keyword_expansion_status";
    const showKeywordUi = false;
    const widgetCsp = {
      connectDomains: ["https://api.xiaoflow.com", "https://mcp.xiaoflow.com", "https://www.xiaoflow.com"],
      resourceDomains: ["https://quickchart.io", "https://www.xiaoflow.com", "https://mcp.xiaoflow.com", "https://fonts.gstatic.com"],
    };

    return {
      ...tool,
      title: TITLES[tool.name] ?? tool.name,
      _meta: showKeywordUi
        ? {
            ui: {
              resourceUri: "ui://xiaoflow/keyword-dashboard-v3",
              csp: widgetCsp,
            },
            "openai/widgetCSP": {
              connect_domains: widgetCsp.connectDomains,
              resource_domains: widgetCsp.resourceDomains,
            },
            "openai/outputTemplate": "ui://xiaoflow/keyword-dashboard-v3",
          }
        : {},
      description: bulkCompact
        ? tool.description
        : tool.description + " Returns complete raw JSON data with all returned rows and fields, without charts or dashboard formatting. Keyword discovery automatically fetches all result pages. Preserve every row and history value; use CSV/JSON resources to save results instead of reconstructing a chat preview.",
      inputSchema: { ...tool.inputSchema, properties },
      outputSchema: { type:"object", additionalProperties:true },
      annotations: {
        title: TITLES[tool.name] ?? tool.name,
        readOnlyHint: !mutates,
        destructiveHint: false,
        idempotentHint: !mutates,
        openWorldHint: true,
      },

    };
  });
}

export const SERVER_INFO = {
  name: "xiaoflow-mcp-server",
  title: "XiaoFlow Keyword Intelligence",
  version: "1.3.1",
  description: "Research keyword metrics, related terms, monthly trends, expansion opportunities, and domain search visibility with XiaoFlow.",
  websiteUrl: "https://www.xiaoflow.com/mcp",
  icon: "https://mcp.xiaoflow.com/icon.png",
  logoUrl: "https://mcp.xiaoflow.com/icon.png",
  logo_url: "https://mcp.xiaoflow.com/icon.png",
  icons: [
    {
      src: "https://mcp.xiaoflow.com/icon.png",
      mimeType: "image/png",
      sizes: ["256x256"],
    },
    {
      src: "https://www.xiaoflow.com/icon.png",
      mimeType: "image/png",
      sizes: ["256x256"],
    },
  ],
};
