/** Isolated browser fixtures. Never load a developer's data or providers. */
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { fixtureBook, fixtureCard, cardPng } from './card-fixtures.ts';
const runDir = process.env.PITAVERN_BROWSER_FIXTURE!;
if (!runDir || !path.isAbsolute(runDir)) throw new Error('Missing isolated fixture directory');
fs.mkdirSync(runDir, { recursive: true });
process.env.PITAVERN_CONFIG = path.join(runDir, 'config.json');
const { defaultConfig, seedDataDirs, saveConfig } = await import('../src/config.ts');
const { CharacterStore } = await import('../src/stdata/characters.ts');
const { ChatStore } = await import('../src/stdata/chats.ts');
const { SessionManager } = await import('../src/session/manager.ts');
const { buildModels } = await import('../src/providers/models.ts');
const { createHttpApp } = await import('../src/api/http.ts');
const { attachWebSocket } = await import('../src/api/ws.ts');
const config = defaultConfig();
config.stDataDir = path.join(runDir, 'st'); seedDataDirs(config.stDataDir);
fs.writeFileSync(path.join(config.stDataDir, 'characters/browser.json'), JSON.stringify({ spec: 'chara_card_v2', data: { name: '浏览器向导', description: '本地合成角色', first_mes: '欢迎，旅行者。', character_book: fixtureBook(), extensions: {} } }));
fs.writeFileSync(path.join(config.stDataDir, 'worlds/browser.json'), JSON.stringify({ entries: { '0': { uid: 0, comment: '初始条目', key: ['旅行者'], content: '初始内容', position: 0 } } }));
fs.writeFileSync(path.join(config.stDataDir, 'OpenAI Settings/browser.json'), JSON.stringify({ prompts: [{ identifier: 'chatHistory', marker: true }], prompt_order: [{ character_id: 100001, order: [{ identifier: 'chatHistory', enabled: true }] }] }));
fs.writeFileSync(path.join(config.stDataDir, 'characters/picture.png'), cardPng(fixtureCard('图片向导')));
fs.writeFileSync(path.join(config.stDataDir, 'characters/greetings.json'), JSON.stringify({ name: '多开局向导',
  first_mes: '请先选择开局。\n' + Array.from({ length: 8 }, (_, i) => `${i + 1}.合成场景${i + 1}`).join('\n'),
  alternate_greetings: Array.from({ length: 8 }, (_, i) => `合成开局${i + 1}：{{user}}抵达地点${i + 1}。`) }));
// 角色卡管理页导入夹具：放在 characters/ 之外，避免启动时就出现在列表里。
fs.mkdirSync(path.join(runDir, 'fixtures'), { recursive: true });
fs.writeFileSync(path.join(runDir, 'fixtures/import-card.json'), JSON.stringify({
  spec: 'chara_card_v2', spec_version: '2.0',
  data: { name: '导入向导', description: '从夹具 JSON 导入的角色', personality: '沉稳', scenario: '档案室',
    first_mes: '导入开场白：{{user}}抵达档案室。', alternate_greetings: ['导入备用一', '导入备用二'],
    mes_example: '<START>', creator_notes: '浏览器导入夹具', system_prompt: '保持简洁',
    post_history_instructions: '', tags: ['导入', '合成'], extensions: { world: 'browser', unknownCard: { keep: true } } },
}));
fs.writeFileSync(path.join(runDir, 'fixtures/import-card.png'), cardPng(fixtureCard('导入图片向导')));
// 重启后仍应保留保存结果的角色卡；只在首次启动时创建，重启不覆盖。
const persistCardPath = path.join(config.stDataDir, 'characters/persist.json');
if (!fs.existsSync(persistCardPath)) {
  fs.writeFileSync(persistCardPath, JSON.stringify({ spec: 'chara_card_v2', data: {
    name: '持久向导', description: '重启后应保留保存结果', first_mes: '持久开场白', tags: ['持久'],
    character_book: fixtureBook(), extensions: { unknownCard: { keep: true } },
  } }));
}
let failedRetryOnce = false;
const mock = http.createServer(async (req, res) => {
  if (req.method === 'GET' && req.url?.endsWith('/models')) {
    fs.appendFileSync(path.join(runDir, 'model-requests.ndjson'), JSON.stringify({ method: req.method, url: req.url }) + '\n');
    if (req.url === '/missing/models') { res.writeHead(404); res.end(); return; }
    if (req.url === '/draft/models' && req.headers.authorization !== 'Bearer synthetic-draft') { res.writeHead(401); res.end(); return; }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    const send = () => res.end(JSON.stringify({ data: req.url === '/empty/models' ? [] : [
      { id: 'fixture', name: '本地模型' }, { id: 'a-embedding' }, { id: 'discovered-chat', name: '列表模型' }, { id: 'discovered-chat' },
    ] }));
    if (req.url === '/slow/models') {
      res.flushHeaders(); const timer = setTimeout(send, 1500); res.on('close', () => clearTimeout(timer));
    } else send();
    return;
  }
  let raw = ''; for await (const part of req) raw += part;
  fs.appendFileSync(path.join(runDir, 'requests.ndjson'), raw + '\n');
  const body = JSON.parse(raw);
  if (raw.includes('诊断空正文') || (raw.includes('失败后重试本轮') && raw.includes('pitavern-narrative-v1') && !failedRetryOnce)) {
    if (raw.includes('失败后重试本轮')) failedRetryOnce = true;
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: '模型输出为空，请降低思考强度。私有故障标记-DO-NOT-EXPOSE' } }));
    return;
  }
  const twoStage = body.tools?.some((tool: {function?:{name?:string}}) => tool.function?.name === 'submit_narrative_plan');
  const contentText = (message:{content?:unknown}) => typeof message.content === 'string' ? message.content : Array.isArray(message.content) ? message.content.filter((c:{type?:string})=>c.type==='text').map((c:{text:string})=>c.text).join('') : '';
  const packetMessage = body.messages?.findLast((message:{role:string;content?:unknown}) => message.role === 'user' && contentText(message).startsWith('{"protocol":"pitavern-narrative-v1"'));
  const questFlow=body.tools?.some((tool:{function?:{name?:string}})=>tool.function?.name==='world_quest');
  const questPacket=packetMessage?JSON.parse(contentText(packetMessage)):undefined;
  if(questFlow || (questPacket?.authoritativeState.schemaVersion??0)>=3){
    const frame=(delta:object,finish_reason:string|null)=>'data: '+JSON.stringify({id:'quest-browser',object:'chat.completion.chunk',model:'fixture',choices:[{index:0,delta,finish_reason}]})+'\n\n';
    const lastUser=contentText(body.messages.findLast((m:{role:string})=>m.role==='user')??{});
    const settled=body.messages.some((m:{tool_calls?:Array<{function:{name:string}}>})=>m.tool_calls?.some(c=>['world_quest','world_command','world_interact'].includes(c.function.name)));
    const wait=(minutes:number)=>({name:'world_command',args:{commandId:`wait-${minutes}`,type:'advance_time',minutes}});
    const operation=(action:string)=>({name:'world_quest',args:{questId:'cellar_sword',action}});
    const plan={name:'submit_narrative_plan',args:{scene:'旧酒馆',beats:['依据实际任务状态叙述'],dialogue:['掌柜回应'],references:[{kind:'quest',id:'cellar_sword'}]}};
    let calls=settled||raw.includes('任务不交付')||raw.includes('日程不返回')?[plan]:lastUser.includes('等待到10')?[wait(10)]:lastUser.includes('日程返回交付')?[wait(20),operation('advance')]:lastUser.includes('任务调查')?[operation('accept'),{name:'world_command',args:{commandId:'buy',type:'purchase_item',buyerId:'player',sellerId:'innkeeper',itemId:'sword',quantity:1}},{name:'world_interact',args:{interactionId:'ask_innkeeper_about_cellar'}},operation('advance')]:lastUser.includes('任务交付')?[operation('advance')]:[plan];
    if(!twoStage && settled)calls=[];
    const text=questPacket?'任务正文：'+(questPacket.authoritativeState.quests?.find((q:{id:string})=>q.id==='cellar_sword')?.status==='completed'?'已交付长剑并领取奖励。':'当前任务尚未完成。'):'任务回应。';
    const delta=questPacket||!calls.length?{role:'assistant',content:text}:{role:'assistant',tool_calls:calls.map((c,index)=>({index,id:'quest-'+index+'-'+(settled?'plan':'act'),type:'function',function:{name:c.name,arguments:JSON.stringify(c.args)}}))};
    res.writeHead(200,{'Content-Type':'text/event-stream'});res.end(frame(delta,null)+frame({},questPacket||!calls.length?'stop':'tool_calls')+'data: '+JSON.stringify({choices:[],usage:{prompt_tokens:1000,completion_tokens:100,total_tokens:1100}})+'\n\ndata: [DONE]\n\n');return;
  }
  if (twoStage || packetMessage) {
    if (raw.includes('双阶段计时')) await new Promise(resolve=>setTimeout(resolve,600));
    if (packetMessage && raw.includes('正文失败测试')) {res.writeHead(400,{'Content-Type':'application/json'});res.end(JSON.stringify({error:{message:'合成正文失败'}}));return;}
    res.writeHead(200,{'Content-Type':'text/event-stream'});
    const frame=(delta:object,finish_reason:string|null)=>'data: '+JSON.stringify({id:'two-stage-browser',object:'chat.completion.chunk',model:'fixture',choices:[{index:0,delta,finish_reason}]})+'\n\n';
    const alreadySettled=body.messages.some((message:{role:string;tool_calls?:Array<{function:{name:string}}>})=>message.tool_calls?.some(call=>call.function.name==='world_command'));
    const calls=alreadySettled?[{name:'submit_narrative_plan',args:{scene:'旧酒馆',beats:['按照实际工具结果叙述购买与线索'],dialogue:['掌柜回应'],references:[{kind:'actor',id:'innkeeper'}]}}]:[
      {name:'world_command',args:{commandId:'buy',type:'purchase_item',buyerId:'player',sellerId:'innkeeper',itemId:'sword',quantity:1}},
      {name:'world_command',args:{commandId:'time',type:'advance_time',minutes:10}},
      {name:'world_interact',args:{interactionId:'ask_innkeeper_about_cellar'}}];
    const packet=packetMessage?JSON.parse(contentText(packetMessage)):undefined;
    const delta=packet?{role:'assistant',content:'双阶段正文：旅人买下长剑。'+(packet.authoritativeState.knownFacts.find((f:{id:string})=>f.id==='hidden_fireplace_passage')?.text??'')+(packet.writingRequest.rewriteDirection?'写作要求：'+packet.writingRequest.rewriteDirection:'')}:{role:'assistant',tool_calls:calls.map((call,index)=>({index,id:'call-'+index+'-'+(alreadySettled?'plan':'settle'),type:'function',function:{name:call.name,arguments:JSON.stringify(call.args)}}))};
    res.end(frame(delta,null)+frame({},packet?'stop':'tool_calls')+'data: '+JSON.stringify({choices:[],usage:{prompt_tokens:1000,completion_tokens:100,total_tokens:1100}})+'\n\ndata: [DONE]\n\n');return;
  }
  // 供逐模型连通测试验证失败态；其它请求一律返回成功。
  if (raw.includes('"model":"broken-model"')) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: '合成失败' } }));
    return;
  }
  // 只给计时验收用的合成提示增加延迟，其它浏览器用例保持即时响应。
  if (raw.includes('计时测试')) await new Promise((resolve) => setTimeout(resolve, 4000));
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  const frame = (delta: object, finish_reason: string | null) => 'data: ' + JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', model: 'fixture', choices: [{ index: 0, delta, finish_reason }] }) + '\n\n';
  res.end(frame({ role: 'assistant', content: '模型原文' }, null) + frame({}, 'stop') + 'data: [DONE]\n\n');
});
mock.listen(0, '127.0.0.1'); await once(mock, 'listening');
config.providers = [{ id: 'fixture', name: '本地合成连接', apiKey: 'synthetic-only', baseUrl: `http://127.0.0.1:${(mock.address() as AddressInfo).port}/v1`, models: [{ id: 'fixture', name: '本地模型', contextWindow: process.env.PITAVERN_BROWSER_QUESTS==='1'?24000:8000, maxTokens: 500 }] }];
config.defaultProvider = 'fixture'; config.defaultModel = 'fixture'; config.toolsEnabled = process.env.PITAVERN_BROWSER_TWO_STAGE === '1';
config.contextMode = 'bridge'; config.activePreset = 'browser'; saveConfig(config);
const characters = new CharacterStore(path.join(config.stDataDir, 'characters'));
const chats = new ChatStore(config.stDataDir);
chats.createChat('浏览器向导', { name: '浏览器向导', is_user: false, is_system: false, mes: '欢迎，旅行者。' });
const modelsRef = { current: buildModels(config) };
const sessions = new SessionManager(config, () => modelsRef.current, characters, chats, config.stDataDir);
const app = createHttpApp({ config, modelsRef, characters, chats, sessions, stDataDir: config.stDataDir, webDistDir: path.resolve(import.meta.dirname, '../../web/dist') });
const server = http.createServer(app); attachWebSocket(server, sessions);
server.listen(0, '127.0.0.1'); await once(server, 'listening');
console.log('PITAVERN_FIXTURE=' + JSON.stringify({ baseURL: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, runDir }));
