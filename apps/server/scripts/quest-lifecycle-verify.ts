import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import {once} from "node:events";
import type {AddressInfo} from "node:net";
import {randomUUID} from "node:crypto";
import {WebSocket} from "ws";
import {WORLD_STATE_KEY as K,WORLD_TEMPLATES_KEY as T} from "@pitavern/shared/world";
import {createHttpApp} from "../src/api/http.ts";
import {attachWebSocket} from "../src/api/ws.ts";
import {ChatImportService} from "../src/stdata/chat-import.ts";
import {ChatStore} from "../src/stdata/chats.ts";
import {SessionManager} from "../src/session/manager.ts";
import {buildModels} from "../src/providers/models.ts";
import {ActivityStore} from "../src/stdata/activity.ts";
import {planWorldSnapshotMigration} from "../src/world/migration.ts";
import {planChatWorldMigration} from "../src/world/chat-migration.ts";
import {createWorldTemplateRecord,createInitialWorldSnapshot} from "../src/world/state.ts";
import {NARRATIVE_KEY} from "../src/session/narrative.ts";
import {twoStageFixture,actions,submit,proposal} from "./two-stage-fixture.ts";
const raw=JSON.parse(fs.readFileSync(new URL('./fixtures/quest-tavern.json',import.meta.url),'utf8'));
raw.initial.inventory.push({ownerId:'innkeeper',itemId:'letter',quantity:5});raw.quests[0].reward.items=[{itemId:'letter',quantity:1}];raw.quests[1].openConditions=[{type:'has_item',itemId:'letter',quantity:2}];
const f=await twoStageFixture(raw);f.config.twoStage=true;
const server=http.createServer(createHttpApp({config:f.config,modelsRef:{current:f.models},characters:f.cards,chats:f.chats,sessions:f.sessions,stDataDir:f.data,webDistDir:null}));attachWebSocket(server,f.sessions);server.listen(0,'127.0.0.1');await once(server,'listening');const base=`http://127.0.0.1:${(server.address() as AddressInfo).port}`;
const ws=new WebSocket(base.replace('http:','ws:')+'/ws');await once(ws,'open');
let checks=0;const check=(s:string)=>{checks++;console.log('✓ '+s);};
const quest=(action:string,id='cellar_sword')=>({name:'world_quest',args:{questId:id,action}});
const safe=(value:unknown)=>{const text=JSON.stringify(value);for(const secret of ['sealed_quest','绝密未开放任务','绝密未来目标',NARRATIVE_KEY])assert.ok(!text.includes(secret),'leaked '+secret);};
async function sync(chatId:string){const pending=new Promise<any>((resolve,reject)=>{const timer=setTimeout(()=>{ws.off('message',listener);reject(new Error('WS timeout'));},5000);const listener=(raw:unknown)=>{const e=JSON.parse(String(raw));if(e.type==='chat.snapshot'&&e.chatId===chatId){clearTimeout(timer);ws.off('message',listener);resolve(e);}};ws.on('message',listener);});ws.send(JSON.stringify({type:'chat.sync',chatId}));return pending;}
try{
 const chat=f.chat();f.plan('quest prep',[{calls:[quest('accept'),actions[0],actions[2],quest('advance')]},{calls:[submit]},{text:'调查已完成。'}]);await f.sessions.send(chat.id,'接取并调查');
 f.plan('quest completed',[{calls:[quest('advance')]},{calls:[{...submit,args:{...proposal,beats:['绝密未开放任务现已可见']}}]},{text:'完成交付，绝密未开放任务已开放。'}]);await f.sessions.send(chat.id,'交付长剑');const completed=f.chats.readChat(chat.id)!.at(-1)!,world=f.chats.readWorld(chat.id)!.snapshot,packet=completed.extra![NARRATIVE_KEY],finalUser=f.chats.readChat(chat.id)!.filter(l=>l.is_user).at(-1)!;
 const full=f.chats.readSource(chat.id).source;
 f.plan('quest unfinished alternative',[{calls:[submit]},{text:'保留长剑，尚未交付。'}]);await f.sessions.regenerate(chat.id,String(completed.extra!.messageId),completed.mes);assert.equal(f.chats.readWorld(chat.id)!.snapshot.money.player,83);assert.equal(f.chats.readWorld(chat.id)!.snapshot.questStates![0].status,'active');safe(f.sessions.snapshot(chat.id));safe(f.sessions.activityPage(chat.id));safe(f.sessions.branchIndex(chat.id));safe(f.sessions.searchBranches(chat.id,'绝密').matches);check('同知识不同任务状态的候选隔离：83/未完成路线隐藏另一条任务、旧包提示和活动内容');
 f.chats.selectReply(chat.id,String(finalUser.extra!.messageId),0,f.chats.revisionId(chat.id));assert.deepEqual(f.chats.readWorld(chat.id)!.snapshot,world);f.plan('quest hidden continuation',[{calls:[quest('accept','sealed_quest')]},{calls:[submit]},{text:'接取绝密未开放任务。'}]);await f.sessions.send(chat.id,'查看新任务');const after=f.chats.readWorld(chat.id)!.snapshot;
 f.chats.selectReply(chat.id,String(finalUser.extra!.messageId),1,f.chats.revisionId(chat.id));safe(f.sessions.snapshot(chat.id));f.chats.selectReply(chat.id,String(finalUser.extra!.messageId),0,f.chats.revisionId(chat.id));assert.deepEqual(f.chats.readWorld(chat.id)!.snapshot,after);check('祖先候选切换及隐藏continuation独立恢复任务进度、奖励和叙事包');
 for(let i=0;i<21;i++){const e=f.sessions.snapshot(chat.id)!.rewrite!;f.plan('quest private rewrite '+i,[{text:'绝密未开放任务的正文变体'+i}]);await f.sessions.rewrite({chatId:chat.id,messageId:e.messageId!,candidate:e.candidate!,revision:e.revision,requestId:randomUUID(),instruction:'更简短'});}
 const exported=await fetch(base+'/api/chats/'+chat.id+'/export?format=jsonl').then(r=>r.text());assert.ok(exported.includes('sealed_quest'));const imported=new ChatImportService(f.data,f.chats,f.cards).import(Buffer.from(exported),{fileName:'quests.jsonl',character:'掌柜'});const restarted=new SessionManager(f.config,()=>buildModels(f.config),f.cards,new ChatStore(f.data),f.data);assert.deepEqual(f.chats.readWorld(imported.id)!.snapshot,after);assert.equal(restarted.snapshot(imported.id)!.rewrite!.enabled,true);check('JSONL完整导出、严格导入、重启后任务与包可恢复，默认接口不暴露包');
 const library=f.sessions.worldTemplateLibrary,entry=library.list()[0],editor=library.get(entry.id)!,changed=structuredClone(f.raw);changed.quests.push({...structuredClone(changed.quests[1]),id:'new_task',name:'新增任务'});changed.initial.actorMoney[0].money=999;
 const draft=library.saveDraft(entry.id,editor.draftRevision,{name:'新增任务',template:changed}),target=library.publish(entry.id,draft.draftRevision);
 f.chats.selectReply(chat.id,String(finalUser.extra!.messageId),1,f.chats.revisionId(chat.id));const migrationState=f.chats.readWorld(chat.id)!.snapshot;
 const source=f.chats.readSource(chat.id).source,preview=f.sessions.previewChatWorldMigration(chat.id,target.publishedHash!);assert.equal(preview.applyable,true);assert.ok(preview.locations.some(l=>l.kind==='continuation'));const applied=f.sessions.applyChatWorldMigration(chat.id,target.publishedHash!,preview.revision,preview.previewHash);assert.deepEqual(f.chats.readWorld(chat.id)!.snapshot.questStates,migrationState.questStates);assert.equal(f.chats.readWorld(chat.id)!.snapshot.money.innkeeper,migrationState.money.innkeeper);assert.ok(!f.chats.readWorld(chat.id)!.snapshot.questStates!.some(q=>q.questId==='new_task'));assert.equal(f.sessions.snapshot(chat.id)!.rewrite!.enabled,false);f.chats.restoreBackup(chat.id,applied.backupId!,f.chats.revisionId(chat.id));assert.equal(f.chats.readSource(chat.id).source,source);assert.equal(f.sessions.snapshot(chat.id)!.rewrite!.enabled,true);check('全部恢复点新增定义不接取、不补NPC资金，迁移禁用旧包，备份字节恢复后资格重建');
 const sourceRecord=createWorldTemplateRecord(f.raw);for(const mutation of [(t:any)=>t.quests[0].reward.money++,(t:any)=>t.quests[0].stages[0].conditions=[],(t:any)=>t.quests[0].stages[1].delivery.quantity=2,(t:any)=>t.quests.shift(),(t:any)=>t.quests[0].id='renamed']){const t=structuredClone(f.raw);mutation(t);assert.equal(planWorldSnapshotMigration(after,sourceRecord,createWorldTemplateRecord(t)).applyable,false);}check('修改阶段/条件/交付/奖励、删除或改ID全部阻断迁移');
 const targetRecord=createWorldTemplateRecord(changed),lines=source.trim().split('\n').map(s=>JSON.parse(s));const damaged=structuredClone(lines);damaged[1].extra._pitavernBeforeTurn.metadata[K].questStates=[{questId:'cellar_sword',status:'completed',acceptedTurn:0,completedStages:[],completedTurn:0}];const broken=planChatWorldMigration(damaged.map(l=>JSON.stringify(l)).join('\n')+'\n',targetRecord);assert.equal(broken.applyable,false);assert.equal(broken.nextSource,undefined);check('任一坏检查点进度阻断全聊天迁移，不返回部分写入结果');
 for(const version of [1,2]){const legacy=structuredClone(f.raw);legacy.schemaVersion=version;delete legacy.quests;delete legacy.initial.actorMoney;if(version===1){delete legacy.facts;delete legacy.interactions;delete legacy.initial.knowledge;}const r=createWorldTemplateRecord(legacy),s=createInitialWorldSnapshot(r),before=JSON.stringify(s),p=planWorldSnapshotMigration(s,r,sourceRecord);assert.equal(p.applyable,true);assert.deepEqual(p.snapshot!.questStates,[]);assert.equal(p.snapshot!.money.innkeeper,0);assert.equal(JSON.stringify(s),before);assert.equal(planWorldSnapshotMigration(after,sourceRecord,r).applyable,false);}check('v1/v2显式升级空任务进度，不授予初始资金/知识；v3禁止降级');
 for(const kind of ['v2','v1','no-world'] as const){
  const metadata=f.chats.readMetadata(chat.id);if(kind==='no-world'){delete metadata[K];delete metadata[T];}else{const legacy=structuredClone(f.raw);legacy.schemaVersion=kind==='v2'?2:1;delete legacy.quests;delete legacy.initial.actorMoney;if(kind==='v1'){delete legacy.facts;delete legacy.interactions;delete legacy.initial.knowledge;}const r=createWorldTemplateRecord(legacy);metadata[K]=createInitialWorldSnapshot(r);metadata[T]={[r.contentHash]:r};}
  f.chats.writeMetadata(chat.id,metadata);
  const baseline=f.chats.readSource(chat.id).source,store=new ActivityStore(f.data),ledger=store.snapshot(chat.id,0).usage;
  safe(await fetch(base+'/api/chats/'+chat.id).then(r=>r.json()));safe(await sync(chat.id));safe(f.sessions.activityPage(chat.id));let cursor:string|null=null,pages=0;do{const page:any=await fetch(base+'/api/chat/activity?chatId='+encodeURIComponent(chat.id)+(cursor?'&before='+encodeURIComponent(cursor):'')).then(r=>r.json());safe(page);cursor=page.before;pages++;}while(cursor);assert.equal(pages,2);
  const fresh=new SessionManager(f.config,()=>buildModels(f.config),f.cards,new ChatStore(f.data),f.data);safe(fresh.snapshot(chat.id));assert.deepEqual(store.snapshot(chat.id,0).usage,ledger);assert.equal(f.chats.readSource(chat.id).source,baseline);check(kind+'：恢复视角后HTTP/WS/重启过滤旧任务活动，状态和实际用量不变');
 }
 // Keep the original completed package as a check against accidental migration rewrites.
 assert.ok(full.includes(JSON.stringify(packet)));
 assert.deepEqual(f.problems,[]);
}finally{ws.terminate();server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));await f.close();}
console.log(`${checks} 组任务生命周期检查通过：${f.run}`);
