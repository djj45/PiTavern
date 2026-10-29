import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { once } from 'node:events';
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { WebSocket } from 'ws';
const root = path.resolve(import.meta.dirname, '..'), archive = path.resolve(process.argv[2] ?? '');
if (!archive.endsWith('.tar.gz') || !fs.statSync(archive).isFile()) throw new Error('用法：npm run verify:release -- /绝对路径/发布包.tar.gz');
const manifest = JSON.parse(fs.readFileSync(path.join(path.dirname(archive), 'manifest.json'), 'utf8'));
assert.equal(createHash('sha256').update(fs.readFileSync(archive)).digest('hex'), manifest.sha256);
const prefix = 'PiTavern-' + manifest.version + '/', entries = execFileSync('tar', ['-tzf', archive], { encoding: 'utf8' }).trim().split('\n');
assert.ok(entries.every((entry) => entry.startsWith(prefix) && !entry.split('/').includes('..') && !/\/(data|node_modules|\.git|\.env)(\/|$)/.test(entry)));
const runRoot = path.join(root, 'data/test-runs'); fs.mkdirSync(runRoot, { recursive: true });
const directory = fs.mkdtempSync(path.join(runRoot, 'release-')), extraction = path.join(directory, 'fresh install'); fs.mkdirSync(extraction);
execFileSync('tar', ['-xzf', archive, '-C', extraction]); const checkout = path.join(extraction, prefix);
assert.ok(!fs.existsSync(path.join(checkout, 'node_modules'))); assert.ok(!fs.existsSync(path.join(checkout, 'data')));
const probe = net.createServer(); probe.listen(0, '127.0.0.1'); await once(probe, 'listening'); const port = probe.address().port; await new Promise((r) => probe.close(r));
const configPath = path.join(directory, 'isolated config.json'), dataRoot = path.join(checkout, 'data/st');
fs.writeFileSync(configPath, JSON.stringify({ stDataDir: dataRoot, port, providers: [], defaultModel: '', defaultProvider: '' }));
const log = fs.openSync(path.join(directory, 'startup.log'), 'a');
const launcher = spawn('bash', ['start.command'], { cwd: checkout, env: { ...process.env, PITAVERN_CONFIG: configPath, PORT: String(port), PITAVERN_OPEN_BROWSER: '0' }, stdio: ['ignore', log, log] }); fs.closeSync(log);
const exit = once(launcher, 'exit'), baseURL = 'http://127.0.0.1:' + port;
let succeeded = false;
try {
  let ready = false;
  const started = Date.now();
  while (Date.now() - started < 180_000) {
    if (launcher.exitCode !== null) throw new Error('启动脚本提前退出，请查看 ' + directory + '/startup.log');
    try { const status = await fetch(baseURL + '/api/status', { signal: AbortSignal.timeout(500) }); if (status.ok) { assert.equal((await status.json()).version, manifest.version); ready = true; break; } } catch { /* Await readiness. */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  assert.ok(ready, '全新安装在三分钟内启动');
  assert.deepEqual(await (await fetch(baseURL + '/api/characters')).json(), []);
  assert.deepEqual(await (await fetch(baseURL + '/api/chats')).json(), []);
  const html = await (await fetch(baseURL)).text(); assert.match(html, /<div id="root">/);
  const script = /src="([^"]+\.js)"/.exec(html)?.[1]; assert.ok(script); assert.equal((await fetch(baseURL + script)).status, 200);
  const ws = new WebSocket(baseURL.replace('http:', 'ws:') + '/ws');
  try {
    const hello = await Promise.race([once(ws, 'message'), new Promise((_resolve, reject) => setTimeout(() => reject(new Error('WebSocket hello 超时')), 5000).unref())]);
    assert.equal(JSON.parse(String(hello[0])).version, manifest.version); const pong = once(ws, 'message'); ws.send(JSON.stringify({ type: 'ping' })); assert.equal(JSON.parse(String((await pong)[0])).type, 'pong');
  } finally { ws.terminate(); }
  succeeded = true;
} finally {
  launcher.kill('SIGTERM'); const fallback = setTimeout(() => launcher.kill('SIGKILL'), 5000); await exit; clearTimeout(fallback);
  await new Promise((r) => setTimeout(r, 100));
  const released = net.createServer(); released.listen(port, '127.0.0.1'); await once(released, 'listening'); await new Promise((r) => released.close(r));
  fs.writeFileSync(path.join(directory, 'report.json'), JSON.stringify({ succeeded, version: manifest.version, revision: manifest.revision, sha256: manifest.sha256, freshInstall: true, launcher: 'start.command', pathWithSpaces: true, privateDataIncluded: false, portReleased: true, provider: 'not_configured', directory }, null, 2) + '\n');
}
console.log('✓ 发布包 SHA256、纯源码、含空格目录全新安装、一键启动、HTTP/静态资源/WS、无模型初始状态与端口回收');
console.log('产物保留：' + directory);
