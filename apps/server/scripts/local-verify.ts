/** Read the local library, but only modify a unique copy. Never print credentials or private prompts. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { CharacterStore } from '../src/stdata/characters.ts';
import { ChatStore } from '../src/stdata/chats.ts';
import { LibraryBackupStore } from '../src/stdata/library-backup.ts';
import { LibraryStore } from '../src/stdata/library.ts';
import { fixtureCard } from './card-fixtures.ts';
const repo = path.resolve(import.meta.dirname, '../../..');
const sourceConfig = path.resolve(repo, process.env.PITAVERN_CONFIG ?? 'data/config.json');
const source = fs.existsSync(sourceConfig) ? JSON.parse(fs.readFileSync(sourceConfig, 'utf8')) as Record<string, unknown> : {};
const sourceRoot = path.resolve(repo, typeof source.stDataDir === 'string' ? source.stDataDir : 'data/st');
const hash = (value: Buffer) => createHash('sha256').update(value).digest('hex');
const roots = ['characters', 'chats', 'worlds', 'OpenAI Settings', 'skills', '.pitavern'];
function inventory(root: string): Record<string, string> {
  const files: Record<string, string> = {};
  const walk = (relative: string) => {
    const file = path.join(root, relative); if (!fs.existsSync(file)) return;
    const stat = fs.lstatSync(file); if (stat.isSymbolicLink()) throw new Error('资料含符号链接，停止副本验收以避免越界读取');
    if (relative.startsWith('.pitavern/vectors') || path.basename(file).startsWith('.pitavern-write-') || file.endsWith('.tmp')) return;
    if (stat.isDirectory()) for (const name of fs.readdirSync(file).sort()) walk(relative + '/' + name);
    else if (stat.isFile()) files[relative] = hash(fs.readFileSync(file));
  };
  for (const relative of roots) walk(relative); return files;
}
const baseline = inventory(sourceRoot);
fs.mkdirSync(path.join(repo, 'data/test-runs'), { recursive: true });
const runDir = fs.mkdtempSync(path.join(repo, 'data/test-runs/local-acceptance-'));
process.env.PITAVERN_CONFIG = path.join(runDir, 'config.json');
const { defaultConfig, seedDataDirs, saveConfig } = await import('../src/config.ts');
const config = defaultConfig(); config.stDataDir = path.join(runDir, 'library-copy'); seedDataDirs(config.stDataDir);
for (const relative of Object.keys(baseline)) { const target = path.join(config.stDataDir, relative); fs.mkdirSync(path.dirname(target), { recursive: true }); fs.copyFileSync(path.join(sourceRoot, relative), target, fs.constants.COPYFILE_EXCL); }
assert.deepEqual(inventory(config.stDataDir), baseline, '副本与读取时原资料字节一致');
saveConfig(config);
const cards = new CharacterStore(path.join(config.stDataDir, 'characters')).listCharacters();
const library = new LibraryStore(config.stDataDir);
const problems: { kind: string; error: string }[] = [];
for (const resource of library.list()) { try { library.read(resource.id); } catch (error) { problems.push({ kind: resource.kind, error: (error as Error).message }); } }
assert.equal(problems.length, 0, '本机资料解析失败，详情仅保存在本轮报告中');
const backups = new LibraryBackupStore(config.stDataDir), archive = await backups.export();
const preview = await backups.preview(fs.createReadStream(archive)); const restore = await backups.restore(preview.id, config);
assert.deepEqual(inventory(restore.stDataDir), baseline, '副本导出恢复逐文件 SHA-256 一致');
assert.deepEqual(inventory(sourceRoot), baseline, '验收前后原资料未改变');
const requestedProvider = process.argv.includes('--provider');
let provider: { status: string; reason?: string } = { status: 'not_requested', reason: '真实供应商验收需显式传入 --provider；仅发送合成短消息' };
if (requestedProvider) {
  const providers = Array.isArray(source.providers) ? source.providers as import('../src/config.ts').ProviderConfig[] : [];
  const selected = providers.find((item) => item.id === source.defaultProvider);
  const model = selected?.models.find((item) => item.id === source.defaultModel);
  if (!selected?.baseUrl || !model) provider = { status: 'not_configured', reason: '尚未配置默认供应商和模型，未发送外部请求' };
  else {
    const isolated = defaultConfig(); isolated.stDataDir = path.join(runDir, 'provider-fixture'); seedDataDirs(isolated.stDataDir);
    isolated.providers = [{ ...structuredClone(selected), models: [{ ...structuredClone(model), maxTokens: 64 }] }]; isolated.defaultProvider = selected.id; isolated.defaultModel = model.id; isolated.toolsEnabled = false;
    // Keep credentials in memory; the isolated disk config and report contain no provider secrets.
    const card = fixtureCard('供应商验收合成角色'); card.data.description = '这是一条短回复连通性验收。'; fs.writeFileSync(path.join(isolated.stDataDir, 'characters/fixture.json'), JSON.stringify(card));
    const { SessionManager } = await import('../src/session/manager.ts'); const { buildModels } = await import('../src/providers/models.ts');
    const models = buildModels(isolated), chats = new ChatStore(isolated.stDataDir), characters = new CharacterStore(path.join(isolated.stDataDir, 'characters'));
    const sessions = new SessionManager(isolated, () => models, characters, chats, isolated.stDataDir);
    const chat = chats.createChat(card.data.name, null); const timer = setTimeout(() => sessions.abort(chat.id), 45000);
    try { await sessions.send(chat.id, '请只回复：验收通过'); const document = chats.readChat(chat.id)!; if (!document.some((line) => !line.is_user && line.mes.trim())) throw new Error('真实供应商未返回正文；请在应用中检查服务连接'); provider = { status: 'passed' }; }
    finally { clearTimeout(timer); }
  }
}
const report = { createdAt: new Date().toISOString(), sourceFiles: Object.keys(baseline).length, sourceCharacters: cards.length, sourceChats: new ChatStore(sourceRoot).listChats().length, resources: library.list().length, byteExactRestore: true, originalUnchanged: true, provider, problems };
fs.writeFileSync(path.join(runDir, 'report.json'), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
console.log(JSON.stringify(report, null, 2)); console.log('验收产物仅保存在：' + runDir);
if (requestedProvider && provider.status !== 'passed') process.exitCode = 2;
