import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import {once} from "node:events";
import type {AddressInfo} from "node:net";
import {WebSocket} from "ws";
import {WORLD_STATE_KEY as K} from "@pitavern/shared/world";
import {createHttpApp} from "../src/api/http.ts";
import {attachWebSocket} from "../src/api/ws.ts";
import {ChatImportService} from "../src/stdata/chat-import.ts";
import {ChatStore} from "../src/stdata/chats.ts";
import {SessionManager} from "../src/session/manager.ts";
import {ActivityStore} from "../src/stdata/activity.ts";
import {buildModels} from "../src/providers/models.ts";
import {planChatWorldMigration} from "../src/world/chat-migration.ts";
import {createWorldTemplateRecord} from "../src/world/state.ts";
import {twoStageFixture,actions,submit} from "./two-stage-fixture.ts";
const raw=JSON.parse(fs.readFileSync(new URL("./fixtures/schedule-tavern.json",import.meta.url),"utf8"));
raw.actionTime={moveMinutes:10,interactionMinutes:10,tradeMinutes:5,questAdvanceMinutes:5};
raw.quests[1].openConditions=[{type:"npc_present",actorId:"innkeeper"}];
const f=await twoStageFixture(raw);f.config.twoStage=true;
const wait=(minutes:number)=>({name:"world_command",args:{commandId:"wait-"+minutes,type:"advance_time",minutes}});
const move=(locationId:string)=>({name:"world_command",args:{commandId:"move-"+locationId,type:"move_to",actorId:"player",locationId}});
const quest=(action="advance")=>({name:"world_quest",args:{questId:"cellar_sword",action}});
const finish=[{calls:[submit]},{text:"依据真实状态继续。"}];
let checks=0;const check=(s:string)=>{checks++;console.log("✓ "+s);};
const serve=async(sessions:SessionManager)=>{
 const server=http.createServer(createHttpApp({config:f.config,modelsRef:{current:f.models},characters:f.cards,chats:f.chats,sessions,stDataDir:f.data,webDistDir:null}));attachWebSocket(server,sessions);server.listen(0,"127.0.0.1");await once(server,"listening");
 const base=`http://127.0.0.1:${(server.address() as AddressInfo).port}`,ws=new WebSocket(base.replace("http:","ws:")+"/ws");await once(ws,"open");
 return {base,async sync(chatId:string){const done=new Promise<any>((resolve,reject)=>{const timer=setTimeout(()=>reject(Error("WS timeout")),5000);const listener=(raw:unknown)=>{const e=JSON.parse(String(raw));if(e.type==="chat.snapshot"&&e.chatId===chatId){clearTimeout(timer);ws.off("message",listener);resolve(e.snapshot);}};ws.on("message",listener);});ws.send(JSON.stringify({type:"chat.sync",chatId}));return done;},async close(){ws.terminate();server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}};
};
const api=await serve(f.sessions);
try{
 const chat=f.chat();f.plan("timed prepare",[{calls:[quest("accept"),actions[0],actions[2],quest()]},...finish]);await f.sessions.send(chat.id,"接案调查");const prior=f.chats.readWorld(chat.id)!.snapshot;assert.equal(prior.clockMinutes,20);
 f.plan("timed completion",[{calls:[wait(10),quest()]},...finish]);await f.sessions.send(chat.id,"等待返回交付");const completed=f.chats.readChat(chat.id)!.at(-1)!,world=f.chats.readWorld(chat.id)!.snapshot,user=f.chats.readChat(chat.id)!.filter(l=>l.is_user).at(-1)!;assert.equal(world.clockMinutes,35);
 f.plan("timed alternative",finish);await f.sessions.regenerate(chat.id,String(completed.extra!.messageId),completed.mes);assert.deepEqual(f.chats.readWorld(chat.id)!.snapshot,prior);
 f.sessions.selectReply(chat.id,String(user.extra!.messageId),0,f.chats.revisionId(chat.id));assert.deepEqual(f.chats.readWorld(chat.id)!.snapshot,world);
 f.plan("timed hidden continuation",[{calls:[move("square")]},...finish]);await f.sessions.send(chat.id,"去广场");const continuation=f.chats.readWorld(chat.id)!.snapshot;assert.equal(continuation.clockMinutes,45);
 f.sessions.selectReply(chat.id,String(user.extra!.messageId),1,f.chats.revisionId(chat.id));assert.equal(f.chats.readWorld(chat.id)!.snapshot.clockMinutes,20);
 f.sessions.selectReply(chat.id,String(user.extra!.messageId),0,f.chats.revisionId(chat.id));assert.deepEqual(f.chats.readWorld(chat.id)!.snapshot,continuation);
 check("候选与隐藏后续分别恢复20/35/45分钟、NPC位置、日程进度及一次奖励");
 let full=f.chats.readSource(chat.id).source;
 const imported=new ChatImportService(f.data,f.chats,f.cards).import(Buffer.from(full),{fileName:"timed.jsonl",character:"掌柜"});
 const restarted=new SessionManager(f.config,()=>buildModels(f.config),f.cards,new ChatStore(f.data),f.data);assert.deepEqual(f.chats.readWorld(imported.id)!.snapshot,continuation);assert.equal(restarted.snapshot(imported.id)!.world!.snapshot!.clockMinutes,45);assert.equal(restarted.snapshot(imported.id)!.rewrite!.enabled,true);
 check("JSONL导出/导入/重启保留自动计时快照与叙事包，不额外执行日程");
 f.sessions.selectReply(chat.id,String(user.extra!.messageId),1,f.chats.revisionId(chat.id));full=f.chats.readSource(chat.id).source;const migrationWorld=f.chats.readWorld(chat.id)!.snapshot;
 const entry=f.sessions.worldTemplateLibrary.list()[0],editor=f.sessions.worldTemplateLibrary.get(entry.id)!,changed=structuredClone(f.raw);changed.templateVersion++;changed.actionTime.moveMinutes=5;
 const saved=f.sessions.worldTemplateLibrary.saveDraft(entry.id,editor.draftRevision,{name:editor.name,template:changed}),published=f.sessions.worldTemplateLibrary.publish(entry.id,saved.draftRevision);
 const preview=f.sessions.previewChatWorldMigration(chat.id,published.publishedHash!);assert.equal(preview.applyable,true);assert.ok(preview.locations.some(l=>l.kind==="continuation"));assert.match(preview.warnings.join(""),/行动耗时/);
 const migrated=f.sessions.applyChatWorldMigration(chat.id,published.publishedHash!,preview.revision,preview.previewHash);const updated=f.chats.readWorld(chat.id)!.snapshot;
 for(const key of ["clockMinutes","actors","money","inventory","knowledge","questStates","scheduleStates"] as const)assert.deepEqual(updated[key],migrationWorld[key]);assert.equal(f.sessions.snapshot(chat.id)!.rewrite!.enabled,false);
 f.chats.restoreBackup(chat.id,migrated.backupId!,f.chats.revisionId(chat.id));assert.equal(f.chats.readSource(chat.id).source,full);assert.equal(f.sessions.snapshot(chat.id)!.rewrite!.enabled,true);
 check("显式改耗时规则全恢复点原子迁移，时钟与进度不变，旧包禁重写；备份逐字节恢复原资格");
 const target=createWorldTemplateRecord(changed),plan=planChatWorldMigration(full,target);assert.equal(plan.applyable,true);
 const lines=full.trim().split("\n").map(l=>JSON.parse(l)),native=structuredClone(lines),line=native.find(l=>l.is_user===false);line.swipes=[line.mes,"原生耗时候选"];line.swipe_id=0;line.swipe_info=[{},{extra:{[K]:world}}];
 const nativeSource=native.map(l=>JSON.stringify(l)).join("\n")+"\n",nativePlan=planChatWorldMigration(nativeSource,target);assert.equal(nativePlan.applyable,true);assert.ok(nativePlan.locations.some(l=>l.kind==="native"));
 for(const damage of [(s:any)=>s.scheduleStates[0].processedThrough=0,(s:any)=>s.questStates[0].completedStages=[]]){const broken=structuredClone(native);damage(broken.find(l=>l.swipe_info).swipe_info[1].extra[K]);const p=planChatWorldMigration(broken.map(l=>JSON.stringify(l)).join("\n")+"\n",target);assert.equal(p.applyable,false);assert.equal(p.nextSource,undefined);}
 check("原生swipe也保存独立耗时；坏日程或任务恢复点阻断整份迁移，无部分写入结果");

 for(const parallel of [false,true]){
  const scoped=f.chat(),key=f.sessions.snapshot(scoped.id)!.world!.snapshot!.questKey;
  const query={name:"world_query",args:{section:"all"}},attempt={name:"world_quest",args:{questId:"sealed_quest",action:"advance"}};
  // Automatic movement closes a task, then a second movement plus explicit wait restores the final view.
  const calls=[query,attempt,move("square"),move("tavern"),wait(10),query];
  f.plan("action scope "+parallel,[...(parallel?[{calls}]:calls.map(c=>({calls:[c]}))),...finish]);await f.sessions.send(scoped.id,"查看临时任务，外出后返回");
  const store=new ActivityStore(f.data),original=store.page(scoped.id).records[0],end=f.sessions.snapshot(scoped.id)!.world!.snapshot!;
  assert.equal(end.clockMinutes,30);assert.equal(end.questKey,key);assert.equal(original.questScope?.mixed,true);assert.ok(JSON.stringify(original.tools).includes("sealed_quest"));
  const hidden=(v:unknown)=>{const text=JSON.stringify(v);for(const token of ["sealed_quest","绝密未开放任务"])assert.ok(!text.includes(token));};
  for(let i=0;i<21;i++){f.plan("timed page "+i,finish);await f.sessions.send(scoped.id,"查看当前地点");}
  const source=f.chats.readSource(scoped.id).source,usage=store.snapshot(scoped.id,0).usage,originalLedger=JSON.stringify(store.page(scoped.id,undefined,100));
  const inspect=async(server:Awaited<ReturnType<typeof serve>>)=>{
    const snapshot=await fetch(server.base+"/api/chats/"+scoped.id).then(r=>r.json());hidden(snapshot.activity);hidden((await server.sync(scoped.id)).activity);
    let cursor:string|null=null,pages=0,found=false;do{const page:any=await fetch(server.base+"/api/chat/activity?chatId="+encodeURIComponent(scoped.id)+(cursor?"&before="+encodeURIComponent(cursor):"")).then(r=>r.json());hidden(page);const row=page.records.find((r:any)=>r.id===original.id);if(row){assert.equal(row.contentHidden,true);assert.deepEqual(row.usage,original.usage);found=true;}cursor=page.before;pages++;}while(cursor);assert.equal(pages,2);assert.equal(found,true);
  };
  await inspect(api);const fresh=new SessionManager(f.config,()=>buildModels(f.config),f.cards,new ChatStore(f.data),f.data),remote=await serve(fresh);try{await inspect(remote);}finally{await remote.close();}
  assert.deepEqual(store.snapshot(scoped.id,0).usage,usage);assert.equal(f.chats.readSource(scoped.id).source,source);assert.equal(JSON.stringify(store.page(scoped.id,undefined,100)),originalLedger);
  check((parallel?"并行":"顺序")+"行动自动耗时触发任务开放→关闭→开放：HTTP/WS/两页活动/重启过滤，原始记录与实际用量不变");
 }
 assert.deepEqual(f.problems,[]);
}finally{await api.close();await f.close();}
console.log(`${checks} 组行动耗时生命周期检查通过：${f.run}`);
