/** M1: immutable, deterministic comparison with the shipped 0.6.0 compressor. */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { compressHistory, contextChars } from "./fixtures/compression-v060.ts";
import { longContextFixture, toolContextFixture } from "./context-fixtures.ts";
const measurements = [100, 500, 1000].map((turns) => {
  const { messages, facts } = longContextFixture(turns);
  const before = JSON.stringify(messages);
  const started = performance.now();
  const result = compressHistory(messages, { enabled: true, keepFullTurns: 3 }, 16000);
  const milliseconds = performance.now() - started;
  const text = JSON.stringify(result.messages);
  assert.equal(JSON.stringify(messages), before);
  assert.equal(facts.filter((fact) => text.includes(fact)).length, 0, "固定基线应复现长消息末尾线索遗漏");
  assert.deepEqual(result.messages.slice(-5), messages.slice(-5));
  return { turns, originalChars: contextChars(messages), inputChars: contextChars(result.messages), factHits: 0, expectedFacts: facts.length, milliseconds };
});
const toolMessages = toolContextFixture();
const result = compressHistory(toolMessages, { enabled: true, keepFullTurns: 1 }, 20000);
assert.deepEqual(result.messages.slice(-3), toolMessages.slice(-3));
assert.ok(!JSON.stringify(result.messages).includes("码头钟楼的入口在地下"));
const root = path.resolve(import.meta.dirname, "../../../data/test-runs"); fs.mkdirSync(root, { recursive: true });
const run = fs.mkdtempSync(path.join(root, "context-baseline-"));
fs.writeFileSync(path.join(run, "report.json"), JSON.stringify({ algorithm: "0.6.0-prefix300", budgetUnit: "characters", budget: 16000, measurements, longToolTailHit: false, realProvider: "not_requested" }, null, 2));
console.log(JSON.stringify(measurements, null, 2));
console.log("✓ 100/500/1000 轮基线与长工具结果，当前工具链完整；报告：" + run);
