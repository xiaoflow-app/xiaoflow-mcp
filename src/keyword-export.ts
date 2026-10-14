/** Full query exports, independent of the chat client's display limits. */
export function keywordRows(data: any): Record<string, any>[] {
  if (Array.isArray(data)) return data;
  if (Array.isArray(data?.data)) return data.data;
  if (Array.isArray(data?.results)) return data.results;
  return [];
}
function csvCell(value: unknown): string {
  let text = value == null ? '' : typeof value === 'object' ? JSON.stringify(value) : String(value);
  // Quoting alone does not stop spreadsheet formula execution.
  if (typeof value === 'string' && /^[\s]*[=+\-@\t\r]/.test(text)) text = "'" + text;
  return '"' + text.replace(/"/g, '""') + '"';
}
export function keywordExport(data: unknown, toolName: string) {
  const rows = keywordRows(data);
  const columns = ['keyword','search_volume','top_of_page_bid_low','top_of_page_bid_high','competition','competition_index','yoy_growth_percent','history'];
  const aliases: Record<string,string> = { keyword:'k',search_volume:'v',top_of_page_bid_low:'l',top_of_page_bid_high:'h',competition:'co',competition_index:'i',yoy_growth_percent:'y',history:'t' };
  for (const row of rows) for (const key of Object.keys(row)) if (!columns.includes(key) && !Object.values(aliases).includes(key)) columns.push(key);
  const csv = '\uFEFF' + [columns.map(csvCell).join(','), ...rows.map(row => columns.map(column => csvCell(row[column] ?? row[aliases[column]])).join(','))].join('\r\n') + '\r\n';
  const json = JSON.stringify({ tool:toolName,row_count:rows.length,result:data }, null, 2);
  return { csv, json, rowCount: rows.length };
}
export function inlineExportResources(data: unknown, toolName: string) {
  const file = keywordExport(data, toolName);
  return ([['csv',file.csv,'text/csv'],['json',file.json,'application/json']] as const).map(([extension,text,mimeType]) => ({ type:'resource' as const, resource:{ uri:`xiaoflow://exports/${toolName}.${extension}`,mimeType,text } }));
}
