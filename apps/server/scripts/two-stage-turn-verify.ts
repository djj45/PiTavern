import assert from 'node:assert/strict';
import {ActivityStore} from '../src/stdata/activity.ts';
import {NARRATIVE_KEY,validateNarrative} from '../src/session/narrative.ts';
import {buildPlayerWorldView} from '../src/world/knowledge.ts';
import {twoStageFixture,actions,submit,proposal,type MockStep} from './two-stage-fixture.ts';
const f=await twoStageFixture();f.config.twoStage=true;
let checks=0;const check=(s:string)=>{checks++;console.log('✓ '+s)};
try{
 for(const mode of ['simple','bridge','takeover'] as const){
  f.config.contextMode=mode;
  const chat=f.chat();f.plan(mode+' successful',[{calls:actions},{calls:[submit]},{text:'旅人买下长剑，并记住了掌柜透露的密道。',inspect:body=>{assert.ok(!body.tools?.length);assert.ok(!JSON.stringify(body).includes(f.raw.facts[1].description));assert.ok(!JSON.stringify(body).includes(f.raw.interactions[0].description));assert.ok(JSON.stringify(body).includes(f.raw.facts[1].text));}}]);
  await f.sessions.send(chat.id,'购买长剑，等十分钟，出示介绍信询问。');
  const state=f.chats.readWorld(chat.id)!,lines=f.chats.readChat(chat.id)!,last=lines.at(-1)!;
  assert.equal(f.count(),3);assert.equal(state.snapshot.money.player,83);assert.equal(state.snapshot.clockMinutes,10);assert.equal(state.snapshot.inventory.find(i=>i.ownerId==='player'&&i.itemId==='sword')?.quantity,1);
  assert.equal(lines.filter(l=>!l.is_user&&!l.is_system).length,1);
  const packet=validateNarrative(last.extra?.[NARRATIVE_KEY],f.chats.readMetadata(chat.id),lines.slice(0,-1),buildPlayerWorldView(state.snapshot,state.template));assert.equal(packet.events.length,3);
  const run=f.sessions.activityPage(chat.id).records[0];assert.equal(run.status,'succeeded');assert.deepEqual(run.stages?.map(s=>s.phase),['settling','validating','rendering','committing']);assert.equal(run.usage.responses,3);assert.equal(run.usage.input,3000);assert.equal(run.stages![0].usage.responses,2);assert.equal(run.stages![2].usage.responses,1);assert.ok(run.stages!.every(s=>s.status==='succeeded'&&s.finishedAt));check(mode+'：实际结算/正文一次原子提交，包与状态一致，两阶段用量分别累计');
  for(const [name,step] of Object.entries({provider:{failure:true},empty:{text:'  '},tool:{calls:[actions[0]]},length:{text:'截断',length:true},conflict:{text:'不应提交',inspect:()=>f.chats.writeMetadata(rollback.id,{...f.chats.readMetadata(rollback.id),external:true})}}) as [string,MockStep][]){
    var rollback=f.chat();const before=f.chats.readWorld(rollback.id)!.snapshot;
    f.plan(mode+' '+name,[{calls:actions},{calls:[submit]},step]);await f.sessions.send(rollback.id,'买剑并询问');
    assert.deepEqual(f.chats.readWorld(rollback.id)!.snapshot,before);assert.equal(f.chats.readChat(rollback.id)!.filter(l=>!l.is_user&&!l.is_system).length,0);const run=f.sessions.activityPage(rollback.id).records[0];assert.equal(run.status,'failed');assert.equal(run.stages!.at(-1)!.status,'failed');
  }check(mode+'：正文供应商异常/空输出/工具调用/截断/revision冲突均撤销整轮状态');
  const stopped=f.chat(),before=f.chats.readWorld(stopped.id)!.snapshot;f.plan(mode+' aborted',[{calls:actions},{calls:[submit]},{pause:true}]);const ready=f.waitPaused();const pending=f.sessions.send(stopped.id,'买剑并询问');await ready;assert.equal(f.sessions.snapshot(stopped.id)!.generationPhase,'rendering');f.sessions.abort(stopped.id);await pending;assert.deepEqual(f.chats.readWorld(stopped.id)!.snapshot,before);assert.equal(f.sessions.activityPage(stopped.id).records[0].status,'aborted');assert.ok(!JSON.stringify(f.sessions.snapshot(stopped.id)).includes(f.raw.facts[1].text));check(mode+'：正文中停止撤销购买/时间/知识，最终诊断隐藏暂存秘密');
 }
 f.config.contextMode='simple';f.config.providers[0].models[0].contextWindow=10000;
 const budget=f.chat(),before=f.chats.readWorld(budget.id)!.snapshot;f.plan('render budget',[{calls:actions},{calls:[{...submit,args:{...proposal,beats:Array.from({length:12},()=> '剧情'.repeat(500))}}]}]);await f.sessions.send(budget.id,'买剑并询问');assert.equal(f.count(),2);assert.deepEqual(f.chats.readWorld(budget.id)!.snapshot,before);const run=f.sessions.activityPage(budget.id).records[0];assert.equal(run.status,'failed');assert.equal(run.stages!.at(-1)!.phase,'rendering');assert.equal(new ActivityStore(f.data).page(budget.id).records[0].context?.overBudget,true);assert.equal(run.contentHidden,true);check('正文超预算在请求前失败，已暂存结算不提交');
 f.config.providers[0].models[0].contextWindow=24000;f.config.renderRetries=1;
 const retried=f.chat();f.plan('render retry',[{calls:actions},{calls:[submit]},{failure:true},{text:'重试正文成功。'}]);await f.sessions.send(retried.id,'买剑');assert.equal(f.count(),4);assert.equal(f.chats.readWorld(retried.id)!.snapshot.money.player,83);const retryRun=f.sessions.activityPage(retried.id).records[0];assert.equal(retryRun.status,'succeeded');assert.deepEqual(retryRun.stages?.filter(s=>s.phase==='rendering').map(s=>s.status),['failed','succeeded']);assert.equal(retryRun.usage.responses,4);assert.equal(retryRun.tools.filter(t=>t.toolName==='world_command').length,2);check('同次运行正文重试复用同一数据包，不重复结算，失败与重试均计入用量');
 assert.deepEqual(f.problems,[]);
}finally{await f.close();}
console.log(`${checks} 组双阶段回合检查通过：${f.run}`);
