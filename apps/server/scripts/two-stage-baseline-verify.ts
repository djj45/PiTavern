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
const run = fs.mkdtempSync(path.join(root,"two-stage-baseline-"));
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
    if(step.calls)res.end(frame({role:"assistant",tool_calls:step.calls.map((c,index)=>({index,id:`call-${stepIndex}-${index}`,type:"function",function:{name:c.name,arguments:JSON.stringify(c.args)}}))},null)+frame({},"tool_calls")+"data: "+JSON.stringify({id:"usage",choices:[],usage:{prompt_tokens:1000,completion_tokens:100,total_tokens:1100}})+"\n\ndata: [DONE]\n\n");
    else res.end(frame({role:"assistant",content:step.known?"掌柜确认了线索："+fact.text:"旧酒馆仍在维修，旅人继续调查。"},null)+frame({},"stop")+"data: "+JSON.stringify({id:"usage",choices:[],usage:{prompt_tokens:1000,completion_tokens:100,total_tokens:1100}})+"\n\ndata: [DONE]\n\n");
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
try {
  const reports=[];
  const library=sessions.worldTemplateLibrary, blank=library.createBlank("双阶段基线", "酒馆固定场景");raw.templateId=blank.id;
  const saved=library.saveDraft(blank.id,blank.draftRevision,{name:"双阶段基线",template:raw});
  const published=library.publish(blank.id,saved.draftRevision);
  for(const mode of ["simple","bridge","takeover"] as const){
    config.contextMode=mode;
    const chat=chats.createChat("知识向导",null);sessions.initializeChatWorldByHash(chat.id,published.publishedHash!,chats.revisionId(chat.id),false);
    const before=requests, start=performance.now();
    await send(chat.id,mode+" single-stage",[{known:false,calls:[interact,command({commandId:"buy",type:"purchase_item",buyerId:"player",sellerId:"innkeeper",itemId:"sword",quantity:1}),command({commandId:"time",type:"advance_time",minutes:10})]},{known:true}]);
    const state=chats.readWorld(chat.id)!.snapshot;
    assert.equal(state.money.player,83);assert.equal(state.clockMinutes,10);
    assert.equal(state.inventory.find(i=>i.ownerId==="player"&&i.itemId==="sword")?.quantity,1);assert.ok(owns(chat.id));
    assert.equal(requests-before,2);
    reports.push({mode,requests:requests-before,elapsedMs:performance.now()-start,usage:sessions.activityPage(chat.id).records[0].usage});
    check(mode+"：单阶段两次请求；余额83、长剑1、时间10、密道已知");
  }
  fs.writeFileSync(path.join(run,"baseline.json"),JSON.stringify({reports,realProvider:"not_requested",quality:"not_evaluated"},null,2)+"\n");
} finally {
  ws.terminate();server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));
  mock.closeAllConnections();await new Promise<void>(resolve=>mock.close(()=>resolve()));
}
console.log(`${checks} 组单阶段基线通过：${run}`);
