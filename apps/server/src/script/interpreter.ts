import { setImmediate as yieldEventLoop } from 'node:timers/promises';
import { substituteMacros } from '../context/macros.ts';
import type { StChatLine } from '../stdata/types.ts';

interface Scope { values: Map<string, Value>; parent?: Scope }
interface Closure { body: string; scope: Scope }
type Value = string | Closure;
export interface ScriptHost {
  char: string; user: string; personaDescription?: string; members?: string[];
  variables: Record<string, unknown>; lines: StChatLine[]; signal: AbortSignal;
  generate?: (prompt: string | undefined, raw: boolean, character: string) => Promise<string>;
}
export interface ScriptResult { pipe: string; notices: string[]; steps: number }
class Flow { constructor(readonly kind: 'return' | 'break' | 'abort', readonly value: Value) {} }
const text = (value: unknown): string => value === undefined || value === null ? '' : typeof value === 'string' ? value : JSON.stringify(value);
const isClosure = (value: Value): value is Closure => typeof value !== 'string';
function keySafe(key: string): string {
  if (!key || key.length > 200 || ['__proto__', 'prototype', 'constructor'].includes(key)) throw new Error('变量名无效');
  return key;
}
function decoded(raw: string): string {
  if (raw.startsWith('"') && raw.endsWith('"')) raw = raw.slice(1, -1);
  return raw.replace(/\\([\\|"{}])/g, '$1');
}
/** Split only at top-level delimiters: quoted values, macros, JSON and closures stay intact. */
function split(source: string, words = false): string[] {
  const out: string[] = []; let start = 0, quote = false, depth = 0, macro = 0, json = 0;
  for (let i = 0; i < source.length; i++) {
    const ch = source[i];
    if (ch === '\\') { i++; continue; }
    if (!quote && !depth && !macro && !json && source.startsWith('/*', i)) {
      const end = source.indexOf('*|', i + 2); if (end < 0) throw new Error('块注释没有结束');
      source = source.slice(0, i) + ' '.repeat(end + 2 - i) + source.slice(end + 2); i = end + 1; continue;
    }
    if (ch === '"' && !macro) { quote = !quote; continue; }
    if (quote) continue;
    if (source.startsWith('{:', i)) { depth++; if (depth > 32) throw new Error('闭包嵌套超过 32 层'); i++; continue; }
    if (source.startsWith(':}', i)) { if (!depth) throw new Error('多余的闭包结束符'); depth--; i++; continue; }
    if (depth) continue;
    if (source.startsWith('{{', i)) { macro++; i++; continue; }
    if (source.startsWith('}}', i) && macro) { macro--; i++; continue; }
    if (macro) continue;
    if (ch === '[' || ch === '{') json++;
    else if (ch === ']' || ch === '}') json--;
    if (json < 0) throw new Error('JSON 括号不匹配');
    if (!words && !json && ch === '|' && source[i + 1] === '|') {
      if (i > start) out.push(source.slice(start, i)); out.push('/pass ""'); i++; start = i + 1; continue;
    }
    if (!json && (words ? /\s/.test(ch) : ch === '|')) {
      if (i > start) out.push(source.slice(start, i)); start = i + 1;
    }
  }
  if (quote || depth || macro || json) throw new Error('引号、宏、JSON 或闭包没有闭合');
  if (start < source.length) out.push(source.slice(start));
  return out.map((part) => part.trim()).filter(Boolean);
}

export async function executeScript(source: string, host: ScriptHost): Promise<ScriptResult> {
  if (!source.trim() || source.length > 200_000) throw new Error('脚本不能为空且不能超过 20 万字符');
  let steps = 0, outputBytes = 0, callDepth = 0; const notices: string[] = [], started = Date.now();
  const root: Scope = { values: new Map() };
  const initialMessages = host.lines.length;
  const stringify = (value: Value) => isClosure(value) ? '{:' + value.body + ':}' : value;
  const scopeOf = (scope: Scope, key: string): Scope | undefined => scope.values.has(key) ? scope : scope.parent ? scopeOf(scope.parent, key) : undefined;
  const scoped = (scope: Scope, key: string): Value => scopeOf(scope, key)?.values.get(key) ?? '';
  const bounded = (value: string) => { if (value.length > 1_000_000) throw new Error('脚本单值超过 100 万字符'); return value; };
  const expand = (raw: string, scope: Scope, pipe: Value, iteration?: number): string => {
    // Escape sentinels are private to this expansion and restored only after macro evaluation.
    if (raw.includes('\uE000') || raw.includes('\uE001')) throw new Error('脚本包含保留字符');
    let value = decoded(raw.replace(/\\\{/g, '\uE000').replace(/\\\}/g, '\uE001'));
    value = value.replace(/\{\{(pipe|timesIndex|lastMessageId|lastMessage)\}\}/gi, (_all, name: string) => {
      switch (name.toLowerCase()) {
        case 'pipe': return stringify(pipe);
        case 'timesindex': return String(iteration ?? 0);
        case 'lastmessageid': return String(host.lines.filter((line) => !line.is_system).length - 1);
        default: return host.lines.findLast((line) => !line.is_system)?.mes ?? '';
      }
    }).replace(/\{\{var::([^{}]+)\}\}/gi, (_all, key: string) => stringify(scoped(scope, key.trim())));
    if (/\{\{(?:get|set|add|inc|dec)globalvar(?:::|:)/i.test(value)) throw new Error('全局变量宏暂不支持');
    const variableReads = value.match(/\{\{(?:getvar|getvardefault)(?:::|:)/gi)?.length ?? 0;
    const largestVariable = Math.max(0, ...Object.values(host.variables).map((item) => text(item).length));
    if (value.length + variableReads * largestVariable > 2_000_000) throw new Error('宏展开超过脚本单值预算');
    value = substituteMacros(value, { ...host, variables: host.variables });
    return bounded(value.replace(/\uE000/g, '{').replace(/\uE001/g, '}'));
  };
  const valueOf = (raw: string, scope: Scope, pipe: Value, iteration?: number): Value => {
    if (raw.startsWith('{:') && raw.endsWith(':}()')) throw new Error('立即执行闭包暂不支持，请使用 /run');
    if (raw.startsWith('{:') && raw.endsWith(':}')) return { body: raw.slice(2, -2).trim(), scope };
    const exact = /^\{\{var::([^{}]+)\}\}$/.exec(raw);
    if (exact) return scoped(scope, exact[1].trim());
    return expand(raw, scope, pipe, iteration);
  };
  const operand = (value: string, scope: Scope): string => Number.isFinite(Number(value)) && value.trim() ? value :
    scopeOf(scope, value) ? stringify(scoped(scope, value)) : Object.hasOwn(host.variables, value) ? text(host.variables[value]) : value;
  const compare = (args: Record<string, Value>, scope: Scope): boolean => {
    const a = operand(stringify(args.left ?? ''), scope), b = operand(stringify(args.right ?? ''), scope);
    const numeric = a.trim() !== '' && b.trim() !== '' && Number.isFinite(Number(a)) && Number.isFinite(Number(b));
    const left = numeric ? Number(a) : a.toLowerCase(), right = numeric ? Number(b) : b.toLowerCase();
    switch (stringify(args.rule ?? 'eq')) {
      case 'eq': return left === right; case 'neq': return left !== right;
      case 'lt': return left < right; case 'gt': return left > right;
      case 'lte': return left <= right; case 'gte': return left >= right;
      case 'not': return !a || ['false', '0', 'null'].includes(a.toLowerCase());
      case 'in': return a.toLowerCase().includes(b.toLowerCase()); case 'nin': return !a.toLowerCase().includes(b.toLowerCase());
      default: throw new Error('不支持的比较规则: ' + stringify(args.rule));
    }
  };
  const tick = async () => {
    host.signal.throwIfAborted();
    if (++steps > 10_000 || Date.now() - started > 60_000) throw new Error('脚本达到执行上限（10000 步 / 60 秒）');
    if (steps % 32 === 0) await yieldEventLoop();
  };
  const call = async (value: Value, parent: Scope, pipe: Value, iteration?: number, params: Record<string, Value> = {}): Promise<Value> => {
    if (++callDepth > 32) { callDepth--; throw new Error('闭包调用超过 32 层'); }
    const closure: Closure = isClosure(value) ? value : { body: value, scope: parent };
    const child: Scope = { parent: closure.scope, values: new Map() };
    let body = closure.body;
    // Closure headers: {: a=1 b= /pass ... :}
    const slash = body.indexOf('/');
    if (slash > 0) {
      for (const token of split(body.slice(0, slash), true)) {
        const match = /^([\w-]+)=([\s\S]*)$/.exec(token); if (!match) throw new Error('闭包参数无效');
        child.values.set(keySafe(match[1]), valueOf(match[2], parent, pipe, iteration));
      }
      body = body.slice(slash);
    }
    for (const [key, value] of Object.entries(params)) child.values.set(keySafe(key), value);
    try { return await run(body, child, pipe, iteration, false); }
    catch (flow) { if (flow instanceof Flow && flow.kind === 'return') return flow.value; throw flow; }
    finally { callDepth--; }
  };
  const run = async (program: string, scope: Scope, initial: Value = '', iteration?: number, inject = true): Promise<Value> => {
    let pipe = initial, first = true;
    for (const raw of split(program)) {
      await tick();
      if (raw.startsWith('//')) continue;
      const match = /^\/([:\w-]+)(?:\s+([\s\S]*))?$/.exec(raw);
      if (!match) throw new Error('命令必须以 / 开头: ' + raw.slice(0, 60));
      const name = match[1].toLowerCase(), body = match[2] ?? '', tokens = split(body, true);
      const args: Record<string, Value> = Object.create(null), rest: string[] = [];
      let named = true;
      for (const token of tokens) {
        const pair = named && /^([\w-]+)=([\s\S]*)$/.exec(token);
        if (pair) args[pair[1]] = valueOf(pair[2], scope, pipe, iteration);
        else { named = false; rest.push(token); }
      }
      const rawValue = rest.join(' ');
      const value = rawValue ? ['let', 'var', 'times', 'foreach'].includes(name) ? rawValue : valueOf(rawValue, scope, pipe, iteration) : first && !inject ? '' : pipe;
      first = false;
      const str = stringify(value), arg = (key: string, fallback = '') => stringify(args[key] ?? fallback);
      const resolve = (key: string) => operand(key, scope);
      if (name.startsWith(':')) {
        const closure = scoped(scope, match[1].slice(1)); if (!isClosure(closure)) throw new Error('命名闭包不存在: ' + match[1]);
        try { pipe = await call(closure, scope, pipe, iteration, args); } catch (flow) { if (flow instanceof Flow && flow.kind === 'break') pipe = flow.value; else throw flow; }
        continue;
      }
      const allowed: Record<string, string[]> = {
        echo: ['title', 'severity'], let: ['key'], var: ['key'], getvar: ['key', 'index'], setvar: ['key', 'index'], addvar: ['key'], incvar: ['key'], decvar: ['key'], flushvar: ['key'],
        if: ['left', 'right', 'rule', 'else'], while: ['left', 'right', 'rule', 'guard'], times: ['guard'], foreach: [],
        replace: ['pattern', 'replacement'], split: ['delimiter'], join: ['glue'], messages: ['names'], send: ['at'], sendas: ['name', 'at'], sys: ['at'], comment: ['at'], trigger: ['name'],
      };
      if (name !== 'run') for (const key of Object.keys(args)) if (!(allowed[name] ?? []).includes(key)) throw new Error('暂不支持 /' + name + ' 参数 ' + key);
      switch (name) {
        case 'pass': pipe = value; break;
        case 'echo': {
          outputBytes += str.length; if (outputBytes > 1_000_000 || notices.length >= 100) throw new Error('脚本提示输出过多');
          notices.push(str); pipe = value; break;
        }
        case 'return': throw new Flow('return', value);
        case 'break': throw new Flow('break', value);
        case 'abort': throw new Flow('abort', value);
        case 'let': case 'var': {
          const key = keySafe(arg('key', rest[0] ? expand(rest[0], scope, pipe, iteration) : ''));
          const hasValue = !!args.key ? !!rawValue : rest.length > 1;
          const next = args.key ? value : hasValue ? valueOf(rest.slice(1).join(' '), scope, pipe, iteration) : '';
          if (name === 'let') { scope.values.set(key, next); pipe = next; }
          else { const owner = scopeOf(scope, key); if (!owner) throw new Error('作用域变量未声明: ' + key); if (hasValue) owner.values.set(key, next); pipe = owner.values.get(key)!; }
          break;
        }
        case 'getvar': case 'setvar': case 'addvar': case 'incvar': case 'decvar': case 'flushvar': {
          const key = keySafe(arg('key', ['setvar', 'addvar'].includes(name) ? '' : str));
          let previous: unknown = Object.hasOwn(host.variables, key) ? host.variables[key] : '';
          if (name === 'flushvar') { delete host.variables[key]; pipe = ''; break; }
          const index = args.index === undefined ? undefined : keySafe(arg('index'));
          let container: Record<string, unknown> | unknown[] | undefined;
          if (index !== undefined) {
            try { container = typeof previous === 'string' ? JSON.parse(previous || (/^\d+$/.test(index) ? '[]' : '{}')) : previous; } catch { throw new Error('变量不是有效 JSON'); }
            if (!container || typeof container !== 'object') throw new Error('变量不是数组或对象');
            if (Array.isArray(container) && (!/^\d+$/.test(index) || Number(index) > 10_000)) throw new Error('数组索引无效');
            previous = Object.hasOwn(container, index) ? (container as Record<string, unknown>)[index] : '';
          }
          if (name === 'getvar') { pipe = text(previous); break; }
          let next: unknown = str;
          if (name === 'incvar' || name === 'decvar') next = (Number(previous) || 0) + (name === 'incvar' ? 1 : -1);
          if (name === 'addvar') {
            let array: unknown; try { array = typeof previous === 'string' ? JSON.parse(previous) : previous; } catch { /* Plain strings are valid. */ }
            next = Array.isArray(array) ? JSON.stringify([...array, str]) : Number.isFinite(Number(previous)) && Number.isFinite(Number(str)) ? Number(previous) + Number(str) : text(previous) + str;
          }
          if (container && index !== undefined) { (container as Record<string, unknown>)[index] = next; next = JSON.stringify(container); }
          Object.defineProperty(host.variables, key, { value: bounded(text(next)), writable: true, configurable: true, enumerable: true }); pipe = text(next); break;
        }
        case 'if': {
          const chosen = compare(args, scope) ? value : args.else;
          if (chosen !== undefined) pipe = await call(chosen, scope, pipe, iteration); break;
        }
        case 'run': {
          const target = !isClosure(value) && scopeOf(scope, str) ? scoped(scope, str) : value;
          try { pipe = await call(target, scope, pipe, iteration, args); }
          catch (flow) { if (flow instanceof Flow && flow.kind === 'break') pipe = flow.value; else throw flow; } break;
        }
        case 'times': case 'while': case 'foreach': {
          let closure: Value, count = 100, entries: [string, unknown][] | undefined;
          if (name === 'times') {
            count = Number(resolve(expand(rest[0] ?? '', scope, pipe, iteration)));
            if (!Number.isInteger(count) || count < 0 || count > (arg('guard') === 'off' ? 10_000 : 100)) throw new Error('循环次数超出限制');
            closure = valueOf(rest.slice(1).join(' '), scope, pipe, iteration);
          } else if (name === 'foreach') {
            const input = resolve(expand(rest[0] ?? '', scope, pipe, iteration)); let collection: unknown;
            try { collection = JSON.parse(input); } catch { throw new Error('foreach 需要 JSON 数组或对象'); }
            if (!collection || typeof collection !== 'object') throw new Error('foreach 需要 JSON 数组或对象');
            entries = Object.entries(collection); count = entries.length;
            if (count > 1000) throw new Error('foreach 集合超过 1000 项');
            closure = valueOf(rest.slice(1).join(' '), scope, pipe, iteration);
          } else { closure = value; count = arg('guard') === 'off' ? 10_000 : 100; }
          const results: string[] = []; let completed = 0;
          const whileArgs = () => { const dynamic: Record<string, Value> = Object.create(null); for (const token of tokens) { const m = /^(left|right|rule)=([\s\S]*)$/.exec(token); if (m) dynamic[m[1]] = valueOf(m[2], scope, pipe, iteration); } return dynamic; };
          for (let i = 0; i < count; i++) {
            await tick();
            // Reevaluate while operands on every iteration, including macros modified by the body.
            if (name === 'while') {
              if (!compare(whileArgs(), scope)) break;
            }
            try {
              const params: Record<string, Value> = entries ? { item: text(entries[i][1]), index: entries[i][0], key: entries[i][0] } : {};
              pipe = await call(closure, scope, pipe, i, params); completed++; if (entries) results.push(stringify(pipe));
            } catch (flow) { if (flow instanceof Flow && flow.kind === 'break') { pipe = flow.value; break; } throw flow; }
          }
          if (name === 'while' && completed === count && compare(whileArgs(), scope)) throw new Error('while 达到循环保护上限');
          if (entries) pipe = JSON.stringify(results); break;
        }
        case 'add': case 'mul': case 'max': case 'min': case 'sub': case 'div': case 'mod': case 'pow':
        case 'sin': case 'cos': case 'log': case 'abs': case 'sqrt': case 'round': case 'floor': case 'ceil': {
          const nums = split(str, true).map((part) => Number(resolve(part)));
          if (!nums.length || nums.some((n) => !Number.isFinite(n))) throw new Error('数学命令需要数值或变量');
          const [a, b] = nums; let n: number;
          switch (name) {
            case 'add': n = nums.reduce((a, b) => a + b, 0); break; case 'mul': n = nums.reduce((a, b) => a * b, 1); break;
            case 'max': n = Math.max(...nums); break; case 'min': n = Math.min(...nums); break;
            case 'sub': n = a - b; break; case 'div': n = a / b; break; case 'mod': n = a % b; break; case 'pow': n = a ** b; break;
            default: n = Math[name as 'sin' | 'cos' | 'log' | 'abs' | 'sqrt' | 'round' | 'floor' | 'ceil'](a);
          }
          pipe = String(Number.isFinite(n) ? n : 0); break;
        }
        case 'len': { let parsed: unknown; try { parsed = JSON.parse(str); } catch { parsed = str; }
          pipe = String(Array.isArray(parsed) || typeof parsed === 'string' ? parsed.length : parsed && typeof parsed === 'object' ? Object.keys(parsed).length : 0); break; }
        case 'trim': pipe = str.trim(); break;
        case 'trimstart': pipe = str.trimStart(); break;
        case 'trimend': pipe = str.trimEnd(); break;
        case 'tolower': case 'lower': pipe = str.toLowerCase(); break;
        case 'toupper': case 'upper': pipe = str.toUpperCase(); break;
        case 'replace': if (!arg('pattern')) throw new Error('replace 缺少 pattern'); else {
          const parts = str.split(arg('pattern')), replacement = arg('replacement');
          if (str.length + (parts.length - 1) * Math.max(0, replacement.length - arg('pattern').length) > 1_000_000) throw new Error('替换结果超过脚本单值预算');
          pipe = bounded(parts.join(replacement)); break;
        }
        case 'split': pipe = bounded(JSON.stringify(str.split(arg('delimiter', ',')))); break;
        case 'join': { const array = JSON.parse(str); if (!Array.isArray(array)) throw new Error('join 需要 JSON 数组'); pipe = bounded(array.map(text).join(arg('glue', ','))); break; }
        case 'messages': {
          const lines = host.lines.filter((line) => !line.is_system), range = /^(\d+)(?:-(\d+))?$/.exec(str);
          if (!range) throw new Error('messages 需要消息索引或 start-finish');
          const start = Number(range[1]), end = Number(range[2] ?? range[1]);
          pipe = end >= lines.length || start > end ? '' : bounded(lines.slice(start, end + 1).map((line) => (arg('names', 'on') === 'off' ? '' : line.name + ': ') + line.mes).join('\n')); break;
        }
        case 'send': case 'sendas': case 'sys': case 'comment': {
          if (!str.trim()) throw new Error('消息不能为空');
          if (host.lines.length > 100_000) throw new Error('聊天消息过多');
          const speaker = name === 'send' ? host.user : name === 'sendas' ? arg('name') : '旁白';
          if (!speaker || speaker.length > 200) throw new Error('sendas 缺少有效 name');
          const line: StChatLine = { name: speaker, is_user: name === 'send', is_system: name === 'comment', send_date: new Date().toISOString(), mes: str, extra: { script: true } };
          if (args.at !== undefined) { const at = Number(resolve(arg('at'))); if (!Number.isInteger(at) || at < 0 || at > host.lines.length) throw new Error('消息插入位置无效'); host.lines.splice(at, 0, line); }
          else host.lines.push(line);
          pipe = ''; break;
        }
        case 'gen': case 'genraw': case 'trigger': {
          if (!host.generate) throw new Error('当前环境没有模型生成接口');
          if (name === 'trigger') {
            const members = arg('name') ? [arg('name')] : host.members ?? [host.char];
            for (const character of members) {
              if (host.members && !host.members.includes(character)) throw new Error('trigger 角色不在群聊成员中');
              const reply = bounded(await host.generate(undefined, false, character));
              host.lines.push({ name: character, mes: reply, is_user: false, is_system: false, send_date: new Date().toISOString(), extra: { script: true } });
            }
            pipe = '';
          } else pipe = bounded(await host.generate(str, name === 'genraw', host.char));
          break;
        }
        case 'delay': { const ms = Number(str); if (!Number.isFinite(ms) || ms < 0 || ms > 5000) throw new Error('delay 范围为 0–5000 毫秒');
          await new Promise<void>((resolve, reject) => { const cancel = () => { clearTimeout(timer); reject(host.signal.reason); }; const timer = setTimeout(() => { host.signal.removeEventListener('abort', cancel); resolve(); }, ms); host.signal.addEventListener('abort', cancel, { once: true }); if (host.signal.aborted) cancel(); }); break; }
        default: throw new Error('暂不支持 STscript 命令 /' + name + '，本次脚本未保存任何更改');
      }
      if (JSON.stringify(host.variables).length > 1_000_000 || host.lines.length > 100_000 || host.lines.length - initialMessages > 100) throw new Error('脚本状态超过限制');
    }
    return pipe;
  };
  try { const pipe = await run(source, root); return { pipe: stringify(pipe), notices, steps }; }
  catch (flow) { if (flow instanceof Flow && flow.kind === 'return') return { pipe: stringify(flow.value), notices, steps }; if (flow instanceof Flow && flow.kind === 'abort') throw new Error('脚本已中止，所有更改已撤回'); if (flow instanceof Flow) throw new Error('/break 只能在循环或闭包中使用'); throw flow; }
}
