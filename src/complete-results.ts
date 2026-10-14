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
  for (let i=0;i<keywords.length;i+=1000) batches.push(await fetchBatch(keywords.slice(i,i+1000)));
  if (batches.length === 1) return batches[0];
  return {...batches[0],data:batches.flatMap(b=>b.data || b.results || []),requested:keywords.length,batches};
}
