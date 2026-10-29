import { test as base, expect, type Page } from '@playwright/test';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';

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

test.beforeEach(async ({ page }) => {
  page.on('pageerror', (error) => { throw error; });
});

const openApp = async (page: Page, url: string) => {
  await page.goto(url);
  await expect(page.getByText('在线', { exact: true })).toBeVisible();
};

const openChatMenu = async (page: Page, displayName: string) => {
  const item = page.locator('aside li').filter({ hasText: displayName }).first();
  await item.hover();
  await page.getByRole('button', { name: `对话操作：${displayName}`, exact: true }).click();
  const menu = page.getByRole('menu', { name: '对话操作菜单' });
  await expect(menu).toBeVisible();
  return menu;
};

test('悬停对话显示三点菜单，包含置顶/重命名/归档/删除四项', async ({ page, app }) => {
  await openApp(page, app.baseURL);
  const item = page.locator('aside li').filter({ hasText: '浏览器向导' }).first();
  await item.hover();
  const trigger = page.getByRole('button', { name: '对话操作：浏览器向导', exact: true });
  await expect(trigger).toBeVisible();
  await trigger.click();

  const menu = page.getByRole('menu', { name: '对话操作菜单' });
  await expect(menu).toBeVisible();
  await expect(menu.getByRole('menuitem')).toHaveCount(4);
  await expect(menu.getByRole('menuitem', { name: '置顶', exact: true })).toBeVisible();
  await expect(menu.getByRole('menuitem', { name: '重命名', exact: true })).toBeVisible();
  await expect(menu.getByRole('menuitem', { name: '归档', exact: true })).toBeVisible();
  await expect(menu.getByRole('menuitem', { name: '删除', exact: true })).toBeVisible();

  await page.keyboard.press('Escape');
  await expect(menu).toHaveCount(0);
});

test('重命名对话后列表标题更新，刷新后仍是新名字', async ({ page, app }) => {
  await openApp(page, app.baseURL);
  const menu = await openChatMenu(page, '浏览器向导');
  await menu.getByRole('menuitem', { name: '重命名', exact: true }).click();

  const dialog = page.getByRole('dialog', { name: '重命名对话', exact: true });
  await expect(dialog).toBeVisible();
  const input = dialog.getByLabel('对话名称', { exact: true });
  await expect(input).toHaveValue('浏览器向导');
  await expect(input).toHaveAttribute('maxlength', '100');
  await input.fill('改名后的对话');
  await dialog.getByRole('button', { name: '保存', exact: true }).click();
  await expect(dialog).toHaveCount(0);

  await expect(page.locator('aside').getByText('改名后的对话', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '对话操作：改名后的对话', exact: true })).toBeVisible();

  await page.reload();
  await expect(page.getByText('在线', { exact: true })).toBeVisible();
  await expect(page.locator('aside').getByText('改名后的对话', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '对话操作：改名后的对话', exact: true })).toBeVisible();
});

test('置顶后刷新仍置顶，并排在对话列表最前', async ({ page, app, request }) => {
  const created = await request.post(app.baseURL + '/api/chats', { data: { character: '多开局向导' } });
  expect(created.ok()).toBeTruthy();
  await openApp(page, app.baseURL);

  const list = page.locator('aside ul[aria-label="对话列表"] > li');
  await expect(list).toHaveCount(2);
  const menu = await openChatMenu(page, '浏览器向导');
  await menu.getByRole('menuitem', { name: '置顶', exact: true }).click();

  await expect(list.first()).toContainText('浏览器向导');
  await expect(list.first()).toContainText('📌');
  await expect(list.nth(1)).toContainText('多开局向导');

  await page.getByRole('button', { name: '对话操作：浏览器向导', exact: true }).click();
  await expect(page.getByRole('menuitem', { name: '取消置顶', exact: true })).toBeVisible();
  await page.keyboard.press('Escape');

  await page.reload();
  await expect(page.getByText('在线', { exact: true })).toBeVisible();
  await expect(list.first()).toContainText('浏览器向导');
  await expect(list.first()).toContainText('📌');
});

test('归档后从主列表隐藏，刷新保持，展开归档可取消归档', async ({ page, app }) => {
  await openApp(page, app.baseURL);
  const menu = await openChatMenu(page, '浏览器向导');
  await menu.getByRole('menuitem', { name: '归档', exact: true }).click();

  const mainItems = page.locator('aside ul[aria-label="对话列表"] > li');
  await expect(mainItems).toHaveCount(0);
  const archivedToggle = page.getByRole('button', { name: /已归档 \(1\)/ });
  await expect(archivedToggle).toBeVisible();

  await page.reload();
  await expect(page.getByText('在线', { exact: true })).toBeVisible();
  await expect(mainItems).toHaveCount(0);
  await expect(archivedToggle).toBeVisible();

  await archivedToggle.click();
  const archivedList = page.locator('aside ul[aria-label="已归档对话"]');
  await expect(archivedList).toBeVisible();
  await expect(archivedList.locator('li')).toHaveCount(1);
  await expect(archivedList).toContainText('浏览器向导');

  await openChatMenu(page, '浏览器向导');
  const unarchive = page.getByRole('menuitem', { name: '取消归档', exact: true });
  await expect(unarchive).toBeVisible();
  await unarchive.click();

  await expect(archivedToggle).toHaveCount(0);
  await expect(archivedList).toHaveCount(0);
  await expect(mainItems).toHaveCount(1);
  await expect(mainItems.first()).toContainText('浏览器向导');
});

test('删除对话需确认，取消不删除，确认后从列表消失', async ({ page, app, request }) => {
  await openApp(page, app.baseURL);
  let menu = await openChatMenu(page, '浏览器向导');
  await menu.getByRole('menuitem', { name: '删除', exact: true }).click();

  const dialog = page.getByRole('dialog', { name: '删除对话', exact: true });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText('删除对话？此操作不可恢复。');
  await dialog.getByRole('button', { name: '取消', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.locator('aside ul[aria-label="对话列表"] > li')).toHaveCount(1);

  const before = await (await request.get(app.baseURL + '/api/chats')).json();
  expect(before).toHaveLength(1);

  menu = await openChatMenu(page, '浏览器向导');
  await menu.getByRole('menuitem', { name: '删除', exact: true }).click();
  await dialog.getByRole('button', { name: '删除', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.locator('aside ul[aria-label="对话列表"] > li')).toHaveCount(0);
  await expect(page.getByText('暂无对话', { exact: true })).toBeVisible();
  const after = await (await request.get(app.baseURL + '/api/chats')).json();
  expect(after).toHaveLength(0);
});

test('手机视口下三点菜单可操作且无水平溢出', async ({ page, app }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openApp(page, app.baseURL);
  await page.getByRole('button', { name: '菜单', exact: true }).click();

  const item = page.locator('aside ul[aria-label="对话列表"] > li').first();
  await expect(item).toBeVisible();
  await item.hover();
  const trigger = page.getByRole('button', { name: '对话操作：浏览器向导', exact: true });
  await expect(trigger).toBeVisible();
  await expect(trigger).toHaveCSS('opacity', '1');
  await trigger.click();

  const menu = page.getByRole('menu', { name: '对话操作菜单' });
  await expect(menu).toBeVisible();
  await expect(menu.getByRole('menuitem')).toHaveCount(4);
  const box = await menu.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(390);
  expect(box!.y).toBeGreaterThanOrEqual(0);
  expect(box!.y + box!.height).toBeLessThanOrEqual(844);

  await menu.getByRole('menuitem', { name: '重命名', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '重命名对话', exact: true });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: '取消', exact: true }).click();
  await expect(dialog).toHaveCount(0);

  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBeTruthy();
});
