import assert from "node:assert/strict";
import { generationFailure } from "../src/session/failure.ts";
import { stateFields } from "../src/stdata/replies.ts";
import { SessionManager } from "../src/session/manager.ts";
import { ChatStore } from "../src/stdata/chats.ts";
import { buildModels } from "../src/providers/models.ts";
import { twoStageFixture, submit } from "./two-stage-fixture.ts";

let checks = 0;
const check = (name: string) => { checks++; console.log("✓ " + name); };
const privateText = "私有剧情和密钥标记-DO-NOT-EXPOSE";
for (const message of ["模型输出为空，请降低思考强度", "empty response", "掌柜 未返回正文"]) {
  const result = generationFailure(new Error(message + privateText));
  assert.equal(result.code, "output"); assert.ok(result.publicMessage.includes("模型未返回可用正文"));
  assert.ok(!result.publicMessage.includes(privateText));
}
check("空正文错误归类为output，只输出固定解释，不回显供应商原文");
const malformed = generationFailure(new Error("Stream ended without finish_reason " + privateText));
assert.equal(malformed.code, "provider"); assert.ok(malformed.publicMessage.includes("缺少完成标记"));
assert.ok(!malformed.publicMessage.includes(privateText));
assert.equal(generationFailure(new Error(privateText)).publicMessage, "本轮生成未完成，世界与知识未提交。");
check("缺少流完成标记可诊断，未知错误仍保守隐藏");

const f = await twoStageFixture();
try {
  f.config.contextMode = "takeover";
  for (const dual of [false, true]) {
    f.config.twoStage = dual;
    const chat = f.chat(), before = stateFields(f.chats.readMetadata(chat.id));
    const events: unknown[] = [];
    const unsubscribe = f.sessions.onEvent(e => events.push(e));
    f.plan("projection then upstream empty " + dual, [
      { calls: [{ name: "tavern_set_state", args: { state: "不得提交的暂存投影" } }] },
      ...(dual ? [{ calls: [submit] }] : []),
      { streamFailure: "模型输出为空，请降低思考强度，并检查是否含有过多敏感内容。" + privateText },
    ]);
    await f.sessions.send(chat.id, "询问公开值夜安排"); unsubscribe();
    const record = f.sessions.activityPage(chat.id).records[0];
    assert.equal(record.status, "failed"); assert.equal(record.failureCode, "output");
    assert.equal(record.tools[0].toolName, "tavern_set_state"); assert.equal(record.tools[0].status, "done");
    assert.ok(record.error?.includes("模型未返回可用正文"));
    assert.deepEqual(stateFields(f.chats.readMetadata(chat.id)), before);
    assert.ok(!JSON.stringify(events).includes(privateText));
    assert.ok(!JSON.stringify(events).includes("过多敏感内容"));
    assert.ok(JSON.stringify(events).includes("模型未返回可用正文"));
    assert.equal(f.chats.readChat(chat.id)!.filter(line => !line.is_user && !line.is_system).length, 0);
    check((dual ? "双阶段" : "单阶段") + "：投影成功后仅思考+上游错误，正文/投影/世界全部不提交，事件返回安全错误");
    const restarted = new SessionManager(f.config, () => buildModels(f.config), f.cards, new ChatStore(f.data), f.data);
    const persisted = restarted.activityPage(chat.id).records[0];
    assert.equal(persisted.error, record.error); assert.equal(persisted.failureCode, "output");
    assert.equal(persisted.usage.responses, dual ? 3 : 2);
    check((dual ? "双阶段" : "单阶段") + "：重启仍保留原因和响应计数，没有补写正文或自动重试");
  }
  const blank = f.chat(); f.config.twoStage = false;
  f.plan("blank without provider error", [{ text: " " }]); await f.sessions.send(blank.id, "问路");
  assert.equal(f.sessions.activityPage(blank.id).records[0].failureCode, "output");
  assert.ok(f.sessions.activityPage(blank.id).records[0].error?.includes("模型未返回可用正文"));
  check("正常结束但正文空白也保留可诊断原因");
  assert.deepEqual(f.problems, []);
} finally { await f.close(); }
console.log(`${checks} 组生成失败诊断检查通过：${f.run}`);
