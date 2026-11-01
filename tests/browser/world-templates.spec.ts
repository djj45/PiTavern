import { test as base, expect, type APIRequestContext, type Page } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import type { WorldSnapshot, WorldTemplate } from '../../packages/shared/src/world.ts';

interface FixtureServer { baseURL: string; child: ChildProcess }
interface AppFixture { baseURL: string; runDir: string; restart: () => Promise<string> }

interface LibrarySummary {
  id: string; name: string; description?: string; draftRevision: number;
  publishedHash?: string; publishedVersion?: number; versionCount: number; draftDirty: boolean;
}
interface EditorDto {
  id: string; name: string; description?: string; draftRevision: number;
  publishedHash?: string; publishedVersion?: number; versionCount: number; draftDirty: boolean;
  draft: WorldTemplate; published?: { contentHash: string; name?: string; description?: string };
  versions: Array<{ contentHash: string; templateVersion: number; rulesVersion: number; createdAt: string }>;
  initialSnapshot?: WorldSnapshot;
}
interface ChatWorldSnapshot {
  world?: { templateName: string; snapshot: { templateHash: string; templateVersion: number } };
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
      /** 同一数据目录重启服务：用于验证模板库落盘后恢复。 */
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

const openTemplates = async (page: Page, baseURL: string, mobile = false) => {
  await page.goto(baseURL);
  await expect(page.getByText('在线', { exact: true })).toBeVisible();
  if (mobile) await page.getByRole('button', { name: '菜单', exact: true }).click();
  await page.getByRole('button', { name: '世界模板', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: /世界模板/ });
  await expect(dialog).toBeVisible();
  return dialog;
};

const getLibrary = async (request: APIRequestContext, baseURL: string): Promise<LibrarySummary[]> =>
  (await request.get(baseURL + '/api/world/template-library')).json() as Promise<LibrarySummary[]>;
const getEditor = async (request: APIRequestContext, baseURL: string, id: string): Promise<EditorDto> =>
  (await request.get(`${baseURL}/api/world/template-library/${encodeURIComponent(id)}`)).json() as Promise<EditorDto>;

const createWorldChat = async (page: Page, templateId: string) => {
  await page.getByLabel('新聊天世界模板').selectOption(templateId);
  await page.getByRole('button', { name: '＋ 开始新对话', exact: true }).click();
  await expect(page.getByRole('button', { name: '打开世界状态', exact: true })).toBeVisible();
};

test('新建模板、编辑地点/角色/物品/初始状态并发布，刷新与重启后保留', async ({ page, app, request }) => {
  let dialog = await openTemplates(page, app.baseURL);
  await dialog.getByLabel('新模板名').fill('浏览器世界');
  await dialog.getByRole('button', { name: '新建空白' }).click();
  await expect(dialog.getByRole('status')).toContainText('已创建空白模板');
  await expect(dialog.getByLabel('模板名称')).toHaveValue('浏览器世界');

  await dialog.getByLabel('地点 1 名称').fill('酒馆');
  await dialog.getByLabel('地点 1 描述').fill('临街的旧酒馆');
  await dialog.getByRole('button', { name: '添加地点' }).click();
  await dialog.getByLabel('地点 2 ID').fill('square');
  await dialog.getByLabel('地点 2 名称').fill('广场');
  await dialog.getByLabel('地点 2 描述').fill('白天喧闹的集市');
  await dialog.getByLabel('角色 1 名称').fill('玩家');
  await dialog.getByRole('button', { name: '添加角色' }).click();
  await dialog.getByLabel('角色 2 ID').fill('merchant');
  await dialog.getByLabel('角色 2 名称').fill('掌柜');
  await dialog.getByLabel('角色 2 描述').fill('酒馆掌柜');
  await dialog.getByRole('button', { name: '添加物品' }).click();
  await dialog.getByLabel('物品 1 ID').fill('sword');
  await dialog.getByLabel('物品 1 名称').fill('长剑');
  await dialog.getByLabel('物品 1 描述').fill('普通的铁剑');
  await dialog.getByLabel('物品 1 固定价格').fill('30');
  await dialog.getByLabel('初始地点').selectOption('square');
  await dialog.getByLabel('初始金额').fill('100');
  await dialog.getByRole('button', { name: '添加库存' }).click();
  await dialog.getByLabel('库存 1 归属').selectOption('merchant');
  await dialog.getByLabel('库存 1 物品').selectOption('sword');
  await dialog.getByLabel('库存 1 数量').fill('2');

  await dialog.getByRole('button', { name: '保存草稿' }).click();
  await expect(dialog.getByRole('status')).toContainText('草稿已保存');
  const preview = dialog.getByLabel('初始世界预览');
  await expect(preview).toContainText('地点 2 · 角色 2 · 物品 1');
  await expect(preview).toContainText('初始地点 广场');
  await expect(preview).toContainText('初始金额 100');
  await expect(preview).toContainText('掌柜·长剑×2');

  await dialog.getByRole('button', { name: '发布模板' }).click();
  await expect(dialog.getByRole('status')).toContainText('已发布版本 v1');
  const versions = dialog.getByRole('list', { name: '模板版本列表' });
  await expect(versions).toContainText('版本 v1');
  await expect(versions).toContainText('规则 v1');
  await expect(versions).toContainText('当前发布');
  await expect(dialog.getByText('草稿与发布一致', { exact: false }).first()).toBeVisible();

  const library = await getLibrary(request, app.baseURL);
  const summary = library.find((entry) => entry.name === '浏览器世界')!;
  expect(summary.publishedHash).toMatch(/^[a-f0-9]{64}$/);
  expect(summary.versionCount).toBe(1);
  expect(summary.draftDirty).toBe(false);
  const editor = await getEditor(request, app.baseURL, summary.id);
  expect(editor.draft.items[0]).toMatchObject({ id: 'sword', name: '长剑', price: 30 });
  expect(editor.draft.initial).toMatchObject({ actorId: 'player', locationId: 'square', money: 100 });
  expect(editor.initialSnapshot?.money.player).toBe(100);
  expect(editor.initialSnapshot?.inventory).toEqual([{ ownerId: 'merchant', itemId: 'sword', quantity: 2 }]);
  await expect(dialog.getByText(summary.publishedHash!, { exact: true }).first()).toBeVisible();

  // 刷新后从服务端重新载入。
  await page.reload();
  await expect(page.getByText('在线', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '世界模板', exact: true }).click();
  dialog = page.getByRole('dialog', { name: /世界模板/ });
  await dialog.getByRole('button', { name: '编辑模板 浏览器世界' }).click();
  await expect(dialog.getByLabel('模板名称')).toHaveValue('浏览器世界');
  await expect(dialog.getByLabel('地点 2 名称')).toHaveValue('广场');
  await expect(dialog.getByLabel('角色 2 名称')).toHaveValue('掌柜');
  await expect(dialog.getByLabel('物品 1 固定价格')).toHaveValue('30');
  await expect(dialog.getByLabel('初始金额')).toHaveValue('100');
  await expect(dialog.getByLabel('初始世界预览')).toContainText('初始金额 100');
  await expect(dialog.getByRole('list', { name: '模板版本列表' })).toContainText('版本 v1');
  await dialog.getByRole('button', { name: '关闭世界模板' }).click();
  await expect(dialog).not.toBeVisible();

  // 服务重启后模板索引、草稿、发布版本仍在，且发布版本进入新聊天选择器。
  const restarted = await app.restart();
  await page.goto(restarted);
  await expect(page.getByText('在线', { exact: true })).toBeVisible();
  const options = await page.getByLabel('新聊天世界模板').locator('option').allTextContents();
  expect(options).toContain('浏览器世界');
  await page.getByRole('button', { name: '世界模板', exact: true }).click();
  dialog = page.getByRole('dialog', { name: /世界模板/ });
  await dialog.getByRole('button', { name: '编辑模板 浏览器世界' }).click();
  await expect(dialog.getByLabel('模板名称')).toHaveValue('浏览器世界');
  await expect(dialog.getByLabel('初始世界预览')).toContainText('初始金额 100');
  await expect(dialog.getByLabel('初始世界预览')).toContainText('掌柜·长剑×2');
  await expect(dialog.getByRole('list', { name: '模板版本列表' })).toContainText('版本 v1');
  await page.screenshot({ path: path.join(app.runDir, 'world-templates-desktop.png') });
  await dialog.getByRole('button', { name: '关闭世界模板' }).click();
});

test('重复 ID 由服务端拒绝并展示，过期修订号 409 后提示并重新载入', async ({ page, app, request }) => {
  const dialog = await openTemplates(page, app.baseURL);
  await dialog.getByLabel('新模板名').fill('冲突模板');
  await dialog.getByRole('button', { name: '新建空白' }).click();
  await expect(dialog.getByLabel('模板名称')).toHaveValue('冲突模板');

  await dialog.getByRole('button', { name: '添加地点' }).click();
  await dialog.getByLabel('地点 2 ID').fill('start');
  await dialog.getByLabel('地点 2 名称').fill('重复地点');
  await dialog.getByRole('button', { name: '保存草稿' }).click();
  await expect(dialog.getByRole('alert')).toContainText('地点 ID不能重复');
  let list = await getLibrary(request, app.baseURL);
  let current = await getEditor(request, app.baseURL, list.find((entry) => entry.name === '冲突模板')!.id);
  expect(current.draftRevision).toBe(1);

  await dialog.getByLabel('地点 2 ID').fill('start-2');
  await dialog.getByRole('button', { name: '保存草稿' }).click();
  await expect(dialog.getByRole('status')).toContainText('草稿已保存');
  list = await getLibrary(request, app.baseURL);
  const summary = list.find((entry) => entry.name === '冲突模板')!;
  current = await getEditor(request, app.baseURL, summary.id);
  expect(current.draftRevision).toBe(2);

  // 模拟另一个窗口用当前修订号保存：本地页面继续持有修订 2。
  const externalTemplate = structuredClone(current.draft);
  externalTemplate.initial.money = 777;
  const external = await request.put(`${app.baseURL}/api/world/template-library/${encodeURIComponent(summary.id)}`, {
    data: { revision: current.draftRevision, name: '外部窗口模板', template: externalTemplate },
  });
  expect(external.ok()).toBeTruthy();

  await dialog.getByLabel('模板名称').fill('本地窗口模板');
  await dialog.getByRole('button', { name: '保存草稿' }).click();
  await expect(dialog.getByRole('alert')).toContainText('其他窗口');
  await expect(dialog.getByRole('alert')).toContainText('已重新载入');
  await expect(dialog.getByLabel('模板名称')).toHaveValue('外部窗口模板');
  await expect(dialog.getByLabel('初始金额')).toHaveValue('777');
  await expect(dialog.getByRole('button', { name: '编辑模板 外部窗口模板' })).toHaveAttribute('aria-pressed', 'true');
});

test('删除模板库模板后已有聊天继续使用内嵌模板版本', async ({ page, app, request }) => {
  const blank = await (await request.post(app.baseURL + '/api/world/template-library', { data: { action: 'blank', name: '可删除模板' } })).json() as EditorDto;
  const template = structuredClone(blank.draft);
  template.locations = [{ id: 'hall', name: '大厅' }];
  template.actors = [{ id: 'hero', name: '英雄' }];
  template.items = [{ id: 'coin-pouch', name: '钱袋', price: 5 }];
  template.initial = { actorId: 'hero', locationId: 'hall', money: 66, inventory: [{ ownerId: 'hero', itemId: 'coin-pouch', quantity: 1 }] };
  const saved = await (await request.put(`${app.baseURL}/api/world/template-library/${encodeURIComponent(blank.id)}`, {
    data: { revision: blank.draftRevision, name: '可删除模板', description: '删除后旧聊天不变', template },
  })).json() as EditorDto;
  const published = await (await request.post(`${app.baseURL}/api/world/template-library/${encodeURIComponent(blank.id)}/publish`, {
    data: { revision: saved.draftRevision },
  })).json() as EditorDto;
  expect(published.publishedHash).toMatch(/^[a-f0-9]{64}$/);

  await page.goto(app.baseURL);
  await expect(page.getByText('在线', { exact: true })).toBeVisible();
  await createWorldChat(page, blank.id);
  await page.getByRole('button', { name: '打开世界状态', exact: true }).click();
  let world = page.getByRole('dialog', { name: '世界状态' });
  await expect(world).toContainText('可删除模板');
  await expect(world).toContainText('66 · 钱袋×1');
  await world.getByRole('button', { name: '关闭世界状态' }).click();

  const chats = await (await request.get(app.baseURL + '/api/chats')).json() as Array<{ id: string; character: string }>;
  const chat = chats.find((entry) => entry.character === '浏览器向导')!;
  const beforeDelete = await (await request.get(`${app.baseURL}/api/chats/${chat.id.split('/').map(encodeURIComponent).join('/')}`)).json() as ChatWorldSnapshot;
  expect(beforeDelete.world?.templateName).toBe('可删除模板');

  await page.getByRole('button', { name: '世界模板', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: /世界模板/ });
  await dialog.getByRole('button', { name: '编辑模板 可删除模板' }).click();
  await expect(dialog.getByLabel('模板名称')).toHaveValue('可删除模板');
  page.once('dialog', (confirm) => void confirm.accept());
  await dialog.getByRole('button', { name: '删除模板', exact: true }).click();
  await expect(dialog.getByRole('status')).toContainText('已删除模板「可删除模板」');
  await expect(dialog.getByRole('button', { name: '编辑模板 可删除模板' })).toHaveCount(0);
  await dialog.getByRole('button', { name: '关闭世界模板' }).click();
  expect((await request.get(`${app.baseURL}/api/world/template-library/${encodeURIComponent(blank.id)}`)).status()).toBe(404);

  // 重启页面后旧聊天仍从自身 JSONL 读取模板和快照。
  await page.reload();
  await expect(page.getByText('在线', { exact: true })).toBeVisible();
  await page.locator('aside li').filter({ hasText: '浏览器向导' }).first().getByRole('button').first().click();
  await expect(page.getByRole('button', { name: '打开世界状态', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '打开世界状态', exact: true }).click();
  world = page.getByRole('dialog', { name: '世界状态' });
  await expect(world).toContainText('可删除模板');
  await expect(world).toContainText('66 · 钱袋×1');
  await world.getByRole('button', { name: '关闭世界状态' }).click();
  const afterDelete = await (await request.get(`${app.baseURL}/api/chats/${chat.id.split('/').map(encodeURIComponent).join('/')}`)).json() as ChatWorldSnapshot;
  expect(afterDelete.world?.templateName).toBe('可删除模板');
  expect(afterDelete.world?.snapshot.templateHash).toBe(published.publishedHash);
  const options = await page.getByLabel('新聊天世界模板').locator('option').allTextContents();
  expect(options).not.toContain('可删除模板');
});

test('复制内置模板、导出草稿 JSON 并导入为新草稿', async ({ page, app, request }) => {
  const dialog = await openTemplates(page, app.baseURL);
  await dialog.getByLabel('新模板名').fill('浏览器副本');
  await dialog.getByLabel('内置模板').selectOption({ label: '酒馆买剑' });
  await dialog.getByRole('button', { name: '复制内置模板' }).click();
  await expect(dialog.getByRole('status')).toContainText('已从内置模板「酒馆买剑」创建副本');
  await expect(dialog.getByLabel('模板名称')).toHaveValue('浏览器副本');
  await expect(dialog.getByLabel('初始世界预览')).toContainText('地点 2 · 角色 3 · 物品 2');
  await expect(dialog.getByLabel('初始世界预览')).toContainText('初始金额 100');

  const downloadPromise = page.waitForEvent('download');
  await dialog.getByRole('button', { name: '导出草稿 JSON' }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toContain('.world-template.json');
  const exportedFile = path.join(app.runDir, 'export.world-template.json');
  await download.saveAs(exportedFile);
  const exported = JSON.parse(fs.readFileSync(exportedFile, 'utf8')) as { format: string; version: number; name: string; template: WorldTemplate };
  expect(exported.format).toBe('pitavern-world-template');
  expect(exported.version).toBe(1);
  expect(exported.name).toBe('浏览器副本');
  expect(exported.template.locations).toHaveLength(2);
  expect(exported.template.items.find((item) => item.id === 'sword')?.price).toBe(30);
  await expect(dialog.getByRole('status')).toContainText('已开始导出模板 JSON');

  const importedPayload = { ...exported, name: '导入副本' };
  await dialog.locator('input[type=file]').setInputFiles({
    name: 'import.world-template.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(importedPayload)),
  });
  await expect(dialog.getByRole('status')).toContainText('已导入模板「导入副本」');
  await expect(dialog.getByLabel('模板名称')).toHaveValue('导入副本');
  await expect(dialog.getByRole('button', { name: '编辑模板 导入副本' })).toHaveAttribute('aria-pressed', 'true');
  const library = await getLibrary(request, app.baseURL);
  expect(library.map((entry) => entry.name)).toEqual(expect.arrayContaining(['浏览器副本', '导入副本']));
  const copy = library.find((entry) => entry.name === '浏览器副本')!;
  const imported = library.find((entry) => entry.name === '导入副本')!;
  expect(imported.draftDirty).toBe(true);
  // 导入时 templateId 已存在：服务端分配新稳定 ID，不覆盖已有模板。
  expect(imported.id).not.toBe(copy.id);
  expect(imported.id).not.toBe(exported.template.templateId);
  const importedEditor = await getEditor(request, app.baseURL, imported.id);
  expect(importedEditor.draft.templateId).toBe(imported.id);
  expect(importedEditor.draft.locations).toHaveLength(2);
  expect((await getEditor(request, app.baseURL, copy.id)).draft.locations).toHaveLength(2);
});

test('新建空白前保护未保存修改：取消后保留当前金额', async ({ page, app }) => {
  const dialog = await openTemplates(page, app.baseURL);
  await dialog.getByLabel('新模板名').fill('未保存模板');
  await dialog.getByRole('button', { name: '新建空白' }).click();
  await expect(dialog.getByLabel('模板名称')).toHaveValue('未保存模板');
  await dialog.getByLabel('初始金额').fill('123');
  let prompt = '';
  page.once('dialog', (confirm) => { prompt = confirm.message(); void confirm.dismiss(); });
  await dialog.getByRole('button', { name: '新建空白' }).click();
  expect(prompt).toContain('未保存');
  await expect(dialog.getByLabel('模板名称')).toHaveValue('未保存模板');
  await expect(dialog.getByLabel('初始金额')).toHaveValue('123');

  page.once('dialog', (confirm) => void confirm.accept());
  await dialog.getByLabel('新模板名').fill('第二个模板');
  await dialog.getByRole('button', { name: '新建空白' }).click();
  await expect(dialog.getByLabel('模板名称')).toHaveValue('第二个模板');
});

test('仅修改名称后发布：新聊天使用新名称且不增加内容版本', async ({ page, app, request }) => {
  const dialog = await openTemplates(page, app.baseURL);
  await dialog.getByLabel('新模板名').fill('旧名称');
  await dialog.getByRole('button', { name: '新建空白' }).click();
  await dialog.getByRole('button', { name: '发布模板' }).click();
  await expect(dialog.getByRole('status')).toContainText('已发布版本 v1');
  await expect(dialog.getByRole('list', { name: '模板版本列表' }).locator('li')).toHaveCount(1);

  let library = await getLibrary(request, app.baseURL);
  const original = library.find((entry) => entry.name === '旧名称')!;
  await dialog.getByLabel('模板名称').fill('新名称');
  await dialog.getByRole('button', { name: '保存草稿' }).click();
  await expect(dialog.getByRole('status')).toContainText('草稿已保存');
  await dialog.getByRole('button', { name: '发布模板' }).click();
  await expect(dialog.getByRole('status')).toContainText('已更新发布名称/描述');
  await expect(dialog.getByRole('list', { name: '模板版本列表' }).locator('li')).toHaveCount(1);

  library = await getLibrary(request, app.baseURL);
  const renamed = library.find((entry) => entry.id === original.id)!;
  expect(renamed.name).toBe('新名称');
  expect(renamed.publishedVersion).toBe(1);
  const editor = await getEditor(request, app.baseURL, original.id);
  expect(editor.published?.name).toBe('新名称');
  expect(editor.versions).toHaveLength(1);
  await dialog.getByRole('button', { name: '关闭世界模板' }).click();
  await expect(dialog).not.toBeVisible();

  await page.getByLabel('新聊天世界模板').selectOption(original.id);
  await page.getByRole('button', { name: '＋ 开始新对话', exact: true }).click();
  await page.getByRole('button', { name: '打开世界状态', exact: true }).click();
  const world = page.getByRole('dialog', { name: '世界状态' });
  await expect(world).toContainText('新名称');
  await world.getByRole('button', { name: '关闭世界状态' }).click();
});

test('世界模板编辑器在 390px 手机宽度可完整操作且无水平溢出', async ({ page, app }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const dialog = await openTemplates(page, app.baseURL, true);
  await dialog.getByLabel('新模板名').fill('手机世界');
  await dialog.getByRole('button', { name: '新建空白' }).click();
  await expect(dialog.getByLabel('模板名称')).toHaveValue('手机世界');
  await dialog.getByRole('button', { name: '添加地点' }).click();
  await dialog.getByLabel('地点 2 ID').fill('yard');
  await dialog.getByLabel('地点 2 名称').fill('院子');
  await dialog.getByRole('button', { name: '添加物品' }).click();
  await dialog.getByLabel('物品 1 ID').fill('water');
  await dialog.getByLabel('物品 1 名称').fill('清水');
  await dialog.getByLabel('物品 1 固定价格').fill('2');
  await dialog.getByLabel('初始地点').selectOption('yard');
  await dialog.getByLabel('初始金额').fill('12');
  await dialog.getByRole('button', { name: '添加库存' }).click();
  await dialog.getByLabel('库存 1 数量').fill('3');
  await dialog.getByRole('button', { name: '保存草稿' }).click();
  await expect(dialog.getByRole('status')).toContainText('草稿已保存');
  await expect(dialog.getByLabel('初始世界预览')).toContainText('初始金额 12');
  await expect(dialog.getByLabel('初始世界预览')).toContainText('地点 2 · 角色 1 · 物品 1');
  await dialog.getByRole('button', { name: '发布模板' }).click();
  await expect(dialog.getByRole('status')).toContainText('已发布版本 v1');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  expect(await dialog.evaluate((node) => node.scrollWidth <= node.clientWidth + 1)).toBe(true);
  await page.screenshot({ path: path.join(app.runDir, 'world-templates-mobile.png'), fullPage: true });
  await dialog.getByRole('button', { name: '关闭世界模板' }).click();
  await expect(dialog).not.toBeVisible();
});
