import assert from "node:assert/strict";
import fs from "node:fs";
import {createWorldTemplateRecord,createInitialWorldSnapshot,WorldState} from "../src/world/state.ts";
import {parseWorldTemplate,parseWorldSnapshot,validateWorldReferences} from "../src/world/schema.ts";
import {buildPlayerWorldView,buildRoleWorldView,publicWorldTemplate} from "../src/world/knowledge.ts";
import {worldContentHash} from "../src/world/hash.ts";
const raw=JSON.parse(fs.readFileSync(new URL('./fixtures/schedule-tavern.json',import.meta.url),'utf8'));
let checks=0;const check=(s:string)=>{checks++;console.log('✓ '+s);};
const record=createWorldTemplateRecord(raw),initial=createInitialWorldSnapshot(record);
assert.equal(new WorldState(initial,{[record.contentHash]:record}).capability.mode,'enabled');
assert.deepEqual(initial.scheduleStates,[{scheduleId:'innkeeper_daily',activatedAt:0,processedThrough:0}]);
assert.equal(initial.money.innkeeper,100);assert.deepEqual(initial.questStates,[]);
assert.equal(initial.knowledge!.length,1);check('v4初始化独立进度，继续使用v3任务和v2知识');
for(const mutate of [
 (t:any)=>t.schedules.push(t.schedules[0]),(t:any)=>t.schedules.push({...t.schedules[0],id:'other'}),
 (t:any)=>t.schedules[0].actorId='player',(t:any)=>t.schedules[0].actorId='missing',
 (t:any)=>t.schedules[0].points[0].locationId='missing',(t:any)=>t.schedules[0].points.push(t.schedules[0].points[0]),
 (t:any)=>t.schedules[0].points=[],(t:any)=>t.schedules[0].points=Array.from({length:17},(_,i)=>({minuteOfDay:i,locationId:'square'})),
 (t:any)=>t.schedules[0].points[0].minuteOfDay=-1,(t:any)=>t.schedules[0].points[0].minuteOfDay=1440,
 (t:any)=>t.schedules[0].points[0].minuteOfDay=0.5,(t:any)=>t.schedules[0].description='x'.repeat(2001),
 (t:any)=>t.schedules[0].id='has space',(t:any)=>t.schedules[0].points[0].effect='trade',
 (t:any)=>delete t.schedules,(t:any)=>t.quests[0].reward.fromActorId='player',
 (t:any)=>t.interactions[0].conditions[0].locationId='missing',
]){const t=structuredClone(raw);mutate(t);assert.throws(()=>parseWorldTemplate(t));}
check('日程重复/玩家/悬空引用/非法时间/字段/容量拒绝，知识任务校验不被v4绕过');
const capacity=structuredClone(raw);capacity.schedules=[];
for(let i=0;i<64;i++){capacity.actors.push({id:`npc${i}`,name:`NPC${i}`});capacity.schedules.push({id:`s${i}`,actorId:`npc${i}`,points:Array.from({length:16},(_,j)=>({minuteOfDay:j,locationId:'tavern'}))});}
parseWorldTemplate(capacity);capacity.actors.push({id:'npc64',name:'NPC64'});capacity.schedules.push({id:'s64',actorId:'npc64',points:[{minuteOfDay:0,locationId:'tavern'}]});
assert.throws(()=>parseWorldTemplate(capacity));check('64日程×16点允许，65日程拒绝');
for(const progress of [
 [],[initial.scheduleStates![0],initial.scheduleStates![0]],
 [{scheduleId:'missing',activatedAt:0,processedThrough:0}],
 [{scheduleId:'innkeeper_daily',activatedAt:1,processedThrough:0}],
 [{scheduleId:'innkeeper_daily',activatedAt:0,processedThrough:1}],
 [{scheduleId:'innkeeper_daily',activatedAt:0,processedThrough:0,lastOccurrenceAt:0}],
])assert.throws(()=>{const s=parseWorldSnapshot({...initial,scheduleStates:progress});validateWorldReferences(s,record.template);});
for(const last of [undefined,9,11])assert.throws(()=>validateWorldReferences(parseWorldSnapshot({...initial,clockMinutes:10,scheduleStates:[{scheduleId:'innkeeper_daily',activatedAt:0,processedThrough:10,lastOccurrenceAt:last}]}),record.template));
const at10={...initial,clockMinutes:10,scheduleStates:[{scheduleId:'innkeeper_daily',activatedAt:0,processedThrough:10,lastOccurrenceAt:10}]};
validateWorldReferences(parseWorldSnapshot(at10),record.template);
check('进度逐一对应，区间和最后消费点精确校验，不依赖事件');
const view=buildPlayerWorldView(initial,record.template),text=JSON.stringify({view,template:publicWorldTemplate(record.template)});
for(const forbidden of ['schedules','scheduleStates','innkeeper_daily','作者日程备注','hidden_fireplace_passage','sealed_quest'])assert.ok(!text.includes(forbidden),forbidden);
assert.ok(view.questKey);assert.equal(view.quests!.length,2);assert.deepEqual(buildRoleWorldView(initial,record.template,'innkeeper').quests,[]);
assert.equal(buildRoleWorldView(initial,record.template,'innkeeper').knownFacts.length,2);check('玩家投影不含时间表/进度/备注且保留角色知识与任务视角');
const moved=structuredClone(at10);moved.recentEvents=[{id:'event',commandId:'advance',turn:1,type:'schedule_move',scheduleId:'innkeeper_daily',actorId:'innkeeper',fromLocationId:'tavern',locationId:'square',worldTimeMinutes:10,summary:'作者备注不可发送'}];
validateWorldReferences(parseWorldSnapshot(moved),record.template);
const safe=JSON.stringify(buildPlayerWorldView(moved,record.template));assert.ok(safe.includes('前往广场'));assert.ok(!safe.includes('innkeeper_daily'));assert.ok(!safe.includes('作者备注'));
assert.deepEqual(buildPlayerWorldView(moved).recentEvents,[]);
moved.recentEvents[0]={...moved.recentEvents[0],type:'schedule_skip',skipReason:'dead'} as any;
assert.deepEqual(buildPlayerWorldView(moved,record.template).recentEvents,[]);check('已发生移动使用服务端摘要，跳过记录与缺模板来源不进入玩家出口');
for(const version of [1,2,3]){const t=structuredClone(raw);t.schemaVersion=version;delete t.schedules;if(version<3){delete t.quests;delete t.initial.actorMoney;}if(version<2){delete t.facts;delete t.interactions;delete t.initial.knowledge;}
 assert.deepEqual(parseWorldTemplate(t),t);const r=createWorldTemplateRecord(t),s=createInitialWorldSnapshot(r);assert.equal(r.contentHash,worldContentHash(t));assert.ok(!('scheduleStates' in s));assert.throws(()=>parseWorldTemplate({...t,schedules:[]}));
 assert.throws(()=>parseWorldSnapshot({...s,scheduleStates:[]}));}
check('v1–v3读取/哈希/快照原样，严格拒绝隐式新字段');
console.log(`${checks} 组日程结构与投影检查通过`);
