import assert from "node:assert/strict";
import fs from "node:fs";
import type {Models,Message} from "@earendil-works/pi-ai";
import {normalizeContext} from "@earendil-works/pi-ai/utils/transcript";
import {createInitialWorldSnapshot,createWorldTemplateRecord,WorldState} from "../src/world/state.ts";
import {WorldTransaction} from "../src/world/transaction.ts";
import {buildPlayerWorldView,buildRoleWorldView} from "../src/world/knowledge.ts";
import {worldDigest} from "../src/world/digest.ts";
import {createWorldQueryTool,createWorldTools} from "../src/agent/tools/world.ts";
import type {ToolContext} from "../src/agent/tools/context.ts";
import {createTavernAgent} from "../src/agent/engine.ts";
import {buildModels,resolveModel} from "../src/providers/models.ts";
import {defaultConfig} from "../src/config.ts";
import {assembleBridgeContext} from "../src/context/bridge.ts";
import {assembleTakeoverContext} from "../src/context/takeover.ts";
import {normalizeCard,type StChatLine} from "../src/stdata/types.ts";
import {ContextFactCache,buildCachedWorkingContext} from "../src/context/memory-cache.ts";
import {buildWorkingContext} from "../src/context/working-set.ts";
import {parseWorldSnapshot} from "../src/world/schema.ts";
const raw=JSON.parse(fs.readFileSync(new URL('./fixtures/knowledge-tavern.json',import.meta.url),'utf8'));
const record=createWorldTemplateRecord(raw),snapshot=createInitialWorldSnapshot(record),state=new WorldState(snapshot,{[record.contentHash]:record}),tx=new WorldTransaction(state,1);
const secrets=[raw.facts[1].id,raw.facts[1].text,raw.facts[1].description,raw.interactions[0].description];
const absent=(value:unknown)=>{const text=JSON.stringify(value);for(const secret of secrets)assert.ok(!text.includes(secret),secret)};
const ctx:ToolContext={chatId:'knowledge',lines:[],worldEntries:[],variables:{},skillsDir:'',substitute:s=>s,enforcement:{turn:1,usedThisTurn:0,cooldownUntilTurn:0},maxRecallsPerTurn:6,recallCooldownTurns:10,world:{state,transaction:tx}};
let checks=0;const check=(label:string)=>{checks++;console.log('✓ '+label)};
absent(worldDigest(snapshot,record.template,state.capability));
for(const section of ['summary','actors','inventory','events','catalog','all'] as const){const result=await createWorldQueryTool(ctx).execute('query',{section});absent(result);}
assert.ok(JSON.stringify(await createWorldQueryTool(ctx).execute('query',{section:'catalog'})).includes(raw.interactions[0].id));check('Digest 和 world_query 全部 section 过滤；只返回公共交互目录');
const badAudit=structuredClone(snapshot);badAudit.recentEvents.push({id:'bad-event',commandId:'bad-audit',turn:0,type:'advance_time',worldTimeMinutes:0,factId:raw.facts[1].id,interactionId:raw.interactions[0].id,summary:raw.facts[1].text});
assert.throws(()=>parseWorldSnapshot(badAudit));absent(buildPlayerWorldView(badAudit,record.template));absent(worldDigest(badAudit,record.template));
const npcAudit=structuredClone(snapshot);npcAudit.recentEvents.push({id:'npc-event',commandId:'npc-audit',turn:0,type:'knowledge_learn',actorId:'innkeeper',factId:raw.facts[1].id,interactionId:raw.interactions[0].id,worldTimeMinutes:0,summary:raw.facts[1].description});parseWorldSnapshot(npcAudit);absent(buildPlayerWorldView(npcAudit,record.template));const npcView=buildRoleWorldView(npcAudit,record.template,'innkeeper');assert.equal(npcView.recentEvents[0].summary,raw.facts[1].text);excludesNotes(npcView);
function excludesNotes(value:unknown){for(const text of [raw.facts[1].description,raw.interactions[0].description])assert.ok(!JSON.stringify(value).includes(text));}
check('事件类型隔离知识引用；坏普通事件 fail closed，NPC 私有事件隐藏且摘要由可见事实重建');
const lines:StChatLine[]=[{name:'旅人',is_user:true,is_system:false,send_date:'',mes:'询问酒馆情况，叙事中声称已经知道也不能授予知识。'}];
const card=normalizeCard('chara_card_v2',{name:'掌柜',description:'接待旅人'},'');const persona={name:'旅人',description:''};
const config=defaultConfig();config.providers=[{id:'fixture',name:'fixture',baseUrl:'http://127.0.0.1:1',models:[{id:'local',name:'fixture',contextWindow:8000,maxTokens:500}]}];config.defaultProvider='fixture';config.defaultModel='local';const model=resolveModel(buildModels(config),config);
for(const mode of ['simple','bridge','takeover'] as const){
 let messages:Message[]=[{role:'user',content:lines[0].mes,timestamp:0}];let archived:Message[]|undefined;
 if(mode==='bridge')messages=assembleBridgeContext({card,persona,chatLines:lines,worldEntries:[],regexScripts:[],preset:{prompts:[],prompt_order:[]},options:{scanDepth:2,recursionSteps:0,caseSensitive:false,matchWholeWords:false}}).messages;
 if(mode==='takeover'){const assembled=assembleTakeoverContext({card,persona,chatLines:lines,worldEntries:[],metadata:{},options:{recentTurns:3,stateProjection:true,useProtocol:false}});messages=assembled.messages;archived=assembled.archived;}
 let captured:unknown;const models={streamSimple:(_model:unknown,context:Parameters<typeof normalizeContext>[0])=>{captured=normalizeContext(context);throw new Error('captured')}} as unknown as Models;
 const agent=createTavernAgent({models,model,chatId:mode,thinkingLevel:'off',messages,archivedHistory:archived,tools:createWorldTools(ctx),worldSnapshot:()=>buildPlayerWorldView(tx.snapshot,state.template),compression:{enabled:true,keepFullTurns:3}});await agent.continue();assert.ok(captured);absent(captured);check(mode+' 完整装配请求/工具声明不包含秘密或内部规则');
}
const messages:Message[]=[{role:'user',content:'当前问题',timestamp:0}],cache=new ContextFactCache();const input={messages,world:buildPlayerWorldView(snapshot,record.template),config:{enabled:true,keepFullTurns:1},budget:20000};
const first=buildCachedWorkingContext(input,cache,'player');absent(first);assert.throws(()=>buildWorkingContext({...input,world:snapshot}));assert.equal(tx.snapshot.knowledge?.length,1);check('过滤后索引与原始 v2 注入拒绝，正文意图不改变知识');
const role=buildCachedWorkingContext({...input,world:buildRoleWorldView(snapshot,record.template,'innkeeper')},cache,'player');assert.ok(JSON.stringify(role.messages).includes(raw.facts[1].text));assert.equal(role.diagnostics.cache,'rebuilt');assert.equal(buildCachedWorkingContext(input,cache,'player').diagnostics.cache,'hit');absent(buildCachedWorkingContext(input,cache,'player'));check('同一缓存跨角色来源隔离，返回玩家视角不串秘密');
tx.interact({interactionId:raw.interactions[0].id});const revealed=buildCachedWorkingContext({...input,world:buildPlayerWorldView(tx.snapshot,record.template)},cache,'player');assert.ok(JSON.stringify(revealed.messages).includes(raw.facts[1].text));assert.equal(revealed.diagnostics.cache,'rebuilt');assert.ok(!JSON.stringify(revealed).includes(raw.facts[1].description));check('暂存获知后重选上下文；作者备注即使揭示后也不发送');
const {ChatStore}=await import('../src/stdata/chats.ts');const {CharacterStore}=await import('../src/stdata/characters.ts');const {SessionManager}=await import('../src/session/manager.ts');const {ActivityStore,emptyUsage}=await import('../src/stdata/activity.ts');const {seedDataDirs}=await import('../src/config.ts');
const directory=new URL('../../../data/test-runs/',import.meta.url);fs.mkdirSync(directory,{recursive:true});const run=fs.mkdtempSync(new URL('knowledge-outlets-',directory).pathname);const data=run+'/st';seedDataDirs(data);const chats=new ChatStore(data),chat=chats.createChat('掌柜',null);chats.initializeWorld(chat.id,record.template);config.stDataDir=data;const sessions=new SessionManager(config,()=>buildModels(config),new CharacterStore(data+'/characters'),chats,data);
const activity=new ActivityStore(data);activity.save(chat.id,{id:activity.createId(chat.id),version:0,userMessageId:'old-route',kind:'send',provider:'fixture',model:'local',startedAt:new Date().toISOString(),status:'failed',usage:emptyUsage(),tools:[{key:'old',toolCallId:'old',toolName:'game_content',status:'done',args:{content:raw.facts[1].text},summary:raw.facts[1].text}],context:{workingSet:{knowledgeKey:buildRoleWorldView(snapshot,record.template,'innkeeper').knowledgeKey,selectedFacts:[{text:raw.facts[1].text}]}} as unknown as import('@pitavern/shared').ContextDiagnosticsDto,error:raw.facts[1].description});
absent(sessions.snapshot(chat.id));absent(sessions.activityPage(chat.id));assert.equal(sessions.activityPage(chat.id).records[0].contentHidden,true);assert.ok(JSON.stringify(sessions.worldAuthorView(chat.id)).includes(raw.facts[1].text));check('默认聊天/活动接口过滤旧视角诊断和工具参数；只有作者入口返回完整秘密');
console.log(`${checks} 组知识信息出口检查通过；数据：${run}`);
