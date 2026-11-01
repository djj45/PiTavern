import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {stateFields} from '../src/stdata/replies.ts';
import {NARRATIVE_KEY} from '../src/session/narrative.ts';
import {SessionManager} from '../src/session/manager.ts';
import {buildModels} from '../src/providers/models.ts';
import {ChatStore} from '../src/stdata/chats.ts';
import {twoStageFixture,actions,submit} from './two-stage-fixture.ts';
const f=await twoStageFixture();f.config.twoStage=true;let checks=0;const check=(s:string)=>{checks++;console.log('✓ '+s)};
const request=(id:string,instruction='缩短并增加对白')=>{const e=f.sessions.snapshot(id)!.rewrite!;assert.equal(e.enabled,true,e.reason ?? "rewrite enabled");return {chatId:id,messageId:e.messageId!,candidate:e.candidate!,revision:e.revision,requestId:randomUUID(),instruction};};
try{
 const preset=path.join(f.data,'OpenAI Settings/context.json');fs.writeFileSync(preset,JSON.stringify({...JSON.parse(fs.readFileSync(preset,'utf8')),temperature:0.27,openai_max_tokens:700,top_p:0.8}));
 for(const mode of ['simple','bridge','takeover'] as const){
  f.config.contextMode=mode;const chat=f.chat();f.plan(mode+' initial',[{calls:actions},{calls:[submit]},{text:'原正文，旅人买剑并获知线索。'}]);const initialRevision=f.chats.revisionId(chat.id),sendRequest={requestId:randomUUID(),revision:initialRevision};await f.sessions.send(chat.id,'买剑并询问',undefined,sendRequest);const before=stateFields(f.chats.readMetadata(chat.id)),old=f.chats.readChat(chat.id)!.at(-1)!,packet=old.extra![NARRATIVE_KEY];
  const count=f.requests.length;await f.sessions.send(chat.id,'买剑并询问',undefined,sendRequest);assert.equal(f.requests.length,count);assert.equal(f.chats.readChat(chat.id)!.filter(l=>l.is_user).length,1);check(mode+'：发送成功后同ID重放无请求、无重复回合');
  let lastRequest=request(chat.id);
  for(let i=0;i<3;i++){
   lastRequest=request(chat.id,'写作方向'+i);f.plan(mode+' rewrite '+i,[{text:'新文字候选'+i,inspect:body=>{assert.ok(!body.tools?.length);if(mode==='bridge'){assert.equal(body.temperature,0.27);assert.equal(body.max_tokens,700);assert.equal(body.top_p,0.8);}assert.ok(JSON.stringify(body).includes('displayNames'));assert.ok(JSON.stringify(body).includes('长剑'));assert.ok(!JSON.stringify(body).includes(f.raw.facts[1].description));assert.ok(!JSON.stringify(body).includes(f.raw.interactions[0].description));assert.ok(JSON.stringify(body).includes('写作方向'+i));}}]);await f.sessions.rewrite(lastRequest);assert.equal(f.count(),1);assert.deepEqual(stateFields(f.chats.readMetadata(chat.id)),before);assert.deepEqual(f.chats.readChat(chat.id)!.at(-1)!.extra![NARRATIVE_KEY],packet);
  }
  assert.equal(f.sessions.snapshot(chat.id)!.replyChoices!.count,4);assert.equal(f.sessions.snapshot(chat.id)!.rewrite!.enabled,true);const run=f.sessions.activityPage(chat.id).records[0];assert.equal(run.kind,'rewrite');assert.equal(run.tools.length,0);assert.equal(run.usage.responses,1);check(mode+'：连续三次只写正文，余额/库存/时间/知识/变量/计时/事件/结算ID不变，保留4个候选');
  const after=f.chats.revisionId(chat.id),n=f.requests.length;assert.equal((await f.sessions.rewrite(lastRequest)).replayed,true);assert.equal(f.requests.length,n);assert.equal(f.chats.revisionId(chat.id),after);await assert.rejects(()=>f.sessions.rewrite({...lastRequest,instruction:'不同内容复用ID'}),/请求 ID/);
  const restarted=new SessionManager(f.config,()=>buildModels(f.config),f.cards,new ChatStore(f.data),f.data);assert.equal((await restarted.rewrite(lastRequest)).replayed,true);assert.equal(f.requests.length,n);check(mode+'：重复提交与重启后响应丢失重放均幂等，ID冲突拒绝');
  const user=f.chats.readChat(chat.id)!.find(l=>l.is_user)!;f.chats.selectReply(chat.id,String(user.extra!.messageId),0,f.chats.revisionId(chat.id));assert.equal(f.chats.readChat(chat.id)!.at(-1)!.mes,old.mes);assert.deepEqual(stateFields(f.chats.readMetadata(chat.id)),before);assert.equal(f.sessions.snapshot(chat.id)!.rewrite!.enabled,true);f.chats.selectReply(chat.id,String(user.extra!.messageId),3,f.chats.revisionId(chat.id));check(mode+'：往返文字候选恢复原正文且不执行工具/结算');
  for(const step of [{failure:true},{text:'  '},{calls:[actions[0]]}]){const req=request(chat.id),source=f.chats.readSource(chat.id).source;f.plan(mode+' failed rewrite',[step]);await assert.rejects(()=>f.sessions.rewrite(req));assert.equal(f.chats.readSource(chat.id).source,source);assert.deepEqual(stateFields(f.chats.readMetadata(chat.id)),before);}
  const req=request(chat.id),source=f.chats.readSource(chat.id).source;f.plan(mode+' aborted rewrite',[{pause:true}]);const ready=f.waitPaused(),pending=f.sessions.rewrite(req);await ready;await assert.rejects(()=>f.sessions.rewrite(req),/生成中/);f.sessions.abort(chat.id);await assert.rejects(()=>pending,/停止/);assert.equal(f.chats.readSource(chat.id).source,source);check(mode+'：重写失败/空白/越权工具/停止保留字节一致正文与候选选择，双击被拒绝');
  const latest=f.chats.readChat(chat.id)!.at(-1)!;f.plan(mode+' regenerate',[{calls:actions},{calls:[submit]},{text:'重新结算候选'}]);const regeneration={requestId:randomUUID(),revision:f.chats.revisionId(chat.id)};await f.sessions.regenerate(chat.id,String(latest.extra!.messageId),latest.mes,undefined,regeneration);assert.equal(f.chats.readWorld(chat.id)!.snapshot.money.player,83);assert.equal(f.chats.readWorld(chat.id)!.snapshot.clockMinutes,10);assert.notDeepEqual(f.chats.readChat(chat.id)!.at(-1)!.extra![NARRATIVE_KEY],packet);const num=f.requests.length;await f.sessions.regenerate(chat.id,String(latest.extra!.messageId),latest.mes,undefined,regeneration);assert.equal(f.requests.length,num);check(mode+'：重新生成仍从回合前100结算到83，独立结算ID且请求幂等');
 }
 const old=f.chats.createChat('掌柜',{name:'掌柜',is_user:false,is_system:false,mes:'旧正文'});assert.equal(f.sessions.snapshot(old.id)!.rewrite!.enabled,false);
 const chat=f.chat();f.plan('edit qualification',[{calls:[submit]},{text:'正文'}]);await f.sessions.send(chat.id,'问路');const reply=f.chats.readChat(chat.id)!.at(-1)!;f.chats.editMessage(chat.id,String(reply.extra!.messageId),'手动改正文',reply.mes);assert.equal(f.sessions.snapshot(chat.id)!.rewrite!.enabled,false);check('旧聊天无包与手工编辑禁用重写，不从正文猜测结算');
 assert.deepEqual(f.problems,[]);
}finally{await f.close();}
console.log(`${checks} 组正文重写检查通过：${f.run}`);
