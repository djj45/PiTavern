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
 const blank=await(await request.post(baseURL+'/api/world/template-library',{data:{action:'blank',name:'任务酒馆'}})).json();
 const template=JSON.parse(fs.readFileSync(path.resolve('apps/server/scripts/fixtures/quest-tavern.json'),'utf8'));template.templateId=blank.id;
 if(legacy){template.schemaVersion=2;delete template.quests;delete template.initial.actorMoney;}else template.quests[1].openConditions=[{type:'has_item',itemId:'sword',quantity:99}];
 const route=baseURL+'/api/world/template-library/'+encodeURIComponent(blank.id),saved=await(await request.put(route,{data:{revision:blank.draftRevision,name:'任务酒馆',template}})).json(),published=await(await request.post(route+'/publish',{data:{revision:saved.draftRevision}})).json();
 await request.put(baseURL+'/api/connection',{data:{twoStage:true,contextMode:'simple',toolsEnabled:true,outputProtocol:'native'}});
 return {id:blank.id,published,route};
}
async function open(page:Page,url:string){await page.goto(url);await expect(page.getByText('在线',{exact:true})).toBeVisible();if((page.viewportSize()?.width??1280)<768&&await page.getByRole('button',{name:'菜单',exact:true}).isVisible())await page.getByRole('button',{name:'菜单',exact:true}).click();await page.locator('aside li').first().getByRole('button').first().click();}

test('作者从v2显式启用v3，配置条件/交付/来源奖励、预览并发布；390px可操作',async({page,request,app})=>{
 const seeded=await seed(request,app.baseURL,true);await open(page,app.baseURL);await page.getByRole('button',{name:'世界模板',exact:true}).click();
 const dialog=page.getByRole('dialog',{name:/世界模板/});await dialog.getByRole('button',{name:'编辑模板 任务酒馆',exact:true}).click();await dialog.getByRole('button',{name:'启用任务规则（v3）',exact:true}).click();
 const editor=dialog.getByLabel('任务规则');await editor.getByLabel('掌柜 初始资金',{exact:true}).fill('100');await editor.getByRole('button',{name:'添加任务',exact:true}).click();await editor.getByLabel('任务 1 名称',{exact:true}).fill('调查密道并交付长剑');await editor.getByLabel('任务 1 阶段 1 目标',{exact:true}).fill('调查掌柜知道的线索');
 await editor.getByRole('button',{name:'添加任务 1 阶段 1条件',exact:true}).click();await editor.getByLabel('任务 1 阶段 1 条件 1 类型',{exact:true}).selectOption('knows_fact');await editor.getByLabel('任务 1 阶段 1 条件 1 事实',{exact:true}).selectOption('hidden_fireplace_passage');
 await editor.getByRole('button',{name:'添加任务 1 阶段',exact:true}).click();await editor.getByLabel('任务 1 阶段 2 目标',{exact:true}).fill('交付一把长剑');await editor.getByLabel('任务 1 最终交付',{exact:true}).check();await editor.getByLabel('任务 1 交付物品',{exact:true}).selectOption('sword');await editor.getByLabel('任务 1 奖励金币',{exact:true}).fill('30');
 const preview=dialog.getByLabel('知识视角预览');await preview.getByRole('button',{name:'刷新视角预览'}).click();await expect(preview.getByLabel('玩家任务日志')).toContainText('调查掌柜知道的线索');await expect(preview.getByLabel('玩家任务日志')).not.toContainText('交付一把长剑');
 await preview.getByLabel('知识预览视角').selectOption('actor:innkeeper');await preview.getByRole('button',{name:'刷新视角预览'}).click();await expect(preview.getByLabel('玩家任务日志')).toContainText('当前没有可见任务');
 await dialog.getByRole('button',{name:'保存草稿',exact:true}).click();await expect(dialog.getByRole('status')).toContainText('草稿已保存');await dialog.getByRole('button',{name:'发布模板',exact:true}).click();await expect(dialog.getByRole('status')).toContainText('已发布版本');
 const saved=await(await request.get(seeded.route)).json();expect(saved.draft.schemaVersion).toBe(3);expect(saved.draft.quests[0].reward.money).toBe(30);expect(saved.draft.quests[0].stages[1].delivery).toEqual({toActorId:'innkeeper',itemId:'sword',quantity:1});
 await page.setViewportSize({width:390,height:844});await editor.getByLabel('任务 1 奖励金币',{exact:true}).scrollIntoViewIfNeeded();expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBe(true);await page.screenshot({path:path.join(app.runDir,'quest-editor-390.png'),fullPage:true});
});

test('任务日志跟随真实结算和分支立即刷新，查询只读；390px隐藏任务不显示',async({page,request,app})=>{
 await page.setViewportSize({width:390,height:844});const seeded=await seed(request,app.baseURL);const id=(await(await request.post(app.baseURL+'/api/chats',{data:{character:'浏览器向导',worldTemplateHash:seeded.published.publishedHash,greeting:''}})).json()).id;
 await open(page,app.baseURL);if(await page.getByRole('button',{name:'关闭侧栏',exact:true}).isVisible())await page.getByRole('button',{name:'关闭侧栏',exact:true}).click();
 const snapshot=async()=>(await(await request.get(app.baseURL+'/api/chats/'+id)).json());const openWorld=async()=>{await page.getByRole('button',{name:'打开世界状态',exact:true}).click();return page.getByRole('dialog',{name:'世界状态',exact:true});};
 const original=(await snapshot()).world.snapshot;let dialog=await openWorld();await expect(dialog.getByLabel('玩家任务日志')).toContainText('可接取');await expect(dialog).not.toContainText('绝密未开放任务');expect((await snapshot()).world.snapshot).toEqual(original);await dialog.getByRole('button',{name:'关闭',exact:true}).click();
 const send=async(text:string)=>{await page.getByLabel('消息输入').fill(text);await page.getByLabel('消息输入').press('Enter');await expect(page.getByRole('button',{name:'只重写正文',exact:true})).toBeEnabled();};
 await send('任务调查');dialog=await openWorld();await expect(dialog.getByLabel('玩家任务日志')).toContainText('进行中');await expect(dialog.getByLabel('玩家任务日志')).toContainText('回酒馆向掌柜交付一把长剑');expect((await snapshot()).world.snapshot.money.player).toBe(83);await dialog.getByRole('button',{name:'关闭',exact:true}).click();
 await send('任务交付');dialog=await openWorld();await expect(dialog.getByLabel('玩家任务日志')).toContainText('已完成');expect((await snapshot()).world.snapshot.money.player).toBe(113);await expect(dialog).not.toContainText('绝密未开放任务');expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBe(true);await page.screenshot({path:path.join(app.runDir,'quest-log-390.png'),fullPage:true});await dialog.getByRole('button',{name:'关闭',exact:true}).click();
 const reply=(await snapshot()).messages.at(-1);
 await page.evaluate(({id,reply})=>new Promise<void>((resolve,reject)=>{const ws=new WebSocket(location.origin.replace('http','ws')+'/ws');const timer=setTimeout(()=>{ws.close();reject(new Error('regenerate timeout'));},15000);ws.onopen=()=>ws.send(JSON.stringify({type:'chat.regenerate',chatId:id,messageId:reply.id,expectedText:reply.text,instruction:'任务不交付'}));ws.onmessage=e=>{const event=JSON.parse(e.data);if(event.chatId!==id)return;if(event.type==='chat.error'){clearTimeout(timer);ws.close();reject(new Error(event.message));}if(event.type==='chat.snapshot'&&!event.snapshot.running){clearTimeout(timer);ws.close();resolve();}};}),{id,reply});
 await expect(page.getByRole('button',{name:'只重写正文',exact:true})).toBeEnabled();expect((await snapshot()).world.snapshot.money.player).toBe(83);
 dialog=await openWorld();await expect(dialog.getByLabel('玩家任务日志')).toContainText('进行中');
 const user=(await snapshot()).messages.filter((m:{role:string})=>m.role==='user').at(-1);
 const select=async(selected:number)=>{const current=await snapshot();expect((await request.post(app.baseURL+'/api/chat/reply',{data:{chatId:id,userMessageId:user.id,selected,revision:current.page.revision}})).ok()).toBeTruthy();};
 await select(0);await expect(dialog.getByLabel('玩家任务日志')).toContainText('已完成');expect((await snapshot()).world.snapshot.money.player).toBe(113);
 await select(1);await expect(dialog.getByLabel('玩家任务日志')).toContainText('进行中');expect((await snapshot()).world.snapshot.money.player).toBe(83);
});
