import assert from "node:assert/strict";
import fs from "node:fs";
import {createWorldTemplateRecord,createInitialWorldSnapshot,WorldState} from "../src/world/state.ts";
import {WorldTransaction} from "../src/world/transaction.ts";
import {planWorldSnapshotMigration} from "../src/world/migration.ts";
import {buildPlayerWorldView} from "../src/world/knowledge.ts";
const raw=JSON.parse(fs.readFileSync(new URL('./fixtures/schedule-tavern.json',import.meta.url),'utf8'));
const record=createWorldTemplateRecord(raw),initial=createInitialWorldSnapshot(record);
const state=(s=initial)=>new WorldState(s,{[record.contentHash]:record});
const wait=(minutes:number,commandId='wait')=>({commandId,type:'advance_time',minutes});
let checks=0;const check=(s:string)=>{checks++;console.log('✓ '+s);};
const large=new WorldTransaction(state(),1),receipt=large.execute(wait(184320));assert.equal(receipt.status,'staged');
if(receipt.status!=='staged')throw new Error('expected receipt');assert.equal(receipt.summary.split('\n').length,257);
assert.equal(large.snapshot.revision,1);assert.equal(large.snapshot.recentEvents.length,100);assert.equal(large.snapshot.scheduleStates![0].lastOccurrenceAt,182910);assert.equal(large.questViewsChanged,true);
assert.deepEqual(large.execute(wait(184320)),receipt);assert.equal(large.snapshot.revision,1);assert.equal(large.execute(wait(1)).status,'rejected');
check('256触发点完整出现在可见移动回执，单命令一次revision，幂等且裁剪不丢进度/混合证明');
const restored=JSON.parse(JSON.stringify(large.commit()));const restart=new WorldTransaction(state(restored),2);
assert.equal(restart.execute(wait(10,'future')).status,'staged');const next=restart.commit();assert.equal(next.clockMinutes,184330);assert.equal(next.scheduleStates![0].lastOccurrenceAt,184330);assert.equal(next.recentEvents.filter(e=>e.worldTimeMinutes===184330&&e.type==='schedule_move').length,1);assert.equal(next.actors.innkeeper.locationId,'square');
check('100条事件裁剪后序列化重启，只执行未来184330，不靠事件重放');
const failed=new WorldTransaction(state(),1);assert.equal(failed.execute(wait(184330)).status,'rejected');assert.deepEqual(failed.snapshot,initial);assert.equal(failed.questViewsChanged,false);
const rollback=new WorldTransaction(state(),1);rollback.execute(wait(30));assert.equal(rollback.questViewsChanged,true);rollback.discard();assert.deepEqual(rollback.snapshot,initial);assert.equal(rollback.questViewsChanged,true);
check('预检拒绝无部分暂存，整轮撤销恢复全部快照且保留活动来源证明');
for(const version of [1,2,3]){
 const t=structuredClone(raw);t.schemaVersion=version;delete t.schedules;if(version<3){delete t.quests;delete t.initial.actorMoney;}if(version<2){delete t.facts;delete t.interactions;delete t.initial.knowledge;}
 const r=createWorldTemplateRecord(t),s=createInitialWorldSnapshot(r),tx=new WorldTransaction(new WorldState(s,{[r.contentHash]:r}),1);tx.execute(wait(10));const advanced=tx.commit();
 assert.equal(advanced.clockMinutes,10);assert.equal(advanced.actors.innkeeper.locationId,'tavern');assert.ok(!('scheduleStates' in advanced));
 const before=JSON.stringify(advanced),p=planWorldSnapshotMigration(advanced,r,record);assert.equal(p.applyable,true);assert.equal(JSON.stringify(advanced),before);assert.equal(p.snapshot!.actors.innkeeper.locationId,'tavern');assert.deepEqual(p.snapshot!.scheduleStates,[{scheduleId:'innkeeper_daily',activatedAt:10,processedThrough:10}]);
 const tx2=new WorldTransaction(state(p.snapshot!),2);tx2.execute(wait(20));assert.equal(tx2.snapshot.recentEvents.filter(e=>e.type==='schedule_move').length,0);assert.equal(tx2.snapshot.scheduleStates![0].lastOccurrenceAt,30);
}
check('v1–v3推进仍不移动；当刻升级不补跑，未来消费already_there，不授予旧分支知识/任务');
const source=JSON.stringify(initial);for(let i=0;i<3;i++){buildPlayerWorldView(state().snapshot,record.template);assert.deepEqual(state().snapshot,initial);}assert.equal(JSON.stringify(initial),source);
check('重复读取、状态解析和玩家投影完全只读');
console.log(`${checks} 组日程事务与持久化检查通过`);
