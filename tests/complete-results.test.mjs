import test from 'node:test';
import assert from 'node:assert/strict';
import {completeMetrics,completePages} from '../build/complete-results.js';
import {formatXiaoFlowReport} from '../build/format-report.js';
import {keywordExport} from '../build/keyword-export.js';
test('more than 1000 requested keywords return all rows in sequential API batches',async()=>{
 const input=Array.from({length:2505},(_,i)=>`keyword ${i}`);const sizes=[];
 const data=await completeMetrics(input,async keywords=>{sizes.push(keywords.length);return {data:keywords.map(keyword=>({keyword,history:[{v:1}],extra_metric:42}))}});
 assert.deepEqual(sizes,[1000,1000,505]);assert.equal(data.data.length,2505);assert.equal(data.data[2504].keyword,'keyword 2504');
 const output=formatXiaoFlowReport(data,'bulk_keyword_metrics');assert.deepEqual(JSON.parse(output),data);assert.doesNotMatch(output,/quickchart|!\[|<svg|▁/);
 const csv=keywordExport(data,'bulk_keyword_metrics').csv;assert.match(csv,/extra_metric/);assert.equal(csv.trim().split('\r\n').length,2506);
});
test('discovery follows every API page until the reported total is complete',async()=>{
 const input=Array.from({length:2505},(_,i)=>({keyword:`keyword ${i}`}));const calls=[];
 const data=await completePages(async page=>{calls.push(page);return {data:input.slice((page-1)*1000,page*1000),page,per_page:1000,total:2505}});
 assert.deepEqual(calls,[1,2,3]);assert.equal(data.returned,2505);assert.equal(data.data[2504].keyword,'keyword 2504');
});
test('incomplete API pagination reports failure instead of silently returning a truncated result',async()=>{
 await assert.rejects(completePages(async page=>({data:page===1?[{keyword:'one'}]:[],page,per_page:1,total:2})),/stopped before all/);
});
test('expansion seeds are never silently sliced to 20',async()=>{
 const {parseSeedList}=await import('../build/expansion.js');assert.equal(parseSeedList({seeds:Array.from({length:35},(_,i)=>`seed ${i}`)}).length,35);
});
