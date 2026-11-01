/** Temporary task authorization must not survive through diagnostic history. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import {once} from 'node:events';
import {createHash} from 'node:crypto';
import type {AddressInfo} from 'node:net';
import {WebSocket} from 'ws';
import type {GenerationRecordDto} from '@pitavern/shared';
import {createHttpApp} from '../src/api/http.ts';
import {attachWebSocket} from '../src/api/ws.ts';
import {ActivityStore,emptyUsage} from '../src/stdata/activity.ts';
import {ChatStore} from '../src/stdata/chats.ts';
import {SessionManager} from '../src/session/manager.ts';
import {buildModels} from '../src/providers/models.ts';
import {WorldState,createInitialWorldSnapshot,createWorldTemplateRecord} from '../src/world/state.ts';
import {WorldTransaction} from '../src/world/transaction.ts';
import {twoStageFixture,actions,submit} from './two-stage-fixture.ts';
const raw=JSON.parse(fs.readFileSync(new URL('./fixtures/quest-tavern.json',import.meta.url),'utf8'));
raw.quests[1].openConditions=[{type:'has_item',itemId:'sword',quantity:1}];
const query={name:'world_query',args:{section:'all'}},attempt={name:'world_quest',args:{questId:'sealed_quest',action:'advance'}},giveBack={name:'world_command',args:{commandId:'give-back',type:'transfer_item',fromId:'player',toId:'innkeeper',itemId:'sword',quantity:1}};
let checks=0;const check=(s:string)=>{checks++;console.log('✓ '+s);};
const record=createWorldTemplateRecord(raw),initial=createInitialWorldSnapshot(record),tx=new WorldTransaction(new WorldState(initial,{[record.contentHash]:record}),1);
tx.execute(actions[0].args);tx.execute(giveBack.args);assert.equal(tx.questViewsChanged,true);tx.discard();assert.equal(tx.questViewsChanged,true);check('事务直接记录开放再关闭，回调前已回到原视角或撤销均不抹掉混合来源');
const f=await twoStageFixture(raw);
async function serve(sessions:SessionManager){
 const server=http.createServer(createHttpApp({config:f.config,modelsRef:{current:f.models},characters:f.cards,chats:f.chats,sessions,stDataDir:f.data,webDistDir:null}));attachWebSocket(server,sessions);server.listen(0,'127.0.0.1');await once(server,'listening');
 const base=`http://127.0.0.1:${(server.address() as AddressInfo).port}`,ws=new WebSocket(base.replace('http:','ws:')+'/ws');await once(ws,'open');
 const waitSnapshot=(id:string,mustStart=false)=>new Promise<any>((resolve,reject)=>{let started=!mustStart;const timer=setTimeout(()=>{ws.off('message',listener);reject(new Error('WS timeout'));},10000);const listener=(data:unknown)=>{const e=JSON.parse(String(data));if(e.chatId===id&&(e.type==='chat.started'||e.type==='chat.regenerating'))started=true;if(started&&e.chatId===id&&e.type==='chat.snapshot'&&!e.snapshot.running){clearTimeout(timer);ws.off('message',listener);resolve(e.snapshot);}};ws.on('message',listener);});
 return {base,ws,async sync(id:string){const done=waitSnapshot(id);ws.send(JSON.stringify({type:'chat.sync',chatId:id}));return done;},async send(id:string,text:string){const done=waitSnapshot(id,true);ws.send(JSON.stringify({type:'chat.send',chatId:id,text}));return done;},async close(){ws.terminate();server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}};
}
const api=await serve(f.sessions),targets:Array<{id:string;record:GenerationRecordDto;pages:number}>=[];
const safe=(value:unknown)=>{const text=JSON.stringify(value);for(const secret of ['sealed_quest','绝密未开放任务','绝密未来目标','绝密内部规则备注'])assert.ok(!text.includes(secret),'leaked '+secret);};
function retained(actual:GenerationRecordDto,original:GenerationRecordDto){
 assert.equal(actual.contentHidden,true);assert.equal(actual.context,undefined);assert.ok(actual.stages?.every(s=>s.context===undefined)??true);assert.ok(actual.tools.every(t=>Object.keys(t.args as object).length===0));
 for(const key of ['id','version','status','usage','provider','model','startedAt','finishedAt'] as const)assert.deepEqual(actual[key],original[key]);
 assert.deepEqual(actual.stages?.map(({context,...s})=>s),original.stages?.map(({context,...s})=>s));
}
async function outlets(server:Awaited<ReturnType<typeof serve>>,target:typeof targets[number]){
 const snapshot=await fetch(server.base+'/api/chats/'+encodeURIComponent(target.id)).then(r=>r.json());safe(snapshot);safe(await server.sync(target.id));
 let before:string|null=null,pages=0,found=false;do{const page:any=await fetch(server.base+'/api/chat/activity?chatId='+encodeURIComponent(target.id)+(before?'&before='+encodeURIComponent(before):'')).then(r=>r.json());safe(page);const row=page.records.find((r:GenerationRecordDto)=>r.id===target.record.id);if(row){retained(row,target.record);found=true;}before=page.before;pages++;}while(before);assert.equal(found,true);assert.equal(pages,target.pages);
}
function disk(id:string){const dir=path.join(f.data,'.pitavern/activity',createHash('sha256').update(id).digest('hex'));return Object.fromEntries(fs.readdirSync(dir).sort().map(name=>[name,createHash('sha256').update(fs.readFileSync(path.join(dir,name))).digest('hex')]));}
try{
 for(const mode of ['simple','bridge','takeover'] as const)for(const dual of [false,true]){
  f.config.contextMode=mode;f.config.twoStage=dual;const chat=f.chat(),key=f.sessions.snapshot(chat.id)!.world!.snapshot!.questKey;
  f.plan(mode+' temporary task '+dual,[{calls:[actions[0]]},{calls:[query,attempt],inspect:body=>assert.ok(JSON.stringify(body).includes('sealed_quest'))},{calls:[giveBack]},...(dual?[{calls:[submit]}]:[]),{text:'已完成临时调查并归还长剑。'}]);
  safe(await api.send(chat.id,'临时调查并归还长剑'));const store=new ActivityStore(f.data),original=store.page(chat.id).records[0],world=f.sessions.snapshot(chat.id)!.world!.snapshot!;
  assert.equal(original.status,'succeeded');assert.equal(original.questKey,key);assert.equal(world.questKey,key);assert.equal(original.questScope?.mixed,true);assert.equal(world.money.player,83);assert.equal(world.money.innkeeper,117);assert.deepEqual(f.chats.readWorld(chat.id)!.snapshot.questStates,[]);assert.ok(original.tools.some(t=>JSON.stringify(t.args).includes('sealed_quest')));assert.ok(original.usage.totalTokens>0);
  const target={id:chat.id,record:original,pages:1};if(targets.length===0){for(let i=0;i<21;i++){f.plan('page filler '+i,[...(dual?[{calls:[submit]}]:[]),{text:'安静等待。'}]);await f.sessions.send(chat.id,'等待');}target.pages=2;}
  const hashes=disk(chat.id),source=f.chats.readSource(chat.id).source,usage=new ActivityStore(f.data).snapshot(chat.id,0).usage;
  await outlets(api,target);retained(f.sessions.activityPage(chat.id,target.pages===2?f.sessions.activityPage(chat.id).before!:undefined).records.find(r=>r.id===original.id)!,original);assert.deepEqual(disk(chat.id),hashes);assert.equal(f.chats.readSource(chat.id).source,source);assert.deepEqual(new ActivityStore(f.data).snapshot(chat.id,0).usage,usage);targets.push(target);check(mode+(dual?'双阶段':'单阶段')+'：实际WS开放→查询/拒绝推进→关闭，HTTP/WS/分页不漏，原始记录及用量不变');
 }
 f.config.contextMode='simple';f.config.twoStage=false;const batch=f.chat();f.plan('parallel task scope',[{calls:[actions[0],query,attempt,giveBack]},{text:'已归还长剑。'}]);safe(await api.send(batch.id,'同批执行临时调查并归还'));const batchRecord=new ActivityStore(f.data).page(batch.id).records[0];assert.equal(batchRecord.status,'succeeded');assert.equal(batchRecord.questScope?.mixed,true);assert.equal(f.chats.readWorld(batch.id)!.snapshot.money.player,83);const batchTarget={id:batch.id,record:batchRecord,pages:1};await outlets(api,batchTarget);targets.push(batchTarget);check('单批并行工具的中间视角也由事务捕获，最终相同指纹仍隐藏整轮内容');
 const fresh=new SessionManager(f.config,()=>buildModels(f.config),f.cards,new ChatStore(f.data),f.data),restarted=await serve(fresh);
 try{for(const target of targets){const hashes=disk(target.id);await outlets(restarted,target);safe(fresh.activityPage(target.id));assert.deepEqual(disk(target.id),hashes);}check('重启后重新读取持久化混合来源，三模式及并行流程HTTP/WS与第二页继续过滤，不改原始文件');}finally{await restarted.close();}
 for(const dual of [false,true]){
  f.config.twoStage=dual;const chat=f.chat();f.plan('single view '+dual,[{calls:[query]},...(dual?[{calls:[submit]}]:[]),{text:'世界没有变化。'}]);await f.sessions.send(chat.id,'查看任务日志');const run=f.sessions.activityPage(chat.id).records[0];assert.equal(run.contentHidden,undefined);assert.equal(run.questScope?.mixed,false);assert.ok(run.context);assert.equal((run.tools[0].args as {section:string}).section,'all');check((dual?'双阶段':'单阶段')+'稳定视角继续显示工具和诊断');
 }
 // Older v3 ledgers cannot prove whether their final key covered all content.
 const legacy=f.chat(),store=new ActivityStore(f.data),view=f.sessions.snapshot(legacy.id)!.world!.snapshot!;
 const old:GenerationRecordDto={id:store.createId(legacy.id),version:0,userMessageId:'legacy',kind:'send',provider:'fixture',model:'fixture',status:'succeeded',startedAt:new Date().toISOString(),usage:{...emptyUsage(),input:7,totalTokens:7},knowledgeKey:view.knowledgeKey,questKey:view.questKey,tools:[{key:'legacy-tool',toolCallId:'legacy',toolName:'world_quest',args:{questId:'sealed_quest',action:'advance'},status:'error',summary:'绝密未开放任务'}]};store.save(legacy.id,old);
 const before=disk(legacy.id),loaded=new SessionManager(f.config,()=>buildModels(f.config),f.cards,new ChatStore(f.data),f.data);safe(loaded.snapshot(legacy.id));retained(loaded.activityPage(legacy.id).records[0],old);assert.deepEqual(disk(legacy.id),before);check('旧v3最终指纹即使匹配也保守隐藏；用量、状态和原始记录保持兼容');
 assert.deepEqual(f.problems,[]);fs.writeFileSync(path.join(f.run,'quest-activity.json'),JSON.stringify({checks,targets:targets.map(t=>({chatId:t.id,recordId:t.record.id,pages:t.pages,usage:t.record.usage})),realProvider:'not_requested'},null,2)+'\n');
}finally{await api.close();await f.close();}
console.log(`${checks} 组任务活动来源检查通过：${f.run}`);
