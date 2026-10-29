import { defineConfig } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
const root = path.resolve('data/test-runs'); fs.mkdirSync(root, { recursive: true });
const run = process.env.PITAVERN_BROWSER_RUN ?? fs.mkdtempSync(path.join(root, 'browser-'));
process.env.PITAVERN_BROWSER_RUN = run;
export default defineConfig({
  testDir: './tests/browser', timeout: 45000, expect: { timeout: 10000 },
  fullyParallel: true, workers: 2, retries: 0, forbidOnly: !!process.env.CI,
  outputDir: path.join(run, 'results'), reporter: [['list'], ['html', { outputFolder: path.join(run, 'report'), open: 'never' }]],
  use: { browserName: 'chromium', viewport: { width: 1280, height: 900 }, trace: 'retain-on-failure', screenshot: 'only-on-failure' },
});
