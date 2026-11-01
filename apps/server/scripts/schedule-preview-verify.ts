import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import {once} from "node:events";
import type {AddressInfo} from "node:net";
import {createHttpApp} from "../src/api/http.ts";
import {twoStageFixture} from "./two-stage-fixture.ts";
const raw=JSON.parse(fs.readFileSync(new URL('./fixtures/schedule-tavern.json',import.meta.url),'utf8'));
const f=await twoStageFixture(raw),chat=f.chat();
const server=http.createServer(createHttpApp({config:f.config,modelsRef:{current:f.models},characters:f.cards,chats:f.chats,sessions:f.sessions,stDataDir:f.data,webDistDir:null}));
server.listen(0,'127.0.0.1');await once(server,'listening');const base=`http://127.0.0.1:${(server.address() as AddressInfo).port}`;
const preview=(fromMinute=0,minutes=30,template=f.raw)=>fetch(base+'/api/world/schedule-preview',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({template,fromMinute,minutes})});
let checks=0;const check=(s:string)=>{checks++;console.log('✓ '+s);};
try{
 const source=f.chats.readSource(chat.id).source,library=JSON.stringify(f.sessions.worldTemplateLibrary.list());
 const first=await preview();assert.equal(first.ok,true);const result:any=await first.json();assert.deepEqual(result.events.map((e:any)=>e.worldTimeMinutes),[10,30]);assert.equal(result.questViewsChanged,true);assert.equal(result.snapshot.actors.innkeeper.locationId,'tavern');
 const at10:any=await(await preview(10,20)).json();assert.equal(at10.events.length,1);assert.equal(at10.events[0].skipReason,'already_there');assert.equal(at10.snapshot.scheduleStates[0].activatedAt,10);check('独立作者HTTP模拟按实际纯规则执行，启用当刻不补跑');
 const over=await preview(0,184330);assert.equal(over.ok,false);assert.ok(JSON.stringify(await over.json()).includes('缩短等待'));assert.equal(f.chats.readSource(chat.id).source,source);assert.equal(JSON.stringify(f.sessions.worldTemplateLibrary.list()),library);assert.equal(f.requests.length,0);check('模拟预算拒绝、成功预览均不写聊天/草稿或调用模型');
 for(const value of [-1,0.5,525600000])assert.equal((await preview(value,30)).ok,false);
 const broken=structuredClone(f.raw);broken.schedules[0].points[1].minuteOfDay=10;assert.equal((await preview(0,30,broken)).ok,false);check('HTTP预览严格拒绝非法分钟、溢出和重复点');
 const state=f.chats.readWorld(chat.id)!.snapshot,changed=structuredClone(state);changed.clockMinutes=10;changed.scheduleStates![0].processedThrough=10;changed.scheduleStates![0].lastOccurrenceAt=10;
 assert.throws(()=>f.chats.correctWorld(chat.id,changed,f.chats.revisionId(chat.id)),/advance_time/);assert.equal(f.chats.readSource(chat.id).source,source);
 const dead=structuredClone(state);dead.actors.innkeeper.status='dead';f.chats.correctWorld(chat.id,dead,f.chats.revisionId(chat.id));assert.equal(f.chats.readWorld(chat.id)!.snapshot.clockMinutes,0);assert.equal(f.chats.readWorld(chat.id)!.snapshot.actors.innkeeper.status,'dead');check('v4禁止手工绕过时钟/进度；仍可修正NPC状态，不执行日程');
 const publicState=JSON.stringify(await(await fetch(base+'/api/chats/'+encodeURIComponent(chat.id))).json());for(const secret of ['"schedules"','"scheduleStates"','innkeeper_daily','作者日程备注'])assert.ok(!publicState.includes(secret));check('作者模拟独立于默认玩家出口，未泄漏时间表');
}finally{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));await f.close();}
console.log(`${checks} 组日程作者预览检查通过：${f.run}`);
