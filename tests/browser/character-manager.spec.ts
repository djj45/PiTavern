import { test as base, expect, type APIRequestContext, type Page } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';

interface FixtureServer { baseURL: string; child: ChildProcess }
interface AppFixture { baseURL: string; runDir: string; restart: () => Promise<string> }
interface CardSummary {
  name: string; avatarUrl: string; format: 'png' | 'json'; file: string; description: string;
  tags: string[]; firstMesPreview: string; alternateGreetings: number; characterBookEntries: number;
  worldName?: string; chatCount: number; revision: string;
}
interface CardEditor extends CardSummary {
  spec: string; personality: string; scenario: string; firstMes: string; mesExample: string;
  creatorNotes: string; systemPrompt: string; postHistoryInstructions: string;
  alternateGreetingTexts: string[]; creator: string; characterVersion: string;
}

const test = base.extend<{ app: AppFixture }>({
  app: async ({}, use, info) => {
    const runDir = fs.mkdtempSync(path.join(process.env.PITAVERN_BROWSER_RUN!, `fixture-${info.workerIndex}-`));
    const start = async (): Promise<FixtureServer> => {
      const child = spawn(process.execPath, ['--import', 'tsx', 'apps/server/scripts/browser-fixture.ts'], {
        cwd: process.cwd(), env: { ...process.env, PITAVERN_BROWSER_FIXTURE: runDir }, stdio: ['ignore', 'pipe', 'pipe'],
      });
      let output = '';
      child.stdout?.on('data', (part) => { output += part; fs.appendFileSync(path.join(runDir, 'server.log'), part); });
      child.stderr?.on('data', (part) => fs.appendFileSync(path.join(runDir, 'server.log'), part));
      const started = Date.now();
      while (!/PITAVERN_FIXTURE=(.+)/.test(output)) {
        if (child.exitCode !== null || Date.now() - started > 15000) throw new Error(`Fixture did not start: ${runDir}/server.log`);
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      const fixture = JSON.parse(/PITAVERN_FIXTURE=(.+)/.exec(output)![1]) as { baseURL: string };
      return { baseURL: fixture.baseURL, child };
    };
    const stop = async (server: FixtureServer): Promise<void> => {
      if (server.child.exitCode === null) {
        const exited = once(server.child, 'exit');
        server.child.kill('SIGTERM');
        const timer = setTimeout(() => server.child.kill('SIGKILL'), 5000);
        await exited;
        clearTimeout(timer);
      }
    };
    let current = await start();
    const app: AppFixture = {
      baseURL: current.baseURL,
      runDir,
      /** 同一数据目录重启服务：验证角色卡保存后落盘。 */
      restart: async () => {
        await stop(current);
        current = await start();
        app.baseURL = current.baseURL;
        return current.baseURL;
      },
    };
    try {
      await use(app);
    } finally {
      await stop(current);
    }
  },
});

test.beforeEach(async ({ page }) => {
  page.on('pageerror', (error) => { throw error; });
});

const openApp = async (page: Page, baseURL: string, mobile = false) => {
  await page.goto(baseURL);
  await expect(page.getByText('在线', { exact: true })).toBeVisible();
  if (mobile) await page.getByRole('button', { name: '菜单', exact: true }).click();
};

const openManager = async (page: Page, baseURL: string, mobile = false) => {
  await openApp(page, baseURL, mobile);
  await page.getByRole('button', { name: '管理角色卡', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: /角色卡管理/ });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText(/共 \d+ 张/)).toBeVisible();
  return dialog;
};

const cards = async (request: APIRequestContext, baseURL: string): Promise<CardSummary[]> =>
  (await request.get(baseURL + '/api/character-cards')).json() as Promise<CardSummary[]>;
const card = async (request: APIRequestContext, baseURL: string, name: string): Promise<CardEditor> =>
  (await request.get(baseURL + '/api/character-cards/' + encodeURIComponent(name))).json() as Promise<CardEditor>;
const fieldsOf = (editor: CardEditor) => ({
  description: editor.description, personality: editor.personality, scenario: editor.scenario,
  firstMes: editor.firstMes, mesExample: editor.mesExample, creatorNotes: editor.creatorNotes,
  systemPrompt: editor.systemPrompt, postHistoryInstructions: editor.postHistoryInstructions,
  alternateGreetings: editor.alternateGreetingTexts, tags: editor.tags,
});

test('选择卡、编辑描述/默认开场白/备用开场白/标签并保存，刷新与重启后保留', async ({ page, app, request }) => {
  let dialog = await openManager(page, app.baseURL);
  await expect(dialog.getByRole('button', { name: '编辑角色卡 浏览器向导' })).toContainText('聊天 1');
  await expect(dialog.getByRole('button', { name: '编辑角色卡 浏览器向导' })).toContainText('卡内世界书 1');
  await dialog.getByRole('button', { name: '编辑角色卡 持久向导' }).click();

  await expect(dialog.getByLabel('角色卡名称')).toHaveValue('持久向导');
  await expect(dialog.getByLabel('角色卡格式')).toHaveValue('JSON');
  await expect(dialog.getByLabel('关联聊天数')).toHaveValue('0');
  await expect(dialog.getByText('未保存修改：无')).toBeVisible();

  await dialog.getByLabel('描述', { exact: true }).fill('新的描述：月光下的酒馆');
  await dialog.getByLabel('默认开场白', { exact: true }).fill('新的开场白：{{user}}推门而入。');
  await dialog.getByRole('button', { name: '添加备用开场白' }).click();
  await dialog.getByRole('textbox', { name: '备用开场白 1' }).fill('备用开场白：雨夜。');
  await dialog.getByLabel('标签', { exact: true }).fill('历史,架空\n剧情，冒险');
  await expect(dialog.getByText('有未保存修改')).toBeVisible();

  await dialog.getByRole('button', { name: '保存角色卡' }).click();
  await expect(dialog.getByRole('status')).toContainText('已保存角色卡「持久向导」');
  await expect(dialog.getByRole('button', { name: '编辑角色卡 持久向导' })).toContainText('历史,架空');

  let stored = await card(request, app.baseURL, '持久向导');
  expect(stored.description).toBe('新的描述：月光下的酒馆');
  expect(stored.firstMes).toBe('新的开场白：{{user}}推门而入。');
  expect(stored.alternateGreetingTexts).toEqual(['备用开场白：雨夜。']);
  expect(stored.tags).toEqual(['历史,架空', '剧情，冒险']);
  expect(stored.characterBookEntries).toBe(1);
  expect(stored.chatCount).toBe(0);

  await dialog.getByRole('button', { name: '关闭角色卡管理' }).click();
  await expect(dialog).not.toBeVisible();

  // 页面刷新后从服务端重新载入。
  await openApp(page, app.baseURL);
  dialog = await openManager(page, app.baseURL);
  await dialog.getByRole('button', { name: '编辑角色卡 持久向导' }).click();
  await expect(dialog.getByLabel('描述', { exact: true })).toHaveValue('新的描述：月光下的酒馆');
  await expect(dialog.getByLabel('默认开场白', { exact: true })).toHaveValue('新的开场白：{{user}}推门而入。');
  await expect(dialog.getByRole('textbox', { name: '备用开场白 1' })).toHaveValue('备用开场白：雨夜。');
  await expect(dialog.getByLabel('标签', { exact: true })).toHaveValue('历史,架空\n剧情，冒险');
  await dialog.getByRole('button', { name: '关闭角色卡管理' }).click();

  // 同数据目录重启服务后仍然保留。
  const restarted = await app.restart();
  dialog = await openManager(page, restarted);
  await dialog.getByRole('button', { name: '编辑角色卡 持久向导' }).click();
  await expect(dialog.getByLabel('描述', { exact: true })).toHaveValue('新的描述：月光下的酒馆');
  await expect(dialog.getByRole('textbox', { name: '备用开场白 1' })).toHaveValue('备用开场白：雨夜。');
  await expect(dialog.getByLabel('标签', { exact: true })).toHaveValue('历史,架空\n剧情，冒险');
  stored = await card(request, restarted, '持久向导');
  expect(stored.alternateGreetingTexts).toEqual(['备用开场白：雨夜。']);

  // 导出原格式文件，字节与服务端当前卡文件一致。
  const downloadPromise = page.waitForEvent('download');
  await dialog.getByRole('button', { name: '导出角色卡' }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe('persist.json');
  const exportedPath = path.join(app.runDir, 'exported-persist.json');
  await download.saveAs(exportedPath);
  const exportedResponse = await request.get(restarted + '/api/character-cards/' + encodeURIComponent('持久向导') + '/export');
  expect(exportedResponse.ok()).toBeTruthy();
  expect(fs.readFileSync(exportedPath).equals(await exportedResponse.body())).toBe(true);

  await page.screenshot({ path: path.join(app.runDir, 'character-manager-desktop.png') });
  await dialog.getByRole('button', { name: '关闭角色卡管理' }).click();
});

test('未保存修改时关闭或切换角色卡需确认，取消后保留编辑内容', async ({ page, app }) => {
  const dialog = await openManager(page, app.baseURL);
  await dialog.getByRole('button', { name: '编辑角色卡 持久向导' }).click();
  await dialog.getByLabel('描述', { exact: true }).fill('尚未保存的草稿');
  await expect(dialog.getByText('有未保存修改')).toBeVisible();

  let prompt = '';
  page.once('dialog', (confirm) => { prompt = confirm.message(); void confirm.dismiss(); });
  await dialog.getByRole('button', { name: '关闭角色卡管理' }).click();
  expect(prompt).toContain('未保存');
  await expect(dialog).toBeVisible();
  await expect(dialog.getByLabel('描述', { exact: true })).toHaveValue('尚未保存的草稿');

  prompt = '';
  page.once('dialog', (confirm) => { prompt = confirm.message(); void confirm.dismiss(); });
  await dialog.getByRole('button', { name: '编辑角色卡 浏览器向导' }).click();
  expect(prompt).toContain('未保存');
  await expect(dialog.getByLabel('角色卡名称')).toHaveValue('持久向导');
  await expect(dialog.getByLabel('描述', { exact: true })).toHaveValue('尚未保存的草稿');

  page.once('dialog', (confirm) => void confirm.accept());
  await dialog.getByRole('button', { name: '关闭角色卡管理' }).click();
  await expect(dialog).not.toBeVisible();
});

test('未保存时取消导入后，再次选择同一文件仍可导入', async ({ page, app }) => {
  const dialog = await openManager(page, app.baseURL);
  await dialog.getByRole('button', { name: '编辑角色卡 持久向导' }).click();
  await dialog.getByLabel('描述', { exact: true }).fill('导入前尚未保存的草稿');
  const input = dialog.locator('input[type=file]');
  const fixture = path.join(app.runDir, 'fixtures/import-card.json');

  page.once('dialog', (confirm) => void confirm.dismiss());
  await input.setInputFiles(fixture);
  await expect(dialog.getByLabel('角色卡名称')).toHaveValue('持久向导');
  await expect(dialog.getByLabel('描述', { exact: true })).toHaveValue('导入前尚未保存的草稿');
  await expect(dialog.getByRole('button', { name: '编辑角色卡 导入向导' })).toHaveCount(0);

  // 同一文件必须再次触发 change，才会出现确认并继续导入。
  page.once('dialog', (confirm) => void confirm.accept());
  await input.setInputFiles(fixture);
  await expect(dialog.getByRole('status')).toContainText('已导入 import-card.json');
  await expect(dialog.getByRole('button', { name: '编辑角色卡 导入向导' })).toBeVisible();
  await expect(dialog.getByLabel('角色卡名称')).toHaveValue('导入向导');

  await dialog.getByRole('button', { name: '关闭角色卡管理' }).click();
  await expect(dialog).not.toBeVisible();
});

test('另一个窗口先保存后，本页保存 409 提示并重新载入最新内容', async ({ page, app, request }) => {
  const dialog = await openManager(page, app.baseURL);
  await dialog.getByRole('button', { name: '编辑角色卡 图片向导' }).click();
  await expect(dialog.getByLabel('角色卡名称')).toHaveValue('图片向导');

  const current = await card(request, app.baseURL, '图片向导');
  const external = await request.put(app.baseURL + '/api/character-cards/' + encodeURIComponent('图片向导'), {
    data: { revision: current.revision, fields: { ...fieldsOf(current), description: '另一个窗口写入的描述' } },
  });
  expect(external.ok()).toBeTruthy();

  await dialog.getByLabel('描述', { exact: true }).fill('本地窗口写入的描述');
  await dialog.getByRole('button', { name: '保存角色卡' }).click();
  await expect(dialog.getByRole('alert')).toContainText('其他窗口');
  await expect(dialog.getByRole('alert')).toContainText('已重新载入');
  await expect(dialog.getByLabel('描述', { exact: true })).toHaveValue('另一个窗口写入的描述');
  await expect(dialog.getByText('未保存修改：无')).toBeVisible();
  const latest = await card(request, app.baseURL, '图片向导');
  expect(latest.description).toBe('另一个窗口写入的描述');

  await dialog.getByRole('button', { name: '关闭角色卡管理' }).click();
  await expect(dialog).not.toBeVisible();
});

test('复制卡后删除副本不影响原卡与聊天；删除有聊天的卡不删除聊天', async ({ page, app, request }) => {
  const dialog = await openManager(page, app.baseURL);
  await dialog.getByRole('button', { name: '编辑角色卡 浏览器向导' }).click();
  page.once('dialog', (confirm) => void confirm.accept());
  await dialog.getByRole('button', { name: '复制角色卡' }).click();
  await expect(dialog.getByRole('status')).toContainText('已复制角色卡「浏览器向导 副本」');
  await expect(dialog.getByRole('button', { name: '编辑角色卡 浏览器向导 副本' })).toBeVisible();

  let list = await cards(request, app.baseURL);
  const copy = list.find((entry) => entry.name === '浏览器向导 副本')!;
  expect(copy.file).not.toBe(list.find((entry) => entry.name === '浏览器向导')!.file);
  expect(copy.chatCount).toBe(0);

  await dialog.getByRole('button', { name: '编辑角色卡 浏览器向导 副本' }).click();
  let prompt = '';
  page.once('dialog', (confirm) => { prompt = confirm.message(); void confirm.accept(); });
  await dialog.getByRole('button', { name: '删除角色卡' }).click();
  expect(prompt).toContain('不会删除聊天');
  await expect(dialog.getByRole('status')).toContainText('已删除角色卡「浏览器向导 副本」');
  await expect(dialog.getByRole('button', { name: '编辑角色卡 浏览器向导 副本' })).toHaveCount(0);

  list = await cards(request, app.baseURL);
  expect(list.find((entry) => entry.name === '浏览器向导 副本')).toBeUndefined();
  expect(list.find((entry) => entry.name === '浏览器向导')!.chatCount).toBe(1);
  const originalChats = await (await request.get(app.baseURL + '/api/chats?character=' + encodeURIComponent('浏览器向导'))).json() as unknown[];
  expect(originalChats).toHaveLength(1);

  // 给图片向导创建聊天后再删除角色卡：聊天保留，但角色卡消失。
  const created = await request.post(app.baseURL + '/api/chats', { data: { character: '图片向导' } });
  expect(created.ok()).toBeTruthy();
  await dialog.getByRole('button', { name: '编辑角色卡 图片向导' }).click();
  prompt = '';
  page.once('dialog', (confirm) => { prompt = confirm.message(); void confirm.accept(); });
  await dialog.getByRole('button', { name: '删除角色卡' }).click();
  expect(prompt).toContain('不会删除聊天');
  expect(prompt).toContain('找不到角色卡');
  await expect(dialog.getByRole('status')).toContainText('已删除角色卡「图片向导」');
  list = await cards(request, app.baseURL);
  expect(list.find((entry) => entry.name === '图片向导')).toBeUndefined();
  const keptChats = await (await request.get(app.baseURL + '/api/chats?character=' + encodeURIComponent('图片向导'))).json() as unknown[];
  expect(keptChats).toHaveLength(1);

  await dialog.getByRole('button', { name: '关闭角色卡管理' }).click();
  await page.reload();
  await expect(page.getByText('在线', { exact: true })).toBeVisible();
  await expect(page.locator('aside li').filter({ hasText: '图片向导' }).first()).toBeVisible();
});

test('从管理页导入 JSON 与 PNG 夹具后列表出现并显示格式与头像', async ({ page, app, request }) => {
  const dialog = await openManager(page, app.baseURL);
  const input = dialog.locator('input[type=file]');
  await input.setInputFiles(path.join(app.runDir, 'fixtures/import-card.json'));
  await expect(dialog.getByRole('status')).toContainText('已导入 import-card.json');
  await expect(dialog.getByRole('button', { name: '编辑角色卡 导入向导' })).toBeVisible();
  await expect(dialog.getByRole('button', { name: '编辑角色卡 导入向导' })).toContainText('导入');
  await expect(dialog.getByRole('button', { name: '编辑角色卡 导入向导' })).toContainText('世界 browser');

  let list = await cards(request, app.baseURL);
  const importedSummary = list.find((entry) => entry.name === '导入向导')!;
  expect(importedSummary.file).toBe('characters/import-card.json');
  expect(importedSummary.format).toBe('json');
  expect(importedSummary.tags).toEqual(['导入', '合成']);
  expect(importedSummary.chatCount).toBe(0);

  await dialog.getByLabel('描述', { exact: true }).fill('导入后马上编辑的描述');
  await dialog.getByRole('textbox', { name: '备用开场白 1' }).fill('导入后修改的开场白');
  await dialog.getByRole('button', { name: '保存角色卡' }).click();
  await expect(dialog.getByRole('status')).toContainText('已保存角色卡「导入向导」');
  const importedEditor = await card(request, app.baseURL, '导入向导');
  expect(importedEditor.description).toBe('导入后马上编辑的描述');
  expect(importedEditor.alternateGreetingTexts).toEqual(['导入后修改的开场白', '导入备用二']);

  await input.setInputFiles(path.join(app.runDir, 'fixtures/import-card.png'));
  await expect(dialog.getByRole('status')).toContainText('已导入 import-card.png');
  await expect(dialog.getByRole('button', { name: '编辑角色卡 导入图片向导' })).toBeVisible();
  list = await cards(request, app.baseURL);
  const importedPng = list.find((entry) => entry.name === '导入图片向导')!;
  expect(importedPng.format).toBe('png');
  expect(importedPng.file).toBe('characters/import-card.png');
  expect(importedPng.avatarUrl).toContain('/avatar');
  await expect(dialog.getByRole('button', { name: '编辑角色卡 导入图片向导' }).locator('img')).toBeVisible();

  await dialog.getByRole('button', { name: '关闭角色卡管理' }).click();
  await expect(page.locator('aside').getByRole('button', { name: '导入图片向导', exact: true })).toBeVisible();
});

test('新建空白角色卡：编辑保存后出现在侧栏和列表', async ({ page, app, request }) => {
  const dialog = await openManager(page, app.baseURL);
  await dialog.getByLabel('新建角色名称').fill('新建向导');
  await dialog.getByRole('button', { name: '＋ 新建' }).click();
  await expect(dialog.getByText('编辑：新建向导', { exact: false })).toBeVisible();
  await dialog.getByLabel('描述').fill('新建描述');
  await dialog.getByLabel('默认开场白').fill('新建开场白');
  await dialog.getByRole('button', { name: '保存角色卡' }).click();
  await expect(dialog.getByRole('status')).toContainText('已保存角色卡');
  const created = (await cards(request, app.baseURL)).find((item) => item.name === '新建向导');
  expect(created).toBeTruthy();
  expect(created!.format).toBe('json');
  expect(created!.description).toBe('新建描述');
  expect(created!.firstMesPreview).toBe('新建开场白');
  await dialog.getByRole('button', { name: '关闭角色卡管理' }).click();
  await expect(page.locator('aside').getByRole('button', { name: '新建向导', exact: true })).toBeVisible();
});

test('角色卡管理在 390px 手机宽度可操作且无水平溢出', async ({ page, app }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const dialog = await openManager(page, app.baseURL, true);
  const box = await dialog.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(390);
  expect(box!.y).toBeGreaterThanOrEqual(0);
  expect(box!.y + box!.height).toBeLessThanOrEqual(844);

  await dialog.getByRole('button', { name: '编辑角色卡 多开局向导' }).click();
  await dialog.getByLabel('描述', { exact: true }).fill('手机端编辑的描述');
  await dialog.getByRole('button', { name: '添加备用开场白' }).click();
  await dialog.getByRole('textbox', { name: '备用开场白 9' }).fill('手机端新增的备用开场白');
  await dialog.getByLabel('标签', { exact: true }).fill('手机\n移动端');
  await dialog.getByRole('button', { name: '保存角色卡' }).click();
  await expect(dialog.getByRole('status')).toContainText('已保存角色卡「多开局向导」');
  await expect(dialog.getByRole('textbox', { name: '备用开场白 9' })).toHaveValue('手机端新增的备用开场白');

  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  expect(await dialog.evaluate((node) => node.scrollWidth <= node.clientWidth + 1)).toBe(true);
  await page.screenshot({ path: path.join(app.runDir, 'character-manager-mobile.png'), fullPage: true });
  await dialog.getByRole('button', { name: '关闭角色卡管理' }).click();
  await expect(dialog).not.toBeVisible();
});
