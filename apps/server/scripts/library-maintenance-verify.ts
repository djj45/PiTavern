/** Keep every synthetic fixture, partial restore and archive for review. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { Readable } from 'node:stream';
import { once } from 'node:events';
import { gzipSync, gunzipSync } from 'node:zlib';
import type { AddressInfo } from 'node:net';
import type { LibraryBackupJobDto, LibraryBackupProgressDto } from '@pitavern/shared';
const root = path.resolve(import.meta.dirname, '../../..');
fs.mkdirSync(path.join(root, 'data/test-runs'), { recursive: true });
const runDir = fs.mkdtempSync(path.join(root, 'data/test-runs/library-maintenance-'));
process.env.PITAVERN_CONFIG = path.join(runDir, 'config.json');
const { defaultConfig, seedDataDirs, saveConfig } = await import('../src/config.ts');
const { LibraryBackupStore } = await import('../src/stdata/library-backup.ts');
const { portableSettings, parsePortableSettings } = await import('../src/stdata/portable-config.ts');
const { CharacterStore } = await import('../src/stdata/characters.ts');
const { ChatStore } = await import('../src/stdata/chats.ts');
const { SessionManager } = await import('../src/session/manager.ts');
const { buildModels } = await import('../src/providers/models.ts');
const { createHttpApp } = await import('../src/api/http.ts');
const config = defaultConfig(); config.stDataDir = path.join(runDir, 'st'); seedDataDirs(config.stDataDir);
config.persona = { name: '源端角色', description: '便携描述' };
config.activeWorlds = ['fixture'];
config.providers = [{ id: 'local', name: '仅本机', apiKey: 'must-never-be-exported', baseUrl: 'http://127.0.0.1:1/private-provider', models: [{ id: 'fixture', name: '测试模型' }] }];
config.defaultProvider = 'local'; config.defaultModel = 'fixture';
fs.mkdirSync(path.join(config.stDataDir, 'skills/fixture'), { recursive: true });
for (let i = 0; i < 70; i++) fs.writeFileSync(path.join(config.stDataDir, 'skills/fixture/' + i + '.md'), '本地合成内容 ' + i);
fs.writeFileSync(path.join(config.stDataDir, 'worlds/fixture.json'), '{"entries":{}}');
saveConfig(config);
const originalRoot = config.stDataDir;
const store = new LibraryBackupStore(originalRoot);
const settings = portableSettings(config);
assert.throws(() => parsePortableSettings({ ...settings, providers: config.providers }), /未知字段/);
assert.throws(() => parsePortableSettings({ ...settings, persona: { ...settings.persona, apiKey: 'bad' } }), /未知字段/);
const progress: LibraryBackupProgressDto[] = [];
const archiveFile = await store.export(settings, { update: (value) => progress.push(value) });
const archive = fs.readFileSync(archiveFile), decoded = gunzipSync(archive).toString('utf8');
assert.ok(!decoded.includes('must-never-be-exported')); assert.ok(!decoded.includes('private-provider')); assert.ok(!decoded.includes('defaultModel'));
assert.ok(progress.some((p) => p.phase === 'collecting')); assert.ok(progress.some((p) => p.phase === 'compressing' && p.files === 71 && p.totalFiles === 71));
const upload = () => Readable.from([archive]);
const preview = await store.preview(upload()); assert.equal(preview.settings!.persona.name, '源端角色');
const altered = decoded.split('\n').filter(Boolean).map((line) => JSON.parse(line)); altered[0].settings.persona.name = '篡改';
const tampered = gzipSync(altered.map((row) => JSON.stringify(row)).join('\n') + '\n'); fs.writeFileSync(path.join(runDir, 'tampered.pitavern.gz'), tampered);
await assert.rejects(store.preview(Readable.from([tampered])), /便携设置校验失败/);
const configBefore = fs.readFileSync(process.env.PITAVERN_CONFIG!, 'utf8');
for (const action of ['export', 'preview', 'restore'] as const) {
  const controller = new AbortController();
  const op = { signal: controller.signal, update: (p: LibraryBackupProgressDto) => {
    if ((action === 'export' && p.phase === 'compressing') || (action === 'preview' && p.phase === 'validating') || (action === 'restore' && p.phase === 'restoring')) controller.abort();
  } };
  await assert.rejects(action === 'export' ? store.export(undefined, op) : action === 'preview' ? store.preview(upload(), op) : store.restore(preview.id, config, true, op));
  assert.equal(fs.readFileSync(process.env.PITAVERN_CONFIG!, 'utf8'), configBefore); assert.equal(config.stDataDir, originalRoot);
}
assert.ok(fs.readdirSync(store.maintenanceDir).some((name) => name.endsWith('.incomplete')));
const storage = await store.storage(); assert.ok(storage.bytes > archive.length); assert.ok(storage.files > 71);
const occupied = storage.items.find((item) => item.kind === 'import' && item.inUse)!; assert.ok(occupied);
assert.throws(() => store.removeArtifact(occupied.id, occupied.id), /恢复预览/);
assert.throws(() => store.removeArtifact('../config.json', '../config.json'), /标识/);
assert.throws(() => store.removeArtifact(path.basename(archiveFile), 'wrong'), /确认/);
// Exercise the final deletion target without deleting any captured/synthetic evidence.
const remove = fs.rmSync; let removed = '';
try { fs.rmSync = ((file: fs.PathLike) => { removed = String(file); }) as typeof fs.rmSync; store.removeArtifact(path.basename(archiveFile), path.basename(archiveFile)); }
finally { fs.rmSync = remove; }
assert.equal(removed, archiveFile); assert.ok(fs.existsSync(archiveFile));
config.persona = { name: '本机角色', description: '本机描述' };
const noSettings = await store.restore(preview.id, config); assert.equal(config.persona.name, '本机角色'); assert.ok(fs.existsSync(noSettings.stDataDir));
config.stDataDir = originalRoot; saveConfig(config);
console.log('✓ 便携设置白名单与无密钥导出、篡改拒绝、导出/校验/恢复取消回滚、原库和归档保留、占用保护');

const characters = new CharacterStore(path.join(originalRoot, 'characters')), chats = new ChatStore(originalRoot);
const modelsRef = { current: buildModels(config) }, sessions = new SessionManager(config, () => modelsRef.current, characters, chats, originalRoot);
const server = http.createServer(createHttpApp({ config, modelsRef, characters, chats, sessions, stDataDir: originalRoot, webDistDir: null }));
server.listen(0, '127.0.0.1'); await once(server, 'listening');
const base = 'http://127.0.0.1:' + (server.address() as AddressInfo).port;
const post = (route: string, data: unknown) => fetch(base + route, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
const job = async (id: string): Promise<LibraryBackupJobDto> => { const response = await fetch(base + '/api/library-backup/jobs/' + id); assert.equal(response.status, 200); return response.json() as Promise<LibraryBackupJobDto>; };
const until = async (id: string, predicate: (j: LibraryBackupJobDto) => boolean) => {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) { const value = await job(id); if (predicate(value)) return value; await new Promise((resolve) => setTimeout(resolve, 10)); }
  throw new Error('等待备份任务超时');
};
try {
  const waiting = await (await post('/api/library-backup/jobs', { action: 'import' })).json() as LibraryBackupJobDto;
  assert.equal((await fetch(base + '/api/chats')).status, 503); assert.equal((await post('/api/library-backup/jobs/' + waiting.id + '/cancel', {})).status, 200);
  assert.equal((await job(waiting.id)).state, 'cancelled'); assert.equal((await fetch(base + '/api/chats')).status, 200);
  const streaming = await (await post('/api/library-backup/jobs', { action: 'import' })).json() as LibraryBackupJobDto;
  const request = http.request(base + '/api/library-backup/jobs/' + streaming.id + '/upload', { method: 'POST', headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': archive.length } });
  request.on('error', () => {}); request.on('response', (res) => res.resume()); request.write(archive.subarray(0, 100));
  await until(streaming.id, (j) => j.progress.bytes >= 100);
  assert.equal((await post('/api/library-backup/jobs/' + streaming.id + '/cancel', {})).status, 200);
  assert.equal((await until(streaming.id, (j) => j.state !== 'running')).state, 'cancelled'); request.destroy();
  assert.equal((await fetch(base + '/api/chats')).status, 200); assert.equal(config.stDataDir, originalRoot);
  const exported = await (await post('/api/library-backup/jobs', { action: 'export', includeSettings: true })).json() as LibraryBackupJobDto;
  assert.equal((await until(exported.id, (j) => j.state !== 'running')).state, 'succeeded');
  const downloaded = await fetch(base + '/api/library-backup/jobs/' + exported.id + '/download'); assert.equal(downloaded.status, 200);
  const bytes = new Uint8Array(await downloaded.arrayBuffer()); fs.writeFileSync(path.join(runDir, 'http-download.pitavern.gz'), bytes);
  const imported = await (await post('/api/library-backup/jobs', { action: 'import' })).json() as LibraryBackupJobDto;
  const received = await fetch(base + '/api/library-backup/jobs/' + imported.id + '/upload', { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: bytes }); assert.equal(received.status, 200);
  const validated = await job(imported.id); assert.equal(validated.state, 'succeeded'); assert.equal(validated.preview!.settings!.persona.name, '本机角色');
  config.persona = { name: '另一个本机角色', description: '' }; saveConfig(config);
  const restored = await (await post('/api/library-backup/jobs', { action: 'restore', previewId: validated.preview!.id, applySettings: true })).json() as LibraryBackupJobDto;
  const completed = await until(restored.id, (j) => j.state !== 'running'); assert.equal(completed.state, 'succeeded', completed.error ?? '恢复任务失败');
  assert.equal(config.persona.name, '本机角色'); assert.equal(config.providers[0].apiKey, 'must-never-be-exported'); assert.equal(config.defaultModel, 'fixture');
  assert.ok(completed.restored!.restartRequired); assert.equal((await fetch(base + '/api/chats')).status, 503);
  assert.equal((await post('/api/library-backup/jobs/' + restored.id + '/cancel', {})).status, 409);
  console.log('✓ HTTP 任务进度、等待上传/传输中取消释放锁、下载与校验、可选应用设置、本机连接保留、提交后禁止取消');
  console.log('测试数据保留：' + runDir);
} finally { server.closeAllConnections(); server.close(); }
