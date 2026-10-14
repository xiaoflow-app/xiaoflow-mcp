import {test} from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {keywordExport} from '../build/keyword-export.js';
import {formatXiaoFlowReport} from '../build/format-report.js';
const rows = Array.from({length:1000},(_,i)=>({keyword:`keyword ${i}`,search_volume:i,top_of_page_bid_low:0.1,top_of_page_bid_high:1.4,history:[{y:2026,m:10,v:i}]}));
test('all 1000 rows and histories are kept in the report and exports',()=>{
 const data={success:true,data:rows}; const file=keywordExport(data,'bulk_keyword_metrics');
 assert.equal(file.rowCount,1000); assert.equal(file.csv.trim().split('\r\n').length,1001);
 assert.equal(JSON.parse(file.json).result.data[999].history[0].v,999);
 assert.match(formatXiaoFlowReport(data,'bulk_keyword_metrics'),/keyword 999/);
 assert.doesNotMatch(formatXiaoFlowReport(data,'bulk_keyword_metrics'),/Top 12/);
});
test('CSV escapes quotes/newlines and neutralizes spreadsheet formulas',()=>{
 const csv=keywordExport({data:[{keyword:'=HYPERLINK("bad")'},{keyword:'a,b\n"c"'}]},'bulk_keyword_lookup').csv;
 assert.match(csv,/"'=HYPERLINK\(""bad""\)"/); assert.match(csv,/"a,b\n""c"""/);
});
test('stdio bulk tools deliver every row plus saveable CSV and JSON resources', async()=>{
 const server=http.createServer((req,res)=>{res.setHeader('Content-Type','application/json');res.end(JSON.stringify({success:true,data:rows.slice(0,25)}));});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const transport=new StdioClientTransport({command:process.execPath,args:['build/node.js'],env:{...process.env,XIAOFLOW_API_KEY:'fixture',XIAOFLOW_API_URL:`http://127.0.0.1:${server.address().port}`},stderr:'pipe'});
 const client=new Client({name:'export-test',version:'1'});
 try {
  await client.connect(transport);
  const registry=await client.listTools();assert(!registry.tools.some(t=>['discover_keywords','bulk_keyword_lookup'].includes(t.name)));
  for(const name of ['bulk_keyword_metrics']) {
   const result=await client.callTool({name,arguments:{keywords:rows.slice(0,25).map(r=>r.keyword)}});
   assert.equal(result.isError,undefined);assert.equal(result.structuredContent.data.length,25);
   const files=result.content.filter(c=>c.type==='resource'); assert.equal(files.length,2);
   assert.equal(files[0].resource.text.trim().split('\r\n').length,26);
   assert.equal(JSON.parse(files[1].resource.text).row_count,25);
  }
 } finally {await client.close(); await new Promise(resolve=>server.close(resolve));}
});
test('stdio bulk metrics omit monthly history by default and accept explicit opt-in',async()=>{
 const bodies=[];const server=http.createServer(async(req,res)=>{let raw='';for await(const c of req)raw+=c;const body=JSON.parse(raw||'{}');bodies.push(body);res.setHeader('Content-Type','application/json');res.end(JSON.stringify({success:true,data:body.keywords.map(keyword=>({keyword,search_volume:10,...(body.with_history?{history:[{y:2026,m:10,v:10}]}:{})}))}));});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const client=new Client({name:'history-default-test',version:'1'});
 try{await client.connect(new StdioClientTransport({command:process.execPath,args:['build/node.js'],env:{...process.env,XIAOFLOW_API_KEY:'fixture',XIAOFLOW_API_URL:`http://127.0.0.1:${server.address().port}`},stderr:'pipe'}));
 const listed=await client.listTools();for(const name of ['bulk_keyword_metrics']){
  assert.equal(listed.tools.find(t=>t.name===name).inputSchema.properties.with_history.default,false);
  let result=await client.callTool({name,arguments:{keywords:['one'],history_months:48}});assert.equal(bodies.at(-1).with_history,false);assert.equal(bodies.at(-1).historical,false);assert.equal(result.structuredContent.data[0].history,undefined);
  result=await client.callTool({name,arguments:{keywords:['one'],with_history:true,history_months:48}});assert.equal(bodies.at(-1).with_history,true);assert.equal(result.structuredContent.data[0].history.length,1);
 }
 }finally{await client.close();await new Promise(resolve=>server.close(resolve));}
});
