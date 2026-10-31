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

const openWorld = async (page: Page) => {
  await page.getByRole('button', { name: '聊天操作', exact: true }).click();
  await page.getByRole('menuitem', { name: '世界状态', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '世界状态' });
  await expect(dialog).toBeVisible();
  return dialog;
};

test('世界模板选择、状态面板、旧聊天初始化与手工修正', async ({ page, app }) => {
  await page.goto(app.baseURL);
  await expect(page.getByText('在线', { exact: true })).toBeVisible();

  // 旧聊天：先产生一条历史，再中途绑定世界。
  await page.locator('aside li').filter({ hasText: '浏览器向导' }).first().getByRole('button').first().click();
  const input = page.getByLabel('消息输入');
  await input.fill('旧剧情');
  await input.press('Enter');
  await expect(page.getByText('模型原文', { exact: true })).toBeVisible();

  let dialog = await openWorld(page);
  await expect(dialog).toContainText('这是已有内容的聊天');
  await dialog.getByLabel('世界模板').selectOption('mist-harbor');
  await dialog.getByRole('button', { name: '启用世界' }).click();
  await expect(page.getByText('世界已初始化', { exact: true })).toBeVisible();

  dialog = await openWorld(page);
  await expect(dialog).toContainText('雾港旅店');
  await expect(dialog).toContainText('40 · 无');
  await expect(dialog.getByText('只读', { exact: true })).toBeVisible();

  // 手工修正快照：revision 冲突由服务端校验，成功后界面同步。
  await dialog.getByRole('button', { name: '修正状态' }).click();
  const area = dialog.getByLabel('世界快照 JSON');
  const snapshot = JSON.parse(await area.inputValue()) as { money: Record<string, number> };
  snapshot.money.player = 55;
  await area.fill(JSON.stringify(snapshot, null, 2));
  await dialog.getByRole('button', { name: '保存修正' }).click();
  await expect(page.getByText('世界状态已修正', { exact: true })).toBeVisible();
  dialog = await openWorld(page);
  await expect(dialog).toContainText('55 · 无');
  await dialog.getByRole('button', { name: '关闭世界状态' }).click();

  // 刷新（重连）后世界快照仍来自 JSONL。
  await page.reload();
  await expect(page.getByText('在线', { exact: true })).toBeVisible();
  await page.locator('aside li').filter({ hasText: '浏览器向导' }).first().getByRole('button').first().click();
  await expect(page.getByRole('button', { name: '聊天操作', exact: true })).toBeEnabled();
  dialog = await openWorld(page);
  await expect(dialog).toContainText('55 · 无');
  await dialog.getByRole('button', { name: '关闭世界状态' }).click();

  // 新建聊天时直接选择世界模板，开局即带初始快照。
  await page.getByLabel('新聊天世界模板').selectOption('tavern-sword');
  await page.getByRole('button', { name: '＋ 开始新对话' }).click();
  await expect(page.getByRole('button', { name: '聊天操作', exact: true })).toBeEnabled();
  dialog = await openWorld(page);
  await expect(dialog).toContainText('酒馆买剑');
  await expect(dialog).toContainText('100');
  await expect(dialog).toContainText('酒馆');
  await dialog.getByRole('button', { name: '关闭世界状态' }).click();
});

test('世界状态面板在 390px 手机宽度可用', async ({ page, app }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(app.baseURL);
  await expect(page.getByText('在线', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '菜单', exact: true }).click();
  await page.getByLabel('新聊天世界模板').selectOption('tavern-sword');
  await page.getByRole('button', { name: '＋ 开始新对话' }).click();
  const worldButton = page.getByRole('button', { name: '打开世界状态', exact: true });
  await expect(worldButton).toBeVisible();
  await worldButton.click();
  const dialog = page.getByRole('dialog', { name: '世界状态' });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText('酒馆买剑');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await dialog.getByRole('button', { name: '关闭世界状态' }).click();
});
