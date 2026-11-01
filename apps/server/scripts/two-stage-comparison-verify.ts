import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {twoStageFixture,actions,submit} from './two-stage-fixture.ts';
const f=await twoStageFixture(),reports:unknown[]=[];
try{
 for(const mode of ['simple','bridge','takeover'] as const){
  f.config.contextMode=mode;
  for(const twoStage of [false,true]){
   f.config.twoStage=twoStage;const chat=f.chat(),start=f.requests.length;
   f.plan(mode+(twoStage?' two-stage':' single-stage'),twoStage?[{calls:actions},{calls:[submit]},{text:'购买长剑并获知密道。'}]:[{calls:actions},{text:'购买长剑并获知密道。'}]);
   const begin=performance.now();await f.sessions.send(chat.id,'购买长剑，等待十分钟，出示介绍信询问掌柜。');const elapsedMs=performance.now()-begin;
   const state=f.chats.readWorld(chat.id)!.snapshot,run=f.sessions.activityPage(chat.id).records[0];assert.equal(state.money.player,83);assert.equal(state.clockMinutes,10);assert.equal(state.inventory.find(i=>i.ownerId==='player'&&i.itemId==='sword')?.quantity,1);assert.ok(state.knowledge?.some(k=>k.actorId==='player'&&k.factId===f.raw.facts[1].id));assert.equal(run.status,'succeeded');assert.equal(f.requests.length-start,twoStage?3:2);
   reports.push({mode,flow:twoStage?'two-stage':'single-stage',elapsedMs,requests:f.requests.length-start,inputJsonChars:f.requests.slice(start).reduce((sum,r)=>sum+JSON.stringify(r.body).length,0),usage:run.usage,hardStateChecks:4,stages:run.stages?.map(s=>({phase:s.phase,elapsedMs:Date.parse(s.finishedAt!)-Date.parse(s.startedAt)}))});
   if(twoStage){const e=f.sessions.snapshot(chat.id)!.rewrite!,before=JSON.stringify(state),n=f.requests.length;f.plan(mode+' rewrite',[{text:'更简洁的正文。'}]);const begin=performance.now();await f.sessions.rewrite({chatId:chat.id,messageId:e.messageId!,candidate:e.candidate!,revision:e.revision,requestId:randomUUID(),instruction:'更简洁'});assert.equal(f.requests.length-n,1);assert.equal(JSON.stringify(f.chats.readWorld(chat.id)!.snapshot),before);const run=f.sessions.activityPage(chat.id).records[0];assert.equal(run.tools.length,0);reports.push({mode,flow:'rewrite',elapsedMs:performance.now()-begin,requests:1,inputJsonChars:JSON.stringify(f.requests.at(-1)!.body).length,usage:run.usage,worldUnchanged:true,tools:0});}
  }
 }
 assert.deepEqual(f.problems,[]);
 fs.writeFileSync(path.join(f.run,'comparison.json'),JSON.stringify({syntheticUsagePerResponse:{input:1000,output:100},realProvider:'not_requested',narrativeQuality:'not_evaluated',reports},null,2)+'\n');
 console.log('✓ 三模式单/双阶段请求数、输入字符、耗时、合成用量对照与正文重写：'+f.run);
}finally{await f.close();}
