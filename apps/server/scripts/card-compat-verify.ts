/** Synthetic fixtures only. Retain every run directory, including failed imports. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { fixtureBook, fixtureCard, cardPng, zipFixture, charxFixture, byafFixture, tinyPng } from './card-fixtures.ts';
import { readCardArchive } from '../src/stdata/card-archive-zip.ts';
import { importedAvatar, withImportedScenario } from '../src/stdata/card-import.ts';
import { cardBookToWorld, updateCardBook, type CardBook } from '../../web/src/cardBookEditor.ts';
import { extractPngTextChunks } from '../src/stdata/png.ts';
import { normalizeCardBook } from '../src/context/worldinfo.ts';
import { LibraryStore } from '../src/stdata/library.ts';
import { CharacterStore } from '../src/stdata/characters.ts';
import { ChatStore } from '../src/stdata/chats.ts';
const repo = path.resolve(import.meta.dirname, '../../..');
fs.mkdirSync(path.join(repo, 'data/test-runs'), { recursive: true });
const runDir = fs.mkdtempSync(path.join(repo, 'data/test-runs/card-compat-'));
process.env.PITAVERN_CONFIG = path.join(runDir, 'config.json');
const { defaultConfig, seedDataDirs, saveConfig } = await import('../src/config.ts');
const { buildModels } = await import('../src/providers/models.ts');
const { SessionManager } = await import('../src/session/manager.ts');
const { createHttpApp } = await import('../src/api/http.ts');
const config = defaultConfig(); config.stDataDir = path.join(runDir, 'st'); seedDataDirs(config.stDataDir); config.toolsEnabled = false;
const library = new LibraryStore(config.stDataDir);
const book = fixtureBook(), view = cardBookToWorld(book);
assert.deepEqual(updateCardBook(book, view), book, '未修改时原始字段完全保留');
view.entries['0'].content = '编辑后的卡内内容'; view.entries['0'].groupWeight = 35; view.entries['0'].order = 12; view.entries['0'].caseSensitive = true;
view.entries['1'] = { ...structuredClone(view.entries['0']), uid: 1, comment: '复制条目' };
const updated = updateCardBook(book, view);
assert.equal(updated.entries[0].id, 42); assert.notEqual(updated.entries[1].id, 42);
assert.deepEqual(updated.entries[1].unknownEntry, book.entries[0].unknownEntry);
assert.equal((updated.entries[0].extensions as Record<string, unknown>).group_weight, 35);
assert.equal((updated.entries[0].extensions as Record<string, unknown>).groupWeight, 35);
assert.equal((updated.entries[0].extensions as Record<string, unknown>).order, 12);
assert.equal(normalizeCardBook(updated, 'fixture')[0].caseSensitive, true);
for (const suffix of ['json', 'png']) {
  const card = fixtureCard('编辑向导-' + suffix), original = suffix === 'png' ? cardPng(card) : Buffer.from(JSON.stringify(card));
  const file = path.join(config.stDataDir, 'characters/fixture.' + suffix); fs.writeFileSync(file, original);
  const id = 'character-world:fixture.' + suffix, document = library.read(id), regexRevision = library.read('character-regex:fixture.' + suffix).revision;
  const saved = library.save(id, document.revision, updated); assert.deepEqual(saved.data, updated);
  assert.throws(() => library.save(id, document.revision, book), /其他窗口/);
  assert.throws(() => library.save('character-regex:fixture.' + suffix, regexRevision, []), /其他窗口/);
  const output = fs.readFileSync(file), json = suffix === 'png' ? JSON.parse(Buffer.from(extractPngTextChunks(output)!.ccv3, 'base64').toString()) : JSON.parse(output.toString());
  assert.deepEqual(json, { ...card, data: { ...card.data, character_book: updated } });
  if (suffix === 'png') {
    const chunks = extractPngTextChunks(output)!; assert.equal(chunks.Comment, 'preserved');
    assert.deepEqual(JSON.parse(Buffer.from(chunks.chara, 'base64').toString()), json);
    let offset = 8; while (offset + 12 <= output.length) { const n = output.readUInt32BE(offset); if (output.toString('ascii', offset + 4, offset + 8) === 'IDAT') assert.ok(original.includes(output.subarray(offset, offset + n + 12))); offset += n + 12; }
  }
  const history = library.history(id); assert.equal(history.items.length, 1);
  library.restoreHistory(id, history.items[0].id, saved.revision); assert.deepEqual(fs.readFileSync(file), original);
  assert.throws(() => library.save(id, library.read(id).revision, { entries: [{ content: 'x', keys: [1] }] }), /关键词/);
}
console.log('✓ JSON/PNG 卡内世界书、未知字段、复制 ID、别名同步、图片保留、共享冲突和原字节恢复');
for (const stored of [true, false]) assert.deepEqual((await readCardArchive(charxFixture('存储测试', { stored, prefix: Buffer.from([255, 216, 255, 0]) }))).get('assets/main.png'), tinyPng);
for (const name of ['../escape', '/absolute', 'C:/drive', 'a\\b', 'a/../b', 'a//b', 'a\0b']) await assert.rejects(readCardArchive(zipFixture([[name, 'x']])));
await assert.rejects(readCardArchive(zipFixture([['a', 'x'], ['a', 'x']])));
await assert.rejects(readCardArchive(zipFixture([['a', 'x'], ['a/b', 'x']])));
const valid = charxFixture(), directory = valid.readUInt32LE(valid.length - 6);
for (const [offset, value] of [[directory + 16, 1], [directory + 24, 33 * 1024 ** 2], [directory + 38, 0xa0000000], [directory + 8, 0x801]] as const) {
  const corrupt = Buffer.from(valid); if (offset === directory + 8) corrupt.writeUInt16LE(value, offset); else corrupt.writeUInt32LE(value, offset); await assert.rejects(readCardArchive(corrupt));
}
await assert.rejects(readCardArchive(valid.subarray(0, -1)));
const compressedBomb = zipFixture([['bomb', Buffer.alloc(100000, 97)]]); const bombDirectory = compressedBomb.readUInt32LE(compressedBomb.length - 6); compressedBomb.writeUInt32LE(1, bombDirectory + 24); await assert.rejects(readCardArchive(compressedBomb));
console.log('✓ ZIP store/deflate/JPEG 前缀、路径穿越/重复/链接/CRC/截断与虚假展开长度拒绝');

const requests: unknown[] = [];
const mock = http.createServer(async (req, res) => { let raw = ''; for await (const part of req) raw += part; requests.push(JSON.parse(raw)); fs.writeFileSync(path.join(runDir, 'request-' + requests.length + '.json'), raw); res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.end('data: ' + JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', model: 'fixture', choices: [{ index: 0, delta: { role: 'assistant', content: '本地验收回复' }, finish_reason: null }] }) + '\n\ndata: ' + JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', model: 'fixture', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }) + '\n\ndata: [DONE]\n\n'); });
mock.listen(0, '127.0.0.1'); await once(mock, 'listening');
config.providers = [{ id: 'fixture', name: '合成连接', apiKey: 'synthetic-only', baseUrl: 'http://127.0.0.1:' + (mock.address() as AddressInfo).port + '/v1', models: [{ id: 'fixture', name: '本地模型', contextWindow: 16000, maxTokens: 300 }] }]; config.defaultProvider = 'fixture'; config.defaultModel = 'fixture'; saveConfig(config);
const characters = new CharacterStore(path.join(config.stDataDir, 'characters')), chats = new ChatStore(config.stDataDir), modelsRef = { current: buildModels(config) };
const sessions = new SessionManager(config, () => modelsRef.current, characters, chats, config.stDataDir);
const server = http.createServer(createHttpApp({ config, modelsRef, characters, chats, sessions, stDataDir: config.stDataDir, webDistDir: null }));
server.listen(0, '127.0.0.1'); await once(server, 'listening');
const base = 'http://127.0.0.1:' + (server.address() as AddressInfo).port;
const upload = (name: string, body: Buffer) => fetch(base + '/api/import/character', { method: 'POST', headers: { 'Content-Type': 'application/octet-stream', 'x-file-name': encodeURIComponent(name) }, body: new Uint8Array(body) });
try {
  const response = await upload('archive.charx', charxFixture()); assert.equal(response.status, 200, await response.clone().text());
  const imported = await response.json() as { file: string; assets: number }; assert.equal(imported.file, 'archive.json'); assert.equal(imported.assets, 3);
  const card = characters.getCharacter('归档向导')!; assert.ok(card); assert.deepEqual(fs.readFileSync(card.avatarFile), tinyPng); assert.equal(card.characterBook && (card.characterBook as CardBook).entries.length, 1);
  const source = JSON.parse(fs.readFileSync(path.join(config.stDataDir, 'characters', imported.file), 'utf8')); const archiveId = source.data.extensions.pitavern_archive.id;
  assert.deepEqual(fs.readFileSync(path.join(config.stDataDir, '.pitavern/imports', archiveId, 'source.charx')), charxFixture());
  assert.equal(fs.readFileSync(path.join(config.stDataDir, '.pitavern/imports', archiveId, 'files/assets/unknown.dat'), 'utf8'), 'preserved unknown asset');
  assert.equal((await fetch(base + '/api/characters/' + encodeURIComponent(card.name) + '/avatar')).status, 200);
  assert.equal((await upload('duplicate.charx', charxFixture())).status, 400);
  const bytes = fs.readFileSync(path.join(config.stDataDir, 'characters', imported.file));
  assert.equal((await upload('broken.charx', zipFixture([['card.json', JSON.stringify(fixtureCard('损坏卡'))]]))).status, 400);
  assert.deepEqual(fs.readFileSync(path.join(config.stDataDir, 'characters', imported.file)), bytes); assert.equal((await fetch(base + '/api/chats')).status, 200, '失败释放维护锁');
  const jsonDoc = library.read('character-world:archive.json'); const edited = structuredClone(jsonDoc.data) as CardBook; edited.entries[0].content = '归档卡内编辑'; library.save(jsonDoc.resource.id, jsonDoc.revision, edited);
  const byaf = await upload('guide.byaf', byafFixture()); assert.equal(byaf.status, 200, await byaf.clone().text()); const byafResult = await byaf.json() as { chats: number }; assert.equal(byafResult.chats, 2);
  const guide = characters.getCharacter('BYAF向导')!; assert.equal(guide.description, '{{char}}欢迎{{user}}'); assert.ok(guide.avatarFile); assert.equal((guide.characterBook as CardBook).entries[0].content, '归档内的世界书');
  const importedChats = chats.listChats('BYAF向导'); assert.equal(importedChats.length, 2);
  const first = importedChats.find((chat) => chat.id.includes('0001'))!, second = importedChats.find((chat) => chat.id.includes('0002'))!;
  assert.equal(chats.readChat(first.id)!.at(-1)!.mes, '选中候选'); assert.deepEqual(chats.readChat(first.id)!.at(-1)!.swipes, ['旧候选', '选中候选']);
  assert.equal(withImportedScenario(guide, chats.readDocument(second.id)!.metadata).scenario, '第二个独立场景');
  await sessions.send(second.id, '继续第二场景'); assert.ok(JSON.stringify(requests.at(-1)).includes('第二个独立场景')); assert.ok(!JSON.stringify(requests.at(-1)).includes('首个场景'));
  assert.ok(chats.readChat(second.id)!.some((line) => line.mes === '本地验收回复'));
  assert.equal(importedAvatar(config.stDataDir, { pitavern_archive: { version: 1, id: '../..', avatar: 'avatar.png' } }), '');
  console.log('✓ HTTP CharX/BYAF 导入、原归档资源、头像、未知字段、同名拒绝、场景/候选和实际生成上下文');
} finally { server.closeAllConnections(); mock.closeAllConnections(); await Promise.all([new Promise<void>((resolve) => server.close(() => resolve())), new Promise<void>((resolve) => mock.close(() => resolve()))]); }
console.log('产物保留：' + runDir);
