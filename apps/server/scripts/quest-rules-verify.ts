import assert from "node:assert/strict";
import fs from "node:fs";
import {createWorldTemplateRecord,createInitialWorldSnapshot,WorldState} from "../src/world/state.ts";
import {WorldTransaction} from "../src/world/transaction.ts";
import {validateWorldReferences,parseWorldSnapshot} from "../src/world/schema.ts";
import {applyQuestAction} from "../src/world/quests.ts";
const raw=JSON.parse(fs.readFileSync(new URL('./fixtures/quest-tavern.json',import.meta.url),'utf8'));
const record=createWorldTemplateRecord(raw),initial=createInitialWorldSnapshot(record);
let checks=0;const check=(s:string)=>{checks++;console.log('✓ '+s);};
const tx=(s=initial,turn=1)=>new WorldTransaction(new WorldState(s,{[record.contentHash]:record}),turn);
const accept={questId:'cellar_sword',action:'accept'},advance={...accept,action:'advance'};
for(const action of [{questId:'sealed_quest',action:'accept'},{...advance},{...accept,status:'completed'},{...accept,reward:30},{...accept,action:'complete'}]){const t=tx();assert.equal(t.quest(action).status,'rejected');assert.deepEqual(t.snapshot,initial);}check('隐藏/未接取/非法动作与模型伪造进度或奖励均拒绝且逐项不变');
let t=tx();assert.equal(t.quest(accept).status,'staged');const accepted=t.snapshot;assert.deepEqual(t.quest(accept),t.quest(accept));assert.deepEqual(t.snapshot,accepted);assert.equal(t.quest(advance).status,'rejected');check('接取只记录进度，重复接取幂等；正文声称获知不能推进');
assert.equal(t.execute({commandId:'buy',type:'purchase_item',buyerId:'player',sellerId:'innkeeper',itemId:'sword',quantity:1}).status,'staged');
assert.equal(t.interact({interactionId:'ask_innkeeper_about_cellar'}).status,'staged');
assert.equal(t.quest(advance).status,'staged');const investigated=t.commit();assert.equal(investigated.money.player,83);assert.equal(investigated.questStates![0].completedStages.length,1);check('购买100→83，真实知识交互后才能推进调查阶段');
t=tx(investigated,2);t.execute({commandId:'leave',type:'move_to',actorId:'player',locationId:'square'});const away=t.snapshot;assert.equal(t.quest(advance).status,'rejected');assert.deepEqual(t.snapshot,away);assert.equal(t.snapshot.questStates![0].completedStages.length,1);check('离开地点不撤销已完成阶段，最终阶段重新检查当前地点和NPC');
t.execute({commandId:'return',type:'move_to',actorId:'player',locationId:'tavern'});assert.equal(t.quest(advance).status,'staged');const completed=t.snapshot;assert.equal(completed.money.player,113);assert.equal(completed.money.innkeeper,87);assert.ok(!completed.inventory.some(i=>i.ownerId==='player'&&i.itemId==='sword'));assert.equal(completed.inventory.find(i=>i.ownerId==='innkeeper'&&i.itemId==='sword')!.quantity,10);assert.equal(completed.questStates![0].status,'completed');validateWorldReferences(parseWorldSnapshot(completed),record.template);check('最终交付、NPC实际扣款、奖励与完成一次原子结算：113/0剑、掌柜87/10剑');
assert.deepEqual(t.quest(advance),t.quest(advance));assert.deepEqual(t.snapshot,completed);const restart=tx(t.commit(),3);assert.equal(restart.quest(advance).status,'unchanged');assert.equal(restart.quest(accept).status,'unchanged');assert.deepEqual(restart.snapshot,completed);check('同事务重复、跨事务重启再领奖均不重复支付或记事件');
for(const mutate of [
 (s:any)=>s.money.innkeeper=0,(s:any)=>s.inventory=s.inventory.filter((i:any)=>i.ownerId!=='player'||i.itemId!=='sword'),
 (s:any)=>s.actors.innkeeper.status='dead',(s:any)=>s.money.player=1e12,
 (s:any)=>s.inventory.find((i:any)=>i.ownerId==='innkeeper'&&i.itemId==='sword').quantity=1e6,
]){const s=structuredClone(investigated);mutate(s);const result=applyQuestAction(s,record.template,advance,2);assert.equal(result.result.status,'rejected');assert.deepEqual(result.snapshot,s);}check('资金/交付物不足、NPC死亡、金额或库存溢出均不收走物品、不完成、不支付');
const itemTemplate=structuredClone(raw);itemTemplate.quests[0].reward.items=[{itemId:'sword',quantity:10}];const itemRecord=createWorldTemplateRecord(itemTemplate),withItems={...structuredClone(investigated),templateHash:itemRecord.contentHash};
const insufficient=applyQuestAction(withItems,itemRecord.template,advance,2);assert.equal(insufficient.result.status,'rejected');assert.deepEqual(insufficient.snapshot,withItems);check('奖励库存不足时不能利用本次交付补齐奖励来源');
itemTemplate.quests[0].reward.items=[{itemId:'sword',quantity:2}];const paidRecord=createWorldTemplateRecord(itemTemplate),paid=applyQuestAction({...withItems,templateHash:paidRecord.contentHash},paidRecord.template,advance,2);assert.equal(paid.result.status,'staged');assert.equal(paid.snapshot.inventory.find(i=>i.ownerId==='player'&&i.itemId==='sword')!.quantity,2);assert.equal(paid.snapshot.inventory.find(i=>i.ownerId==='innkeeper'&&i.itemId==='sword')!.quantity,8);check('固定奖励物品从NPC实际库存支付，并计入双方容量');
t=tx(investigated,2);t.quest(advance);t.discard();assert.deepEqual(t.snapshot,investigated);assert.equal(t.quest(advance).status,'rejected');const readonly=new WorldTransaction(new WorldState(investigated,{[record.contentHash]:record},{mode:'read-only'}),2);assert.equal(readonly.quest(advance).status,'rejected');check('整轮撤销恢复逐项状态，结束及只读事务不能推进');
const stages=structuredClone(raw);stages.quests[0].stages.forEach((s:any)=>{s.conditions=[];delete s.delivery;});const sr=createWorldTemplateRecord(stages),st=createInitialWorldSnapshot(sr),multi=new WorldTransaction(new WorldState(st,{[sr.contentHash]:sr}),1);multi.quest(accept);multi.quest(advance);const once=multi.snapshot;multi.quest(advance);assert.deepEqual(multi.snapshot,once);assert.equal(once.questStates![0].completedStages.length,1);check('同一事务重复advance不会跳过多个阶段，下一事务才可推进下一阶段');
console.log(`${checks} 组任务纯规则与事务检查通过`);
