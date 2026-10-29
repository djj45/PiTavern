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
  await page.getByRole('button', { name: '资料', exact: true }).click();
};
const openChatActions = async (page: Page) => {
  await page.getByRole('button', { name: '聊天操作', exact: true }).click();
};
test.beforeEach(async ({ page }) => {
  page.on('pageerror', (error) => { throw error; });
});

test('八个备用开局可选择和翻页，刷新保留选中正文并用于模型对话', async ({ page, app, request }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const connection = await (await request.get(app.baseURL + '/api/connection')).json();
  await page.goto(app.baseURL);
  await page.getByRole('button', { name: '菜单', exact: true }).click();
  await page.locator('aside').getByRole('button', { name: '多开局向导', exact: true }).click();
  await page.getByRole('button', { name: '＋ 开始新对话', exact: true }).click();
  const greetingButton = page.getByRole('button', { name: '开场白', exact: true });
  await expect(greetingButton).toBeVisible();
  await greetingButton.click();
  const picker = page.getByRole('dialog', { name: '选择开场白', exact: true });
  await expect(picker).toBeVisible();
  await expect(picker.getByRole('button')).toHaveCount(9);
  await expect(picker.getByRole('button').first()).toHaveAttribute('aria-current', 'true');
  await expect(picker.getByRole('button', { name: /开局 3/ })).toContainText('开局 3 · 合成场景3');
  await picker.getByRole('button', { name: /开局 3/ }).click();
  await expect(page.getByText(`合成开局3：${connection.persona.name}抵达地点3。`, { exact: true })).toBeVisible();
  await greetingButton.click();
  await picker.getByRole('button', { name: /开局 4/ }).click();
  await expect(page.getByText(`合成开局4：${connection.persona.name}抵达地点4。`, { exact: true })).toBeVisible();
  await greetingButton.click();
  await expect(picker.getByRole('button', { name: /开局 4/ })).toHaveAttribute('aria-current', 'true');
  await picker.getByRole('button', { name: /开局 8/ }).click();
  await expect(page.getByText(`合成开局8：${connection.persona.name}抵达地点8。`, { exact: true })).toBeVisible();
  await greetingButton.click();
  await expect(picker.getByRole('button', { name: /开局 8/ })).toHaveAttribute('aria-current', 'true');
  await page.keyboard.press('Escape');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBeTruthy();
  await page.screenshot({ path: path.join(app.runDir, 'greetings-mobile.png') });
  const list = await (await request.get(app.baseURL + '/api/chats')).json();
  const chat = list.find((item: { character: string }) => item.character === '多开局向导');
  const exported = await (await request.get(app.baseURL + '/api/chats/' + chat.id + '/export?format=jsonl')).text();
  const opening = JSON.parse(exported.trim().split('\n')[1]);
  expect(opening.swipe_id).toBe(8); expect(opening.mes).toBe('合成开局8：{{user}}抵达地点8。');
  await page.reload();
  await page.getByRole('button', { name: '菜单', exact: true }).click();
  await page.locator('aside li button').filter({ hasText: '多开局向导' }).first().click();
  await expect(page.getByText(`合成开局8：${connection.persona.name}抵达地点8。`, { exact: true })).toBeVisible();
  await greetingButton.click();
  await expect(picker.getByRole('button', { name: /开局 8/ })).toHaveAttribute('aria-current', 'true');
  await page.keyboard.press('Escape');
  await page.getByPlaceholder(/身份发言/).fill('继续这个开局');
  await page.getByRole('button', { name: '发送', exact: true }).click();
  await expect(page.getByText('模型原文', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '开场白', exact: true })).toHaveCount(0);
  const sent = fs.readFileSync(path.join(app.runDir, 'requests.ndjson'), 'utf8');
  expect(sent).toContain(`合成开局8：${connection.persona.name}抵达地点8。`);
  expect(sent).not.toContain('合成开局1：');
});

test('已有介绍页聊天可切换开局，其他窗口同步且过期选择被拒绝', async ({ page, app, request }) => {
  const cards = await (await request.get(app.baseURL + '/api/characters')).json();
  const card = cards.find((item: { name: string }) => item.name === '多开局向导');
  const created = await request.post(app.baseURL + '/api/chats', { data: { character: card.name } });
  const { id } = await created.json();
  const initial = await (await request.get(app.baseURL + '/api/chats/' + id)).json();
  const exported = await (await request.get(app.baseURL + '/api/chats/' + id + '/export?format=jsonl')).text();
  expect(JSON.parse(exported.trim().split('\n')[1]).swipes).toBeUndefined();
  const other = await page.context().newPage();
  for (const window of [page, other]) {
    await window.goto(app.baseURL);
    await window.locator('aside li button').filter({ hasText: card.name }).first().click();
    await window.getByRole('button', { name: '开场白', exact: true }).click();
    const dialog = window.getByRole('dialog', { name: '选择开场白', exact: true });
    await expect(dialog.getByRole('button')).toHaveCount(9);
    await expect(dialog.getByRole('button').first()).toHaveAttribute('aria-current', 'true');
    await window.keyboard.press('Escape');
  }
  await page.getByRole('button', { name: '开场白', exact: true }).click();
  await page.getByRole('dialog', { name: '选择开场白', exact: true }).getByRole('button', { name: /开局 5/ }).click();
  await other.getByRole('button', { name: '开场白', exact: true }).click();
  await expect(other.getByRole('dialog', { name: '选择开场白', exact: true }).getByRole('button', { name: /开局 5/ })).toHaveAttribute('aria-current', 'true');
  const rejected = await request.post(app.baseURL + '/api/chat/greeting', { data: { chatId: id, selected: 2, revision: initial.page.revision } });
  expect(rejected.status()).toBe(409);
  expect((await (await request.get(app.baseURL + '/api/chats/' + id)).json()).greetingChoices.selected).toBe(5);
  await other.close();
});

test('模型列表搜索添加、去重、保存与已有参数保留，手机布局可操作', async ({ page, app, request }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(app.baseURL);
  await page.getByRole('button', { name: '设置', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '设置', exact: true });
  const provider = dialog.getByRole('group', { name: '模型连接：本地合成连接', exact: true });
  await provider.getByLabel('模型上下文长度：fixture', { exact: true }).fill('9000');
  await provider.getByRole('button', { name: '获取模型列表', exact: true }).click();
  await expect(provider.getByRole('status')).toContainText('已获取 3 个模型');
  await expect(provider.getByLabel('模型上下文长度：fixture', { exact: true })).toHaveValue('9000');
  const list = provider.getByLabel('可用模型', { exact: true });
  await expect(list.locator('option[value="fixture"]')).toBeDisabled();
  await provider.getByLabel('搜索可用模型').fill('列表模型');
  await list.selectOption('discovered-chat');
  await provider.getByRole('button', { name: '添加所选模型', exact: true }).click();
  await expect(provider.getByLabel('模型显示名：discovered-chat', { exact: true })).toHaveCount(1);
  await expect(list.locator('option[value="discovered-chat"]')).toBeDisabled();
  await provider.getByRole('button', { name: /手动添加/ }).click();
  await provider.getByLabel('手动模型 ID').fill('discovered-chat');
  await provider.getByRole('button', { name: '添加模型', exact: true }).click();
  await expect(provider.getByLabel('模型显示名：discovered-chat', { exact: true })).toHaveCount(1);
  await expect.poll(async () => (await (await request.get(app.baseURL + '/api/connection')).json()).providers[0].models.length, { timeout: 5000 }).toBe(2);
  expect(await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBeTruthy();
  const autoSaved = await (await request.get(app.baseURL + '/api/connection')).json();
  expect(autoSaved.providers[0].models.map((model: { id: string }) => model.id)).toEqual(['fixture', 'discovered-chat']);
  expect(autoSaved.providers[0].models[0].contextWindow).toBe(9000);
  expect(autoSaved.providers[0].models[0].maxTokens).toBe(500);
  expect(autoSaved.defaultModel).toBe('fixture');
  await expect(dialog.getByText('已自动保存', { exact: true })).toBeVisible({ timeout: 5000 });
  await dialog.getByRole('button', { name: '关闭设置', exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await expect(provider.getByLabel('模型显示名：discovered-chat', { exact: true })).toBeVisible();
});

test('模型列表使用新连接草稿地址和密钥，放弃更改不落库', async ({ page, app, request }) => {
  const initial = await (await request.get(app.baseURL + '/api/connection')).json();
  const origin = new URL(initial.providers[0].baseUrl).origin;
  await page.goto(app.baseURL);
  await page.getByRole('button', { name: '设置', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '设置', exact: true });
  await dialog.getByRole('button', { name: '＋ 添加', exact: true }).click();
  const provider = dialog.getByRole('group', { name: '模型连接：新中转', exact: true });
  await provider.getByLabel('接口地址').fill(origin + '/draft');
  await provider.getByLabel('API Key', { exact: true }).fill('synthetic-draft');
  await provider.getByRole('button', { name: '获取模型列表', exact: true }).click();
  await expect(provider.getByRole('status')).toContainText('已获取 3 个模型');
  await provider.getByLabel('可用模型', { exact: true }).selectOption('discovered-chat');
  await provider.getByRole('button', { name: '添加所选模型', exact: true }).click();
  await dialog.getByRole('button', { name: '放弃本次更改', exact: true }).click();
  await expect(dialog).not.toBeVisible();
  expect(await (await request.get(app.baseURL + '/api/connection')).json()).toEqual(initial);
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await expect(dialog.getByRole('group')).toHaveCount(1);
  const saved = dialog.getByRole('group');
  await saved.getByLabel('API Key', { exact: true }).fill('synthetic-draft');
  await saved.getByLabel('接口地址').fill(origin + '/missing');
  await saved.getByRole('button', { name: '获取模型列表', exact: true }).click();
  await expect(saved.getByRole('alert')).toContainText('HTTP 404');
  await saved.getByRole('button', { name: /手动添加/ }).click();
  await saved.getByLabel('手动模型 ID').fill('manual-model');
  await saved.getByRole('button', { name: '添加模型', exact: true }).click();
  await expect(saved.getByLabel('模型显示名：manual-model', { exact: true })).toBeVisible();
  await dialog.getByRole('button', { name: '放弃本次更改', exact: true }).click();
  await expect(dialog).not.toBeVisible();
  expect(await (await request.get(app.baseURL + '/api/connection')).json()).toEqual(initial);
});

test('模型列表请求可取消，编辑地址清除旧结果并处理空列表', async ({ page, app, request }) => {
  const initial = await (await request.get(app.baseURL + '/api/connection')).json();
  const origin = new URL(initial.providers[0].baseUrl).origin;
  await page.goto(app.baseURL);
  await page.getByRole('button', { name: '设置', exact: true }).click();
  const provider = page.getByRole('dialog', { name: '设置', exact: true }).getByRole('group');
  await provider.getByLabel('接口地址').fill(origin + '/slow');
  await provider.getByLabel('API Key', { exact: true }).fill('synthetic-draft');
  const slowCount = () => {
    const file = path.join(app.runDir, 'model-requests.ndjson');
    return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter((line) => line.includes('/slow/models')).length : 0;
  };
  await provider.getByRole('button', { name: '获取模型列表', exact: true }).click();
  await expect.poll(slowCount).toBe(1);
  await provider.getByRole('button', { name: '取消获取', exact: true }).click();
  await expect(provider.getByRole('button', { name: '获取模型列表', exact: true })).toBeEnabled();
  await expect(provider.getByRole('alert')).toHaveCount(0);
  await provider.getByRole('button', { name: '获取模型列表', exact: true }).click();
  await expect.poll(slowCount).toBe(2);
  await provider.getByLabel('接口地址').fill(origin + '/empty');
  await expect(provider.getByRole('button', { name: '获取模型列表', exact: true })).toBeEnabled();
  await provider.getByRole('button', { name: '获取模型列表', exact: true }).click();
  await expect(provider.getByRole('status')).toContainText('模型列表为空');
  await expect(provider.getByLabel('可用模型', { exact: true })).toHaveCount(0);
  await provider.getByLabel('接口地址').fill(origin + '/v1');
  await expect(provider.getByRole('status')).toHaveCount(0);
  await provider.getByRole('button', { name: '获取模型列表', exact: true }).click();
  await expect(provider.getByRole('status')).toContainText('已获取 3 个模型');
  await provider.getByLabel('API Key', { exact: true }).fill('');
  await expect(provider.getByRole('status')).toHaveCount(0);
  const settings = page.getByRole('dialog', { name: '设置', exact: true });
  await settings.getByRole('button', { name: '放弃本次更改', exact: true }).click();
  await expect(settings).toHaveCount(0);
  expect(await (await request.get(app.baseURL + '/api/connection')).json()).toEqual(initial);
});

test('世界书保存、刷新和旧版本冲突保留草稿', async ({ page, app, request }) => {
  await open(page, app.baseURL);
  await page.getByLabel('资料文件').selectOption('world:browser.json');
  await page.getByLabel('条目内容', { exact: true }).fill('浏览器保存的内容');
  await page.getByRole('button', { name: '保存资料', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('已保存');
  await page.reload(); await page.getByRole('button', { name: '资料', exact: true }).click();
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
  await page.getByRole('button', { name: '资料', exact: true }).click();
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
  await page.getByRole('button', { name: '资料', exact: true }).click(); await page.getByLabel('资料文件').selectOption('world:browser.json');
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
  await page.getByRole('button', { name: '资料', exact: true }).click();
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
  await page.reload(); await page.getByRole('button', { name: '资料', exact: true }).click(); await page.getByRole('tab', { name: '备份与迁移' }).click();
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
  await page.reload(); await page.getByRole('button', { name: '资料', exact: true }).click();
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
  await page.getByRole('button', { name: '资料', exact: true }).click();
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
  await expect(page.getByRole('button', { name: '剧情分支' })).toContainText('分支 2/2');
  await page.getByRole('button', { name: '剧情分支' }).click();
  const branchDialog = page.getByRole('dialog', { name: '分支选择' });
  await expect(branchDialog.getByText(/共 2 个节点/)).toBeVisible();
  await branchDialog.getByRole('button', { name: /未继续的候选/ }).click();
  await expect(branchDialog.locator('button[aria-pressed]')).toHaveCount(2);
  await branchDialog.locator('button[aria-pressed]').nth(1).click();
  await branchDialog.getByRole('button', { name: '继续这条路线' }).click();
  await expect(page.getByText('已切换剧情路线', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '剧情分支' })).toContainText('分支 1/2');
  await page.reload(); await page.locator('aside').first().getByRole('button').filter({ hasText: '浏览器群聊' }).click();
  await expect(page.getByLabel('本轮发言角色')).toBeVisible();
  stored = await (await request.get(app.baseURL + '/api/chats/' + group.id)).json(); expect(stored.group.members).toEqual(['浏览器向导', '图片向导']);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: '统计', exact: true }).click();
  await expect.poll(async () => (await page.locator('aside').first().boundingBox())!.x + (await page.locator('aside').first().boundingBox())!.width).toBeLessThanOrEqual(1);
  await expect(page.getByLabel('本轮发言角色')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBeTruthy();
  await page.screenshot({ path: path.join(app.runDir, 'mobile-group.png'), fullPage: true });
});

test('STscript 编辑器执行闭包、事务回滚和无需模型的聊天命令', async ({ page, app, request }) => {
  await page.goto(app.baseURL); await page.locator('aside').first().locator('li').getByRole('button').filter({ hasText: '浏览器向导' }).first().click();
  await openChatActions(page);
  await page.getByRole('menuitem', { name: 'STscript', exact: true }).click();
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
  await openChatActions(page); await page.getByRole('menuitem', { name: 'STscript', exact: true }).click(); await dialog.getByLabel('STscript 源码').fill('/setvar key=n 100 | /delay 5000 | /send 不保存'); await dialog.getByRole('button', { name: '执行脚本' }).click();
  await dialog.getByRole('button', { name: '停止脚本' }).click(); await expect(dialog.getByRole('alert')).toBeVisible(); await expect(dialog.getByRole('button', { name: '执行脚本' })).toBeEnabled();
  await page.setViewportSize({ width: 390, height: 844 }); expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBeTruthy(); await page.screenshot({ path: path.join(app.runDir, 'mobile-script.png'), fullPage: true });
});

test('底部模型选择、加宽回复区、自动候选与历史分支弹窗', async ({ page, app }) => {
  await page.setViewportSize({ width: 1806, height: 922 });
  await page.goto(app.baseURL); await expect(page.getByText('在线', { exact: true })).toBeVisible();
  await page.locator('aside').first().locator('li').getByRole('button').filter({ hasText: '浏览器向导' }).first().click();
  await expect(page.getByLabel('当前模型')).toBeVisible();
  expect(await page.locator('header select').count()).toBe(0);
  await expect(page.getByText(/条消息/)).toHaveCount(0);
  await openChatActions(page);
  const chatMenu = page.getByRole('menu', { name: '聊天操作菜单' });
  await expect(chatMenu).toBeVisible();
  for (const name of ['STscript', '作者注释', '备份与恢复', '导出 MD', '导出 JSONL']) {
    await expect(chatMenu.getByRole('menuitem', { name, exact: true })).toBeVisible();
  }
  await page.keyboard.press('Escape');
  await expect(chatMenu).toHaveCount(0);
  await page.getByRole('button', { name: '统计', exact: true }).click();
  expect((await page.getByLabel('消息输入').boundingBox())!.width).toBeGreaterThan(1000);
  await expect(page.getByText('最近一次生成的工具活动')).toHaveCount(0);

  await page.getByRole('button', { name: '设置', exact: true }).click();
  const settings = page.getByRole('dialog', { name: '设置', exact: true });
  await settings.getByLabel('自动候选分支数').selectOption('2');
  await settings.getByRole('button', { name: '关闭设置', exact: true }).click();
  await expect(settings).toHaveCount(0);

  await page.getByLabel('消息输入').fill('自动生成多条后续');
  await page.getByRole('button', { name: '发送', exact: true }).click();
  await expect(page.getByRole('button', { name: '剧情分支' })).toContainText('分支 3/3', { timeout: 20000 });
  await page.getByRole('button', { name: '剧情分支' }).click();
  const dialog = page.getByRole('dialog', { name: '分支选择', exact: true });
  await expect(dialog.getByText(/共 3 个节点/)).toBeVisible();
  await dialog.getByRole('button', { name: /未继续的候选/ }).click();
  await expect(dialog.locator('button[aria-pressed]')).toHaveCount(3);
  await dialog.locator('button[aria-pressed]').nth(1).click();
  await expect(dialog.getByText('剧情预览 · 原文', { exact: true })).toBeVisible();
  await expect(dialog.getByText('已加载全文', { exact: true })).toBeVisible();
  await page.screenshot({ path: path.join(app.runDir, 'branch-manager.png') });
  await dialog.getByRole('button', { name: '继续这条路线' }).click();
  await expect(page.getByText('已切换剧情路线', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '剧情分支' })).toContainText('分支 1/3');
  await dialog.getByRole('button', { name: '关闭分支选择' }).click();
  await expect(dialog).toHaveCount(0);

  // 关掉自动候选，在第二个候选的后续上继续写一段，再切回更早分支验证后续保留。
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await settings.getByLabel('自动候选分支数').selectOption('0');
  await settings.getByRole('button', { name: '关闭设置', exact: true }).click();
  await expect(settings).toHaveCount(0);
  await page.getByRole('button', { name: '剧情分支' }).click();
  await dialog.getByRole('button', { name: /未继续的候选/ }).click();
  await dialog.locator('button[aria-pressed]').nth(1).click();
  await dialog.getByRole('button', { name: '继续这条路线' }).click();
  await dialog.getByRole('button', { name: '关闭分支选择' }).click();
  await expect(page.getByRole('button', { name: '剧情分支' })).toContainText('分支 2/3');
  await page.getByLabel('消息输入').fill('沿着第二条分支继续');
  await page.getByRole('button', { name: '发送', exact: true }).click();
  await expect(page.getByRole('button', { name: '发送', exact: true })).toBeVisible();
  await expect(page.getByText('沿着第二条分支继续', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '剧情分支' }).click();
  await expect(dialog.getByText(/第 1 轮/).first()).toBeVisible();
  await dialog.getByRole('button', { name: /未继续的候选/ }).click();
  await dialog.locator('button[aria-pressed]').nth(1).click();
  await dialog.getByRole('button', { name: '继续这条路线' }).click();
  await dialog.getByRole('button', { name: '关闭分支选择' }).click();
  await expect(page.getByText('沿着第二条分支继续', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '剧情分支' })).toContainText('分支 1/3');
  await page.getByRole('button', { name: '剧情分支' }).click();
  await dialog.getByRole('button', { name: /未继续的候选/ }).click();
  await dialog.locator('button[aria-pressed]').nth(1).click();
  await dialog.getByRole('button', { name: '继续这条路线' }).click();
  await dialog.getByRole('button', { name: '关闭分支选择' }).click();
  await expect(page.getByText('沿着第二条分支继续', { exact: true })).toBeVisible({ timeout: 10000 });
  await expect(page.getByRole('button', { name: '剧情分支' })).toContainText('分支 2/3');

  // 收藏和重命名持久化，并能通过搜索定位非当前路线。
  await page.getByRole('button', { name: '剧情分支' }).click();
  await dialog.getByRole('button', { name: /未继续的候选/ }).click();
  await dialog.locator('button[aria-pressed]').last().click();
  await dialog.getByRole('button', { name: '☆ 收藏' }).click();
  await expect(dialog.getByRole('button', { name: '★ 已收藏' })).toBeVisible();
  await dialog.getByRole('button', { name: '重命名' }).click();
  await dialog.getByLabel('路线名称').fill('备用路线');
  await dialog.getByRole('button', { name: '保存名称' }).click();
  await expect(dialog.getByText('备用路线', { exact: true }).first()).toBeVisible();
  await dialog.getByLabel('搜索分支').fill('备用路线');
  await expect(dialog.getByText('备用路线', { exact: true }).first()).toBeVisible();
  await dialog.getByRole('tab', { name: '收藏路线' }).click();
  await expect(dialog.getByText('备用路线', { exact: true }).first()).toBeVisible();
  await dialog.getByRole('button', { name: '关闭分支选择' }).click();

  await page.reload();
  await page.locator('aside').first().locator('li').getByRole('button').filter({ hasText: '浏览器向导' }).first().click();
  await expect(page.getByRole('button', { name: '剧情分支' })).toContainText('分支 2/3');
  await expect(page.getByText('沿着第二条分支继续', { exact: true })).toBeVisible();

  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: '统计', exact: true }).click();
  await page.getByRole('button', { name: '剧情分支' }).click();
  await expect(dialog.getByLabel('搜索分支')).toBeVisible();
  await dialog.locator('button[aria-pressed]').first().click();
  await expect(dialog.getByRole('button', { name: '← 返回目录' })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBeTruthy();
  await page.screenshot({ path: path.join(app.runDir, 'mobile-branch-manager.png'), fullPage: true });
  await dialog.getByRole('button', { name: '← 返回目录' }).click();
  await dialog.getByRole('button', { name: '关闭分支选择' }).click();
});

test('官方推理模型显示思考强度选择并持久化', async ({ page, app, request }) => {
  await page.goto(app.baseURL); await expect(page.getByText('在线', { exact: true })).toBeVisible();
  await page.locator('aside').first().locator('li').getByRole('button').filter({ hasText: '浏览器向导' }).first().click();
  await expect(page.getByLabel('当前模型')).toBeVisible();
  await expect(page.getByLabel('推理等级')).toHaveCount(0);
  await page.getByRole('button', { name: '设置', exact: true }).click();
  const settings = page.getByRole('dialog', { name: '设置', exact: true });
  await settings.getByLabel('思考等级：fixture', { exact: true }).selectOption('high');
  await settings.getByRole('button', { name: '关闭设置', exact: true }).click();
  await expect(settings).toHaveCount(0);
  await expect(page.getByLabel('推理等级')).toBeVisible();
  await page.getByLabel('推理等级').selectOption('low');
  await expect.poll(async () => {
    const snapshot = await (await request.get(app.baseURL + '/api/connection')).json();
    return snapshot.providers[0].models.find((model: { id: string }) => model.id === 'fixture').thinkingLevel;
  }).toBe('low');
  await page.reload();
  await page.locator('aside').first().locator('li').getByRole('button').filter({ hasText: '浏览器向导' }).first().click();
  await expect(page.getByLabel('推理等级')).toHaveValue('low');
});

test('未配置的空白连接默认隐藏，点添加后才显示', async ({ page, app, request }) => {
  const initial = await (await request.get(app.baseURL + '/api/connection')).json();
  const updated = await request.put(app.baseURL + '/api/connection', { data: {
    providers: [...initial.providers, { id: 'blank-draft', name: '新中转', baseUrl: 'https:', apiType: 'chat', models: [] }],
  } });
  expect(updated.ok()).toBeTruthy();
  await page.goto(app.baseURL); await expect(page.getByText('在线', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '设置', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '设置', exact: true });
  await expect(dialog.getByRole('group')).toHaveCount(1);
  await expect(dialog.getByText('新中转', { exact: true })).toHaveCount(0);
  await dialog.getByRole('button', { name: '＋ 添加', exact: true }).click();
  await expect(dialog.getByRole('group')).toHaveCount(2);
  await expect(dialog.getByRole('group', { name: '模型连接：新中转', exact: true })).toBeVisible();
  await dialog.getByRole('button', { name: '放弃本次更改', exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await expect(dialog.getByRole('group')).toHaveCount(1);
});

test('发送后显示生成计时，完成后消失', async ({ page, app }) => {
  await page.goto(app.baseURL); await expect(page.getByText('在线', { exact: true })).toBeVisible();
  await page.locator('aside').first().locator('li').getByRole('button').filter({ hasText: '浏览器向导' }).first().click();
  await page.getByPlaceholder(/身份发言/).fill('计时测试');
  await page.getByRole('button', { name: '发送', exact: true }).click();
  const timer = page.getByRole('timer');
  await expect(timer).toBeVisible({ timeout: 3000 });
  await expect(page.getByText('思考中', { exact: true })).toBeVisible();
  await expect.poll(async () => Number(((await timer.getAttribute('aria-label')) || '').match(/\d+/)?.[0] || 0), { timeout: 5000 })
    .toBeGreaterThanOrEqual(1);
  await expect(page.getByText('模型原文', { exact: true })).toBeVisible({ timeout: 15000 });
  await expect(page.getByRole('timer')).toHaveCount(0);
});

test('设置可标记对白颜色并支持自定义符号', async ({ page, app }) => {
  await page.goto(app.baseURL); await expect(page.getByText('在线', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '设置', exact: true }).click();
  const settings = page.getByRole('dialog', { name: '设置', exact: true });
  const setColor = async (label: string, color: string) => {
    await settings.getByLabel(label, { exact: true }).evaluate((element, value) => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
      setter.call(element, value);
      element.dispatchEvent(new Event('input', { bubbles: true }));
      element.dispatchEvent(new Event('change', { bubbles: true }));
    }, color);
  };
  await setColor('角色回复颜色', '#ff0000');
  await setColor('对白颜色', '#0080ff');
  await setColor('对白符号颜色 1', '#00ff00');
  await settings.getByLabel('对白起始符号 1', { exact: true }).fill('【');
  await settings.getByLabel('对白结束符号 1', { exact: true }).fill('】');
  await settings.getByRole('button', { name: '关闭设置', exact: true }).click();
  await expect(settings).toHaveCount(0);
  await page.locator('aside').first().locator('li').getByRole('button').filter({ hasText: '浏览器向导' }).first().click();
  await expect(page.getByText('欢迎，旅行者。', { exact: true })).toBeVisible();
  expect(await page.getByText('欢迎，旅行者。', { exact: true }).evaluate((element) => getComputedStyle(element).color)).toBe('rgb(255, 0, 0)');

  const chatDir = path.join(app.runDir, 'st', 'chats', '浏览器向导');
  const file = fs.readdirSync(chatDir).find((name) => name.endsWith('.jsonl'))!;
  fs.appendFileSync(path.join(chatDir, file), JSON.stringify({ name: '浏览器向导', is_user: false, is_system: false,
    mes: '【自定义对白】和“引号对白”，普通叙述。', send_date: new Date().toISOString(), extra: { messageId: 'dialogue-color-test' } }) + '\n');
  await page.reload();
  await page.locator('aside').first().locator('li').getByRole('button').filter({ hasText: '浏览器向导' }).first().click();
  await expect(page.getByText('【自定义对白】和“引号对白”，普通叙述。', { exact: true })).toBeVisible();
  const dialogue = page.locator('.tavern-dialogue');
  await expect(dialogue).toHaveCount(2);
  await expect(dialogue.nth(0)).toHaveText('【自定义对白】');
  await expect(dialogue.nth(1)).toHaveText('“引号对白”');
  expect(await dialogue.nth(0).evaluate((element) => getComputedStyle(element).color)).toBe('rgb(0, 255, 0)');
  expect(await dialogue.nth(1).evaluate((element) => getComputedStyle(element).color)).toBe('rgb(0, 128, 255)');
  expect(await page.locator('.tavern-markdown p').filter({ hasText: '普通叙述。' }).first().evaluate((element) => getComputedStyle(element).color)).toBe('rgb(255, 0, 0)');
});

test('主题按钮可自由选色并持久化', async ({ page, app }) => {
  await page.goto(app.baseURL); await expect(page.getByText('在线', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '切换主题', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: '主题与配色', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '主题与配色', exact: true });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('button', { name: '夜琥珀', exact: true })).toBeVisible();
  await dialog.getByLabel('强调色', { exact: true }).evaluate((element, value) => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    setter.call(element, value);
    element.dispatchEvent(new Event('input', { bubbles: true }));
    element.dispatchEvent(new Event('change', { bubbles: true }));
  }, '#ff8800');
  await expect.poll(async () => page.evaluate(() => getComputedStyle(document.body).getPropertyValue('--color-tavern-accent').trim())).toBe('#ff8800');
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await page.reload(); await expect(page.getByText('在线', { exact: true })).toBeVisible();
  expect(await page.evaluate(() => getComputedStyle(document.body).getPropertyValue('--color-tavern-accent').trim())).toBe('#ff8800');
  await page.getByRole('button', { name: '主题与配色', exact: true }).click();
  await page.getByRole('dialog', { name: '主题与配色', exact: true }).getByRole('button', { name: '林间绿', exact: true }).click();
  await expect.poll(async () => page.evaluate(() => getComputedStyle(document.body).getPropertyValue('--color-tavern-accent').trim())).toBe('#7fbf8e');
  expect(await page.evaluate(() => document.body.dataset.theme)).toBe('grove');
  await page.reload(); await expect(page.getByText('在线', { exact: true })).toBeVisible();
  expect(await page.evaluate(() => getComputedStyle(document.body).getPropertyValue('--color-tavern-accent').trim())).toBe('#7fbf8e');
});

test('设置自动保存，放弃更改与恢复默认（模型配置保留）', async ({ page, app, request }) => {
  await page.goto(app.baseURL); await expect(page.getByText('在线', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '设置', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '设置', exact: true });
  const persona = dialog.getByLabel('用户名', { exact: true });
  await persona.fill('自动保存测试');
  await expect.poll(async () => (await (await request.get(app.baseURL + '/api/connection')).json()).persona.name, { timeout: 5000 }).toBe('自动保存测试');
  await expect(dialog.getByText('已自动保存', { exact: true })).toBeVisible({ timeout: 5000 });
  await dialog.getByRole('button', { name: '关闭设置', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await page.reload(); await expect(page.getByText('在线', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await expect(dialog.getByLabel('用户名', { exact: true })).toHaveValue('自动保存测试');

  await dialog.getByLabel('用户名', { exact: true }).fill('临时修改');
  await expect.poll(async () => (await (await request.get(app.baseURL + '/api/connection')).json()).persona.name, { timeout: 5000 }).toBe('临时修改');
  await dialog.getByRole('button', { name: '放弃本次更改', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await expect(dialog.getByLabel('用户名', { exact: true })).toHaveValue('自动保存测试');

  await dialog.getByLabel('自动候选分支数', { exact: true }).selectOption('2');
  await dialog.getByRole('button', { name: '恢复默认配置（模型配置除外）', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await expect(dialog.getByLabel('自动候选分支数', { exact: true })).toHaveValue('0');
  await expect(dialog.getByLabel('用户名', { exact: true })).toHaveValue('旅人');
  await expect(dialog.getByRole('group', { name: '模型连接：本地合成连接', exact: true })).toBeVisible();
  const restored = await (await request.get(app.baseURL + '/api/connection')).json();
  expect(restored.defaultModel).toBe('fixture');
  expect(restored.providers[0].baseUrl).toContain('/v1');
});

test('顶栏悬停提示即时显示并覆盖设置按钮', async ({ page, app }) => {
  await page.goto(app.baseURL); await expect(page.getByText('在线', { exact: true })).toBeVisible();
  const cases: Array<[string, string]> = [
    ['主题与配色', '主题与配色'],
    ['统计', '用量与工具调用统计'],
    ['资料', '世界书、正则脚本、备份与迁移等'],
    ['设置', '模型连接与运行设置'],
  ];
  for (const [button, text] of cases) {
    await page.getByRole('button', { name: button, exact: true }).hover();
    await expect(page.getByRole('tooltip')).toBeVisible({ timeout: 1500 });
    await expect(page.getByRole('tooltip')).toHaveText(text);
  }
  await page.getByRole('button', { name: '统计', exact: true }).hover();
  await page.screenshot({ path: path.join(app.runDir, 'topbar-tooltip.png') });
});

test('模型列表支持逐模型测试并显示成功或失败颜色', async ({ page, app }) => {
  await page.goto(app.baseURL); await expect(page.getByText('在线', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '设置', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '设置', exact: true });
  const okButton = dialog.getByRole('button', { name: '测试模型：fixture', exact: true });
  await okButton.click();
  await expect(okButton).toHaveClass(/text-emerald-400/, { timeout: 5000 });

  await dialog.getByLabel('请求模型 ID：fixture', { exact: true }).fill('broken-model');
  const failButton = dialog.getByRole('button', { name: /测试模型：broken-model/ });
  await failButton.click();
  await expect(failButton).toHaveClass(/text-red-400/, { timeout: 5000 });
  await expect(failButton).toHaveAttribute('aria-label', /合成失败/);
});
