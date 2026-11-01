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
  world?: { templateName: string; snapshot: WorldSnapshot };
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
  await page.locator('aside').getByRole('button', { name: '浏览器向导', exact: true }).click();
  await page.getByLabel('新聊天世界模板').selectOption(templateId);
  await page.getByRole('button', { name: /开始新对话/ }).click();
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
  library = await getLibrary(request, app.baseURL);
  expect(library.find((entry) => entry.id === original.id)!.draftDirty).toBe(true);
  await expect(dialog.getByText('草稿有修改', { exact: false })).toBeVisible();
  await dialog.getByRole('button', { name: '发布模板' }).click();
  await expect(dialog.getByRole('status')).toContainText('已更新发布名称/描述');
  await expect(dialog.getByText('草稿与发布一致', { exact: false }).first()).toBeVisible();
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

  await page.locator('aside').getByRole('button', { name: '浏览器向导', exact: true }).click();
  await page.getByLabel('新聊天世界模板').selectOption(original.id);
  await page.getByRole('button', { name: /开始新对话/ }).click();
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

test('世界状态更新模板：全分支迁移、备份恢复与 390px 可操作', async ({ page, app, request }) => {
  const blank = await (await request.post(app.baseURL + '/api/world/template-library', { data: { action: 'blank', name: '迁移世界' } })).json() as EditorDto;
  const template = structuredClone(blank.draft);
  template.locations = [{ id: 'tavern', name: '酒馆' }];
  template.actors = [{ id: 'player', name: '旅人' }, { id: 'merchant', name: '掌柜' }];
  template.items = [{ id: 'sword', name: '长剑', price: 17 }];
  template.initial = { actorId: 'player', locationId: 'tavern', money: 100, inventory: [{ ownerId: 'merchant', itemId: 'sword', quantity: 1 }] };
  const saved = await (await request.put(`${app.baseURL}/api/world/template-library/${encodeURIComponent(blank.id)}`, {
    data: { revision: blank.draftRevision, name: '迁移世界', description: '旧描述', template },
  })).json() as EditorDto;
  const published = await (await request.post(`${app.baseURL}/api/world/template-library/${encodeURIComponent(blank.id)}/publish`, {
    data: { revision: saved.draftRevision },
  })).json() as EditorDto;
  expect(published.publishedHash).toMatch(/^[a-f0-9]{64}$/);

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(app.baseURL);
  await expect(page.getByText('在线', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '菜单', exact: true }).click();
  await createWorldChat(page, blank.id);
  let world = page.getByRole('dialog', { name: '世界状态' });
  await page.getByRole('button', { name: '打开世界状态', exact: true }).click();
  await expect(world).toContainText('迁移世界');
  await world.getByRole('button', { name: '关闭世界状态' }).click();

  const editor = await (await request.get(`${app.baseURL}/api/world/template-library/${encodeURIComponent(blank.id)}`)).json() as EditorDto;
  const nextTemplate = structuredClone(editor.draft);
  nextTemplate.items = [{ id: 'sword', name: '长剑', price: 23 }];
  const saved2 = await (await request.put(`${app.baseURL}/api/world/template-library/${encodeURIComponent(blank.id)}`, {
    data: { revision: editor.draftRevision, name: '迁移世界·新版', description: '新描述', template: nextTemplate },
  })).json() as EditorDto;
  const published2 = await (await request.post(`${app.baseURL}/api/world/template-library/${encodeURIComponent(blank.id)}/publish`, {
    data: { revision: saved2.draftRevision },
  })).json() as EditorDto;
  const targetHash = published2.publishedHash!;

  await page.getByRole('button', { name: '打开世界状态', exact: true }).click();
  world = page.getByRole('dialog', { name: '世界状态' });
  await expect(world.getByLabel('目标模板版本')).toBeVisible();
  await world.getByLabel('目标模板版本').selectOption(targetHash);
  await world.getByRole('button', { name: '预览迁移差异' }).click();
  await expect(world.getByText(/世界恢复点/)).toBeVisible();
  await expect(world.getByLabel('迁移差异')).toContainText('17 → 23');
  page.once('dialog', (confirm) => void confirm.accept());
  await world.getByRole('button', { name: '应用迁移并备份' }).click();
  await expect(world.getByRole('status')).toContainText('模板已更新');

  const chats = await (await request.get(app.baseURL + '/api/chats')).json() as Array<{ id: string; character: string }>;
  const chat = chats.find((entry) => entry.character === '浏览器向导')!;
  const chatRoute = chat.id.split('/').map(encodeURIComponent).join('/');
  const appliedWorld = await (await request.get(`${app.baseURL}/api/chats/${chatRoute}`)).json() as ChatWorldSnapshot;
  expect(appliedWorld.world?.templateName).toBe('迁移世界·新版');
  expect(appliedWorld.world?.snapshot.templateVersion).toBe(2);
  expect(appliedWorld.world?.snapshot.templateHash).toBe(targetHash);

  await world.getByRole('button', { name: '打开备份与恢复' }).click();
  const backups = page.getByRole('dialog', { name: /聊天备份/ });
  await expect(backups).toBeVisible();
  await backups.getByRole('button', { name: '恢复此备份' }).click();
  await expect(backups).not.toBeVisible();
  const restoredWorld = await (await request.get(`${app.baseURL}/api/chats/${chatRoute}`)).json() as ChatWorldSnapshot;
  expect(restoredWorld.world?.snapshot.templateHash).toBe(published.publishedHash);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test('同哈希名称/描述发布可从 UI 迁移，世界数值不变，再次预览无需迁移', async ({ page, app, request }) => {
  const blank = await (await request.post(app.baseURL + '/api/world/template-library', {
    data: { action: 'blank', name: '元数据旧名称' },
  })).json() as EditorDto;
  const route = `${app.baseURL}/api/world/template-library/${encodeURIComponent(blank.id)}`;
  const published = await (await request.post(route + '/publish', {
    data: { revision: blank.draftRevision },
  })).json() as EditorDto;
  await page.goto(app.baseURL);
  await expect(page.getByText('在线', { exact: true })).toBeVisible();
  await createWorldChat(page, blank.id);
  const chats = await (await request.get(app.baseURL + '/api/chats')).json() as Array<{ id: string; character: string }>;
  const chat = chats.find((entry) => entry.character === '浏览器向导')!;
  const chatRoute = `${app.baseURL}/api/chats/${chat.id.split('/').map(encodeURIComponent).join('/')}`;
  const before = await (await request.get(chatRoute)).json() as ChatWorldSnapshot;
  const saved = await (await request.put(route, {
    data: { revision: published.draftRevision, name: '元数据新名称', description: '仅更新名称与描述', template: published.draft },
  })).json() as EditorDto;
  const renamed = await (await request.post(route + '/publish', {
    data: { revision: saved.draftRevision },
  })).json() as EditorDto;
  expect(renamed.publishedHash).toBe(published.publishedHash);

  await page.getByRole('button', { name: '打开世界状态', exact: true }).click();
  const world = page.getByRole('dialog', { name: '世界状态' });
  await expect(world.getByLabel('目标模板版本')).toBeVisible();
  await world.getByLabel('目标模板版本').selectOption(renamed.publishedHash!);
  await world.getByRole('button', { name: '预览迁移差异' }).click();
  await expect(world.getByLabel('迁移差异')).toContainText('名称/描述');
  await expect(world.getByLabel('迁移差异')).toContainText('描述已更新');
  page.once('dialog', (confirm) => void confirm.accept());
  await world.getByRole('button', { name: '应用迁移并备份' }).click();
  await expect(world.getByRole('status')).toContainText('模板已更新');
  const after = await (await request.get(chatRoute)).json() as ChatWorldSnapshot;
  expect(after.world?.templateName).toBe('元数据新名称');
  const exported = await request.get(chatRoute + '/export?format=jsonl');
  expect(exported.ok()).toBeTruthy();
  const header = JSON.parse((await exported.text()).split('\n')[0]);
  expect(header.chat_metadata._pitavernWorldTemplates[renamed.publishedHash!].description).toBe('仅更新名称与描述');
  expect(after.world?.snapshot).toEqual(before.world?.snapshot);

  await world.getByRole('button', { name: '关闭世界状态' }).click();
  await page.getByRole('button', { name: '打开世界状态', exact: true }).click();
  await world.getByRole('button', { name: '预览迁移差异' }).click();
  await expect(world.getByText('目标已是当前版本，无需迁移。', { exact: true })).toBeVisible();
  await expect(world.getByRole('button', { name: '应用迁移并备份' })).toHaveCount(0);
});

test('长局诊断显示保留/压缩范围、来源、字符量与估算预算，刷新后记录可读', async ({ page, app, request }) => {
  await page.goto(app.baseURL);
  await expect(page.getByText('在线', { exact: true })).toBeVisible();
  await createWorldChat(page, 'tavern-sword');
  const chats = await (await request.get(app.baseURL + '/api/chats')).json() as Array<{ id: string; character: string }>;
  const chat = chats.find((entry) => entry.character === '浏览器向导')!;
  const file = path.join(app.runDir, 'st', chat.id);
  const header = JSON.parse(fs.readFileSync(file, 'utf8').split('\n')[0]);
  const lines: unknown[] = [header];
  for (let turn = 1; turn <= 100; turn++) {
    lines.push({ name: '旅人', is_user: true, is_system: false, mes: `第${turn}轮观察。`, send_date: '' });
    lines.push({ name: '浏览器向导', is_user: false, is_system: false, send_date: '',
      mes: '微风吹过石墙，远方灯火摇曳。'.repeat(50) + (turn === 1 ? '发现线索：旧井铜匣里是蓝色地图。' : '') });
  }
  fs.writeFileSync(file, lines.map((line) => JSON.stringify(line)).join('\n') + '\n');
  await page.reload(); await expect(page.getByText('在线', { exact: true })).toBeVisible();
  await page.locator('aside li').filter({ hasText: '浏览器向导' }).first().getByRole('button').first().click();
  await page.getByLabel('消息输入').fill('旧井铜匣里发现了什么地图？');
  await page.getByRole('button', { name: '发送', exact: true }).click();
  await expect(page.getByText('模型原文', { exact: true })).toBeVisible();
  const diagnosticsButton = page.getByRole('button', { name: '生成记录与上下文诊断', exact: true });
  await expect(diagnosticsButton).toBeVisible();
  await diagnosticsButton.click();
  const dialog = page.getByRole('dialog', { name: '生成记录与上下文诊断', exact: true });
  const memory = dialog.getByRole('region', { name: '长局记忆诊断' });
  await expect(memory).toContainText('最近全文保留');
  await expect(memory).toContainText('压缩范围');
  await expect(memory).toContainText('字符量');
  await expect(memory).toContainText('估算 token');
  await memory.getByText('查看已发送线索及来源', { exact: true }).click();
  await expect(memory.getByLabel('线索来源列表')).toContainText('旧井铜匣里是蓝色地图');
  await expect(memory.getByLabel('线索来源列表')).toContainText('SHA-256');
  const requests = fs.readFileSync(path.join(app.runDir, 'requests.ndjson'), 'utf8');
  expect(requests).toContain('旧井铜匣里是蓝色地图');
  expect(requests).toContain('当前权威世界快照');
  await dialog.getByRole('button', { name: '关闭生成记录' }).click();
  await page.reload(); await expect(page.getByText('在线', { exact: true })).toBeVisible();
  await page.locator('aside li').filter({ hasText: '浏览器向导' }).first().getByRole('button').first().click();
  await expect(diagnosticsButton).toBeVisible();
  await diagnosticsButton.click();
  await expect(dialog.getByRole('region', { name: '长局记忆诊断' })).toContainText('extractive-v1');
});

const seedKnowledge = async (request: APIRequestContext, baseURL: string) => {
  const blank = await (await request.post(baseURL + '/api/world/template-library', {data:{action:'blank',name:'知识酒馆'}})).json() as EditorDto;
  const template = JSON.parse(fs.readFileSync(path.resolve('apps/server/scripts/fixtures/knowledge-tavern.json'),'utf8')) as WorldTemplate;
  template.templateId=blank.id;
  const route=baseURL+'/api/world/template-library/'+encodeURIComponent(blank.id);
  const saved=await (await request.put(route,{data:{revision:blank.draftRevision,name:'知识酒馆',template}})).json() as EditorDto;
  const published=await (await request.post(route+'/publish',{data:{revision:saved.draftRevision}})).json() as EditorDto;
  return {id:blank.id,template,published};
};

test('知识作者编辑器：事实、初始知情、揭示条件和玩家/NPC服务端预览，390px 可操作',async({page,app,request})=>{
  const seeded=await seedKnowledge(request,app.baseURL);const secret=seeded.template.facts![1];
  const dialog=await openTemplates(page,app.baseURL);await dialog.getByRole('button',{name:'编辑模板 知识酒馆',exact:true}).click();
  await expect(dialog.getByLabel('事实 2 正文',{exact:true})).toHaveValue(secret.text);
  const preview=dialog.getByLabel('知识视角预览');await preview.getByRole('button',{name:'刷新视角预览'}).click();
  await expect(preview.getByRole('list',{name:'预览已知事实'})).toContainText('旧酒馆正在维修');await expect(preview.getByRole('list')).not.toContainText(secret.text);
  await preview.getByLabel('知识预览视角').selectOption('actor:innkeeper');await preview.getByRole('button',{name:'刷新视角预览'}).click();await expect(preview.getByRole('list')).toContainText(secret.text);await expect(preview.getByRole('list')).not.toContainText(secret.description!);
  await dialog.getByLabel('交互 1 条件 3 数量',{exact:true}).fill('2');await dialog.getByRole('button',{name:'保存草稿',exact:true}).click();await expect(dialog.getByRole('status')).toContainText('草稿已保存');
  const saved=await getEditor(request,app.baseURL,seeded.id);expect(saved.draft.interactions![0].conditions[2]).toEqual({type:'has_item',itemId:'letter',quantity:2});expect(saved.draft.initial.knowledge).toEqual([{actorId:'innkeeper',factId:secret.id}]);
  await page.setViewportSize({width:390,height:844});await dialog.getByLabel('事实 2 内部备注',{exact:true}).scrollIntoViewIfNeeded();await expect(dialog.getByLabel('事实 2 内部备注',{exact:true})).toBeVisible();
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBe(true);
});

for(const mobile of [false,true]) test(`玩家已知线索与独立作者入口${mobile?'（390px）':''}：默认响应不泄露，修正后来源可见`,async({page,app,request})=>{
  const seeded=await seedKnowledge(request,app.baseURL);const secret=seeded.template.facts![1];const authorRequests:string[]=[];page.on('request',r=>{if(r.url().endsWith('/api/chat/world/author'))authorRequests.push(r.url())});
  if(mobile)await page.setViewportSize({width:390,height:844});await page.goto(app.baseURL);await expect(page.getByText('在线',{exact:true})).toBeVisible();if(mobile)await page.getByRole('button',{name:'菜单',exact:true}).click();await createWorldChat(page,seeded.id);
  await page.getByRole('button',{name:'打开世界状态',exact:true}).click();let dialog=page.getByRole('dialog',{name:'世界状态',exact:true});await expect(dialog.getByLabel('已知线索')).toContainText('旧酒馆正在维修');await expect(dialog).not.toContainText(secret.text);expect(authorRequests).toHaveLength(0);
  const chats=await (await request.get(app.baseURL+'/api/chats')).json() as Array<{id:string}>;const chat=chats.find(c=>c.id.includes('浏览器向导'))!;const route=app.baseURL+'/api/chats/'+chat.id.split('/').map(encodeURIComponent).join('/');const player=await (await request.get(route)).json();for(const value of [secret.id,secret.text,secret.description])expect(JSON.stringify(player)).not.toContain(value!);
  await dialog.getByRole('button',{name:'作者视图（含秘密）',exact:true}).click();const author=dialog.getByLabel('作者世界视图');await author.getByText('查看完整模板与知识快照 JSON',{exact:true}).click();await expect(author).toContainText(secret.text);expect(authorRequests).toHaveLength(1);
  await dialog.getByRole('button',{name:'关闭作者视图',exact:true}).click();await expect(dialog).not.toContainText(secret.text);
  await dialog.getByRole('button',{name:'作者视图（含秘密）',exact:true}).click();await dialog.getByRole('button',{name:'修正状态',exact:true}).click();const area=dialog.getByLabel('世界快照 JSON',{exact:true});const raw=JSON.parse(await area.inputValue()) as WorldSnapshot;raw.knowledge!.push({actorId:'player',factId:secret.id,source:{type:'interaction',turn:1,interactionId:seeded.template.interactions![0].id,fromActorId:'innkeeper'}});await area.fill(JSON.stringify(raw));await dialog.getByRole('button',{name:'保存修正',exact:true}).click();await expect(page.getByText('世界状态已修正',{exact:true})).toBeVisible();
  await page.getByRole('button',{name:'打开世界状态',exact:true}).click();dialog=page.getByRole('dialog',{name:'世界状态',exact:true});await expect(dialog.getByLabel('已知线索')).toContainText(secret.text);await expect(dialog.getByLabel('已知线索')).toContainText('第 1 轮交互');await expect(dialog).not.toContainText(secret.description!);expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBe(true);
});

test('v1 草稿显式启用 v2，新增秘密与初始知情可保存发布',async({page,app,request})=>{
  const dialog=await openTemplates(page,app.baseURL);await dialog.getByLabel('新模板名').fill('新知识规则');await dialog.getByRole('button',{name:'新建空白',exact:true}).click();await expect(dialog.getByRole('status')).toContainText('已创建空白模板');await dialog.getByRole('button',{name:'启用知识规则（v2）',exact:true}).click();await dialog.getByRole('button',{name:'添加事实',exact:true}).click();await dialog.getByLabel('事实 1 正文',{exact:true}).fill('窗台下藏着绿色账册。');await dialog.getByLabel('初始知情角色',{exact:true}).getByRole('checkbox').first().check();await dialog.getByRole('button',{name:'保存草稿',exact:true}).click();await expect(dialog.getByRole('status')).toContainText('草稿已保存');await dialog.getByRole('button',{name:'发布模板',exact:true}).click();await expect(dialog.getByRole('status')).toContainText('已发布版本');const summary=(await getLibrary(request,app.baseURL)).find(e=>e.name==='新知识规则')!;const saved=await getEditor(request,app.baseURL,summary.id);expect(saved.draft.schemaVersion).toBe(2);expect(saved.draft.facts![0].visibility).toBe('restricted');expect(saved.draft.initial.knowledge).toHaveLength(1);
});
