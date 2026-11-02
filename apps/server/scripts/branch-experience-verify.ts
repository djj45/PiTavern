import assert from "node:assert/strict";
import { buildBranchIndex } from "../src/stdata/branch-index.ts";
import { branchPoints, selectedMessages, turnReplies } from "../src/stdata/replies.ts";
import type { StChatLine } from "../src/stdata/types.ts";

const first = "2026-11-01T12:00:00.000Z", second = "2026-11-01T12:01:00.000Z";
const message = (mes: string, send_date: string): StChatLine => ({name:"向导",mes,send_date,is_user:false,is_system:false});
const catalog = {selected:1,versions:[{messages:[message("第一条路线：留在公所",first)]},{messages:[message("第二条路线：去往灯塔",second)]}]};
const user: StChatLine = {name:"玩家",mes:"接下来呢",send_date:first,is_user:true,is_system:false,extra:{messageId:"turn-one",_pitavernReplies:catalog}};
const lines = [user,...selectedMessages(catalog)];
const source = [{chat_metadata:{}},...lines].map(l => JSON.stringify(l)).join("\n");
const index = buildBranchIndex(source,"test");
assert.deepEqual(index.nodes.map(n => n.title), ["第 1 轮 · 候选 1/2", "第 1 轮 · 候选 2/2"]);
assert.deepEqual(index.nodes.map(n => n.generatedAt), [first,second]);
assert.deepEqual(index.nodes.map(n => n.assistantPreview), ["第一条路线：留在公所","第二条路线：去往灯塔"]);
assert.equal(index.nodes[1].isCurrent,true);
assert.equal(index.nodes[0].isActive,false);
assert.deepEqual(branchPoints(lines)[0].candidates.map(c => c.generatedAt),[first,second]);
console.log("✓ 目录和活动分叉点按回合/候选定位，正文摘要及各自原始时间正确，当前路线不混淆");

const native = structuredClone(lines[1]); delete user.extra!._pitavernReplies;
const imported = turnReplies([user,native],{},0).catalog;
assert.deepEqual(imported.versions.map(v => v.messages[0].send_date),[first,second]);
assert.deepEqual(selectedMessages(imported)[0].swipe_info?.map(s => s.send_date),[first,second]);
console.log("✓ 原生swipe与JSONL往返保存每个候选自己的时间，不套用选中候选时间");

delete native.swipe_info;
const oldLines = [user,native];
const oldIndex = buildBranchIndex([{chat_metadata:{}},...oldLines].map(l=>JSON.stringify(l)).join("\n"),"legacy");
assert.equal(oldIndex.nodes[0].generatedAt,undefined);
assert.equal(oldIndex.nodes[1].generatedAt,second);
assert.deepEqual(branchPoints(oldLines)[0].candidates.map(c=>c.generatedAt),[undefined,second]);
assert.equal(turnReplies(oldLines,{},0).catalog.versions[0].messages[0].send_date,"");
console.log("✓ 缺少旧候选时间保持未知，读取不以打开/重启或当前候选时间补造");

native.send_date = "未知旧时间";
assert.ok(buildBranchIndex([{chat_metadata:{}},user,native].map(l=>JSON.stringify(l)).join("\n"),"old").nodes.every(n=>!n.generatedAt));
console.log("✓ 无效旧时间按未记录兼容，不阻断目录或分支恢复");
console.log("4 组分支体验检查通过");
