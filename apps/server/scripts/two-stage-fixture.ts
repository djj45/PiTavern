/** Local synthetic Chat Completions fixture; never contacts a real provider. */
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import {once} from 'node:events';
import type {AddressInfo} from 'node:net';
import {defaultConfig,seedDataDirs} from '../src/config.ts';
import {buildModels} from '../src/providers/models.ts';
import {ChatStore} from '../src/stdata/chats.ts';
import {CharacterStore} from '../src/stdata/characters.ts';
import {SessionManager} from '../src/session/manager.ts';
export type MockStep={text?:string;calls?:Array<{name:string;args:unknown}>;failure?:boolean;pause?:boolean;length?:boolean;inspect?:(body:any)=>void};
export async function twoStageFixture(template?:unknown){
  const root=path.resolve(import.meta.dirname,'../../../data/test-runs');fs.mkdirSync(root,{recursive:true});
  const run=fs.mkdtempSync(path.join(root,'two-stage-'));process.env.PITAVERN_CONFIG=path.join(run,'config.json');
  let steps:MockStep[]=[],index=0,label='';const requests:any[]=[],problems:string[]=[];
  let paused:()=>void=()=>{};
  const frame=(delta:object,finish:string|null)=>'data: '+JSON.stringify({id:'local',object:'chat.completion.chunk',created:1,model:'fixture',choices:[{index:0,delta,finish_reason:finish}]})+'\n\n';
  const mock=http.createServer(async(req,res)=>{try{
    let text='';for await(const part of req)text+=part;
    const body=JSON.parse(text),step=steps[index++];requests.push({label,body});fs.appendFileSync(path.join(run,'requests.ndjson'),JSON.stringify({label,body})+'\n');
    if(!step)throw new Error('unexpected request '+label+' #'+index);step.inspect?.(body);
    if(step.failure){res.writeHead(400,{'Content-Type':'application/json'});res.end(JSON.stringify({error:{message:'synthetic provider failure'}}));return;}
    res.writeHead(200,{'Content-Type':'text/event-stream'});
    if(step.pause){res.flushHeaders();paused();return;}
    if (typeof body.prompt === 'string') {res.end('data: '+JSON.stringify({id:'text',choices:[{index:0,text:step.text??'文本补全正文',finish_reason:'stop'}],usage:{prompt_tokens:1000,completion_tokens:100,total_tokens:1100}})+'\n\ndata: [DONE]\n\n');return;}
    const delta=step.calls?{role:'assistant',tool_calls:step.calls.map((c,i)=>({index:i,id:`call-${index}-${i}`,type:'function',function:{name:c.name,arguments:JSON.stringify(c.args)}}))}:{role:'assistant',content:step.text??'掌柜迎接旅人。'};
    res.end(frame(delta,null)+frame({},step.length?'length':step.calls?'tool_calls':'stop')+'data: '+JSON.stringify({choices:[],usage:{prompt_tokens:1000,completion_tokens:100,total_tokens:1100}})+'\n\ndata: [DONE]\n\n');
  }catch(e){problems.push(String(e));res.writeHead(400);res.end(JSON.stringify({error:{message:String(e)}}));}});
  mock.listen(0,'127.0.0.1');await once(mock,'listening');
  const data=path.join(run,'st');seedDataDirs(data);
  fs.writeFileSync(path.join(data,'characters/掌柜.json'),JSON.stringify({name:'掌柜',description:'酒馆掌柜，输出中文。'}));
  fs.writeFileSync(path.join(data,'OpenAI Settings/context.json'),JSON.stringify({prompts:[{identifier:'chatHistory',marker:true}],prompt_order:[{character_id:100001,order:[{identifier:'chatHistory',enabled:true}]}]}));
  const config=defaultConfig();config.stDataDir=data;config.activePreset='context';
  config.providers=[{id:'fixture',name:'本地合成',apiKey:'synthetic-only',baseUrl:`http://127.0.0.1:${(mock.address() as AddressInfo).port}/v1`,models:[{id:'fixture',name:'fixture',contextWindow:24000,maxTokens:500}]}];config.defaultProvider='fixture';config.defaultModel='fixture';
  const models=buildModels(config),chats=new ChatStore(data),cards=new CharacterStore(path.join(data,'characters')),sessions=new SessionManager(config,()=>buildModels(config),cards,chats,data);
  const raw=template?structuredClone(template):JSON.parse(fs.readFileSync(new URL('./fixtures/knowledge-tavern.json',import.meta.url),'utf8'));
  const blank=sessions.worldTemplateLibrary.createBlank('酒馆双阶段','固定验收');raw.templateId=blank.id;
  const saved=sessions.worldTemplateLibrary.saveDraft(blank.id,blank.draftRevision,{name:'酒馆双阶段',template:raw}),published=sessions.worldTemplateLibrary.publish(blank.id,saved.draftRevision);
  return {run,data,config,models,chats,cards,sessions,raw,requests,problems,
    chat:()=>{const chat=chats.createChat('掌柜',null);sessions.initializeChatWorldByHash(chat.id,published.publishedHash!,chats.revisionId(chat.id),false);return chat;},
    plan:(name:string,next:MockStep[])=>{label=name;steps=next;index=0;},count:()=>index,waitPaused:()=>new Promise<void>((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('pause timeout')),8000);paused=()=>{clearTimeout(timer);resolve();};}),
    close:async()=>{mock.closeAllConnections();await new Promise<void>(resolve=>mock.close(()=>resolve()));},
  };
}
export const proposal={scene:'旧酒馆',beats:['根据服务端实际结果描述本轮经历'],dialogue:['掌柜回应旅人的请求'],references:[{kind:'actor',id:'innkeeper'}]};
export const submit={name:'submit_narrative_plan',args:proposal};
export const actions=[{name:'world_command',args:{commandId:'buy',type:'purchase_item',buyerId:'player',sellerId:'innkeeper',itemId:'sword',quantity:1}},{name:'world_command',args:{commandId:'time',type:'advance_time',minutes:10}},{name:'world_interact',args:{interactionId:'ask_innkeeper_about_cellar'}}];
