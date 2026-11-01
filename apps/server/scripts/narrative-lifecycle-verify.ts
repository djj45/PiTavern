import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import {once} from 'node:events';
import type {AddressInfo} from 'node:net';
import {WebSocket} from 'ws';
import {randomUUID} from 'node:crypto';
import {WORLD_STATE_KEY as K} from '@pitavern/shared/world';
import {createHttpApp} from '../src/api/http.ts';
import {attachWebSocket} from '../src/api/ws.ts';
import {ChatImportService} from '../src/stdata/chat-import.ts';
import {ChatStore} from '../src/stdata/chats.ts';
import {ActivityStore} from '../src/stdata/activity.ts';
import {SessionManager} from '../src/session/manager.ts';
import {buildModels} from '../src/providers/models.ts';
import {portableSettings,parsePortableSettings,applyPortableSettings} from '../src/stdata/portable-config.ts';
import {NARRATIVE_KEY} from '../src/session/narrative.ts';
import {twoStageFixture,actions,submit,proposal} from './two-stage-fixture.ts';
const f=await twoStageFixture();f.config.twoStage=true;
const server=http.createServer(createHttpApp({config:f.config,modelsRef:{current:f.models},characters:f.cards,chats:f.chats,sessions:f.sessions,stDataDir:f.data,webDistDir:null}));attachWebSocket(server,f.sessions);server.listen(0,'127.0.0.1');await once(server,'listening');const base=`http://127.0.0.1:${(server.address() as AddressInfo).port}`;
const ws=new WebSocket(base.replace('http:','ws:')+'/ws');await once(ws,'open');
let checks=0;const check=(s:string)=>{checks++;console.log('✓ '+s)};
const secret=f.raw.facts[1].text,secretId=f.raw.facts[1].id,privateText=f.raw.facts[1].description;
const safe=(value:unknown)=>{const text=JSON.stringify(value);for(const s of [secret,secretId,privateText,NARRATIVE_KEY])assert.ok(!text.includes(s),'unexpected protected value '+s);};
const rewriteReq=(chatId:string,instruction='简洁')=>{const e=f.sessions.snapshot(chatId)!.rewrite!;assert.equal(e.enabled,true);return{chatId,messageId:e.messageId!,candidate:e.candidate!,revision:e.revision,requestId:randomUUID(),instruction};};
const secretPlan={...submit,args:{...proposal,beats:[secret]}};
async function sync(chatId:string){const pending=new Promise<any>((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('WS timeout')),5000);const listener=(raw:unknown)=>{const e=JSON.parse(String(raw));if(e.type==='chat.snapshot'&&e.chatId===chatId){clearTimeout(timer);ws.off('message',listener);resolve(e);}};ws.on('message',listener);});ws.send(JSON.stringify({type:'chat.sync',chatId}));return pending;}
try{
 const chat=f.chat();f.plan('known original',[{calls:actions},{calls:[secretPlan]},{text:secret}]);await f.sessions.send(chat.id,'购买并询问');const original=f.chats.readChat(chat.id)!.at(-1)!;
 f.plan('unknown alternative',[{calls:[submit]},{text:'旅人尚未询问掌柜。'}]);await f.sessions.regenerate(chat.id,String(original.extra!.messageId),original.mes);const user=f.chats.readChat(chat.id)!.find(l=>l.is_user)!;
 f.chats.selectReply(chat.id,String(user.extra!.messageId),0,f.chats.revisionId(chat.id));f.plan('known continuation',[{calls:[secretPlan]},{text:'旅人记起'+secret}]);await f.sessions.send(chat.id,'继续调查');const continuation=f.chats.readChat(chat.id)!.at(-1)!,packet=continuation.extra![NARRATIVE_KEY];
 f.chats.selectReply(chat.id,String(user.extra!.messageId),1,f.chats.revisionId(chat.id));const unknown=f.sessions.snapshot(chat.id)!;safe({messages:unknown.messages,world:unknown.world,activity:unknown.activity,staged:unknown.stagedMessages,rewrite:unknown.rewrite});assert.ok(!JSON.stringify(unknown).includes(NARRATIVE_KEY));safe(f.sessions.activityPage(chat.id));check('切未知剧情路线后，旧正文阶段诊断与计划参数隐藏，隐藏后续不进入活动路径');
 f.chats.selectReply(chat.id,String(user.extra!.messageId),0,f.chats.revisionId(chat.id));assert.deepEqual(f.chats.readChat(chat.id)!.at(-1)!.extra![NARRATIVE_KEY],packet);assert.equal(f.sessions.snapshot(chat.id)!.rewrite!.enabled,true);check('切回祖先候选完整恢复隐藏 continuation 的原始包及重写资格');
 const exported=await fetch(base+'/api/chats/'+chat.id+'/export?format=jsonl').then(r=>r.text());assert.ok(exported.includes(NARRATIVE_KEY));assert.ok(exported.includes(privateText));const imported=new ChatImportService(f.data,f.chats,f.cards).import(Buffer.from(exported),{fileName:'narrative.jsonl',character:'掌柜'});const restarted=new SessionManager(f.config,()=>buildModels(f.config),f.cards,new ChatStore(f.data),f.data);assert.equal(restarted.snapshot(imported.id)!.rewrite!.enabled,true);const e=restarted.snapshot(imported.id)!.rewrite!;f.plan('imported rewrite',[{text:'重启后改写正文'}]);await restarted.rewrite({chatId:imported.id,messageId:e.messageId!,candidate:e.candidate!,revision:e.revision,requestId:randomUUID(),instruction:'更短'});assert.deepEqual(f.chats.readWorld(imported.id)!.snapshot,f.chats.readWorld(chat.id)!.snapshot);check('JSONL 完整导出导入、重启后包仍可验证，改写不改变知识状态');
 const library=f.sessions.worldTemplateLibrary,entry=library.list()[0],editor=library.get(entry.id)!;
 const changed=structuredClone(f.raw);changed.items.find((i:any)=>i.id==='sword').price=23;
 const saved=library.saveDraft(entry.id,editor.draftRevision,{name:'改价',template:changed}),target=library.publish(entry.id,saved.draftRevision);
 const before=f.chats.readSource(chat.id).source,preview=f.sessions.previewChatWorldMigration(chat.id,target.publishedHash!);assert.equal(preview.applyable,true);const applied=f.sessions.applyChatWorldMigration(chat.id,target.publishedHash!,preview.revision,preview.previewHash);assert.deepEqual(f.chats.readChat(chat.id)!.at(-1)!.extra![NARRATIVE_KEY],packet);assert.equal(f.sessions.snapshot(chat.id)!.rewrite!.enabled,false);f.chats.restoreBackup(chat.id,applied.backupId!,f.chats.revisionId(chat.id));assert.equal(f.chats.readSource(chat.id).source,before);assert.equal(f.sessions.snapshot(chat.id)!.rewrite!.enabled,true);check('模板迁移保留原包来源但禁用不匹配重写，字节一致恢复后可重建资格');
 // A discoverable target permits an explicitly upgraded v1 world to learn without
 // applying the new-template NPC initial knowledge to existing branches.
 const discovery=structuredClone(changed);discovery.interactions[0].conditions=discovery.interactions[0].conditions.filter((c:any)=>c.type!=='knows_fact');discovery.interactions[0].effects=[{type:'learn',actorId:'player',factId:secretId}];const draft=library.saveDraft(entry.id,target.draftRevision,{name:'恢复规则',template:discovery}),discoveryTarget=library.publish(entry.id,draft.draftRevision);
 for(const kind of ['v1','no-world'] as const){
  const chat=f.chats.createChat('掌柜',null);if(kind==='v1'){const v1=structuredClone(f.raw);v1.schemaVersion=1;delete v1.facts;delete v1.interactions;delete v1.initial.knowledge;f.chats.initializeWorld(chat.id,v1);}
  // Legacy single-stage reply for no world; a v1 enabled world uses two stages.
  f.plan(kind+' public',kind==='v1'?[{calls:[submit]},{text:'公开见闻'}]:[{text:'公开见闻'}]);await f.sessions.send(chat.id,'公开问候');const before=f.chats.readSource(chat.id).source;let backupId:string;
  if(kind==='v1'){const p=f.sessions.previewChatWorldMigration(chat.id,discoveryTarget.publishedHash!);backupId=f.sessions.applyChatWorldMigration(chat.id,discoveryTarget.publishedHash!,p.revision,p.previewHash).backupId!;}
  else{const previous=new Set(f.chats.backups(chat.id).backups.map(b=>b.id));f.sessions.initializeChatWorldByHash(chat.id,discoveryTarget.publishedHash!,f.chats.revisionId(chat.id),true);backupId=f.chats.backups(chat.id).backups.find(b=>!previous.has(b.id))!.id;}
  f.plan(kind+' reveal',[{calls:[actions[2]]},{calls:[secretPlan]},{text:secret}]);await f.sessions.send(chat.id,'出示介绍信');assert.ok(JSON.stringify(f.sessions.activityPage(chat.id)).includes(secret));
  for(let i=0;i<21;i++){f.plan(kind+' rewrite page '+i,[{text:secret+'。第'+i+'次重写'}]);const response=await fetch(base+'/api/chat/rewrite',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(rewriteReq(chat.id))});assert.equal(response.status,200);}
  const activity=f.sessions.snapshot(chat.id)!.activity!;const raw=new ActivityStore(f.data).page(chat.id,undefined,100);assert.ok(JSON.stringify(raw).includes(secret));
  const response=await fetch(base+'/api/chat/backup/restore',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({chatId:chat.id,backupId,revision:f.chats.revisionId(chat.id)})});assert.equal(response.status,200);assert.equal(f.chats.readSource(chat.id).source,before);
  const snapshot=await fetch(base+'/api/chats/'+chat.id).then(r=>r.json());safe(snapshot);safe(await sync(chat.id));assert.deepEqual(snapshot.activity.usage,activity.usage);assert.equal(snapshot.rewrite.enabled,kind==='v1');
  let cursor:string|null=null,pages=0,records=0;do{const p:import('@pitavern/shared').GenerationPageDto=await fetch(base+'/api/chat/activity?chatId='+encodeURIComponent(chat.id)+(cursor?'&before='+encodeURIComponent(cursor):'')).then(r=>r.json());safe(p);cursor=p.before;pages++;records+=p.records.length;}while(cursor);assert.equal(pages,2);assert.equal(records,23);
  const restarted=new SessionManager(f.config,()=>buildModels(f.config),f.cards,new ChatStore(f.data),f.data);safe(restarted.snapshot(chat.id));safe(restarted.activityPage(chat.id));check(kind+'：恢复后 HTTP/WS/跨页/重启隐藏旧包线索与阶段诊断，不回退用量、不改原活动');
 }
 const portable=portableSettings(f.config);assert.equal(portable.twoStage,true);const {twoStage:_,renderRetries:__,...legacy}=portable;const bytes=JSON.stringify(legacy);assert.equal(JSON.stringify(parsePortableSettings(legacy)),bytes);assert.equal(applyPortableSettings(f.config,legacy).twoStage,false);assert.equal(applyPortableSettings(f.config,legacy).renderRetries,0);check('便携设置保留新开关，旧归档校验内容不变，恢复默认单阶段');
 assert.deepEqual(f.problems,[]);
}finally{ws.terminate();server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));await f.close();}
console.log(`${checks} 组叙事恢复检查通过：${f.run}`);
