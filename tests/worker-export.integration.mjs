import http from 'node:http';
import assert from 'node:assert/strict';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
const rows=Array.from({length:2505},(_,i)=>({keyword:`关键词 ${i}`,search_volume:i,history:Array.from({length:48},(_,m)=>({y:2023+Math.floor(m/12),m:m%12+1,v:i+m}))}));
const server=http.createServer(async (req,res)=>{let body="";for await(const chunk of req)body+=chunk;const payload=body?JSON.parse(body):{};const keywords=payload.keywords;const selected=keywords?rows.filter(r=>keywords.includes(r.keyword)):rows;res.setHeader('Content-Type','application/json');res.end(JSON.stringify(req.url==='/api/v1/user'?{user:{id:1,email:'fixture@example.test'}}:{success:true,data:payload.with_history?selected:selected.map(({history,...base})=>base)}));});
await new Promise(resolve=>server.listen(8899,'127.0.0.1',resolve));
const client=new Client({name:'worker-export-test',version:'1'});
try {
 await client.connect(new StreamableHTTPClientTransport(new URL('http://127.0.0.1:8799/mcp'),{requestInit:{headers:{Authorization:'Bearer fixture'}}}));
 const listed=await client.listTools();assert.equal(listed.tools.find(t=>t.name==='bulk_keyword_metrics').inputSchema.properties.keywords.maxItems,undefined);assert.equal((await client.listResources()).resources.length,0);
 for(const name of ['bulk_keyword_metrics']) {
  assert.equal(listed.tools.find(t=>t.name===name).inputSchema.properties.with_history.default,false);
  const compact=await client.callTool({name,arguments:{keywords:['关键词 0']}});assert.equal(compact.structuredContent.data[0].history,undefined);

  const result=await client.callTool({name,arguments:{keywords:rows.map(r=>r.keyword),with_history:true,history_months:48}});
  assert.equal(result.isError,undefined);assert.equal(result.structuredContent.row_count,2505);
  assert.deepEqual(JSON.parse(result.content[0].text),result.structuredContent);assert.equal(result._meta?.['openai/outputTemplate'],undefined);
 const exports=result.structuredContent.exports;assert.equal(exports.length,2);
  for(const file of exports) {
   const url=file.url.replace('https://mcp.xiaoflow.com','http://127.0.0.1:8799');
   const response=await fetch(url);assert.equal(response.status,200);assert.match(response.headers.get('content-disposition'),/attachment/);
   const content=await response.text();
   if(file.format==='json') assert.deepEqual(JSON.parse(content).result.data,rows);
   else assert.equal(content.trim().split('\r\n').length,2506);
   const head=await fetch(url,{method:'HEAD'});assert.equal(head.status,200);assert.equal(await head.text(),'');
   const bad=await fetch(url.replace(/\/([a-f0-9]{64})\.(csv|json)$/, '/'+ '0'.repeat(64)+'.$2'));assert.equal(bad.status,404);
  }
 }
 assert.equal((await fetch('http://127.0.0.1:8799/__store_export',{method:'POST',body:'{}'})).status,404);
 console.log(JSON.stringify({workerBulkTools:1,rowsPerTool:2505,historyMonths:48,fullCsvAndJson:true,unguessableDownloads:true}));
} finally {await client.close();await new Promise(resolve=>server.close(resolve));}
