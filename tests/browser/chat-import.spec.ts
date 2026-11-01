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

const openImport = async (page: Page) => {
  await page.locator('aside').getByRole('button', { name: '＋ 导入聊天', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '导入聊天', exact: true });
  await expect(dialog).toBeVisible();
  return dialog;
};

const fileOf = (name: string, text: string) => ({ name, mimeType: 'application/x-ndjson', buffer: Buffer.from(text, 'utf8') });

const header = { user_name: '旅人', character_name: '浏览器向导', chat_metadata: {} };
const validMessages = [
  { name: '旅人', is_user: true, is_system: false, mes: '导入的用户消息', send_date: '2026-11-01T10:00:00.000Z' },
  { name: '浏览器向导', is_user: false, is_system: false, mes: '导入的助手消息', send_date: '2026-11-01T10:00:01.000Z' },
];
const validJsonl = [header, ...validMessages].map((line) => JSON.stringify(line)).join('\n') + '\n';

test('导入入口→预览→选择角色→导入并打开，中文+空格文件名可识别', async ({ page, app }) => {
  await openApp(page, app.baseURL);
  // 先筛选到浏览器向导，验证导入其他角色后会自动回到“全部”。
  await page.locator('aside').getByRole('button', { name: '浏览器向导', exact: true }).click();

  const dialog = await openImport(page);
  await dialog.getByLabel('选择聊天 JSONL 文件', { exact: true }).setInputFiles(fileOf('中文 空格 聊天.jsonl', validJsonl));

  await expect(dialog.getByRole('heading', { name: '文件预览', exact: true })).toBeVisible();
  await expect(dialog).toContainText('中文 空格 聊天.jsonl');
  await expect(dialog).toContainText('3 行');
  await expect(dialog).toContainText('2 条消息');
  await expect(dialog).toContainText('隐藏消息');
  await expect(dialog).toContainText('分叉点');
  await expect(dialog).toContainText('候选');
  await expect(dialog.getByLabel('关联角色', { exact: true })).toHaveValue('浏览器向导');
  await expect(dialog.getByLabel('聊天标题', { exact: true })).toHaveValue('中文 空格 聊天');

  await dialog.getByLabel('关联角色', { exact: true }).selectOption('图片向导');
  await dialog.getByLabel('聊天标题', { exact: true }).fill('导入标题 中文 空格');
  await dialog.getByRole('button', { name: '导入并打开', exact: true }).click();

  await expect(dialog).toHaveCount(0);
  await expect(page.locator('aside').getByText('导入标题 中文 空格', { exact: true })).toBeVisible();
  await expect(page.getByText('导入的助手消息', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '全部', exact: true })).toHaveClass(/bg-tavern-accent/);
  await expect(page.getByText(/已导入聊天「导入标题 中文 空格」/)).toBeVisible();
});

test('损坏 JSONL 按行号提示并禁止导入', async ({ page, app }) => {
  await openApp(page, app.baseURL);
  const dialog = await openImport(page);
  const broken = [header, validMessages[0], '{"name": "半截"'].map((line) => typeof line === 'string' ? line : JSON.stringify(line)).join('\n') + '\n';
  await dialog.getByLabel('选择聊天 JSONL 文件', { exact: true }).setInputFiles(fileOf('损坏 文件.jsonl', broken));

  await expect(dialog.getByRole('heading', { name: '校验错误', exact: true })).toBeVisible();
  await expect(dialog).toContainText('第 3 行');
  await expect(dialog).toContainText('校验未通过');
  await expect(dialog.getByRole('button', { name: '导入并打开', exact: true })).toBeDisabled();
});

test('重复导入同一文件被阻止且不新增聊天', async ({ page, app, request }) => {
  await openApp(page, app.baseURL);
  let dialog = await openImport(page);
  await dialog.getByLabel('选择聊天 JSONL 文件', { exact: true }).setInputFiles(fileOf('重复 文件.jsonl', validJsonl));
  await expect(dialog.getByRole('heading', { name: '文件预览', exact: true })).toBeVisible();
  await dialog.getByRole('button', { name: '导入并打开', exact: true }).click();
  await expect(dialog).toHaveCount(0);

  const afterFirst = await (await request.get(app.baseURL + '/api/chats')).json();
  expect(Array.isArray(afterFirst)).toBeTruthy();

  dialog = await openImport(page);
  await dialog.getByLabel('选择聊天 JSONL 文件', { exact: true }).setInputFiles(fileOf('重复 文件.jsonl', validJsonl));
  await expect(dialog.getByText(/该文件已导入过/)).toBeVisible();
  await expect(dialog.getByRole('button', { name: '导入并打开', exact: true })).toBeDisabled();

  const afterSecond = await (await request.get(app.baseURL + '/api/chats')).json();
  expect(afterSecond).toHaveLength(afterFirst.length);
});

test('390px 移动端可完成导入且无水平溢出', async ({ page, app }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openApp(page, app.baseURL);
  await page.getByRole('button', { name: '菜单', exact: true }).click();

  const dialog = await openImport(page);
  const box = await dialog.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(390);
  expect(box!.y).toBeGreaterThanOrEqual(0);
  expect(box!.y + box!.height).toBeLessThanOrEqual(844);

  const mobileMessages = [
    { name: '旅人', is_user: true, is_system: false, mes: '移动端用户消息', send_date: '2026-11-01T11:00:00.000Z' },
    { name: '浏览器向导', is_user: false, is_system: false, mes: '移动端导入的助手消息', send_date: '2026-11-01T11:00:01.000Z' },
  ];
  const mobileJsonl = [header, ...mobileMessages].map((line) => JSON.stringify(line)).join('\n') + '\n';
  await dialog.getByLabel('选择聊天 JSONL 文件', { exact: true }).setInputFiles(fileOf('移动端 导入.jsonl', mobileJsonl));
  await expect(dialog.getByRole('heading', { name: '文件预览', exact: true })).toBeVisible();
  expect(await dialog.evaluate((node) => node.scrollWidth <= node.clientWidth + 1)).toBeTruthy();

  await dialog.getByLabel('关联角色', { exact: true }).selectOption('图片向导');
  await dialog.getByLabel('聊天标题', { exact: true }).fill('移动端导入聊天');
  await dialog.getByRole('button', { name: '导入并打开', exact: true }).click();

  await expect(dialog).toHaveCount(0);
  await expect(page.getByText('移动端导入的助手消息', { exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBeTruthy();
});
