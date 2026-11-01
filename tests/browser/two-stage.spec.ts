import { test as base, expect, type Page } from '@playwright/test';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';

const test = base.extend<{ app: { baseURL: string; runDir: string } }>({
  app: async ({}, use, info) => {
    const runDir = fs.mkdtempSync(path.join(process.env.PITAVERN_BROWSER_RUN!, `fixture-${info.workerIndex}-`));
    const child = spawn(process.execPath, ['--import', 'tsx', 'apps/server/scripts/browser-fixture.ts'], { cwd: process.cwd(), env: { ...process.env, PITAVERN_BROWSER_FIXTURE: runDir, PITAVERN_BROWSER_TWO_STAGE: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
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

async function seed(request:import('@playwright/test').APIRequestContext,baseURL:string){
 const blank=await(await request.post(baseURL+'/api/world/template-library',{data:{action:'blank',name:'双阶段酒馆'}})).json();
 const template=JSON.parse(fs.readFileSync(path.resolve('apps/server/scripts/fixtures/knowledge-tavern.json'),'utf8'));template.templateId=blank.id;
 const route=baseURL+'/api/world/template-library/'+encodeURIComponent(blank.id),saved=await(await request.put(route,{data:{revision:blank.draftRevision,name:'双阶段酒馆',template}})).json(),published=await(await request.post(route+'/publish',{data:{revision:saved.draftRevision}})).json();
 expect((await request.put(baseURL+'/api/connection',{data:{twoStage:true,renderRetries:0,contextMode:'simple',toolsEnabled:true,outputProtocol:'native'}})).ok()).toBeTruthy();
 return (await(await request.post(baseURL+'/api/chats',{data:{character:'浏览器向导',worldTemplateHash:published.publishedHash,greeting:''}})).json()).id as string;
}
async function open(page:Page,url:string){await page.goto(url);await expect(page.getByText('在线',{exact:true})).toBeVisible();if((page.viewportSize()?.width??1280)<768&&await page.getByRole('button',{name:'菜单',exact:true}).isVisible())await page.getByRole('button',{name:'菜单',exact:true}).click();await page.locator('aside li').first().getByRole('button').first().click();}

test('双阶段结算/正文状态、三次重写和重新生成，实际请求隔离工具与秘密',async({page,request,app})=>{
 const id=await seed(request,app.baseURL);await open(page,app.baseURL);
 const rewrite=page.getByRole('button',{name:'只重写正文',exact:true});await expect(rewrite).toBeDisabled();
 await page.getByLabel('消息输入').fill('双阶段计时买剑并询问掌柜');await page.getByLabel('消息输入').press('Enter');await expect(page.getByText('正在结算',{exact:true})).toBeVisible();await expect(page.getByText('正在生成正文',{exact:true})).toBeVisible();await expect(rewrite).toBeEnabled();
 const state=async()=> (await(await request.get(app.baseURL+'/api/chats/'+id)).json()).world.snapshot;
 const before=await state();expect(before.money.player).toBe(83);expect(before.clockMinutes).toBe(10);
 for(let i=0;i<3;i++){await rewrite.click();const dialog=page.getByRole('dialog',{name:'只重写正文',exact:true});await expect(dialog).toContainText('不执行工具');await dialog.getByLabel('本次写作要求').fill('增加对白'+i);await dialog.getByRole('button',{name:'新增文字候选'}).click();await expect(dialog).toHaveCount(0);await expect(rewrite).toBeEnabled();expect(await state()).toEqual(before);}
 let snapshot=await(await request.get(app.baseURL+'/api/chats/'+id)).json();expect(snapshot.replyChoices.count).toBe(4);expect(snapshot.activity.records[0].kind).toBe('rewrite');expect(snapshot.activity.records[0].tools).toHaveLength(0);
 await page.getByRole('button',{name:'重新生成回复',exact:true}).click();await expect(rewrite).toBeEnabled();snapshot=await(await request.get(app.baseURL+'/api/chats/'+id)).json();expect(snapshot.replyChoices.count).toBe(5);expect(snapshot.world.snapshot.money.player).toBe(83);
 const requests=fs.readFileSync(path.join(app.runDir,'requests.ndjson'),'utf8').trim().split('\n').map(s=>JSON.parse(s));const renders=requests.filter(r=>r.messages?.some((m:{content?:unknown})=>(typeof m.content==='string'?m.content:Array.isArray(m.content)?m.content.filter((c:{type:string})=>c.type==='text').map((c:{text:string})=>c.text).join(''):'').startsWith('{"protocol":"pitavern-narrative-v1"')));expect(renders).toHaveLength(5);for(const body of renders){expect(body.tools??[]).toHaveLength(0);expect(JSON.stringify(body)).not.toContain('暗扣密码灰蓝七星');expect(JSON.stringify(body)).not.toContain('内部条件：');}
});

test('390px 两种操作文案清晰、重写可停止且没有横向溢出',async({page,request,app})=>{
 await page.setViewportSize({width:390,height:844});const id=await seed(request,app.baseURL);await open(page,app.baseURL);const nav=page.getByRole('button',{name:'关闭侧栏',exact:true});if(await nav.isVisible())await nav.click();
 await page.getByLabel('消息输入').fill('双阶段计时买剑');await page.getByLabel('消息输入').press('Enter');const rewrite=page.getByRole('button',{name:'只重写正文',exact:true});await expect(rewrite).toBeEnabled();
 await expect(page.getByRole('button',{name:'重新生成回复',exact:true})).toContainText('重新生成');expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBe(true);
 const before=await(await request.get(app.baseURL+'/api/chats/'+id)).json();await rewrite.click();const dialog=page.getByRole('dialog',{name:'只重写正文',exact:true});await dialog.getByLabel('本次写作要求').fill('双阶段计时更简洁');await dialog.getByRole('button',{name:'新增文字候选'}).click();await dialog.getByRole('button',{name:'停止',exact:true}).click();await expect(dialog.getByRole('button',{name:'新增文字候选'})).toBeVisible();await dialog.getByRole('button',{name:'关闭',exact:true}).click();const after=await(await request.get(app.baseURL+'/api/chats/'+id)).json();expect(after.world.snapshot).toEqual(before.world.snapshot);expect(after.messages).toEqual(before.messages);expect(after.replyChoices).toEqual(before.replyChoices);await page.screenshot({path:path.join(app.runDir,'two-stage-390.png'),fullPage:true});
});

test('默认关闭双阶段，设置开关与正文重试可保存，旧正文禁用重写',async({page,app,request})=>{
 await open(page,app.baseURL);expect((await(await request.get(app.baseURL+'/api/connection')).json()).twoStage).toBe(false);await expect(page.getByRole('button',{name:'只重写正文',exact:true})).toBeDisabled();await page.getByRole('button',{name:'设置',exact:true}).click();const checkbox=page.getByRole('checkbox',{name:'可选双阶段生成',exact:true});await expect(checkbox).not.toBeChecked();await checkbox.check();await page.getByLabel('正文请求失败重试次数').selectOption('1');await expect.poll(async()=>{const c=await(await request.get(app.baseURL+'/api/connection')).json();return [c.twoStage,c.renderRetries];}).toEqual([true,1]);
});
