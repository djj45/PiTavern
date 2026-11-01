import assert from "node:assert/strict";
import fs from "node:fs";
import {randomUUID} from "node:crypto";
import {stateFields} from "../src/stdata/replies.ts";
import {NARRATIVE_KEY} from "../src/session/narrative.ts";
import {SessionManager} from "../src/session/manager.ts";
import {ChatStore} from "../src/stdata/chats.ts";
import {buildModels} from "../src/providers/models.ts";
import {twoStageFixture,actions,submit} from "./two-stage-fixture.ts";
const raw=JSON.parse(fs.readFileSync(new URL('./fixtures/schedule-tavern.json',import.meta.url),'utf8'));
raw.quests.push({...structuredClone(raw.quests[1]),id:'never_open_quest',name:'永不开放测试任务',openConditions:[{type:'has_item',itemId:'sword',quantity:999999}]});
const f=await twoStageFixture(raw);let checks=0;const check=(s:string)=>{checks++;console.log('✓ '+s);};
const wait=(minutes:number)=>({name:'world_command',args:{commandId:`wait-${minutes}`,type:'advance_time',minutes}});
const quest=(action:string)=>({name:'world_quest',args:{questId:'cellar_sword',action}});
const rewrite=(chatId:string)=>{const e=f.sessions.snapshot(chatId)!.rewrite!;assert.equal(e.enabled,true,e.reason??"rewrite eligible");return {chatId,messageId:e.messageId!,candidate:e.candidate!,revision:e.revision,requestId:randomUUID(),instruction:'改写得更简洁'};};
const finish=(dual:boolean,text:string)=>[...(dual?[{calls:[submit]}]:[]),{text}];
try{
 for(const mode of ['simple','bridge','takeover'] as const)for(const dual of [false,true]){
  const label=mode+(dual?'双阶段':'单阶段');f.config.contextMode=mode;f.config.twoStage=dual;const chat=f.chat();
  f.plan(label+' start',[{calls:[quest('accept'),actions[0],actions[2],quest('advance')],inspect:b=>{const s=JSON.stringify(b);assert.ok(!s.includes('绝密未开放任务'));assert.ok(!s.includes('sealed_quest'));assert.ok(!s.includes(raw.facts[1].text));}},...finish(dual,'调查已推进，尚未交付长剑。')]);
  await f.sessions.send(chat.id,'接取任务、买剑并向掌柜调查线索');let state=f.chats.readWorld(chat.id)!.snapshot;assert.equal(state.money.player,83);assert.equal(state.questStates![0].completedStages.length,1);assert.equal(state.questStates![0].status,'active');check(label+'：实际工具接取/购买/获知/推进，83金币、有剑、未完成');
  f.plan(label+' to9',[{calls:[wait(9)]},...finish(dual,'等待到九分钟。')]);await f.sessions.send(chat.id,'等待9分钟');
  state=f.chats.readWorld(chat.id)!.snapshot;assert.equal(state.clockMinutes,9);assert.equal(state.actors.innkeeper.locationId,'tavern');
  f.plan(label+' to10 rejected delivery',[{calls:[wait(1),quest('advance'),actions[2],{name:'world_query',args:{section:'all'}}]},...finish(dual,'掌柜已经离开，不能交付。')]);await f.sessions.send(chat.id,'再等1分钟并尝试交付');
  state=f.chats.readWorld(chat.id)!.snapshot;assert.equal(state.clockMinutes,10);assert.equal(state.actors.innkeeper.locationId,'square');assert.deepEqual(state.scene.presentActorIds,['bystander','player']);assert.equal(state.money.player,83);assert.equal(state.questStates![0].status,'active');assert.equal(state.scheduleStates![0].lastOccurrenceAt,10);
  const rejectedTools=f.sessions.activityPage(chat.id).records[0].tools;for(const name of ['world_quest','world_interact'])assert.ok(rejectedTools.some(t=>t.toolName===name&&t.status==='error'));
  check(label+'：9分钟在场，10分钟离开；后续交付和知识交互按新位置拒绝，查询不推进');
  const before=stateFields(f.chats.readMetadata(chat.id));
  for(const bad of [{text:' '},{calls:[actions[0]]},{failure:true}]){
   if(!dual && 'calls' in bad)continue;
   f.plan(label+' failed final',[{calls:[wait(20),quest('advance')]},...(dual?[{calls:[submit]}]:[]),bad]);await f.sessions.send(chat.id,'交付长剑');
   assert.deepEqual(stateFields(f.chats.readMetadata(chat.id)),before);assert.equal(f.sessions.activityPage(chat.id).records[0].status,'failed');
  }
  f.plan(label+' cancelled final',[{calls:[wait(20),quest('advance')]},...(dual?[{calls:[submit]}]:[]),{pause:true}]);const ready=f.waitPaused(),pending=f.sessions.send(chat.id,'交付长剑');await ready;f.sessions.abort(chat.id);await pending;assert.deepEqual(stateFields(f.chats.readMetadata(chat.id)),before);check(label+'：正文失败/空白/停止，双阶段非法工具输出，均撤销交付、奖励和进度');
  f.plan(label+' final',[{calls:[wait(20),quest('advance'),quest('advance')]},...finish(dual,'长剑已交付，获得三十金币。')]);const request={requestId:randomUUID(),revision:f.chats.revisionId(chat.id)};await f.sessions.send(chat.id,'交付长剑并领取奖励',undefined,request);state=f.chats.readWorld(chat.id)!.snapshot;assert.equal(state.clockMinutes,30);assert.equal(state.actors.innkeeper.locationId,'tavern');assert.equal(state.scheduleStates![0].lastOccurrenceAt,30);assert.equal(state.money.player,113);assert.equal(state.money.innkeeper,87);assert.equal(state.questStates![0].status,'completed');assert.ok(!state.inventory.some(i=>i.ownerId==='player'&&i.itemId==='sword'));
  const n=f.requests.length,committed=f.chats.readSource(chat.id).source;await f.sessions.send(chat.id,'交付长剑并领取奖励',undefined,request);const restarted=new SessionManager(f.config,()=>buildModels(f.config),f.cards,new ChatStore(f.data),f.data);await restarted.send(chat.id,'交付长剑并领取奖励',undefined,request);assert.equal(f.requests.length,n);assert.equal(f.chats.readSource(chat.id).source,committed);check(label+'：最终原子完成到113，重复调用和重启后同ID重放无奖励、无新请求');
  if(dual){
   const all=stateFields(f.chats.readMetadata(chat.id)),packet=f.chats.readChat(chat.id)!.at(-1)!.extra![NARRATIVE_KEY];
   for(let i=0;i<3;i++){f.plan(label+' rewrite '+i,[{text:'仅改写叙事'+i,inspect:b=>{assert.ok(!b.tools?.length);assert.ok(JSON.stringify(b).includes('quests'));assert.ok(!JSON.stringify(b).includes('openConditions'));}}]);await f.sessions.rewrite(rewrite(chat.id));assert.deepEqual(stateFields(f.chats.readMetadata(chat.id)),all);assert.deepEqual(f.chats.readChat(chat.id)!.at(-1)!.extra![NARRATIVE_KEY],packet);}
   check(label+'：连续三次重写不执行任何工具，任务、结算ID和全部状态逐项一致');
  }
  const reply=f.chats.readChat(chat.id)!.at(-1)!;f.plan(label+' regenerate',[{calls:[wait(20),quest('advance')]},...finish(dual,'重新结算最终回合。')]);await f.sessions.regenerate(chat.id,String(reply.extra!.messageId),reply.mes);state=f.chats.readWorld(chat.id)!.snapshot;assert.equal(state.clockMinutes,30);assert.equal(state.actors.innkeeper.locationId,'tavern');assert.equal(state.scheduleStates![0].lastOccurrenceAt,30);assert.equal(state.money.player,113);assert.equal(state.money.innkeeper,87);assert.equal(state.questStates![0].status,'completed');check(label+'：重生成最终回合从83与持剑检查点结算到113，不重复扣款或奖励');
 }
 for(const r of f.requests){const text=JSON.stringify(r.body);for(const value of ['never_open_quest','永不开放测试任务','绝密内部规则备注','作者备注：内部验收记录不可进入玩家请求','"questStates"','"actorMoney"','"schedules"','"scheduleStates"','innkeeper_daily','作者日程备注'])assert.ok(!text.includes(value),r.label+' leaked '+value);}
 check('截取所有三模式单/双阶段及重写真实供应商请求，未开放任务、原始进度和内部配置均不进入');
 assert.deepEqual(f.problems,[]);
}finally{await f.close();}
console.log(`${checks} 组日程实际生成检查通过：${f.run}`);
