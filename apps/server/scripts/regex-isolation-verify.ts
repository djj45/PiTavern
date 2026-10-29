import assert from 'node:assert/strict';
import { assembleBridgeContext, type BridgeInput } from '../src/context/bridge.ts';
import { assembleBridgeIsolated } from '../src/context/bridge-isolated.ts';
import { normalizeCard } from '../src/stdata/types.ts';
import { emptyTimedState } from '../src/context/worldinfo.ts';
const fixture = (): BridgeInput => ({
  card: normalizeCard('chara_card_v2', { name: '测试角色' }, ''), persona: { name: '旅人', description: '' },
  preset: { prompts: [{ identifier: 'main', role: 'system', content: '{{setvar::score::2}}测试' }, { identifier: 'chatHistory', role: 'system', content: '', marker: true }],
    prompt_order: [{ character_id: 100001, order: [{ identifier: 'main', enabled: true }, { identifier: 'chatHistory', enabled: true }] }] },
  chatLines: [{ name: '旅人', is_user: true, is_system: false, send_date: '', mes: '原文' }], worldEntries: [], variables: { score: '1' },
  regexScripts: [{ scriptName: '替换', findRegex: '原文', replaceString: '{{getvar::score}}', placement: [1] }],
  options: { scanDepth: 2, recursionSteps: 0, caseSensitive: false, matchWholeWords: true, timed: emptyTimedState(), messageCount: 1 },
});
const expectedInput = fixture(), actualInput = fixture();
const expected = assembleBridgeContext(expectedInput), actual = await assembleBridgeIsolated(actualInput, 'fixture');
const contents = (result: typeof actual) => result.messages.map(({ role, content }) => ({ role, content }));
assert.deepEqual(contents(actual), contents(expected)); assert.deepEqual(actualInput.variables, expectedInput.variables);
assert.deepEqual(actualInput.options.timed, expectedInput.options.timed);
const dangerous = fixture(); dangerous.chatLines[0].mes = 'a'.repeat(32) + '!'; dangerous.regexScripts[0].findRegex = '/(a+)+$/';
const before = structuredClone(dangerous); let heartbeats = 0; const timer = setInterval(() => heartbeats++, 10);
try { await assert.rejects(assembleBridgeIsolated(dangerous, 'fixture', undefined, undefined, 100), /超时/); } finally { clearInterval(timer); }
assert.ok(heartbeats >= 5, '主事件循环持续响应'); assert.deepEqual(dangerous, before, '超时不会泄漏变量和时序修改');
const controller = new AbortController();
const pending = assembleBridgeIsolated(dangerous, 'fixture', undefined, controller.signal);
setTimeout(() => controller.abort(), 150); await assert.rejects(pending, /停止/); assert.deepEqual(dangerous, before);
const recovered = await assembleBridgeIsolated(fixture(), 'fixture'); assert.deepEqual(contents(recovered), contents(expected));
console.log('✓ 隔离组装保持宏和时序语义；灾难性正则超时、主线程响应、取消回滚、后续恢复');
