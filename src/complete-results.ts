/** Fetch all API pages and batches without a presentation or total-row ceiling. */
export async function completePages(fetchPage: (page: number) => Promise<any>, start = 1): Promise<any> {
  const first = await fetchPage(start);
  if (!Array.isArray(first?.data)) return first;
  const rows = [...first.data];
  let current = first;
  let page = start;
  while (Number(current.page || page) * Number(current.per_page || current.page_size || 0) < Number(current.total || 0)) {
    current = await fetchPage(++page);
    if (!Array.isArray(current?.data) || !current.data.length) throw new Error('The API stopped before all result pages were returned. Retry to obtain the complete result.');
    rows.push(...current.data);
  }
  return {...first, data:rows, returned:rows.length, pages_fetched:page-start+1};
}
export async function completeMetrics(keywords: unknown[], fetchBatch: (keywords: unknown[]) => Promise<any>): Promise<any> {
  if (!keywords.length) throw new Error('keywords must contain at least one item');
  const batches = [];
  for (let i = 0; i < keywords.length; i += 1000) {
    let res = await fetchBatch(keywords.slice(i, i + 1000));

    // If some keywords were temporarily rate-limited or unresolved, retry those specific keywords once after a brief pause
    if (res?.unresolved_count > 0 && Array.isArray(res?.data)) {
      const unresolvedKws = res.data
        .filter((row: any) => row?.unresolved === true || row?.status === 'unresolved' || row?.v === null)
        .map((row: any) => row?.k || row?.keyword)
        .filter(Boolean);

      if (unresolvedKws.length > 0 && unresolvedKws.length <= 200) {
        try {
          await new Promise((resolve) => setTimeout(resolve, 3000));
          const retryRes = await fetchBatch(unresolvedKws);
          if (Array.isArray(retryRes?.data)) {
            const retryMap = new Map<string, any>(
              retryRes.data.map((r: any) => [String(r?.k || r?.keyword || '').toLowerCase().trim(), r])
            );
            res.data = res.data.map((r: any) => {
              const k = String(r?.k || r?.keyword || '').toLowerCase().trim();
              const hit = retryMap.get(k);
              return (hit && !hit.unresolved && hit.status !== 'unresolved' && hit.v !== null) ? hit : r;
            });
            res.unresolved_count = res.data.filter(
              (r: any) => r?.unresolved === true || r?.status === 'unresolved' || r?.v === null
            ).length;
          }
        } catch {
          // Keep initial response if retry errors
        }
      }
    }

    batches.push(res);
  }
  if (batches.length === 1) return batches[0];
  return {
    ...batches[0],
    data: batches.flatMap(b => b.data || b.results || []),
    requested: keywords.length,
    unresolved_count: batches.reduce((sum, b) => sum + (Number(b?.unresolved_count) || 0), 0),
    batches,
  };
}
