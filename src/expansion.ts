export type ExpansionArgs = Record<string, unknown>;

export function parseSeedList(args: ExpansionArgs): string[] {
  const raw = args.seeds ?? args.seed ?? args.keyword ?? [];
  const list = Array.isArray(raw) ? raw : [raw];
  return list.map((item) => String(item || "").trim()).filter(Boolean);
}

export function parseSeedsField(raw: unknown): string[] {
  if (Array.isArray(raw)) {
    return raw.map((item) => String(item || "").trim()).filter(Boolean);
  }
  if (typeof raw === "string" && raw.trim() !== "") {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        return parseSeedsField(parsed);
      }
    } catch {
      return [raw.trim()];
    }
  }
  return [];
}

export function progressPercent(progress: unknown, fallback = 0): number {
  if (typeof progress === "number" && Number.isFinite(progress)) {
    return Math.max(0, Math.min(100, progress));
  }
  if (progress && typeof progress === "object" && "percent" in progress) {
    const value = Number((progress as { percent?: unknown }).percent);
    if (Number.isFinite(value)) {
      return Math.max(0, Math.min(100, value));
    }
  }
  return fallback;
}

export function axiosErrorMessage(err: unknown, fallback: string): string {
  const anyErr = err as {
    response?: { status?: number; data?: { error?: string; message?: string } };
    message?: string;
  };
  const status = anyErr?.response?.status;
  const fromBody = anyErr?.response?.data?.error || anyErr?.response?.data?.message;
  if (status === 401) return "Sign in with your XiaoFlow account to start or poll expansion tasks.";
  if (status === 404) return fromBody || "Expansion task not found.";
  return String(fromBody || anyErr?.message || fallback);
}

export function expansionStartPayload(args: ExpansionArgs, seeds: string[]): Record<string, unknown> {
  return {
    seeds,
    max_iterations: Number(args.max_iterations) || Number(args.rounds) || 5,
    min_search_volume: Number(args.min_search_volume ?? 0),
    location_id: Number(args.location_id) || 2840,
    language_id: Number(args.language_id) || 1000,
    include_rules: Array.isArray(args.include_rules) ? args.include_rules : [],
    exclude_rules: Array.isArray(args.exclude_rules) ? args.exclude_rules : [],
  };
}

export function normalizeStartedTask(data: Record<string, unknown> | undefined, seeds: string[]): Record<string, unknown> | null {
  const nested = (data?.data && typeof data.data === "object") ? data.data as Record<string, unknown> : {};
  const taskId = data?.task_id ?? data?.taskId ?? nested.task_id ?? nested.taskId ?? nested.id;
  if (taskId === undefined || taskId === null || taskId === "") {
    return null;
  }
  return {
    success: true,
    task_id: Number(taskId) || taskId,
    status: String(data?.status || nested.status || "pending"),
    progress: 0,
    seeds,
    keywords_count: 0,
    url: `https://www.xiaoflow.com/user/discovery?task=${taskId}`,
    mode: "background_task",
    next_action: `Call get_keyword_expansion_status with task_id=${taskId} until status is completed, processed, or failed. Do not reprint keyword rows in chat — download CSV/JSON when the status tool returns exports.`,
  };
}

/** Compact status only — never attach full result rows (use exports instead). */
export function normalizeExpansionStatus(
  task: Record<string, unknown>,
  taskId: number,
  _includeResults = false,
): Record<string, unknown> {
  const progress = task.progress;
  const progressObj = progress && typeof progress === "object" ? progress as Record<string, unknown> : {};
  const status = String(task.status || "pending");
  const payload: Record<string, unknown> = {
    success: true,
    mode: "background_task",
    task_id: Number(task.id ?? taskId),
    status,
    progress: progressPercent(progress, 0),
    seeds: parseSeedsField(task.seeds),
    keywords_count: Number(task.found_keywords_count ?? progressObj.keywords_found ?? 0),
    current_depth: progressObj.current_depth ?? null,
    max_iterations: progressObj.max_iterations ?? null,
    pending_count: task.pending_count ?? progressObj.pending_count ?? 0,
    processed_count: task.processed_count ?? progressObj.processed_count ?? 0,
    results_total: task.results_total ?? task.found_keywords_count ?? 0,
    results_truncated: Boolean(task.results_truncated),
    url: `https://www.xiaoflow.com/user/discovery?task=${task.id ?? taskId}`,
  };
  if (task.error) {
    payload.error = task.error;
  }
  return payload;
}
