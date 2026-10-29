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
config.providers = [{ id: 'fixture', name: '本地合成连接', apiKey: 'synthetic-only', baseUrl: `http://127.0.0.1:${(mock.address() as AddressInfo).port}/v1`, models: [{ id: 'fixture', name: '本地模型', contextWindow: 8000, maxTokens: 500 }] }];
config.defaultProvider = 'fixture'; config.defaultModel = 'fixture'; config.toolsEnabled = false;
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
