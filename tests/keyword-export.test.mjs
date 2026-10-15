import {test} from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
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
test('stdio bulk tools return compact summary and write CSV/JSON to disk', async()=>{
 const exportDir=fs.mkdtempSync(path.join(os.tmpdir(),'xiaoflow-mcp-test-'));
 const server=http.createServer((req,res)=>{res.setHeader('Content-Type','application/json');res.end(JSON.stringify({success:true,data:rows.slice(0,25)}));});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const transport=new StdioClientTransport({command:process.execPath,args:['build/node.js'],env:{...process.env,XIAOFLOW_API_KEY:'fixture',XIAOFLOW_API_URL:`http://127.0.0.1:${server.address().port}`,XIAOFLOW_EXPORT_DIR:exportDir},stderr:'pipe'});
 const client=new Client({name:'export-test',version:'1'});
 try {
  await client.connect(transport);
  const registry=await client.listTools();assert(!registry.tools.some(t=>['discover_keywords','bulk_keyword_lookup'].includes(t.name)));
  assert.ok(registry.tools.some(t=>t.name==='get_bulk_keyword_lookup_status'));
  for(const name of ['bulk_keyword_metrics']) {
   const result=await client.callTool({name,arguments:{keywords:rows.slice(0,25).map(r=>r.keyword)}});
   assert.equal(result.isError,undefined);
   assert.equal(result.structuredContent.mode,'summary_with_exports');
   assert.equal(result.structuredContent.row_count,25);
   assert.ok(result.structuredContent.summary.preview.length<=20);
   assert.match(result.content[0].text,/Rows \| \*\*25\*\*/);
   assert.doesNotMatch(result.content[0].text,/"search_volume":24/);
   const exports=result.structuredContent.exports; assert.equal(exports.length,2);
   for(const file of exports){
    const filePath=file.url.replace(/^file:\/\//,'');
    assert.ok(fs.existsSync(filePath));
    if(file.format==='csv') assert.equal(fs.readFileSync(filePath,'utf8').trim().split('\r\n').length,26);
    else assert.equal(JSON.parse(fs.readFileSync(filePath,'utf8')).row_count,25);
   }
  }
 } finally {await client.close(); await new Promise(resolve=>server.close(resolve)); fs.rmSync(exportDir,{recursive:true,force:true});}
});
test('stdio bulk metrics omit monthly history by default and accept explicit opt-in',async()=>{
 const bodies=[];const server=http.createServer(async(req,res)=>{let raw='';for await(const c of req)raw+=c;const body=JSON.parse(raw||'{}');bodies.push(body);res.setHeader('Content-Type','application/json');res.end(JSON.stringify({success:true,data:body.keywords.map(keyword=>({keyword,search_volume:10,...(body.with_history?{history:[{y:2026,m:10,v:10}]}:{})}))}));});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const client=new Client({name:'history-default-test',version:'1'});
 const exportDir=fs.mkdtempSync(path.join(os.tmpdir(),'xiaoflow-mcp-hist-'));
 try{await client.connect(new StdioClientTransport({command:process.execPath,args:['build/node.js'],env:{...process.env,XIAOFLOW_API_KEY:'fixture',XIAOFLOW_API_URL:`http://127.0.0.1:${server.address().port}`,XIAOFLOW_EXPORT_DIR:exportDir},stderr:'pipe'}));
 const listed=await client.listTools();for(const name of ['bulk_keyword_metrics']){
  assert.equal(listed.tools.find(t=>t.name===name).inputSchema.properties.with_history.default,false);
  let result=await client.callTool({name,arguments:{keywords:['one'],history_months:48}});assert.equal(bodies.at(-1).with_history,false);assert.equal(bodies.at(-1).historical,false);assert.equal(result.structuredContent.mode,'summary_with_exports');
  const jsonPath=result.structuredContent.exports.find(f=>f.format==='json').url.replace(/^file:\/\//,'');
  assert.equal(JSON.parse(fs.readFileSync(jsonPath,'utf8')).result.data[0].history,undefined);
  result=await client.callTool({name,arguments:{keywords:['one'],with_history:true,history_months:48}});assert.equal(bodies.at(-1).with_history,true);assert.equal(JSON.parse(fs.readFileSync(result.structuredContent.exports.find(f=>f.format==='json').url.replace(/^file:\/\//,''),'utf8')).result.data[0].history.length,1);
 }
 }finally{await client.close();await new Promise(resolve=>server.close(resolve)); fs.rmSync(exportDir,{recursive:true,force:true});}
});
test('stdio bulk lists over sync limit create a background task', async()=>{
 const keywords=Array.from({length:2001},(_,i)=>`kw ${i}`);
 const server=http.createServer(async(req,res)=>{
  let raw='';for await(const c of req)raw+=c;
  res.setHeader('Content-Type','application/json');
  if(String(req.url).includes('/bulk-lookup/tasks') && req.method==='POST'){
   res.statusCode=202;res.end(JSON.stringify({success:true,task_id:99,status:'pending'}));return;
  }
  res.end(JSON.stringify({success:true,data:[]}));
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const client=new Client({name:'async-bulk-test',version:'1'});
 try{
  await client.connect(new StdioClientTransport({command:process.execPath,args:['build/node.js'],env:{...process.env,XIAOFLOW_API_KEY:'fixture',XIAOFLOW_API_URL:`http://127.0.0.1:${server.address().port}`},stderr:'pipe'}));
  const result=await client.callTool({name:'bulk_keyword_metrics',arguments:{keywords}});
  assert.equal(result.isError,undefined);
  assert.equal(result.structuredContent.mode,'background_task');
  assert.equal(result.structuredContent.task_id,99);
  assert.match(result.content[0].text,/get_bulk_keyword_lookup_status/);
 }finally{await client.close();await new Promise(resolve=>server.close(resolve));}
});
