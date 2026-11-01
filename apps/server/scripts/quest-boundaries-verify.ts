import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {WORLD_STATE_KEY as K,WORLD_TEMPLATES_KEY as T} from "@pitavern/shared/world";
import type {StChatLine} from "../src/stdata/types.ts";
import {stateFields} from "../src/stdata/replies.ts";
import {createWorldTemplateRecord,createInitialWorldSnapshot} from "../src/world/state.ts";
import {parseWorldSnapshot,validateWorldReferences} from "../src/world/schema.ts";
import {applyQuestAction} from "../src/world/quests.ts";
import {buildPlayerWorldView,buildRoleWorldView} from "../src/world/knowledge.ts";
import {buildWorkingContext,type WorkingSetInput} from "../src/context/working-set.ts";
import {ContextFactCache,buildCachedWorkingContext} from "../src/context/memory-cache.ts";
import {ActivityStore} from "../src/stdata/activity.ts";
import {longContextFixture} from "./context-fixtures.ts";
import {twoStageFixture,actions,submit,proposal} from "./two-stage-fixture.ts";
const raw=JSON.parse(fs.readFileSync(new URL('./fixtures/quest-tavern.json',import.meta.url),'utf8'));
raw.quests[1].openConditions=[{type:'has_item',itemId:'sword',quantity:999999}];
const record=createWorldTemplateRecord(raw),initial=createInitialWorldSnapshot(record),accept={questId:'cellar_sword',action:'accept'},advance={...accept,action:'advance'};
let checks=0;const check=(s:string)=>{checks++;console.log('✓ '+s);};
const accepted=applyQuestAction(initial,record.template,accept,1).snapshot;
const view=buildPlayerWorldView(initial,record.template),active=buildPlayerWorldView(accepted,record.template);
assert.equal(view.knowledgeKey,active.knowledgeKey);assert.notEqual(view.questKey,active.questKey);
const input:WorkingSetInput={messages:longContextFixture(100).messages,world:view,config:{enabled:true,keepFullTurns:2},budget:18000,sourceRevision:'same-source'};
const cache=new ContextFactCache();assert.equal(buildCachedWorkingContext(input,cache,'quest').diagnostics.cache,'rebuilt');assert.equal(buildCachedWorkingContext(input,cache,'quest').diagnostics.cache,'hit');
const changed=buildCachedWorkingContext({...input,world:active},cache,'quest');assert.equal(changed.diagnostics.cache,'rebuilt');assert.deepEqual(changed.messages,buildWorkingContext({...input,world:active}).messages);
assert.equal(buildCachedWorkingContext({...input,world:buildRoleWorldView(initial,record.template,'innkeeper')},cache,'quest').diagnostics.cache,'rebuilt');
assert.throws(()=>buildWorkingContext({...input,world:initial}),/禁止注入原始快照/);check('任务指纹独立于知识，缓存按任务/角色重建且等于纯构建；原始v3快照禁止注入');
for(const mutate of [
 (s:any)=>s.recentEvents[0].stageId='deliver',
 (s:any)=>{s.recentEvents[0].type='quest_advance';s.recentEvents[0].stageId='deliver';},
 (s:any)=>s.recentEvents[0].turn=2,
 (s:any)=>s.questStates=[],
]){const s=structuredClone(accepted);mutate(s);assert.throws(()=>validateWorldReferences(parseWorldSnapshot(s),record.template));}
const forged=structuredClone(accepted);forged.recentEvents[0].summary='绝密未来目标';assert.ok(!JSON.stringify(buildPlayerWorldView(forged,record.template)).includes('绝密未来目标'));check('任务事件必须匹配真实已完成进度和回合；伪造未来阶段、来源及摘要不能泄漏');
const f=await twoStageFixture(raw),metrics:unknown[]=[];f.config.twoStage=true;
const quest=(action:string)=>({name:'world_quest',args:{questId:'cellar_sword',action}});
const prep=async()=>{const c=f.chat();f.plan('prepare final',[{calls:[quest('accept'),actions[0],actions[2],quest('advance')]},{calls:[submit]},{text:'已调查，保留长剑。'}]);await f.sessions.send(c.id,'接取、购买并调查');assert.equal(f.chats.readWorld(c.id)!.snapshot.money.player,83);return c;};
try{
 for(const mode of ['simple','bridge','takeover'] as const){
  f.config.contextMode=mode;const chat=f.chat(),fixture=longContextFixture(1000);
  const history:StChatLine[]=fixture.messages.slice(1,-1).map((m,i)=>({name:m.role==='user'?'旅人':'掌柜',is_user:m.role==='user',is_system:false,mes:typeof m.content==='string'?m.content:m.content.filter(c=>c.type==='text').map(c=>(c as {text:string}).text).join(''),send_date:'',extra:{messageId:'quest-history-'+i}}));
  const header=f.chats.readSource(chat.id).source.trim().split('\n')[0];fs.writeFileSync(chat.file,[header,...history.map(l=>JSON.stringify(l))].join('\n')+'\n');
  const inspect=(body:any)=>{const text=JSON.stringify(body.messages);for(const fact of fixture.facts)assert.ok(text.includes(fact));for(const hidden of ['sealed_quest','绝密未来目标','绝密内部规则备注'])assert.ok(!text.includes(hidden));};
  const start=performance.now();f.plan(mode+' 1000 quest',[{calls:[quest('accept'),actions[0],actions[2],quest('advance')],inspect},{calls:[{...submit,args:{...proposal,beats:fixture.facts}}],inspect},{text:'沿已知线索推进调查，尚未交剑。',inspect:body=>{inspect(body);assert.ok(!body.tools?.length);assert.ok(body.messages.length<30);}}]);
  await f.sessions.send(chat.id,'接取、买剑、询问并调查；回忆旧井地图、莉雅承诺与北塔暗号。');
  const state=f.chats.readWorld(chat.id)!.snapshot;assert.equal(state.money.player,83);assert.equal(state.questStates![0].completedStages.length,1);assert.equal(f.sessions.activityPage(chat.id).records[0].status,'succeeded');
  metrics.push({mode,turns:1000,requests:f.count(),elapsedMs:performance.now()-start,sourceBytes:Buffer.byteLength(f.chats.readSource(chat.id).source),factsHit:3,model:'local_synthetic'});check(mode+' 1000回合：线索、当前任务及完整工具链保留，隐藏任务不进请求');
 }
 f.config.contextMode='simple';let chat=await prep(),before=stateFields(f.chats.readMetadata(chat.id));f.config.providers[0].models[0].contextWindow=10000;
 f.plan('quest render over budget',[{calls:[quest('advance')]},{calls:[{...submit,args:{...proposal,beats:Array.from({length:12},()=> '剧情'.repeat(500))}}]}]);await f.sessions.send(chat.id,'交付长剑');assert.equal(f.count(),2);assert.deepEqual(stateFields(f.chats.readMetadata(chat.id)),before);assert.equal(new ActivityStore(f.data).page(chat.id).records[0].context?.overBudget,true);check('正文超预算不发送正文请求，交付/奖励/进度全部回滚到83与持剑状态');
 f.config.providers[0].models[0].contextWindow=24000;chat=await prep();before=stateFields(f.chats.readMetadata(chat.id));
 f.plan('quest final revision conflict',[{calls:[quest('advance')]},{calls:[submit]},{text:'不应提交',inspect:()=>fs.utimesSync(chat.file,new Date(),new Date(Date.now()+2000))}]);await f.sessions.send(chat.id,'交付长剑');assert.deepEqual(stateFields(f.chats.readMetadata(chat.id)),before);assert.equal(f.sessions.activityPage(chat.id).records[0].status,'failed');check('最终写入前revision变化阻断已生成正文及整份任务结算');
 for(const restored of ['v3','v1','none']){
  const c=await prep(),events:unknown[]=[];const off=f.sessions.onEvent(e=>{if(e.type==='chat.error'&&e.chatId===c.id)events.push(e);});
  f.plan('quest private provider error '+restored,[{calls:[quest('advance')]},{calls:[submit]},{failure:true,failureMessage:'sealed_quest 绝密未来目标',inspect:()=>{
   if(restored==='v3')return;const metadata=f.chats.readMetadata(c.id);if(restored==='none'){delete metadata[K];delete metadata[T];}else{const old=structuredClone(raw);old.schemaVersion=1;delete old.facts;delete old.interactions;delete old.initial.knowledge;delete old.quests;delete old.initial.actorMoney;const r=createWorldTemplateRecord(old);metadata[K]=createInitialWorldSnapshot(r);metadata[T]={[r.contentHash]:r};}f.chats.writeMetadata(c.id,metadata);
  }}]);await f.sessions.send(c.id,'交付长剑');off();assert.equal(events.length,1);assert.ok(!JSON.stringify(events).includes('sealed_quest'));assert.ok(!JSON.stringify(f.sessions.activityPage(c.id)).includes('绝密未来目标'));assert.equal(f.sessions.activityPage(c.id).records[0].status,'failed');check(restored+'：供应商错误及运行中回退后的WS错误不暴露受保护任务内容');
 }
 assert.deepEqual(f.problems,[]);fs.writeFileSync(path.join(f.run,'quest-boundaries.json'),JSON.stringify({checks,metrics,realModel:'not_requested'},null,2)+'\n');
}finally{await f.close();}
console.log(`${checks} 组任务边界检查通过：${f.run}`);
