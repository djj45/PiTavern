import assert from "node:assert/strict";
import fs from "node:fs";
import {randomUUID} from "node:crypto";
import {stateFields} from "../src/stdata/replies.ts";
import {SessionManager} from "../src/session/manager.ts";
import {ChatStore} from "../src/stdata/chats.ts";
import {buildModels} from "../src/providers/models.ts";
import {ActivityStore} from "../src/stdata/activity.ts";
import {NARRATIVE_KEY} from "../src/session/narrative.ts";
import {twoStageFixture,actions,submit,proposal,type MockStep} from "./two-stage-fixture.ts";
const raw=JSON.parse(fs.readFileSync(new URL("./fixtures/schedule-tavern.json",import.meta.url),"utf8"));
raw.actionTime={moveMinutes:10,interactionMinutes:10,tradeMinutes:5,questAdvanceMinutes:5};
const f=await twoStageFixture(raw);
const wait=(minutes:number)=>({name:"world_command",args:{commandId:"wait-"+minutes,type:"advance_time",minutes}});
const quest=(action="advance")=>({name:"world_quest",args:{questId:"cellar_sword",action}});
const finish=(dual:boolean,final:MockStep)=>[...(dual?[{calls:[submit]}]:[]),final];
let checks=0;const check=(s:string)=>{checks++;console.log("✓ "+s);};
try{
 for(const mode of ["simple","bridge","takeover"] as const)for(const dual of [false,true]){
  f.config.contextMode=mode;f.config.twoStage=dual;const label=mode+(dual?"双阶段":"单阶段"),chat=f.chat();
  const state=()=>f.chats.readWorld(chat.id)!.snapshot;
  f.plan(label+" action prep",[{calls:[quest("accept"),actions[0],actions[2],quest(),{name:"world_query",args:{section:"all"}}],inspect:b=>{const text=JSON.stringify(b);assert.ok(!text.includes(raw.facts[1].text));assert.ok(!text.includes("作者私记"));assert.match(text,/服务端行动耗时/);}},...finish(dual,{text:"调查成功，掌柜随后离开了酒馆。",inspect:b=>{const text=JSON.stringify(b);assert.ok(text.includes(raw.facts[1].text));assert.match(text,/clockMinutes[\\"\s:]+20/);assert.ok(!text.includes("作者私记"));if(dual)assert.ok(!b.tools?.length);}})]);
  await f.sessions.send(chat.id,"接取并买剑，询问后推进调查");
  assert.equal(state().clockMinutes,20);assert.equal(state().money.player,83);assert.equal(state().actors.innkeeper.locationId,"square");assert.equal(state().questStates![0].completedStages.length,1);
  check(label+"：购买5+调查10+阶段5，工具与正文请求使用最终20分钟及新位置；秘密按揭示过滤");
  const priorWorld=state();
  f.plan(label+" rejected",[{calls:[quest(),actions[2]]},...finish(dual,{text:"掌柜不在，交付不能执行。"})]);await f.sessions.send(chat.id,"现在交付");assert.deepEqual(state(),priorWorld);
  const before=stateFields(f.chats.readMetadata(chat.id));
  check(label+"：NPC不在时交付/交互拒绝，查询与拒绝不耗时");
  for(const [name,final] of Object.entries({provider:{failure:true},empty:{text:" "},...(dual?{length:{text:"截断",length:true},tool:{calls:[actions[0]]}}:{}),conflict:{text:"不提交",inspect:()=>{const file=f.chats.resolveChatFile(chat.id)!;fs.utimesSync(file,new Date(),new Date(Date.now()+1000));}}}) as [string,MockStep][]){
    f.plan(label+" rollback "+name,[{calls:[wait(10),quest()]},...finish(dual,final)]);await f.sessions.send(chat.id,"等待掌柜返回并交付："+name);
    assert.deepEqual(stateFields(f.chats.readMetadata(chat.id)),before,label+" "+name);assert.equal(f.sessions.activityPage(chat.id).records[0].status,"failed");
  }
  f.plan(label+" cancelled",[{calls:[wait(10),quest()]},...finish(dual,{pause:true})]);const ready=f.waitPaused(),pending=f.sessions.send(chat.id,"等待并交付后停止");await ready;f.sessions.abort(chat.id);await pending;assert.deepEqual(stateFields(f.chats.readMetadata(chat.id)),before);
  check(label+"：供应商失败/空白/冲突/停止（双阶段含截断/非法工具）撤销耗时、日程、物品、奖励与进度");
  const users=f.chats.readChat(chat.id)!.filter(l=>l.is_user).length;
  f.plan(label+" retry",[{calls:[wait(10),quest(),quest()]},...finish(dual,{text:"交付完成，耗时五分钟。"})]);const request={requestId:randomUUID(),revision:f.chats.revisionId(chat.id)},retryUser=f.sessions.snapshot(chat.id)!.messages.at(-1)!;
  // Retry the uncompleted user turn using the same UI operation as "重试本轮".
  await f.sessions.regenerate(chat.id,retryUser.id,retryUser.text,undefined,request);
  assert.equal(f.chats.readChat(chat.id)!.filter(l=>l.is_user).length,users);assert.equal(state().clockMinutes,35);assert.equal(state().money.player,113);assert.equal(state().money.innkeeper,87);assert.equal(state().questStates![0].status,"completed");
  const saved=stateFields(f.chats.readMetadata(chat.id)),source=f.chats.readSource(chat.id).source,n=f.requests.length;
  await f.sessions.regenerate(chat.id,retryUser.id,retryUser.text,undefined,request);
  const restarted=new SessionManager(f.config,()=>buildModels(f.config),f.cards,new ChatStore(f.data),f.data);await restarted.regenerate(chat.id,retryUser.id,retryUser.text,undefined,request);
  assert.equal(f.requests.length,n);assert.equal(f.chats.readSource(chat.id).source,source);
  check(label+"：重试沿用用户回合，交付一次到35分钟/113币，重复请求及重启重放不耗时、不调用模型");
  if(dual){
    const packet=f.chats.readChat(chat.id)!.at(-1)!.extra![NARRATIVE_KEY];
    for(let i=0;i<3;i++){const e=f.sessions.snapshot(chat.id)!.rewrite!;assert.equal(e.enabled,true);f.plan(label+" rewrite "+i,[{text:"仅改写正文"+i,inspect:b=>assert.ok(!b.tools?.length)}]);await f.sessions.rewrite({chatId:chat.id,messageId:e.messageId!,candidate:e.candidate!,revision:e.revision,requestId:randomUUID(),instruction:"简洁"});assert.deepEqual(stateFields(f.chats.readMetadata(chat.id)),saved);assert.deepEqual(f.chats.readChat(chat.id)!.at(-1)!.extra![NARRATIVE_KEY],packet);}
    check(label+"：三次正文重写无工具，时间、日程、任务、知识和叙事包完全不变");
  }
  const reply=f.chats.readChat(chat.id)!.at(-1)!;f.plan(label+" regenerate",[{calls:[wait(10),quest()]},...finish(dual,{text:"从检查点重新交付。"})]);await f.sessions.regenerate(chat.id,String(reply.extra!.messageId),reply.mes);assert.equal(state().clockMinutes,35);assert.equal(state().money.player,113);
  const last=f.chats.readChat(chat.id)!.at(-1)!;f.plan(label+" alternative",finish(dual,{text:"暂时保留长剑。"}));await f.sessions.regenerate(chat.id,String(last.extra!.messageId),last.mes);assert.deepEqual(state(),priorWorld);
  const user=f.sessions.snapshot(chat.id)!.messages.filter(m=>m.role==="user").at(-1)!;f.sessions.selectReply(chat.id,user.id,0,f.chats.revisionId(chat.id));assert.deepEqual(stateFields(f.chats.readMetadata(chat.id)),saved);
  check(label+"：重生成从20分钟检查点重算到35；切候选独立恢复20/35分钟及奖励");
 }
 f.config.contextMode="simple";f.config.twoStage=true;f.config.providers[0].models[0].contextWindow=10000;
 const budget=f.chat(),before=f.chats.readWorld(budget.id)!.snapshot;
 f.plan("action render budget",[{calls:[actions[0],actions[2]]},{calls:[{...submit,args:{...proposal,beats:Array.from({length:12},()=>"剧情".repeat(500))}}]}]);await f.sessions.send(budget.id,"买剑并调查");assert.equal(f.count(),2);assert.deepEqual(f.chats.readWorld(budget.id)!.snapshot,before);assert.equal(new ActivityStore(f.data).page(budget.id).records[0].context?.overBudget,true);
 check("正文超预算在请求前拒绝，已暂存的15分钟与日程/购买/知识全部撤销");
 f.config.providers[0].models[0].contextWindow=24000;f.config.renderRetries=1;const retry=f.chat();f.plan("render retry without settlement",[{calls:[actions[0],actions[2]]},{calls:[submit]},{failure:true},{text:"正文重试成功"}]);await f.sessions.send(retry.id,"购买并调查");assert.equal(f.count(),4);assert.equal(f.chats.readWorld(retry.id)!.snapshot.clockMinutes,15);assert.equal(f.chats.readWorld(retry.id)!.snapshot.money.player,83);
 check("同次正文自动重试复用数据包，不重复执行工具或15分钟耗时");
 for(const r of f.requests)for(const token of ["作者私记","作者日程备注",'"scheduleStates"','"schedules"'])assert.ok(!JSON.stringify(r.body).includes(token),r.label+" leaked "+token);
 assert.deepEqual(f.problems,[]);
}finally{await f.close();}
console.log(`${checks} 组行动耗时生成检查通过：${f.run}`);
