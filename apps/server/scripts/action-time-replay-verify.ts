import assert from "node:assert/strict";
import fs from "node:fs";
import type {WorldCommandStaged} from "@pitavern/shared/world";
import {createWorldTemplateRecord,createInitialWorldSnapshot,WorldState} from "../src/world/state.ts";
import {WorldTransaction} from "../src/world/transaction.ts";
import {buildPlayerWorldView} from "../src/world/knowledge.ts";
import {twoStageFixture} from "./two-stage-fixture.ts";

const template=JSON.parse(fs.readFileSync(new URL("../../../games/fogharbor/template.json",import.meta.url),"utf8")).template;
const record=createWorldTemplateRecord(template),initial=createInitialWorldSnapshot(record);
const tx=()=>new WorldTransaction(new WorldState(initial,{[record.contentHash]:record}),1);
const buy={commandId:"lens",type:"purchase_item" as const,buyerId:"player",sellerId:"qiao",itemId:"lens",quantity:1};
const move={commandId:"go",type:"move_to" as const,actorId:"player",locationId:"lighthouse"};
const accept={questId:"repair",action:"accept" as const};
const wait={commandId:"wait",type:"advance_time" as const,minutes:10};
let checks=0;const check=(s:string)=>{checks++;console.log("✓ "+s);};

const t=tx(),accepted=t.quest(accept),purchased=t.execute(buy) as WorldCommandStaged;
assert.equal(accepted.time!.clockMinutes,0);assert.equal(purchased.time!.clockMinutes,5);t.execute(move);
const state=t.snapshot,ledger=t.receipts,scope=t.questViewsChanged;
for(let i=0;i<3;i++){
 const replay=t.execute(buy) as WorldCommandStaged;
 assert.equal(replay.time!.elapsedMinutes,0);assert.equal(replay.time!.clockMinutes,15);assert.deepEqual(replay.time!.changes,[]);
 assert.deepEqual(replay.replay,{originalRevision:purchased.revision,originalTime:purchased.time});assert.deepEqual(replay.event,purchased.event);assert.equal(replay.revision,state.revision);
 assert.match(replay.summary,/此前已处理.*本次新增耗时 0 分钟.*00:15（累计 15 分钟）/);
 assert.ok(!replay.summary.includes("当前世界时间 5 分钟"));
 replay.replay!.originalTime!.clockMinutes=999;replay.event.summary="mutated";
 assert.deepEqual(t.snapshot,state);assert.deepEqual(t.receipts,ledger);assert.equal(t.questViewsChanged,scope);
}
assert.equal(state.money.player,12);assert.equal(state.clockMinutes,15);
assert.equal(t.execute({...buy,quantity:2}).status,"rejected");assert.deepEqual(t.snapshot,state);assert.deepEqual(t.receipts,ledger);
check("雾港购买00:05→移动00:15→重放三次：新增0、当前00:15，历史事件/时间保留且原回执、状态、冲突校验不变");

const oldAccepted=structuredClone(accepted),replayedAccept=t.quest(accept);
assert.equal(replayedAccept.time!.clockMinutes,15);assert.equal(replayedAccept.time!.elapsedMinutes,0);assert.equal(replayedAccept.replay!.originalTime!.clockMinutes,0);assert.equal(replayedAccept.revision,state.revision);assert.deepEqual(accepted,oldAccepted);
assert.deepEqual(replayedAccept.quests,buildPlayerWorldView(state,record.template).quests);assert.deepEqual(t.snapshot,state);
t.execute(wait);const afterWait=t.snapshot,replayedWait=t.execute(wait) as WorldCommandStaged;t.execute({commandId:"more",type:"advance_time",minutes:5});
const laterWait=t.execute(wait) as WorldCommandStaged;assert.equal(replayedWait.time!.clockMinutes,25);assert.equal(laterWait.time!.clockMinutes,30);assert.equal(laterWait.time!.elapsedMinutes,0);assert.equal(laterWait.event.worldTimeMinutes,25);assert.equal(t.snapshot.clockMinutes,30);assert.equal(t.snapshot.money.player,12);assert.equal(afterWait.clockMinutes,25);
check("开局接取与明确等待回执在后续推进后均报告最新时钟/revision，原时间只作历史记录");

const other=JSON.parse(fs.readFileSync(new URL("./fixtures/schedule-tavern.json",import.meta.url),"utf8"));
other.actionTime={moveMinutes:10,interactionMinutes:10,tradeMinutes:5,questAdvanceMinutes:5};
other.quests.push({id:"temporary_visit",name:"临时可见拜访",openConditions:[{type:"npc_present",actorId:"innkeeper"}],stages:[{id:"meet",objective:"拜访",conditions:[]}],reward:{fromActorId:"innkeeper",money:0,items:[]}});
const r=createWorldTemplateRecord(other),o=new WorldTransaction(new WorldState(createInitialWorldSnapshot(r),{[r.contentHash]:r}),1);
o.quest({questId:"cellar_sword",action:"accept"});o.interact({interactionId:"ask_innkeeper_about_cellar"});
const advanced=o.quest({questId:"cellar_sword",action:"advance"});assert.equal(advanced.time!.clockMinutes,15);
o.execute({commandId:"later",type:"advance_time",minutes:15});const beforeAdvanceReplay=o.snapshot;
const replayedAdvance=o.quest({questId:"cellar_sword",action:"advance"});assert.equal(replayedAdvance.time!.clockMinutes,30);assert.equal(replayedAdvance.time!.elapsedMinutes,0);assert.equal(replayedAdvance.replay!.originalTime!.clockMinutes,15);assert.equal(replayedAdvance.replay!.originalTime!.elapsedMinutes,5);assert.deepEqual(o.snapshot,beforeAdvanceReplay);
check("任务阶段推进后插入等待再重放：不跳阶段、不计时，原耗时5/结束15与当前30分离");

const audience={questId:"innkeeper_audience",action:"accept" as const};
// Cache an unchanged operation on an already completed task, then hide another available task.
const done=o.commit();done.questStates!.push({questId:"innkeeper_audience",status:"completed",acceptedTurn:1,completedStages:[{stageId:"meet",turn:1}],completedTurn:1});
const fresh=new WorldTransaction(new WorldState(done,{[r.contentHash]:r}),2);
const unchanged=fresh.quest(audience);assert.equal(unchanged.status,"unchanged");assert.ok(unchanged.quests!.some(q=>q.id==="temporary_visit"));
fresh.execute({commandId:"away",type:"move_to",actorId:"player",locationId:"square"});const unchangedReplay=fresh.quest(audience);
assert.equal(unchangedReplay.status,"unchanged");assert.equal(unchangedReplay.time!.elapsedMinutes,0);assert.equal(unchangedReplay.time!.clockMinutes,40);assert.deepEqual(unchangedReplay.quests,buildPlayerWorldView(fresh.snapshot,r.template).quests);
assert.equal(unchangedReplay.replay!.originalRevision,unchanged.revision);assert.ok(!unchangedReplay.quests!.some(q=>q.id==="temporary_visit"));
check("缓存unchanged操作也报告当前时间与当前玩家任务投影，不重发旧任务目录");

const f=await twoStageFixture(template);
const call=(name:string,args:unknown)=>({name,args});
const submit=call("submit_narrative_plan",{scene:"北灯塔",beats:["仅按当前服务端时间叙述"],dialogue:[],references:[{kind:"actor",id:"player"}]});
try{
 for(const mode of ["simple","bridge","takeover"] as const)for(const dual of [false,true]){
  f.config.contextMode=mode;f.config.twoStage=dual;const chat=f.chat(),label=mode+(dual?"双阶段":"单阶段");
  const inspect=(body:any)=>{
    const tools=body.messages.filter((m:any)=>m.role==="tool").slice(-2);assert.equal(tools.length,2);
    for(const msg of tools){const text=typeof msg.content==="string"?msg.content:JSON.stringify(msg.content);assert.match(text,/本次新增耗时 0 分钟/);assert.match(text,/当前世界时间 第1天 00:15（累计 15 分钟）/);assert.ok(!text.includes("当前世界时间 5 分钟"));assert.ok(!text.includes("当前世界时间 0 分钟"));}
    assert.ok(JSON.stringify(tools).includes("originalTime"));
  };
  f.plan(label+" replay after movement",[
    {calls:[call("world_quest",accept),call("world_command",buy),call("world_command",move)]},
    {calls:[call("world_command",buy),call("world_quest",accept)]},
    ...(dual?[{calls:[submit],inspect},{text:"仍是00:15，未再次购买。",inspect:(b:any)=>{assert.ok(!b.tools?.length);const packet=JSON.parse(b.messages.findLast((m:any)=>m.role==="user").content);assert.equal(packet.authoritativeState.clockMinutes,15);assert.equal(packet.authoritativeState.money.player,12);}}]:[{text:"仍是00:15，未再次购买。",inspect}]),
  ]);
  await f.sessions.send(chat.id,"开局买聚光片，移动到灯塔，再重试原购买和接任务操作");
  assert.equal(f.count(),dual?4:3);const world=f.chats.readWorld(chat.id)!.snapshot;assert.equal(world.clockMinutes,15);assert.equal(world.money.player,12);assert.equal(world.inventory.find(i=>i.ownerId==="player"&&i.itemId==="lens")!.quantity,1);assert.equal(world.questStates!.length,1);
  assert.equal(f.sessions.activityPage(chat.id).records[0].status,"succeeded");
  check(label+"：实际供应商后续请求收到两份重放的当前00:15/新增0回执；状态与正文包时钟一致");
 }
 assert.deepEqual(f.problems,[]);
}finally{await f.close();}
console.log(`${checks} 组行动回执重放检查通过：${f.run}`);
