function toSlug(s: string): string {
  return String(s || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "overview";
}

export function buildSparkline(history?: Array<{ v: number }>): string {
  if (!history || history.length === 0) return "";
  const values = history.map(h => h.v);
  const min = Math.min(...values);
  const max = Math.max(...values);
  if (max === min) return "▅".repeat(Math.min(values.length, 12));
  const chars = [" ", "▂", "▃", "▄", "▅", "▆", "▇", "█"];
  return values.map(v => {
    const idx = Math.min(chars.length - 1, Math.max(0, Math.floor(((v - min) / (max - min)) * (chars.length - 1))));
    return chars[idx];
  }).join("");
}

export function buildChartUrl(title: string, history?: Array<{ y: number; m: number; v: number }>): string {
  if (!history || history.length < 2) return "";
  const labels = history.map(h => `${h.y % 100}/${String(h.m).padStart(2, "0")}`);
  const data = history.map(h => h.v);
  const chartConfig = {
    type: "line",
    data: {
      labels,
      datasets: [
        {
          label: "Monthly Search Volume",
          data,
          borderColor: "#2563EB",
          backgroundColor: "rgba(37, 99, 235, 0.15)",
          borderWidth: 3,
          pointRadius: 4,
          pointBackgroundColor: "#2563EB",
          fill: true,
          tension: 0.35,
        },
      ],
    },
    options: {
      title: {
        display: true,
        text: `XiaoFlow • ${title} 48-Month Search Volume Trend`,
        fontColor: "#0F172A",
        fontSize: 13,
      },
      legend: { display: false },
      scales: {
        yAxes: [
          {
            ticks: {
              beginAtZero: false,
              fontColor: "#64748B",
              fontSize: 11,
              callback: (val: number) =>
                val >= 1000000
                  ? `${(val / 1000000).toFixed(1)}M`
                  : val >= 1000
                  ? `${(val / 1000).toFixed(0)}K`
                  : val,
            },
            gridLines: { color: "rgba(226, 232, 240, 0.8)" },
          },
        ],
        xAxes: [
          {
            ticks: { fontColor: "#64748B", fontSize: 11 },
            gridLines: { display: false },
          },
        ],
      },
    },
  };

  return `https://quickchart.io/chart?w=640&h=260&bkg=white&c=${encodeURIComponent(JSON.stringify(chartConfig))}`;
}

function formatExpansionReport(data: any): string {
  const tid = data.task_id ?? data.taskId ?? data.id ?? "—";
  const status = String(data.status || (data.success === false ? "failed" : "pending"));
  const progressRaw = data.progress;
  const progress = typeof progressRaw === "number"
    ? progressRaw
    : Number(progressRaw?.percent ?? 0);
  const count = data.keywords_count ?? data.found_keywords_count ?? (Array.isArray(data.results) ? data.results.length : 0);
  let seeds: unknown = data.seeds;
  if (typeof seeds === "string") {
    try {
      seeds = JSON.parse(seeds);
    } catch {
      // keep original string
    }
  }
  const seedsText = Array.isArray(seeds) ? seeds.join(", ") : (seeds || data.seed || "—");
  const depth = data.current_depth ?? data.progress?.current_depth;
  const maxIter = data.max_iterations ?? data.progress?.max_iterations;
  const pending = data.pending_count ?? data.progress?.pending_count;
  const processed = data.processed_count ?? data.progress?.processed_count;

  let report = `## 🚀 XiaoFlow 关键词拓词任务 (#${tid})\n\n` +
    `| 任务属性 | 状态与进度 |\n` +
    `| :--- | :--- |\n` +
    `| 📋 **任务编号** | \`#${tid}\` |\n` +
    `| 🌱 **种子关键词** | **${seedsText}** |\n` +
    `| ⚡ **执行状态** | **${status.toUpperCase()}** (${Number(progress) || 0}%) |\n` +
    `| 🔍 **已发现关键词** | **${count}** 个 |\n`;

  if (depth !== undefined && depth !== null || maxIter !== undefined && maxIter !== null) {
    report += `| 🔁 **拓展轮次** | **${depth ?? "—"} / ${maxIter ?? "—"}** |\n`;
  }
  if (pending !== undefined || processed !== undefined) {
    report += `| 📦 **队列进度** | 已处理 **${processed ?? 0}** / 待处理 **${pending ?? 0}** |\n`;
  }
  report += `\n`;

  if (data.error) {
    report += `> ⚠️ **错误**: ${data.error}\n\n`;
  }

  if (data.next_action) {
    report += `> 🔄 **下一步**: ${data.next_action}\n`;
  } else {
    report += `> 🔄 **轮询状态**: 调用 \`get_keyword_expansion_status(task_id=${tid})\` 直到 status 为 completed / processed / failed。未完成前不要把相关词列表当作拓词结果。\n`;
  }
  report += `> 🔗 [👉 前往 XiaoFlow 发现中心实时查看与导出](${data.url || "https://www.xiaoflow.com/user/discovery"})\n`;

  const results = Array.isArray(data.results) ? data.results : [];
  if (results.length > 0) {
    report += `\n### 🎯 本任务已发现关键词 (${results.length} rows)\n\n`;
    report += `| 关键词 (Keyword) | 月搜索量 | CPC 出价区间 | 竞争度 |\n`;
    report += `| :--- | :--- | :--- | :--- |\n`;
    results.forEach((kw: any) => {
      const name = kw.keyword || kw.k || "";
      const vol = (kw.search_volume ?? kw.v ?? 0).toLocaleString();
      const low = Number(kw.top_of_page_bid_low ?? kw.l ?? 0).toFixed(2);
      const high = Number(kw.top_of_page_bid_high ?? kw.h ?? 0).toFixed(2);
      const comp = kw.competition ?? kw.co ?? "—";
      report += `| **${name}** | \`${vol}\` | $${low} - $${high} | ${comp} |\n`;
    });
    report += `\n`;
  }

  return report;
}

function formatDomainKeywordsReport(data: any, toolName: string): string {
  const domain = data.domain?.domain ?? data.domain ?? data.site ?? "—";
  const total = Number(data.total ?? 0).toLocaleString();
  const page = Number(data.page ?? 1);
  const perPage = Number(data.per_page ?? 50);
  const traffic = Number(data.domain?.total_organic_traffic ?? 0).toLocaleString();
  const kwCount = Number(data.domain?.total_organic_keywords ?? 0).toLocaleString();
  const adSpend = Number(data.domain?.ad_spend ?? 0).toFixed(0);
  const yoy = Number(data.domain?.yoy_change ?? 0);
  const keywords: any[] = Array.isArray(data.data) ? data.data : [];

  let report = `## 🌐 XiaoFlow 域名关键词分析: **${domain}**\n\n`;

  // Domain overview stats (only if we have them)
  if (data.domain && (data.domain.total_organic_traffic > 0 || data.domain.total_organic_keywords > 0)) {
    report += `### 📊 域名概况\n`;
    report += `| 指标 | 数值 |\n`;
    report += `| :--- | :--- |\n`;
    report += `| 🔍 **自然流量 (Organic Traffic)** | **${traffic}** /月 |\n`;
    report += `| 🗝️ **关键词总数 (Total Keywords)** | **${kwCount}** |\n`;
    report += `| 💰 **广告花费估算 (Ad Spend)** | **$${adSpend}** |\n`;
    report += `| 📈 **年同比变化 (YoY)** | **${yoy > 0 ? "+" : ""}${yoy}%** |\n\n`;
  }

  // Traffic history sparkline
  const trafficHistory: any[] = Array.isArray(data.traffic_history) ? data.traffic_history : [];
  if (trafficHistory.length >= 2) {
    const vols = trafficHistory.map((h: any) => h.v ?? h.volume ?? 0);
    const min = Math.min(...vols);
    const max = Math.max(...vols);
    const chars = [" ", "▂", "▃", "▄", "▅", "▆", "▇", "█"];
    const spark = max === min
      ? "▅".repeat(Math.min(vols.length, 12))
      : vols.map((v: number) => {
          const idx = Math.min(chars.length - 1, Math.max(0, Math.floor(((v - min) / (max - min)) * (chars.length - 1))));
          return chars[idx];
        }).join("");
    report += `> 📈 **流量趋势 (Traffic Trend)**: \`${spark}\`\n\n`;
  }

  // Keywords table
  if (keywords.length > 0) {
    const showing = Math.min(keywords.length, 20);
    report += `### 🎯 关键词列表 (第 ${page} 页，显示 ${showing} / ${total} 条)\n\n`;
    report += `| 关键词 (Keyword) | 月搜索量 | CPC 区间 | 竞争度 | 趋势 |\n`;
    report += `| :--- | :--- | :--- | :--- | :--- |\n`;

    keywords.slice(0, 20).forEach((kw: any) => {
      const name = kw.keyword || kw.k || "";
      const vol = (kw.search_volume ?? kw.v ?? 0).toLocaleString();
      const low = Number(kw.top_of_page_bid_low ?? kw.l ?? 0).toFixed(2);
      const high = Number(kw.top_of_page_bid_high ?? kw.h ?? 0).toFixed(2);
      const comp = kw.competition ?? kw.co ?? "—";
      const spark = buildSparkline(kw.history ?? kw.t);
      report += `| **${name}** | \`${vol}\` | $${low} – $${high} | ${comp} | \`${spark || "—"}\` |\n`;
    });
    report += `\n`;

    if (Number(data.total ?? 0) > keywords.length) {
      report += `> 📌 共 **${total}** 条关键词，当前显示第 ${page} 页。可用 \`page\` 参数翻页。\n`;
    }
  } else {
    report += `> ⚠️ 暂无关键词数据，域名可能尚未被收录或正在更新中。\n`;
  }

  report += `> 💡 **数据来源**: XiaoFlow Enterprise Google Ads Intelligence API\n`;
  report += `> 🔗 [👉 在 XiaoFlow 官网查看 ${domain} 完整域名分析](https://www.xiaoflow.com/websites/us/en/${domain})\n`;

  return report;
}

/** Return the complete original data, without charts, KPI decoration or row previews. */
export function formatXiaoFlowReport(data: any, _toolName: string): string {
  return JSON.stringify(data, null, 2);
}
