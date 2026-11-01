import assert from "node:assert/strict";
import fs from "node:fs";
import {createWorldTemplateRecord,createInitialWorldSnapshot,WorldState} from "../src/world/state.ts";
import {parseWorldTemplate,parseWorldSnapshot,validateWorldReferences} from "../src/world/schema.ts";
import {buildPlayerWorldView,buildRoleWorldView,publicWorldTemplate} from "../src/world/knowledge.ts";
import {worldContentHash} from "../src/world/hash.ts";
const raw=JSON.parse(fs.readFileSync(new URL('./fixtures/quest-tavern.json',import.meta.url),'utf8'));
let checks=0;const check=(s:string)=>{checks++;console.log('✓ '+s);};
const record=createWorldTemplateRecord(raw),state=createInitialWorldSnapshot(record);
assert.equal(state.money.innkeeper,100);assert.deepEqual(state.questStates,[]);assert.equal(new WorldState(state,{[record.contentHash]:record}).capability.mode,'enabled');check('v3初始化实际NPC资金、空进度及严格世界引用');
for(const mutate of [
 (t:any)=>t.quests.push(t.quests[0]),(t:any)=>t.quests[0].stages.push(t.quests[0].stages[0]),(t:any)=>t.quests[0].stages=[],
 (t:any)=>t.quests[0].stages=Array.from({length:9},(_,i)=>({...t.quests[0].stages[0],id:String(i)})),
 (t:any)=>t.quests[0].stages[0].conditions=[{type:'knows_fact',actorId:'player',factId:'missing'}],
 (t:any)=>t.quests[0].reward.fromActorId='player',(t:any)=>t.quests[0].reward.items=[{itemId:'missing',quantity:1}],
 (t:any)=>t.quests[0].stages[0].delivery={toActorId:'innkeeper',itemId:'sword',quantity:1},
 (t:any)=>t.quests[0].stages[1].delivery.quantity=0,(t:any)=>t.quests[0].name='x'.repeat(101),
 (t:any)=>t.quests[0].reward.money=1e12+1,(t:any)=>t.initial.actorMoney.push(t.initial.actorMoney[0]),
 (t:any)=>t.initial.actorMoney[0].actorId='player',(t:any)=>t.quests=Array.from({length:65},(_,i)=>({...t.quests[0],id:String(i)})),
]){const t=structuredClone(raw);mutate(t);assert.throws(()=>parseWorldTemplate(t));}check('重复ID、悬空引用、阶段/数量/容量/文本与初始资金越权拒绝');
for(const progress of [
 {questId:'missing',status:'active',acceptedTurn:0,completedStages:[]},
 {questId:'cellar_sword',status:'active',acceptedTurn:0,completedStages:[{stageId:'deliver',turn:1}]},
 {questId:'cellar_sword',status:'completed',acceptedTurn:0,completedStages:[],completedTurn:0},
 {questId:'cellar_sword',status:'active',acceptedTurn:2,completedStages:[{stageId:'investigate',turn:1}]},
])assert.throws(()=>{const s=parseWorldSnapshot({...state,questStates:[progress]});validateWorldReferences(s,record.template);});check('损坏/悬空/乱序/倒退进度不能成为有效恢复点');
const before=JSON.stringify(state),view=buildPlayerWorldView(state,record.template);
assert.equal(view.quests!.length,1);assert.equal(view.quests![0].status,'available');assert.equal(view.quests![0].currentStage!.id,'investigate');
const text=JSON.stringify({view,template:publicWorldTemplate(record.template)});
for(const forbidden of ['questStates','sealed_quest','绝密未开放任务','sealed_stage','绝密未来目标','绝密内部规则备注','openConditions','delivery','fromActorId','作者备注'])assert.ok(!text.includes(forbidden),forbidden);
assert.deepEqual(buildRoleWorldView(state,record.template,'innkeeper').quests,[]);assert.deepEqual(buildPlayerWorldView(state).quests,[]);assert.equal(JSON.stringify(state),before);check('玩家/角色/缺模板投影不泄漏隐藏任务、未来阶段、规则、奖励与备注，查询纯只读');
const known=structuredClone(state);known.knowledge!.push({actorId:'player',factId:raw.facts[1].id,source:{type:'initial',turn:0}});
const revealed=buildPlayerWorldView(known,record.template);assert.equal(revealed.quests!.length,2);assert.notEqual(revealed.questKey,view.questKey);check('真实知识条件授权任务可见性，任务指纹随授权视图变化');
for(const version of [1,2]){const t=structuredClone(raw);t.schemaVersion=version;delete t.quests;delete t.initial.actorMoney;if(version===1){delete t.facts;delete t.interactions;delete t.initial.knowledge;}assert.deepEqual(parseWorldTemplate(t),t);const r=createWorldTemplateRecord(t),s=createInitialWorldSnapshot(r);assert.equal(r.contentHash,worldContentHash(t));assert.ok(!('questStates' in s));assert.ok(!('questKey' in buildPlayerWorldView(s,r.template)));assert.throws(()=>parseWorldTemplate({...t,quests:[]}));}check('v1/v2读取和哈希原样，新增字段不会隐式注入旧世界');
console.log(`${checks} 组任务结构与投影检查通过`);
