/**
 * M6 确定性验证：世界书计时效果（sticky/cooldown/delay）+ 状态持久化恢复。npm run verify:m6
 */
import assert from "node:assert";
import {
  scanWorldInfo,
  normalizeTimedState,
  emptyTimedState,
  type WiEntry,
  type WiScanOptions,
} from "../src/context/worldinfo.ts";

const baseOpts = (timed?: WiScanOptions["timed"], messageCount?: number): WiScanOptions => ({
  scanDepth: 2,
  recursionSteps: 0,
  caseSensitive: false,
  matchWholeWords: true,
  ...(timed ? { timed } : {}),
  ...(messageCount !== undefined ? { messageCount } : {}),
});

const mkEntry = (patch: Partial<WiEntry>): WiEntry => ({
  uid: "0",
  world: "t",
  key: [],
  keysecondary: [],
  content: "",
  constant: false,
  disabled: false,
  selective: true,
  selectiveLogic: 0,
  order: 100,
  position: 0,
  depth: 4,
  role: "system",
  probability: 100,
  ...patch,
});

// A: 剑（sticky 2 / cooldown 3）；B: 符（delay 4）；C: 丹（对照）
const entries: WiEntry[] = [
  mkEntry({ uid: "a", key: ["剑"], content: "[A 剑气]", sticky: 2, cooldown: 3 }),
  mkEntry({ uid: "b", key: ["符"], content: "[B 符光]", delay: 4 }),
  mkEntry({ uid: "c", key: ["丹"], content: "[C 丹香]" }),
];

const activatedIds = (result: ReturnType<typeof scanWorldInfo>) =>
  result.activated.map((e) => e.uid).sort().join(",");

// ---- 1. delay：前 N 条消息内压制
{
  const state = emptyTimedState();
  let r = scanWorldInfo(entries, ["我画了一张符"], baseOpts(state, 3));
  assert.ok(!r.activated.some((e) => e.uid === "b"), "delay=4：第 3 条消息时符不激活");
  r = scanWorldInfo(entries, ["我画了一张符"], baseOpts(state, 5));
  assert.ok(r.activated.some((e) => e.uid === "b"), "第 5 条消息时 delay 解除");
  console.log("✓ delay（聊天前 4 条消息内压制，之后放行）");
}

// ---- 2. sticky：激活后免关键词保活，到期进 cooldown
{
  const state = emptyTimedState();

  // 轮 1（消息数 1）：关键词命中激活，记录 sticky {start:1, end:3}
  let r = scanWorldInfo(entries, ["我拔出剑"], baseOpts(state, 1));
  assert.ok(r.activated.some((e) => e.uid === "a"), "关键词命中激活");
  assert.deepEqual(state.sticky["t/a"], { start: 1, end: 3 }, "sticky 区间 start=消息数, end=+sticky");
  assert.deepEqual(state.cooldown["t/a"], { start: 1, end: 4 }, "激活时同步记录 cooldown 区间");

  // 轮 2（消息数 2）：无关键词，sticky 保活
  r = scanWorldInfo(entries, ["夜色渐深"], baseOpts(state, 2));
  assert.ok(r.activated.some((e) => e.uid === "a"), "sticky 期间免关键词保活");

  // 轮 3（消息数 3 = end）：sticky 到期，关键词不命中 → 不激活
  r = scanWorldInfo(entries, ["风停了"], baseOpts(state, 3));
  assert.ok(!r.activated.some((e) => e.uid === "a"), "sticky 到期后无关键词不激活");
  assert.ok(state.sticky["t/a"] === undefined, "过期 sticky 已清理");

  // 轮 4（消息数 4）：关键词再命中，但 protected cooldown（start=3, end=6）压制
  assert.deepEqual(state.cooldown["t/a"], { start: 3, end: 6, protected: true }, "sticky 到期转入 protected cooldown");
  r = scanWorldInfo(entries, ["我再拔剑"], baseOpts(state, 4));
  assert.ok(!r.activated.some((e) => e.uid === "a"), "cooldown 期间关键词命中也被压制");

  // 轮 7（消息数 7 > end=6）：cooldown 过期，关键词恢复激活
  r = scanWorldInfo(entries, ["我又拔剑"], baseOpts(state, 7));
  assert.ok(r.activated.some((e) => e.uid === "a"), "cooldown 过期后恢复激活");
  console.log("✓ sticky（2 条保活）→ 到期自动进 cooldown（3 条压制）→ 过期恢复");
}

// ---- 3. normalizeTimedState：恢复与坏数据重置
{
  const restored = normalizeTimedState({
    sticky: { "w/1": { start: 1, end: 3 }, bad: { start: "x" } },
    cooldown: { "w/2": { start: 2, end: 5, protected: true } },
  });
  assert.deepEqual(restored.sticky, { "w/1": { start: 1, end: 3 } });
  assert.deepEqual(restored.cooldown, { "w/2": { start: 2, end: 5, protected: true } });
  assert.deepEqual(normalizeTimedState("垃圾"), emptyTimedState());
  assert.deepEqual(normalizeTimedState(undefined), emptyTimedState());
  console.log("✓ normalizeTimedState（恢复合法区间，坏数据重置）");
}

// ---- 4. 无 timed 时行为不变（对照条目 C 正常关键词激活）
{
  const r = scanWorldInfo(entries, ["我吞下一枚丹"], baseOpts());
  assert.equal(activatedIds(r), "c");
  console.log("✓ 未启用计时效果时扫描行为不变");
}

console.log("\n=== M6 世界书计时效果验证全部通过 ===");
