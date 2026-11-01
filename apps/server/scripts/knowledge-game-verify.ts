/** Full local-provider requests, real tools/transactions and restore points. No external provider. */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { WebSocket } from "ws";
import type { WorldTemplate } from "@pitavern/shared/world";
import type { ServerEvent } from "@pitavern/shared";
import { ActivityStore } from "../src/stdata/activity.ts";
import { ChatStore } from "../src/stdata/chats.ts";
import { CharacterStore } from "../src/stdata/characters.ts";
import { ChatImportService } from "../src/stdata/chat-import.ts";
const root = path.resolve(import.meta.dirname, "../../../data/test-runs");
fs.mkdirSync(root, {recursive:true});
const run = fs.mkdtempSync(path.join(root,"knowledge-game-"));
process.env.PITAVERN_CONFIG = path.join(run,"config.json");
const {defaultConfig,seedDataDirs} = await import("../src/config.ts");
const {buildModels} = await import("../src/providers/models.ts");
const {SessionManager} = await import("../src/session/manager.ts");
const {createHttpApp} = await import("../src/api/http.ts");
const {attachWebSocket} = await import("../src/api/ws.ts");
const raw:WorldTemplate = JSON.parse(fs.readFileSync(new URL("./fixtures/knowledge-tavern.json",import.meta.url),"utf8"));
const fact = raw.facts![1], interaction = raw.interactions![0];
const privateNotes = [fact.description!, interaction.description!];
function excludes(value:unknown, secrets:string[]) {const text=JSON.stringify(value);for(const secret of secrets)assert.ok(!text.includes(secret),"unexpected private content: "+secret);}
type Call = {name:string;args:unknown};
type Step = {known:boolean; calls?:Call[]; result?:string; failure?:boolean; pause?:boolean};
let steps:Step[]=[], stepIndex=0, label="", requests=0;
let paused:()=>void=()=>{};
const problems:string[]=[];
const frame=(delta:object,finish:string|null)=>"data: "+JSON.stringify({id:"knowledge-local",object:"chat.completion.chunk",created:1,model:"fixture",choices:[{index:0,delta,finish_reason:finish}]})+"\n\n";
const mock=http.createServer(async(req,res)=>{
  try {
    let text="";for await(const part of req)text+=part;
    const body=JSON.parse(text), step=steps[Math.min(stepIndex++,steps.length-1)];requests++;
    fs.appendFileSync(path.join(run,"requests.ndjson"),JSON.stringify({label,step:stepIndex,body})+"\n");
    assert.ok(step,"unexpected request");excludes(body,privateNotes);
    if(!step.known)excludes(body,[fact.id,fact.text]);
    else assert.ok(JSON.stringify(body.messages).includes(fact.text),"staged/current knowledge must reach the next request");
    const calls=new Set(body.messages.flatMap((m:{tool_calls?:Array<{id:string}>})=>m.tool_calls?.map(c=>c.id)??[]));
    for(const message of body.messages)if(message.role==="tool")assert.ok(calls.has(message.tool_call_id),"orphan tool result");
    if(step.result)assert.ok(JSON.stringify(body.messages).includes(step.result),"previous tool result must be preserved: "+step.result);
    if(step.failure){res.writeHead(400,{"Content-Type":"application/json"});res.end(JSON.stringify({error:{message:privateNotes.join(" ")+fact.text}}));return;}
    res.writeHead(200,{"Content-Type":"text/event-stream"});
    if(step.pause){res.flushHeaders();paused();return;}
    if(step.calls)res.end(frame({role:"assistant",tool_calls:step.calls.map((c,index)=>({index,id:`call-${stepIndex}-${index}`,type:"function",function:{name:c.name,arguments:JSON.stringify(c.args)}}))},null)+frame({},"tool_calls")+"data: [DONE]\n\n");
    else res.end(frame({role:"assistant",content:step.known?"掌柜确认了线索："+fact.text:"旧酒馆仍在维修，旅人继续调查。"},null)+frame({},"stop")+"data: [DONE]\n\n");
  }catch(error){problems.push(String(error));res.writeHead(400);res.end(JSON.stringify({error:{message:String(error)}}));}
});
mock.listen(0,"127.0.0.1");await once(mock,"listening");
const data=path.join(run,"st");seedDataDirs(data);
fs.writeFileSync(path.join(data,"characters/guide.json"),JSON.stringify({name:"知识向导",description:"酒馆接待员，仅叙述已授权的事实。"}));
fs.writeFileSync(path.join(data,"OpenAI Settings/context.json"),JSON.stringify({prompts:[{identifier:"chatHistory",marker:true}],prompt_order:[{character_id:100001,order:[{identifier:"chatHistory",enabled:true}]}]}));
const config=defaultConfig();config.stDataDir=data;
config.providers=[{id:"fixture",name:"本地合成",apiKey:"synthetic-only",baseUrl:`http://127.0.0.1:${(mock.address() as AddressInfo).port}/v1`,models:[{id:"fixture",name:"fixture",contextWindow:20000,maxTokens:500}]}];
config.defaultProvider="fixture";config.defaultModel="fixture";config.outputProtocol="native";config.toolsEnabled=true;config.branches.autoGenerate=0;config.activePreset="context";config.compression={enabled:true,keepFullTurns:3};
const chats=new ChatStore(data),cards=new CharacterStore(path.join(data,"characters"));
const sessions=new SessionManager(config,()=>buildModels(config),cards,chats,data);
const events:ServerEvent[]=[];sessions.onEvent(event=>events.push(event));
const server=http.createServer(createHttpApp({config,modelsRef:{current:buildModels(config)},characters:cards,chats,sessions,stDataDir:data,webDistDir:null}));
attachWebSocket(server,sessions);server.listen(0,"127.0.0.1");await once(server,"listening");
const base=`http://127.0.0.1:${(server.address() as AddressInfo).port}`;
const ws=new WebSocket(base.replace("http:","ws:")+"/ws");const wire:unknown[]=[];ws.on("message",data=>wire.push(JSON.parse(String(data))));await once(ws,"open");
let checks=0;const check=(message:string)=>{checks++;console.log("✓ "+message)};
const interact:Call={name:"world_interact",args:{interactionId:interaction.id}};
const query=(section:string):Call=>({name:"world_query",args:{section}});
const command=(args:object):Call=>({name:"world_command",args});
const owns=(chatId:string)=>chats.readWorld(chatId)!.snapshot.knowledge!.some(k=>k.actorId==="player"&&k.factId===fact.id);
function plan(name:string,next:Step[]){label=name;steps=next;stepIndex=0;}
async function send(chatId:string,name:string,next:Step[]){plan(name,next);await sessions.send(chatId,"询问掌柜并核对当前世界。");assert.deepEqual(problems,[]);assert.equal(stepIndex,next.length);}
async function visible(chatId:string,known:boolean){
  const response=await fetch(base+"/api/chats/"+chatId);assert.equal(response.status,200);const body=await response.json();
  excludes(body,privateNotes);excludes(sessions.activityPage(chatId),privateNotes);
  // Branch selectors retain previously written prose. It is not knowledge authorization,
  // nor model history; the active prose, projected state and diagnostics must be isolated.
  const active=(snapshot:Record<string,unknown>)=>({world:snapshot.world,messages:snapshot.messages,activity:snapshot.activity,stagedMessages:snapshot.stagedMessages});
  if(!known){excludes(body,[fact.id]);excludes(active(body),[fact.text]);excludes(sessions.activityPage(chatId),[fact.id,fact.text]);}
  const before=wire.length;const synced=new Promise<void>((resolve,reject)=>{const timer=setTimeout(()=>{ws.off("message",listener);reject(new Error("WS sync timeout"));},5000);const listener=(data:unknown)=>{const event=JSON.parse(String(data));if(event.type==="chat.snapshot"&&event.chatId===chatId){clearTimeout(timer);ws.off("message",listener);resolve();}};ws.on("message",listener);});
  ws.send(JSON.stringify({type:"chat.sync",chatId}));await synced;const responseEvents=wire.slice(before);excludes(responseEvents,privateNotes);if(!known){excludes(responseEvents,[fact.id]);for(const event of responseEvents as Array<{snapshot?:Record<string,unknown>}>)if(event.snapshot)excludes(active(event.snapshot),[fact.text]);}
}
try{
  const library=sessions.worldTemplateLibrary,blank=library.createBlank("酒馆密道","固定知识场景");raw.templateId=blank.id;
  const saved=library.saveDraft(blank.id,blank.draftRevision,{name:"酒馆密道",template:raw}),published=library.publish(blank.id,saved.draftRevision);
  const next=structuredClone(raw);next.facts!.push({id:"future_clue",text:"旧聊天不得自动获得的新增秘密。",visibility:"restricted"});next.initial.knowledge!.push({actorId:"player",factId:"future_clue"});next.items.find(i=>i.id==="sword")!.price=23;
  const savedNext=library.saveDraft(blank.id,published.draftRevision,{name:"酒馆密道新版",template:next}),target=library.publish(blank.id,savedNext.draftRevision);
  for(const mode of ["simple","bridge","takeover"] as const){
    config.contextMode=mode;
    const chat=chats.createChat("知识向导",null);sessions.initializeChatWorldByHash(chat.id,published.publishedHash!,chats.revisionId(chat.id),false);
    await visible(chat.id,false);
    await send(chat.id,mode+" reveal",[
      {known:false,calls:["summary","actors","inventory","events","catalog","all"].map(query)},
      {known:false,calls:[{name:"world_interact",args:{interactionId:"unknown_public_action"}}]},
      {known:false,result:"当前无法完成该交互",calls:[interact,interact]},
      {known:true,result:"没有新的知识变化"},
    ]);
    assert.ok(owns(chat.id));let snapshot=chats.readWorld(chat.id)!.snapshot;
    assert.equal(snapshot.knowledge!.filter(k=>k.factId===fact.id).length,2);assert.ok(!snapshot.knowledge!.some(k=>k.actorId==="bystander"));
    assert.equal(snapshot.recentEvents.filter(e=>e.type==="knowledge_learn").length,1);assert.equal(snapshot.money.player,100);
    await visible(chat.id,true);check(mode+"：完整请求/所有查询/HTTP/WS 过滤，暂存揭示、重复幂等且不自动传播");
    const reply=chats.readChat(chat.id)!.at(-1)!,user=chats.readChat(chat.id)!.findLast(l=>l.is_user)!;
    plan(mode+" regenerate-unknown",[
      {known:false,calls:[command({commandId:"give-letter",type:"transfer_item",fromId:"player",toId:"innkeeper",itemId:"letter",quantity:1})]},
      {known:false,calls:[interact]},
      {known:false,result:"当前无法完成该交互"},
    ]);
    await sessions.regenerate(chat.id,String(reply.extra!.messageId),reply.mes);assert.deepEqual(problems,[]);assert.equal(stepIndex,3);assert.equal(owns(chat.id),false);
    const unknownReply=chats.readChat(chat.id)!.at(-1)!;
    await visible(chat.id,false);
    chats.selectReply(chat.id,String(user.extra!.messageId),0,chats.revisionId(chat.id));assert.ok(owns(chat.id));await visible(chat.id,true);
    chats.selectReply(chat.id,String(user.extra!.messageId),1,chats.revisionId(chat.id));assert.equal(owns(chat.id),false);assert.equal(chats.readChat(chat.id)!.at(-1)!.mes,unknownReply.mes);
    await visible(chat.id,false);check(mode+"：重生成从回合前检查点计算、旧候选独立恢复、活动诊断不串知识");
    const mdResponse=await fetch(base+"/api/chats/"+chat.id+"/export?format=md");assert.equal(mdResponse.status,200);const md=await mdResponse.text();excludes(md,privateNotes.concat(fact.text,fact.id));
    const jsonlResponse=await fetch(base+"/api/chats/"+chat.id+"/export?format=jsonl");assert.equal(jsonlResponse.status,200);const jsonl=await jsonlResponse.text();assert.equal(jsonl,fs.readFileSync(chat.file,"utf8"));for(const secret of privateNotes.concat(fact.text,fact.id))assert.ok(jsonl.includes(secret));
    await send(chat.id,mode+" active-history-recall",[{known:false,calls:[{name:"tavern_recall_history",args:{query:"壁炉 密道 旧酒馆",limit:5}},query("all")]},{known:false}]);
    assert.equal(owns(chat.id),false);check(mode+"：历史召回仅使用活动正文；MD 不含另一候选，JSONL 完整保留秘密");
    const before=fs.readFileSync(chat.file,"utf8"),preview=sessions.previewChatWorldMigration(chat.id,target.publishedHash!);assert.equal(preview.applyable,true);assert.equal(fs.readFileSync(chat.file,"utf8"),before);
    const applied=sessions.applyChatWorldMigration(chat.id,target.publishedHash!,preview.revision,preview.previewHash);assert.equal(owns(chat.id),false);
    assert.ok(!chats.readWorld(chat.id)!.snapshot.knowledge!.some(k=>k.factId==="future_clue"));
    chats.restoreBackup(chat.id,applied.backupId!,chats.revisionId(chat.id));assert.equal(fs.readFileSync(chat.file,"utf8"),before);
    const again=sessions.previewChatWorldMigration(chat.id,target.publishedHash!);sessions.applyChatWorldMigration(chat.id,target.publishedHash!,again.revision,again.previewHash);
    const imported=new ChatImportService(data,chats,cards).import(fs.readFileSync(chat.file),{fileName:mode+"-knowledge.jsonl",character:"知识向导"});
    const restarted=new ChatStore(data),fresh=new SessionManager(config,()=>buildModels(config),cards,restarted,data);
    assert.deepEqual(restarted.readWorld(imported.id)!.snapshot,chats.readWorld(chat.id)!.snapshot);
    plan(mode+" import-restart",[{known:false,calls:[query("all")]},{known:false}]);await fresh.send(imported.id,"重新核对账本和已知线索。");assert.deepEqual(problems,[]);
    assert.ok(!restarted.readWorld(imported.id)!.snapshot.knowledge!.some(k=>k.actorId==="player"));
    check(mode+"：备份字节一致恢复、再次迁移、JSONL 导入与重启不凭空授予知识");
    // Return to the already-known candidate; ordinary settlement still uses the migrated price.
    chats.selectReply(chat.id,String(user.extra!.messageId),0,chats.revisionId(chat.id));
    await send(chat.id,mode+" purchase",[{known:true,calls:[interact,command({commandId:"buy",type:"purchase_item",buyerId:"player",sellerId:"innkeeper",itemId:"sword",quantity:1}),command({commandId:"move",type:"move_to",actorId:"player",locationId:"square"})]},{known:true}]);
    snapshot=chats.readWorld(chat.id)!.snapshot;assert.equal(snapshot.money.player,77);assert.equal(snapshot.inventory.find(i=>i.ownerId==="player"&&i.itemId==="sword")?.quantity,1);assert.equal(snapshot.scene.locationId,"square");assert.equal(snapshot.recentEvents.filter(e=>e.type==="knowledge_learn").length,1);
    check(mode+"：已知事实跨回合不重复获知，购买/移动沿用新价格且不破坏库存");
    for(const failure of ["failed","aborted"] as const){
      const rollback=chats.createChat("知识向导",null);sessions.initializeChatWorldByHash(rollback.id,published.publishedHash!,chats.revisionId(rollback.id),false);const beforeState=chats.readWorld(rollback.id)!.snapshot;
      if(failure==="failed")await send(rollback.id,mode+" failure",[{known:false,calls:[interact]},{known:true,failure:true}]);
      else{
        plan(mode+" abort",[{known:false,calls:[interact]},{known:true,pause:true}]);
        let timer:ReturnType<typeof setTimeout>;const ready=new Promise<void>((resolve,reject)=>{paused=resolve;timer=setTimeout(()=>reject(new Error("pause timeout")),10000);});
        const pending=sessions.send(rollback.id,"询问后等待叙述。");try{await ready;assert.equal(sessions.abort(rollback.id),true);await pending;}finally{clearTimeout(timer!);}
      }
      assert.deepEqual(chats.readWorld(rollback.id)!.snapshot,beforeState);assert.equal(owns(rollback.id),false);assert.equal(chats.readChat(rollback.id)!.filter(l=>!l.is_user&&!l.is_system).length,0);
      await visible(rollback.id,false);assert.equal(sessions.activityPage(rollback.id).records[0].status,failure);excludes(events.filter(e=>e.type==="chat.error"&&e.chatId===rollback.id),privateNotes.concat(fact.text));
      check(mode+"：暂存揭示后"+(failure==="failed"?"供应商失败":"停止生成")+"整轮撤销，最终接口/诊断保持未获知");
    }
  }
  config.contextMode="simple";config.outputProtocol="game_tool";
  // v1 upgrades intentionally do not receive NPC initial knowledge. This target
  // uses an authored discovery rule, so the upgraded world can reveal by action.
  const discovery=structuredClone(raw);discovery.interactions![0].conditions=discovery.interactions![0].conditions.filter(c=>c.type!=="knows_fact");
  discovery.interactions![0].effects=[{type:"learn",actorId:"player",factId:fact.id}];
  const discoveryDraft=library.saveDraft(blank.id,target.draftRevision,{name:"恢复回归·发现规则",template:discovery}),discoveryTarget=library.publish(blank.id,discoveryDraft.draftRevision);
  const publicReply:Call={name:"game_content",args:{content:"旧酒馆正在维修，旅人记录了公开见闻。<summary>公开见闻。</summary>"}};
  for(const restoreKind of ["v1","no-world"] as const){
    const chat=chats.createChat("知识向导",null);
    if(restoreKind==="v1"){
      const legacy=structuredClone(raw);legacy.schemaVersion=1;delete legacy.facts;delete legacy.interactions;delete legacy.initial.knowledge;
      chats.initializeWorld(chat.id,legacy);
    }
    await send(chat.id,restoreKind+" public-legacy",[{known:false,calls:[publicReply]}]);
    const legacyRecord=sessions.activityPage(chat.id).records[0],before=fs.readFileSync(chat.file,"utf8");let backupId:string;
    if(restoreKind==="v1"){
      const preview=sessions.previewChatWorldMigration(chat.id,discoveryTarget.publishedHash!);assert.equal(preview.applyable,true);
      backupId=sessions.applyChatWorldMigration(chat.id,discoveryTarget.publishedHash!,preview.revision,preview.previewHash).backupId!;
    }else{
      const previous=new Set(chats.backups(chat.id).backups.map(b=>b.id));
      sessions.initializeChatWorldByHash(chat.id,discoveryTarget.publishedHash!,chats.revisionId(chat.id),true);
      backupId=chats.backups(chat.id).backups.find(b=>!previous.has(b.id))!.id;
    }
    await send(chat.id,restoreKind+" reveal-game-content",[{known:false,calls:[interact]},{known:true,calls:[{name:"game_content",args:{content:fact.text+"<summary>获知密道。</summary>"}}]}]);
    assert.ok(owns(chat.id));assert.ok(chats.readChat(chat.id)!.at(-1)!.mes.includes(fact.text));
    const revealedRecord=sessions.activityPage(chat.id).records[0];assert.ok(JSON.stringify(revealedRecord.tools).includes(fact.text));assert.ok(revealedRecord.context?.workingSet?.knowledgeKey);
    // Put the actual secret-bearing generation on the second HTTP page.
    for(let i=0;i<21;i++)await send(chat.id,restoreKind+" later-public-"+i,[{known:true,calls:[publicReply]}]);
    const beforeActivity=sessions.snapshot(chat.id)!.activity!;
    const broadcast=new Promise<unknown>((resolve,reject)=>{
      const timer=setTimeout(()=>{ws.off("message",listener);reject(new Error("restore broadcast timeout"));},5000);
      const listener=(data:unknown)=>{const event=JSON.parse(String(data));if(event.type==="chat.snapshot"&&event.chatId===chat.id&&(restoreKind==="v1"?event.snapshot.world?.snapshot?.schemaVersion===1:!event.snapshot.world)){clearTimeout(timer);ws.off("message",listener);resolve(event);}};ws.on("message",listener);
    });
    const restored=await fetch(base+"/api/chat/backup/restore",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({chatId:chat.id,backupId,revision:chats.revisionId(chat.id)})});assert.equal(restored.status,200);
    const restoredBroadcast=await broadcast;excludes(restoredBroadcast,privateNotes.concat(fact.id,fact.text));
    fs.writeFileSync(path.join(run,restoreKind+"-restore-ws.json"),JSON.stringify(restoredBroadcast,null,2));
    assert.equal(fs.readFileSync(chat.file,"utf8"),before);assert.equal(chats.readWorld(chat.id)?.snapshot.schemaVersion,restoreKind==="v1"?1:undefined);
    await visible(chat.id,false);
    const response=await fetch(base+"/api/chats/"+chat.id);assert.equal(response.status,200);const snapshot=await response.json();excludes(snapshot,privateNotes.concat(fact.id,fact.text));
    assert.equal(snapshot.activity.totalGenerations,beforeActivity.totalGenerations);assert.deepEqual(snapshot.activity.usage,beforeActivity.usage);assert.deepEqual(snapshot.activity.toolCounts,beforeActivity.toolCounts);
    fs.writeFileSync(path.join(run,restoreKind+"-restored-http.json"),JSON.stringify(snapshot,null,2));
    let cursor:string|null=null;const records:import("@pitavern/shared").GenerationRecordDto[]=[];let pages=0;
    do{
      const url=new URL(base+"/api/chat/activity");url.searchParams.set("chatId",chat.id);if(cursor)url.searchParams.set("before",cursor);
      const response=await fetch(url);assert.equal(response.status,200);const page=await response.json();excludes(page,privateNotes.concat(fact.id,fact.text));records.push(...page.records);cursor=page.before;pages++;
      fs.writeFileSync(path.join(run,restoreKind+"-activity-page-"+pages+".json"),JSON.stringify(page,null,2));
    }while(cursor);
    assert.equal(pages,2);assert.equal(records.length,23);
    const hidden=records.find(r=>r.id===revealedRecord.id)!;assert.equal(hidden.contentHidden,true);assert.equal(hidden.context,undefined);assert.deepEqual(hidden.tools.map(t=>t.args),hidden.tools.map(()=>({})));assert.deepEqual(hidden.usage,revealedRecord.usage);assert.equal(hidden.status,revealedRecord.status);
    assert.deepEqual(records.find(r=>r.id===legacyRecord.id),legacyRecord,"旧 v1 / 无知识视角记录保持兼容");
    const rawRecords=new ActivityStore(data).page(chat.id,undefined,100).records;assert.deepEqual(rawRecords.find(r=>r.id===revealedRecord.id),revealedRecord,"只过滤接口，不清洗或改写本地活动文件");
    const restarted=new SessionManager(config,()=>buildModels(config),cards,new ChatStore(data),data);excludes(restarted.snapshot(chat.id),privateNotes.concat(fact.id,fact.text));excludes(restarted.activityPage(chat.id,records[19].id),privateNotes.concat(fact.id,fact.text));
    check(restoreKind+"：实际交互/game_content 后字节一致恢复，HTTP/WS/跨页活动隐藏旧知识，保留旧记录与用量，重启一致");
  }
}finally{
  ws.terminate();server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));
  mock.closeAllConnections();await new Promise<void>(resolve=>mock.close(()=>resolve()));
}
fs.writeFileSync(path.join(run,"report.json"),JSON.stringify({checks,requests,problems,realProvider:"not_requested",realModelKnowledgeCompliance:"not_evaluated"},null,2)+"\n");
console.log(`${checks} 组知识合成游戏检查通过；完整请求和存档：${run}`);
