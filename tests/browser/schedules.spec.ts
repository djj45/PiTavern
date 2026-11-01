import { test as base, expect, type Page } from '@playwright/test';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';

const test = base.extend<{ app: { baseURL: string; runDir: string } }>({
  app: async ({}, use, info) => {
    const runDir = fs.mkdtempSync(path.join(process.env.PITAVERN_BROWSER_RUN!, `fixture-${info.workerIndex}-`));
    const child = spawn(process.execPath, ['--import', 'tsx', 'apps/server/scripts/browser-fixture.ts'], { cwd: process.cwd(), env: { ...process.env, PITAVERN_BROWSER_FIXTURE: runDir, PITAVERN_BROWSER_TWO_STAGE: '1', PITAVERN_BROWSER_QUESTS: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
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

async function seed(request:import('@playwright/test').APIRequestContext,baseURL:string,legacy=false){
 const blank=await(await request.post(baseURL+'/api/world/template-library',{data:{action:'blank',name:'日程酒馆'}})).json();
 const template=JSON.parse(fs.readFileSync(path.resolve('apps/server/scripts/fixtures/schedule-tavern.json'),'utf8'));template.templateId=blank.id;
 if(legacy){template.schemaVersion=3;delete template.schedules;}else template.quests[1].openConditions=[{type:'has_item',itemId:'sword',quantity:99}];
 const route=baseURL+'/api/world/template-library/'+encodeURIComponent(blank.id),saved=await(await request.put(route,{data:{revision:blank.draftRevision,name:'日程酒馆',template}})).json(),published=await(await request.post(route+'/publish',{data:{revision:saved.draftRevision}})).json();
 await request.put(baseURL+'/api/connection',{data:{twoStage:true,contextMode:'simple',toolsEnabled:true,outputProtocol:'native'}});
 return {id:blank.id,published,route};
}
async function open(page:Page,url:string){await page.goto(url);await expect(page.getByText('在线',{exact:true})).toBeVisible();if((page.viewportSize()?.width??1280)<768&&await page.getByRole('button',{name:'菜单',exact:true}).isVisible())await page.getByRole('button',{name:'菜单',exact:true}).click();await page.locator('aside li').first().getByRole('button').first().click();}

test('作者从v3启用v4，编辑每日点、验证重复与预算、只读模拟并发布；390px',async({page,request,app})=>{
 const seeded=await seed(request,app.baseURL,true);await open(page,app.baseURL);await page.getByRole('button',{name:'世界模板',exact:true}).click();
 const dialog=page.getByRole('dialog',{name:/世界模板/});await dialog.getByRole('button',{name:'编辑模板 日程酒馆',exact:true}).click();
 await dialog.getByRole('button',{name:'启用日程规则（v4）',exact:true}).click();await expect(dialog.getByRole('button',{name:'启用任务规则（v3）',exact:true})).toHaveCount(0);
 const editor=dialog.getByLabel('NPC日程规则');await editor.getByRole('button',{name:'添加NPC日程',exact:true}).click();await editor.getByLabel('日程 1 ID',{exact:true}).fill('innkeeper_daily');await editor.getByLabel('日程 1 NPC',{exact:true}).selectOption('innkeeper');await editor.getByLabel('日程 1 内部备注',{exact:true}).fill('作者日程备注，不进入玩家请求');
 await editor.getByLabel('日程 1 时间点 1 时间',{exact:true}).fill('00:10');await editor.getByLabel('日程 1 时间点 1 地点',{exact:true}).selectOption('square');await editor.getByRole('button',{name:'添加日程 1 时间点',exact:true}).click();
 await editor.getByLabel('日程 1 时间点 2 时间',{exact:true}).fill('00:10');await editor.getByRole('button',{name:'模拟日程推进',exact:true}).click();await expect(editor.getByRole('alert')).toContainText('不能重复');
 await editor.getByLabel('日程 1 时间点 2 时间',{exact:true}).fill('00:30');await editor.getByLabel('日程 1 时间点 2 地点',{exact:true}).selectOption('tavern');
 const before=await(await request.get(seeded.route)).json();await editor.getByRole('button',{name:'模拟日程推进',exact:true}).click();await expect(editor.getByLabel('日程模拟结果')).toContainText('已消费 2 个时间点');await expect(editor.getByLabel('日程模拟结果')).toContainText('旧酒馆 → 广场');await expect(editor.getByLabel('日程模拟结果')).toContainText('广场 → 旧酒馆');expect(await(await request.get(seeded.route)).json()).toEqual(before);
 await editor.getByLabel('模拟推进分钟',{exact:true}).fill('184330');await editor.getByRole('button',{name:'模拟日程推进',exact:true}).click();await expect(editor.getByRole('alert')).toContainText('缩短等待');await expect(editor.getByLabel('日程模拟结果')).toHaveCount(0);
 await editor.getByLabel('模拟推进分钟',{exact:true}).fill('30');await page.setViewportSize({width:390,height:844});await editor.getByRole('button',{name:'模拟日程推进',exact:true}).click();await expect(editor.getByLabel('日程模拟结果')).toContainText('第1天 00:30');expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBe(true);await page.screenshot({path:path.join(app.runDir,'schedule-editor-390.png'),fullPage:true});
 await dialog.getByRole('button',{name:'保存草稿',exact:true}).click();await expect(dialog.getByRole('status')).toContainText('草稿已保存');await dialog.getByRole('button',{name:'发布模板',exact:true}).click();await expect(dialog.getByRole('status')).toContainText('已发布版本');
 const saved=await(await request.get(seeded.route)).json();expect(saved.draft.schemaVersion).toBe(4);expect(saved.draft.quests.length).toBe(3);expect(saved.draft.initial.actorMoney[0].money).toBe(100);expect(saved.draft.schedules[0].points).toEqual([{minuteOfDay:10,locationId:'square'},{minuteOfDay:30,locationId:'tavern'}]);
});

test('玩家时钟、在场、交付和候选随真实日程刷新，未来时间表不入请求；390px',async({page,request,app})=>{
 await page.setViewportSize({width:390,height:844});const seeded=await seed(request,app.baseURL);const id=(await(await request.post(app.baseURL+'/api/chats',{data:{character:'浏览器向导',worldTemplateHash:seeded.published.publishedHash,greeting:''}})).json()).id;
 await open(page,app.baseURL);if(await page.getByRole('button',{name:'关闭侧栏',exact:true}).isVisible())await page.getByRole('button',{name:'关闭侧栏',exact:true}).click();
 const snapshot=async()=>(await(await request.get(app.baseURL+'/api/chats/'+id)).json());const openWorld=async()=>{await page.getByRole('button',{name:'打开世界状态',exact:true}).click();return page.getByRole('dialog',{name:'世界状态',exact:true});};
 const send=async(text:string)=>{const before=(await snapshot()).messages.length;await page.getByLabel('消息输入').fill(text);await page.getByLabel('消息输入').press('Enter');await expect.poll(async()=>(await snapshot()).messages.length).toBeGreaterThan(before);await expect(page.getByRole('button',{name:'只重写正文',exact:true})).toBeEnabled();};
 const initial=(await snapshot()).world.snapshot;let dialog=await openWorld();await expect(dialog).toContainText('第1天 00:00');await expect(dialog.getByLabel('玩家任务日志')).toContainText('拜访掌柜');expect((await snapshot()).world.snapshot).toEqual(initial);await dialog.getByRole('button',{name:'关闭',exact:true}).click();
 await send('任务调查');expect((await snapshot()).world.snapshot.money.player).toBe(83);
 await send('等待到10');dialog=await openWorld();await expect(dialog).toContainText('第1天 00:10');await expect(dialog.getByLabel('玩家任务日志')).not.toContainText('拜访掌柜');await expect(dialog.getByText('在场',{exact:true}).locator('..')).not.toContainText('掌柜');await expect(dialog.getByLabel('最近世界变化')).toContainText('掌柜从旧酒馆前往广场');await dialog.getByRole('button',{name:'关闭',exact:true}).click();
 await send('日程返回交付');dialog=await openWorld();await expect(dialog).toContainText('第1天 00:30');await expect(dialog.getByLabel('玩家任务日志')).toContainText('已完成');await expect(dialog.getByLabel('玩家任务日志')).toContainText('拜访掌柜');await expect(dialog.getByText('在场',{exact:true}).locator('..')).toContainText('掌柜');expect((await snapshot()).world.snapshot.money.player).toBe(113);await expect(dialog).not.toContainText('innkeeper_daily');expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBe(true);await page.screenshot({path:path.join(app.runDir,'schedule-player-390.png'),fullPage:true});await dialog.getByRole('button',{name:'关闭',exact:true}).click();
 const reply=(await snapshot()).messages.at(-1);
 await page.evaluate(({id,reply})=>new Promise<void>((resolve,reject)=>{const ws=new WebSocket(location.origin.replace('http','ws')+'/ws');const timer=setTimeout(()=>{ws.close();reject(new Error('regenerate timeout'));},15000);ws.onopen=()=>ws.send(JSON.stringify({type:'chat.regenerate',chatId:id,messageId:reply.id,expectedText:reply.text,instruction:'日程不返回'}));ws.onmessage=e=>{const event=JSON.parse(e.data);if(event.chatId!==id)return;if(event.type==='chat.error'){clearTimeout(timer);ws.close();reject(new Error(event.message));}if(event.type==='chat.snapshot'&&!event.snapshot.running){clearTimeout(timer);ws.close();resolve();}};}),{id,reply});
 expect((await snapshot()).world.snapshot.clockMinutes).toBe(10);expect((await snapshot()).world.snapshot.money.player).toBe(83);dialog=await openWorld();await expect(dialog).toContainText('第1天 00:10');
 const user=(await snapshot()).messages.filter((m:{role:string})=>m.role==='user').at(-1);
 for(const selected of [0,1]){const current=await snapshot();expect((await request.post(app.baseURL+'/api/chat/reply',{data:{chatId:id,userMessageId:user.id,selected,revision:current.page.revision}})).ok()).toBeTruthy();await expect(dialog).toContainText(selected===0?'第1天 00:30':'第1天 00:10');expect((await snapshot()).world.snapshot.money.player).toBe(selected===0?113:83);}
 const requests=fs.readFileSync(path.join(app.runDir,'requests.ndjson'),'utf8');for(const secret of ['innkeeper_daily','作者日程备注','scheduleStates','schedules'])expect(requests).not.toContain(secret);
});

