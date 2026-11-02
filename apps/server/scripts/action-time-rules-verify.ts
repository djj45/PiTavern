import assert from "node:assert/strict";
import fs from "node:fs";
import {WORLD_MAX_CLOCK_MINUTES, type WorldTemplate, type WorldSnapshot} from "@pitavern/shared/world";
import {createWorldTemplateRecord,createInitialWorldSnapshot,WorldState} from "../src/world/state.ts";
import {WorldTransaction} from "../src/world/transaction.ts";
import {parseWorldTemplate} from "../src/world/schema.ts";
import {buildPlayerWorldView} from "../src/world/knowledge.ts";
import {worldDigest} from "../src/world/digest.ts";
import {planWorldSnapshotMigration} from "../src/world/migration.ts";

const legacy:WorldTemplate=JSON.parse(fs.readFileSync(new URL("./fixtures/schedule-tavern.json",import.meta.url),"utf8"));
const policy={moveMinutes:10,interactionMinutes:10,tradeMinutes:5,questAdvanceMinutes:5};
const raw={...structuredClone(legacy),actionTime:policy};
function setup(template:WorldTemplate=raw){
  const record=createWorldTemplateRecord(template),initial=createInitialWorldSnapshot(record);
  const tx=(snapshot:WorldSnapshot=initial,turn=1)=>new WorldTransaction(new WorldState(snapshot,{[record.contentHash]:record}),turn);
  return {record,initial,tx};
}
const buy={commandId:"buy",type:"purchase_item",buyerId:"player",sellerId:"innkeeper",itemId:"sword",quantity:1};
const interact={interactionId:"ask_innkeeper_about_cellar"};
const quest=(action="advance")=>({questId:"cellar_sword",action});
const wait=(minutes:number)=>({commandId:"wait-"+minutes,type:"advance_time",minutes});
const move=(locationId:string,commandId="move")=>({commandId,type:"move_to",actorId:"player",locationId});
let checks=0;const check=(name:string)=>{checks++;console.log("✓ "+name);};

assert.deepEqual(parseWorldTemplate(raw).actionTime,policy);
for(const field of Object.keys(policy))for(const value of [-1,0.5,1441,"10",null])assert.throws(()=>parseWorldTemplate({...raw,actionTime:{...policy,[field]:value}}));
for(const actionTime of [{moveMinutes:10},{...policy,authorNotes:"secret"}])assert.throws(()=>parseWorldTemplate({...raw,actionTime}));
for(const schemaVersion of [1,2,3])assert.throws(()=>parseWorldTemplate({...raw,schemaVersion}));
const old=setup(legacy),before=JSON.stringify(legacy);assert.equal(old.tx().execute(buy).status,"staged");
const oldTx=old.tx();oldTx.execute(buy);oldTx.interact(interact);assert.equal(oldTx.snapshot.clockMinutes,0);
assert.equal(JSON.stringify(legacy),before);assert.ok(!Object.hasOwn(parseWorldTemplate(legacy),"actionTime"));
check("耗时表严格校验、仅v4显式启用；旧模板哈希/读取/手动计时不变");

const s=setup();let t=s.tx();assert.equal(t.quest(quest("accept")).status,"staged");assert.equal(t.snapshot.clockMinutes,0);
const purchased=t.execute(buy);assert.equal(purchased.status,"staged");if(purchased.status!=="staged")throw Error("buy");
assert.equal(purchased.time!.elapsedMinutes,5);assert.equal(t.snapshot.money.player,83);assert.equal(t.snapshot.clockMinutes,5);
assert.deepEqual(t.execute(buy),purchased);assert.equal(t.snapshot.clockMinutes,5);
assert.equal(t.execute({...buy,quantity:2}).status,"rejected");assert.equal(t.snapshot.clockMinutes,5);
check("购买每命令5分钟，幂等回执不重复计时，ID冲突不扣物/钱/时间");
const learned=t.interact(interact);assert.equal(learned.status,"staged");assert.equal(learned.time!.elapsedMinutes,10);
assert.equal(t.snapshot.clockMinutes,15);assert.equal(t.snapshot.actors.innkeeper.locationId,"square");
assert.match(learned.time!.changes.join("\n"),/掌柜从旧酒馆前往广场/);assert.ok(learned.knownFacts!.some(f=>f.id==="hidden_fireplace_passage"));
assert.equal(t.interact(interact).status,"rejected");assert.equal(t.snapshot.clockMinutes,15);
assert.equal(t.quest(quest()).status,"staged");assert.equal(t.snapshot.clockMinutes,20);
assert.equal(t.quest(quest()).status,"staged");assert.equal(t.snapshot.clockMinutes,20);
check("按行动开始时条件揭示，再耗时使NPC离场；后续交互按新位置拒绝；同轮阶段回执不再扣时");
const view=buildPlayerWorldView(t.snapshot,s.record.template),snap=t.snapshot;
assert.deepEqual(view.actionTime,policy);assert.match(worldDigest(snap,s.record.template),/不得额外advance_time/);assert.deepEqual(t.snapshot,snap);
for(const token of ["作者私记","作者日程备注","schedules","scheduleStates"])assert.ok(!JSON.stringify(view).includes(token));
check("查询/提示只读，模型只收到公开耗时表与已发生移动，不带未来日程和私有配置");

t.execute(wait(10));assert.equal(t.snapshot.clockMinutes,30);t=s.tx(t.commit(),2);
const repeated=t.interact(interact);assert.equal(repeated.status,"unchanged");assert.equal(t.snapshot.clockMinutes,30);
const done=t.quest(quest());assert.equal(done.time!.elapsedMinutes,5);assert.equal(t.snapshot.clockMinutes,35);
assert.equal(t.snapshot.money.player,113);assert.equal(t.snapshot.money.innkeeper,87);
assert.equal(t.snapshot.inventory.find(i=>i.ownerId==="innkeeper"&&i.itemId==="sword")!.quantity,10);
assert.ok(!t.snapshot.inventory.some(i=>i.ownerId==="player"&&i.itemId==="sword"));
const finished=t.commit(),restarted=s.tx(finished,2);assert.equal(restarted.quest(quest()).status,"unchanged");assert.equal(restarted.interact(interact).status,"unchanged");
assert.deepEqual(restarted.snapshot,finished);
check("等待只加指定分钟；最终交付奖励仅5分钟，113币/剑0；重启重复交付/调查零变化");

const scrubbed=structuredClone(finished);scrubbed.recentEvents=[];
const noEvents=s.tx(scrubbed,3);assert.equal(noEvents.interact(interact).status,"unchanged");assert.deepEqual(noEvents.snapshot,scrubbed);
check("重复调查依据持久化知识，事件全部裁剪后仍不收费");
const multi=structuredClone(raw);multi.quests![0].reward.items=[{itemId:"letter",quantity:1}];multi.initial.inventory.push({ownerId:"innkeeper",itemId:"letter",quantity:3});
const m=setup(multi);let mt=m.tx();mt.quest(quest("accept"));mt.execute(buy);mt.interact(interact);mt.quest(quest());mt.execute(wait(10));mt=m.tx(mt.commit(),2);
const delivery=mt.quest(quest());assert.equal(delivery.status,"staged");assert.equal(mt.snapshot.clockMinutes,35);assert.equal(delivery.time!.elapsedMinutes,5);
assert.equal(mt.snapshot.inventory.find(i=>i.ownerId==="player"&&i.itemId==="letter")!.quantity,2);
check("任务内部交付加多项奖励一次结算，不按转移命令重复计时");

const close=structuredClone(raw);close.schedules![0].points=[{minuteOfDay:32,locationId:"square"},{minuteOfDay:60,locationId:"tavern"}];
const c=setup(close);let ct=c.tx();ct.quest(quest("accept"));ct.execute(buy);ct.interact(interact);ct.quest(quest());ct.execute(wait(10));ct=c.tx(ct.commit(),2);
assert.equal(ct.snapshot.clockMinutes,30);assert.equal(ct.quest(quest()).status,"staged");assert.equal(ct.snapshot.clockMinutes,35);assert.equal(ct.snapshot.actors.innkeeper.locationId,"square");assert.equal(ct.snapshot.money.player,113);
check("交付开始时NPC在场即可成功，结束时离场不追溯撤销；在场列表立即更新");

const poor=structuredClone(finished);poor.money.innkeeper=0;poor.money.player=83;poor.questStates![0].status="active";delete poor.questStates![0].completedTurn;poor.questStates![0].completedStages.pop();poor.inventory.push({ownerId:"player",itemId:"sword",quantity:1});
const pt=s.tx(poor,3);assert.equal(pt.quest(quest()).status,"rejected");assert.deepEqual(pt.snapshot,poor);
assert.equal(pt.execute({...buy,commandId:"too-many",quantity:1000}).status,"rejected");assert.deepEqual(pt.snapshot,poor);
check("奖励/库存不足动作失败，物品、知识、任务、时间全部不变");

const quiet={...structuredClone(raw),schedules:[]},q=setup(quiet),limit=structuredClone(q.initial);limit.clockMinutes=WORLD_MAX_CLOCK_MINUTES-1;
for(const kind of ["command","interaction","quest"]){
  const start=structuredClone(limit);
  if(kind==="quest"){start.questStates=[{questId:"cellar_sword",status:"active",acceptedTurn:0,completedStages:[]}];start.knowledge!.push({actorId:"player",factId:"hidden_fireplace_passage",source:{type:"initial",turn:0}});}
  const lt=q.tx(start);const result=kind==="command"?lt.execute(buy):kind==="interaction"?lt.interact(interact):lt.quest(quest());
  assert.equal(result.status,"rejected");assert.deepEqual(lt.snapshot,start);assert.equal(lt.questViewsChanged,false);
}
const overflowRevision=structuredClone(q.initial);overflowRevision.revision=Number.MAX_SAFE_INTEGER-1;const rt=q.tx(overflowRevision);assert.equal(rt.execute(buy).status,"rejected");assert.deepEqual(rt.snapshot,overflowRevision);
check("时钟/二次revision溢出时整操作回滚，三种操作均无部分状态或错误授权标记");

const busy=structuredClone(raw);for(let n=0;n<32;n++){const id="npc"+n;busy.actors.push({id,name:id});busy.schedules!.push({id,actorId:id,points:Array.from({length:9},(_,i)=>({minuteOfDay:i+1,locationId:i%2?"square":"tavern"}))});}
const b=setup(busy),bt=b.tx();assert.equal(bt.execute(move("square")).status,"rejected");assert.deepEqual(bt.snapshot,b.initial);assert.equal(bt.questViewsChanged,false);
check("行动耗时超过256个日程触发点，执行前拒绝，不移动、不扣时、不污染活动授权");

const midnight=q.tx();midnight.execute(wait(1435));assert.equal(midnight.execute(move("square")).status,"staged");assert.equal(midnight.snapshot.clockMinutes,1445);
const stationary=midnight.execute(move("square","stationary"));assert.equal(stationary.status,"staged");assert.equal(stationary.time!.elapsedMinutes,0);assert.equal(midnight.snapshot.clockMinutes,1445);
const zero=setup({...quiet,actionTime:{moveMinutes:0,interactionMinutes:0,tradeMinutes:0,questAdvanceMinutes:0}}).tx();zero.execute(buy);zero.interact(interact);assert.equal(zero.snapshot.clockMinutes,0);
check("跨午夜正确；同地点移动与零耗时配置不推进；日程移动本身不递归收费");

const rollback=s.tx();rollback.execute(buy);rollback.interact(interact);rollback.discard();assert.deepEqual(rollback.snapshot,s.initial);
const enabled=planWorldSnapshotMigration(old.initial,old.record,s.record);assert.equal(enabled.applyable,true);assert.equal(enabled.snapshot!.clockMinutes,0);assert.deepEqual(enabled.snapshot!.scheduleStates,old.initial.scheduleStates);assert.match(enabled.warnings.join(""),/不补扣|时钟/);
const changed=setup({...raw,actionTime:{...policy,moveMinutes:5}}).record;const migrated=planWorldSnapshotMigration(finished,s.record,changed);assert.equal(migrated.applyable,true);assert.equal(migrated.snapshot!.clockMinutes,35);assert.deepEqual(migrated.snapshot!.knowledge,finished.knowledge);assert.deepEqual(migrated.snapshot!.questStates,finished.questStates);
check("整轮丢弃恢复原状态；显式新增/改耗时迁移不补扣时间、不改既有任务和知识");
console.log(`${checks} 组行动耗时规则检查通过`);
