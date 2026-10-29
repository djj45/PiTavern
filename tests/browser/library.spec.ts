import { test as base, expect, type Page } from '@playwright/test';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { charxFixture, byafFixture } from '../../apps/server/scripts/card-fixtures.ts';
import { extractPngTextChunks } from '../../apps/server/src/stdata/png.ts';

const test = base.extend<{ app: { baseURL: string; runDir: string } }>({
  app: async ({}, use, info) => {
    const runDir = fs.mkdtempSync(path.join(process.env.PITAVERN_BROWSER_RUN!, `fixture-${info.workerIndex}-`));
    const child = spawn(process.execPath, ['--import', 'tsx', 'apps/server/scripts/browser-fixture.ts'], { cwd: process.cwd(), env: { ...process.env, PITAVERN_BROWSER_FIXTURE: runDir }, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', (part) => { output += part; fs.appendFileSync(path.join(runDir, 'server.log'), part); });
    child.stderr.on('data', (part) => fs.appendFileSync(path.join(runDir, 'server.log'), part));
    try {
      const start = Date.now();
      while (!/PITAVERN_FIXTURE=(.+)/.test(output)) {
        if (child.exitCode !== null || Date.now() - start > 15000) throw new Error(`Fixture did not start: ${runDir}/server.log`);
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      await use(JSON.parse(/PITAVERN_FIXTURE=(.+)/.exec(output)![1]));
    } finally {
      if (child.exitCode === null) {
        const exited = once(child, 'exit'); child.kill('SIGTERM');
        const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
        await exited; clearTimeout(timer);
      }
    }
  },
});
const open = async (page: Page, url: string) => {
  await page.goto(url); await expect(page.getByText('在线', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '资料库', exact: true }).click();
};
test.beforeEach(async ({ page }) => {
  page.on('pageerror', (error) => { throw error; });
});

test('世界书保存、刷新和旧版本冲突保留草稿', async ({ page, app, request }) => {
  await open(page, app.baseURL);
  await page.getByLabel('资料文件').selectOption('world:browser.json');
  await page.getByLabel('条目内容', { exact: true }).fill('浏览器保存的内容');
  await page.getByRole('button', { name: '保存资料', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('已保存');
  await page.reload(); await page.getByRole('button', { name: '资料库', exact: true }).click();
  await page.getByLabel('资料文件').selectOption('world:browser.json');
  await expect(page.getByLabel('条目内容', { exact: true })).toHaveValue('浏览器保存的内容');
  await page.getByLabel('条目内容', { exact: true }).fill('保留这份草稿');
  const current = await (await request.get(app.baseURL + '/api/library/document?id=world:browser.json')).json();
  current.data.entries['0'].content = '另一个窗口的修改';
  expect((await request.put(app.baseURL + '/api/library/document', { data: { id: current.resource.id, revision: current.revision, data: current.data } })).ok()).toBeTruthy();
  await page.getByRole('button', { name: '保存资料', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('其他窗口');
  await expect(page.getByLabel('条目内容', { exact: true })).toHaveValue('保留这份草稿');
});

test('正则预览超时后界面可操作，聊天展示也在工作线程执行', async ({ page, app, request }) => {
  const doc = await (await request.get(app.baseURL + '/api/library/document?id=global-regex:regex.json')).json();
  doc.data = [{ scriptName: '展示替换', findRegex: '模型原文', replaceString: '显示后的回复', placement: [2] }];
  expect((await request.put(app.baseURL + '/api/library/document', { data: { id: doc.resource.id, revision: doc.revision, data: doc.data } })).ok()).toBeTruthy();
  await page.goto(app.baseURL);
  await page.locator('aside li button').filter({ hasText: '浏览器向导' }).first().click();
  await page.getByPlaceholder(/身份发言/).fill('你好'); await page.getByRole('button', { name: '发送', exact: true }).click();
  await expect(page.getByText('显示后的回复', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '资料库', exact: true }).click();
  await page.getByRole('tab', { name: '正则脚本' }).click();
  await page.getByLabel('资料文件').selectOption('global-regex:regex.json');
  await page.getByRole('button', { name: '复制脚本', exact: true }).click();
  await page.getByLabel('搜索正则脚本').fill('副本');
  await expect(page.getByLabel('正则脚本', { exact: true }).locator('option')).toHaveCount(1);
  await page.getByLabel('查找表达式', { exact: true }).fill('/{{char}}/gu');
  await page.getByLabel('查找宏替换', { exact: true }).selectOption('1');
  await page.getByLabel('替换内容', { exact: true }).fill('宏替换成功');
  await page.getByLabel('正则测试文本').fill('角色');
  await page.getByRole('button', { name: '运行预览', exact: true }).click();
  await expect(page.getByLabel('正则预览结果')).toContainText('宏替换成功');
  await page.getByLabel('查找表达式', { exact: true }).fill('/(a+)+$/');
  await page.getByLabel('正则测试文本').fill('a'.repeat(32) + '!');
  await page.getByRole('button', { name: '运行预览', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('超时');
  await expect(page.getByRole('button', { name: '关闭', exact: true })).toBeEnabled();
});

test('整库下载、上传校验和恢复锁定', async ({ page, app }) => {
  await open(page, app.baseURL); await page.getByRole('tab', { name: '备份与迁移' }).click();
  const downloaded = page.waitForEvent('download');
  await page.getByRole('button', { name: '导出整库备份' }).click();
  const archive = path.join(app.runDir, 'browser.pitavern.gz'); await (await downloaded).saveAs(archive);
  await page.locator('dialog input[type=file]').setInputFiles(archive);
  await expect(page.getByRole('heading', { name: '备份预览' })).toBeVisible();
  await expect(page.getByRole('button', { name: '恢复到新目录', exact: true })).toBeDisabled();
  await page.getByRole('checkbox', { name: /我已核对预览/ }).check();
  await page.getByRole('button', { name: '恢复到新目录', exact: true }).click();
  await expect(page.getByText('恢复完成，请重启 PiTavern 服务后继续。', { exact: true })).toBeVisible();
  await expect(page.getByText('旧目录（回退保留）：', { exact: false })).toBeVisible();
});

test('手机资料库无水平溢出且表单可操作', async ({ page, app }) => {
  await page.setViewportSize({ width: 390, height: 844 }); await open(page, app.baseURL);
  await page.getByLabel('资料文件').selectOption('world:browser.json');
  await page.getByLabel('条目内容', { exact: true }).fill('手机编辑');
  await page.getByRole('button', { name: '保存资料', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('已保存');
  expect(await page.locator('dialog').evaluate((node) => node.scrollWidth <= node.clientWidth + 1)).toBeTruthy();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
  await page.screenshot({ path: path.join(app.runDir, 'mobile-library.png'), fullPage: true });
});

test('刷新后恢复草稿、搜索复制并从历史恢复', async ({ page, app, request }) => {
  await open(page, app.baseURL); await page.getByLabel('资料文件').selectOption('world:browser.json');
  await page.getByLabel('条目内容', { exact: true }).fill('刷新不能丢失的草稿');
  page.once('dialog', (dialog) => dialog.accept()); await page.reload();
  await page.getByRole('button', { name: '资料库', exact: true }).click(); await page.getByLabel('资料文件').selectOption('world:browser.json');
  await expect(page.getByRole('button', { name: '恢复本地草稿', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '恢复本地草稿', exact: true }).click();
  await expect(page.getByLabel('条目内容', { exact: true })).toHaveValue('刷新不能丢失的草稿');
  await page.getByRole('button', { name: '复制条目', exact: true }).click();
  await page.getByRole('button', { name: '保存资料', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('已保存');
  await page.getByLabel('搜索世界书条目').fill('副本');
  await expect(page.getByLabel('世界书条目').locator('option')).toHaveCount(1);
  await expect(page.getByLabel('条目备注', { exact: true })).toHaveValue('初始条目（副本）');
  await page.getByText('编辑历史与恢复', { exact: true }).click();
  await page.getByRole('button', { name: '查看编辑历史', exact: true }).click();
  const history = await (await request.get(app.baseURL + '/api/library/history?id=world:browser.json')).json();
  await page.getByRole('button', { name: new RegExp(history.items[0].revision.slice(0, 8)) }).click();
  await expect(page.getByLabel('历史资料内容', { exact: true })).toContainText('初始内容');
  await page.getByRole('checkbox', { name: '我已对比内容，确认恢复此版本' }).check();
  await page.getByRole('button', { name: '恢复此历史版本', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('历史版本已恢复');
  await expect(page.getByLabel('条目内容', { exact: true })).toHaveValue('初始内容');
  const after = await (await request.get(app.baseURL + '/api/library/history?id=world:browser.json')).json();
  expect(after.items.length).toBe(2);
  expect((await request.post(app.baseURL + '/api/library/history/restore', { data: { id: 'world:browser.json', backupId: after.items[0].id, revision: 'stale' } })).status()).toBe(409);
});

test('真实聊天显示正则超时后仍可打开资料库', async ({ page, app, request }) => {
  const doc = await (await request.get(app.baseURL + '/api/library/document?id=global-regex:regex.json')).json();
  expect((await request.put(app.baseURL + '/api/library/document', { data: { id: doc.resource.id, revision: doc.revision, data: [{ scriptName: '危险显示正则', findRegex: '/(a+)+$/', replaceString: '', placement: [2], markdownOnly: true }] } })).ok()).toBeTruthy();
  await page.goto(app.baseURL); await page.locator('aside li button').filter({ hasText: '浏览器向导' }).first().click();
  await page.getByRole('button', { name: '编辑浏览器向导的消息', exact: true }).click();
  await page.getByLabel('编辑消息内容').fill('a'.repeat(32) + '!'); await page.getByRole('button', { name: '保存修改', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('显示正则超时');
  expect((await request.get(app.baseURL + '/api/status')).ok()).toBeTruthy();
  const repaired = await (await request.get(app.baseURL + '/api/library/document?id=global-regex:regex.json')).json();
  repaired.data[0].findRegex = '/a+/g'; repaired.data[0].replaceString = '恢复后的显示';
  expect((await request.put(app.baseURL + '/api/library/document', { data: { id: repaired.resource.id, revision: repaired.revision, data: repaired.data } })).ok()).toBeTruthy();
  await expect(page.getByText('恢复后的显示!', { exact: true })).toBeVisible();
  await expect(page.getByRole('alert')).toHaveCount(0);
  await page.getByRole('button', { name: '资料库', exact: true }).click();
  await expect(page.getByRole('dialog', { name: '资料库' })).toBeVisible();
});

test('便携设置可选迁移、预览刷新恢复以及备份占用展示', async ({ page, app, request }) => {
  expect((await request.put(app.baseURL + '/api/connection', { data: { persona: { name: '迁移 persona', description: '源端描述' } } })).ok()).toBeTruthy();
  await open(page, app.baseURL); await page.getByRole('tab', { name: '备份与迁移' }).click();
  await page.getByRole('checkbox', { name: /导出时附带便携应用设置/ }).check();
  const download = page.waitForEvent('download'); await page.getByRole('button', { name: '导出整库备份', exact: true }).click();
  const archive = path.join(app.runDir, 'portable.pitavern.gz'); await (await download).saveAs(archive);
  expect((await request.put(app.baseURL + '/api/connection', { data: { persona: { name: '本机 persona', description: '' } } })).ok()).toBeTruthy();
  await page.getByText('备份磁盘占用与管理', { exact: true }).click(); await page.getByRole('button', { name: '刷新备份占用', exact: true }).click();
  await expect(page.getByText(/完整导出 ·/)).toBeVisible();
  await page.getByLabel('选择整库备份', { exact: true }).setInputFiles(archive);
  await expect(page.getByRole('heading', { name: '备份预览', exact: true })).toBeVisible();
  await expect(page.getByRole('checkbox', { name: '同时应用归档中的便携设置' })).not.toBeChecked();
  await page.reload(); await page.getByRole('button', { name: '资料库', exact: true }).click(); await page.getByRole('tab', { name: '备份与迁移' }).click();
  await expect(page.getByRole('heading', { name: '备份预览', exact: true })).toBeVisible();
  await page.getByText('查看归档中的便携设置', { exact: true }).click();
  await expect(page.getByLabel('便携设置预览')).toContainText('迁移 persona');
  await page.getByRole('checkbox', { name: '同时应用归档中的便携设置' }).check();
  await page.getByRole('checkbox', { name: /我已核对预览/ }).check();
  await page.screenshot({ path: path.join(app.runDir, 'portable-preview-desktop.png'), fullPage: true });
  await page.getByRole('button', { name: '恢复到新目录', exact: true }).click();
  await expect(page.getByText('恢复完成，请重启 PiTavern 服务后继续。', { exact: true })).toBeVisible();
  const config = JSON.parse(fs.readFileSync(path.join(app.runDir, 'config.json'), 'utf8'));
  expect(config.persona.name).toBe('迁移 persona'); expect(config.providers[0].apiKey).toBe('synthetic-only'); expect(config.defaultModel).toBe('fixture');
});

test('取消等待上传的任务后解除维护锁', async ({ page, app, request }) => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  await page.route('**/api/library-backup/jobs/*/upload', async (route) => { await gate; await route.abort(); });
  await open(page, app.baseURL); await page.getByRole('tab', { name: '备份与迁移' }).click();
  await page.getByLabel('选择整库备份', { exact: true }).setInputFiles({ name: 'cancel.pitavern.gz', mimeType: 'application/gzip', buffer: Buffer.from('synthetic-only') });
  await expect(page.getByRole('button', { name: '取消当前任务', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '取消当前任务', exact: true }).click(); release();
  await expect(page.getByRole('dialog').getByText('操作已取消', { exact: true })).toBeVisible();
  expect((await request.get(app.baseURL + '/api/chats')).status()).toBe(200);
  await expect(page.getByRole('button', { name: '导出整库备份', exact: true })).toBeEnabled();
});


test('JSON 和 PNG 卡内世界书编辑保留原图与未知字段', async ({ page, app }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const picture = path.join(app.runDir, 'st/characters/picture.png');
  const original = fs.readFileSync(picture);
  await open(page, app.baseURL);
  await page.getByLabel('资料文件').selectOption('character-world:browser.json');
  await expect(page.getByLabel('条目内容', { exact: true })).toHaveValue('卡内初始内容');
  await page.getByLabel('条目内容', { exact: true }).fill('JSON 卡内保存');
  await page.getByRole('button', { name: '保存资料', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('已保存');
  await page.getByLabel('资料文件').selectOption('character-world:picture.png');
  await page.getByRole('button', { name: '复制条目', exact: true }).click();
  await page.getByLabel('条目内容', { exact: true }).fill('PNG 副本内容');
  await page.getByRole('button', { name: '保存资料', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('已保存');
  const current = fs.readFileSync(picture), chunks = extractPngTextChunks(current)!;
  const raw = JSON.parse(Buffer.from(chunks.ccv3, 'base64').toString());
  expect(raw.data.character_book.entries).toHaveLength(2);
  expect(raw.data.character_book.entries[1].content).toBe('PNG 副本内容');
  expect(raw.data.character_book.entries[1].unknownEntry).toEqual({ keep: [1, 2] });
  expect(raw.data.character_book.entries[0].id).not.toBe(raw.data.character_book.entries[1].id);
  expect(chunks.Comment).toBe('preserved');
  for (let offset = 8; offset + 12 <= current.length;) { const n = current.readUInt32BE(offset); if (current.toString('ascii', offset + 4, offset + 8) === 'IDAT') expect(original.includes(current.subarray(offset, offset + n + 12))).toBeTruthy(); offset += n + 12; }
  expect(await page.locator('dialog').evaluate((node) => node.scrollWidth <= node.clientWidth + 1)).toBeTruthy();
  await page.screenshot({ path: path.join(app.runDir, 'mobile-card-world.png'), fullPage: true });
  await page.reload(); await page.getByRole('button', { name: '资料库', exact: true }).click();
  await page.getByLabel('资料文件').selectOption('character-world:browser.json');
  await expect(page.getByLabel('条目内容', { exact: true })).toHaveValue('JSON 卡内保存');
});

test('侧栏导入 CharX 后头像可读且可编辑卡内世界书', async ({ page, app, request }) => {
  await page.goto(app.baseURL); await expect(page.getByText('在线', { exact: true })).toBeVisible();
  await page.locator('aside input[type=file]').setInputFiles({ name: 'archive.charx', mimeType: 'application/octet-stream', buffer: charxFixture('界面归档向导') });
  await expect(page.getByRole('button', { name: '界面归档向导', exact: true })).toBeVisible();
  const cards = await (await request.get(app.baseURL + '/api/characters')).json();
  const imported = cards.find((card: { name: string }) => card.name === '界面归档向导'); expect(imported.avatarUrl).toBeTruthy();
  expect((await request.get(app.baseURL + imported.avatarUrl)).ok()).toBeTruthy();
  await page.getByRole('button', { name: '资料库', exact: true }).click();
  await page.getByLabel('资料文件').selectOption('character-world:archive.json');
  await page.getByLabel('条目内容', { exact: true }).fill('导入后修改');
  await page.getByRole('button', { name: '保存资料', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('已保存');
});

test('侧栏导入 BYAF 后能直接打开场景聊天与继续生成', async ({ page, app, request }) => {
  expect((await request.put(app.baseURL + '/api/connection', { data: { contextMode: 'simple' } })).ok()).toBeTruthy();
  await page.goto(app.baseURL); await expect(page.getByText('在线', { exact: true })).toBeVisible();
  await page.locator('aside input[type=file]').setInputFiles({ name: 'guide.byaf', mimeType: 'application/octet-stream', buffer: byafFixture() });
  await expect(page.getByRole('button', { name: 'BYAF向导', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'BYAF向导', exact: true }).click();
  await expect(page.locator('aside').first().locator('li')).toHaveCount(2);
  await page.locator('aside li button').filter({ hasText: '另一个开场' }).click();
  await expect(page.getByText('另一个开场', { exact: true })).toBeVisible();
  await page.getByPlaceholder(/身份发言/).fill('继续这个场景');
  await page.getByRole('button', { name: '发送', exact: true }).click();
  await expect(page.getByText('模型原文', { exact: true })).toBeVisible();
  const requests = fs.readFileSync(path.join(app.runDir, 'requests.ndjson'), 'utf8');
  expect(requests).toContain('第二个独立场景'); expect(requests).not.toContain('首个场景');
});

test('创建群聊、全员与指定角色发言、候选切换和重载', async ({ page, app, request }) => {
  expect((await request.put(app.baseURL + '/api/connection', { data: { contextMode: 'simple' } })).ok()).toBeTruthy();
  await page.goto(app.baseURL); await expect(page.getByText('在线', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '＋ 新建群聊', exact: true }).click();
  const form = page.getByRole('form', { name: '新建群聊' });
  await form.getByLabel('群聊名称').fill('浏览器群聊');
  await form.getByLabel('浏览器向导').check(); await form.getByLabel('图片向导').check();
  await form.getByRole('button', { name: '创建群聊', exact: true }).click();
  await expect(page.getByLabel('本轮发言角色')).toBeVisible();
  await page.getByPlaceholder(/身份发言/).fill('一起出发'); await page.getByRole('button', { name: '发送', exact: true }).click();
  await expect(page.getByText('模型原文', { exact: true })).toHaveCount(2);
  await expect(page.getByRole('button', { name: '重新生成回复', exact: true })).toBeEnabled();
  const list = await (await request.get(app.baseURL + '/api/chats')).json(); const group = list.find((item: { group?: { name: string } }) => item.group?.name === '浏览器群聊'); expect(group).toBeTruthy();
  let stored = await (await request.get(app.baseURL + '/api/chats/' + group.id)).json();
  expect(stored.messages.map((line: { name: string }) => line.name).slice(-2)).toEqual(['浏览器向导', '图片向导']);
  await page.getByLabel('本轮发言角色').selectOption('图片向导');
  await page.getByPlaceholder(/身份发言/).fill('只让图片向导回答'); await page.getByRole('button', { name: '发送', exact: true }).click();
  await expect(page.getByText('模型原文', { exact: true })).toHaveCount(3); await expect(page.getByRole('button', { name: '重新生成回复', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: '重新生成回复', exact: true }).click();
  await expect(page.getByText('候选 2 / 2', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '上一个候选回复' }).click(); await expect(page.getByText('候选 1 / 2', { exact: true })).toBeVisible();
  await page.reload(); await page.locator('aside').first().getByRole('button').filter({ hasText: '浏览器群聊' }).click();
  await expect(page.getByLabel('本轮发言角色')).toBeVisible();
  stored = await (await request.get(app.baseURL + '/api/chats/' + group.id)).json(); expect(stored.group.members).toEqual(['浏览器向导', '图片向导']);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: '工具活动与用量面板', exact: true }).click();
  await expect.poll(async () => (await page.locator('aside').first().boundingBox())!.x + (await page.locator('aside').first().boundingBox())!.width).toBeLessThanOrEqual(1);
  await expect(page.getByLabel('本轮发言角色')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBeTruthy();
  await page.screenshot({ path: path.join(app.runDir, 'mobile-group.png'), fullPage: true });
});

test('STscript 编辑器执行闭包、事务回滚和无需模型的聊天命令', async ({ page, app, request }) => {
  await page.goto(app.baseURL); await page.locator('aside').first().locator('li').getByRole('button').filter({ hasText: '浏览器向导' }).first().click();
  await page.getByRole('button', { name: 'STscript', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'STscript 编辑器' });
  await dialog.getByLabel('STscript 源码').fill('/setvar key=n 0 | /times 3 {: /incvar n :} | /sendas name=图片向导 脚本计数{{getvar::n}} | /echo 已完成');
  await dialog.getByRole('button', { name: '执行脚本' }).click(); await expect(dialog.getByRole('status')).toContainText('已完成');
  await dialog.getByLabel('STscript 源码').fill('/setvar key=n 99 | /sendas name=图片向导 不应保存 | /unsupported');
  await dialog.getByRole('button', { name: '执行脚本' }).click(); await expect(dialog.getByRole('alert')).toContainText('暂不支持');
  await dialog.getByRole('button', { name: '关闭脚本' }).click();
  await expect(page.getByText('脚本计数3', { exact: true })).toBeVisible(); await expect(page.getByText('不应保存', { exact: true })).toHaveCount(0);
  const list = await (await request.get(app.baseURL + '/api/chats')).json(), id = list.find((item: { character: string }) => item.character === '浏览器向导').id;
  const file = path.join(app.runDir, 'st', id); expect(JSON.parse(fs.readFileSync(file, 'utf8').split('\n')[0]).chat_metadata.variables.n).toBe('3');
  expect((await request.put(app.baseURL + '/api/connection', { data: { defaultModel: '' } })).ok()).toBeTruthy(); await page.reload();
  await page.locator('aside').first().locator('li').getByRole('button').filter({ hasText: '浏览器向导' }).first().click();
  await page.getByPlaceholder(/身份发言/).fill('/sendas name=图片向导 无模型脚本'); await expect(page.getByRole('button', { name: '发送', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: '发送', exact: true }).click(); await expect(page.getByText('无模型脚本', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'STscript', exact: true }).click(); await dialog.getByLabel('STscript 源码').fill('/setvar key=n 100 | /delay 5000 | /send 不保存'); await dialog.getByRole('button', { name: '执行脚本' }).click();
  await dialog.getByRole('button', { name: '停止脚本' }).click(); await expect(dialog.getByRole('alert')).toBeVisible(); await expect(dialog.getByRole('button', { name: '执行脚本' })).toBeEnabled();
  await page.setViewportSize({ width: 390, height: 844 }); expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBeTruthy(); await page.screenshot({ path: path.join(app.runDir, 'mobile-script.png'), fullPage: true });
});
