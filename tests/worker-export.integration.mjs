import http from 'node:http';
import assert from 'node:assert/strict';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
const rows=Array.from({length:1500},(_,i)=>({keyword:`关键词 ${i}`,search_volume:i,history:Array.from({length:48},(_,m)=>({y:2023+Math.floor(m/12),m:m%12+1,v:i+m}))}));
const server=http.createServer(async (req,res)=>{
  let body="";for await(const chunk of req)body+=chunk;
  const payload=body?JSON.parse(body):{};
  res.setHeader('Content-Type','application/json');
  if(req.url==='/api/v1/user'){res.end(JSON.stringify({user:{id:1,email:'fixture@example.test'}}));return;}
  if(String(req.url).includes('/bulk-lookup/tasks') && req.method==='POST'){
    res.statusCode=202;res.end(JSON.stringify({success:true,task_id:7,status:'pending'}));return;
  }
  const keywords=payload.keywords;
  const selected=keywords?rows.filter(r=>keywords.includes(r.keyword)):rows;
  res.end(JSON.stringify({success:true,data:payload.with_history?selected:selected.map(({history,...base})=>base)}));
});
await new Promise(resolve=>server.listen(8899,'127.0.0.1',resolve));
const client=new Client({name:'worker-export-test',version:'1'});
try {
 await client.connect(new StreamableHTTPClientTransport(new URL('http://127.0.0.1:8799/mcp'),{requestInit:{headers:{Authorization:'Bearer fixture'}}}));
 const listed=await client.listTools();
 assert.equal(listed.tools.find(t=>t.name==='bulk_keyword_metrics').inputSchema.properties.keywords.maxItems,undefined);
 assert.ok(listed.tools.some(t=>t.name==='get_bulk_keyword_lookup_status'));
 assert.equal((await client.listResources()).resources.length,0);
 for(const name of ['bulk_keyword_metrics']) {
  assert.equal(listed.tools.find(t=>t.name===name).inputSchema.properties.with_history.default,false);
  const compact=await client.callTool({name,arguments:{keywords:['关键词 0']}});
  assert.equal(compact.structuredContent.mode,'summary_with_exports');
  assert.equal(compact.structuredContent.row_count,1);
  assert.match(compact.content[0].text,/Rows \| \*\*1\*\*/);

  const result=await client.callTool({name,arguments:{keywords:rows.map(r=>r.keyword),with_history:true,history_months:48}});
  assert.equal(result.isError,undefined);
  assert.equal(result.structuredContent.mode,'summary_with_exports');
  assert.equal(result.structuredContent.row_count,1500);
  assert.ok(result.content[0].text.length < 20_000);
  const exports=result.structuredContent.exports;assert.equal(exports.length,2);
  for(const file of exports) {
   const url=file.url.replace('https://mcp.xiaoflow.com','http://127.0.0.1:8799');
   const response=await fetch(url);assert.equal(response.status,200);assert.match(response.headers.get('content-disposition'),/attachment/);
   const content=await response.text();
   if(file.format==='json') assert.deepEqual(JSON.parse(content).result.data,rows);
   else assert.equal(content.trim().split('\r\n').length,1501);
   const head=await fetch(url,{method:'HEAD'});assert.equal(head.status,200);assert.equal(await head.text(),'');
   const bad=await fetch(url.replace(/\/([a-f0-9]{64})\.(csv|json)$/, '/'+ '0'.repeat(64)+'.$2'));assert.equal(bad.status,404);
  }

  const asyncKick=await client.callTool({name,arguments:{keywords:Array.from({length:2001},(_,i)=>`extra ${i}`),force_async:true}});
  assert.equal(asyncKick.structuredContent.mode,'background_task');
  assert.equal(asyncKick.structuredContent.task_id,7);
 }
 assert.equal((await fetch('http://127.0.0.1:8799/__store_export',{method:'POST',body:'{}'})).status,404);
 console.log(JSON.stringify({workerBulkTools:1,rowsPerTool:1500,historyMonths:48,compactSummary:true,fullCsvAndJson:true,backgroundTask:true,unguessableDownloads:true}));
} finally {await client.close();await new Promise(resolve=>server.close(resolve));}
