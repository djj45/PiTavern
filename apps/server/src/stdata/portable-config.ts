import type { TavernConfig } from '../config.ts';
import { object } from './files.ts';
export type PortableSettings = Pick<TavernConfig, 'persona' | 'thinkingLevel' | 'contextMode' | 'activePreset' | 'activeWorlds' | 'worldInfo' | 'toolsEnabled' | 'outputProtocol' | 'protocolStrict' | 'compression' | 'takeover' | 'branches'>;
const keys = ['persona', 'thinkingLevel', 'contextMode', 'activePreset', 'activeWorlds', 'worldInfo', 'toolsEnabled', 'outputProtocol', 'protocolStrict', 'compression', 'takeover', 'branches'] as const;
export function portableSettings(config: TavernConfig): PortableSettings {
  // Deliberately never spread the full config; URLs, keys, paths, providers and model IDs stay local.
  return parsePortableSettings(Object.fromEntries(keys.map((key) => [key, config[key]])));
}
function shape(value: unknown, allowed: string[]): asserts value is Record<string, unknown> {
  if (!object(value) || Object.keys(value).some((key) => !allowed.includes(key))) throw new Error('便携设置包含未知字段');
}
function text(value: unknown, max: number): asserts value is string {
  if (typeof value !== 'string' || value.length > max) throw new Error('便携设置文本无效或过长');
}
function bool(value: unknown): asserts value is boolean { if (typeof value !== 'boolean') throw new Error('便携设置开关无效'); }
function integer(value: unknown, min: number, max: number): void {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) throw new Error('便携设置数值超出范围');
}
function fileName(value: unknown): void {
  text(value, 255); if (/[\\/\x00-\x1f]/.test(value) || value === '.' || value === '..') throw new Error('便携设置资料名称无效');
}
export function parsePortableSettings(value: unknown): PortableSettings {
  shape(value, [...keys]);
  // branches 是 0.2.0 之后新增的可选段；旧归档没有它时按关闭处理。
  if (keys.some((key) => key !== 'branches' && !Object.hasOwn(value, key))) throw new Error('便携设置缺少必要字段');
  shape(value.persona, ['name', 'description']); text(value.persona.name, 1000); text(value.persona.description, 200000);
  if (!['off', 'minimal', 'low', 'medium', 'high'].includes(String(value.thinkingLevel)) || !['simple', 'bridge', 'takeover'].includes(String(value.contextMode)) || !['native', 'game_tool'].includes(String(value.outputProtocol))) throw new Error('便携设置模式无效');
  fileName(value.activePreset);
  if (!Array.isArray(value.activeWorlds) || value.activeWorlds.length > 1000) throw new Error('便携设置世界书列表无效');
  value.activeWorlds.forEach(fileName);
  bool(value.toolsEnabled); bool(value.protocolStrict);
  shape(value.worldInfo, ['scanDepth', 'recursionSteps', 'caseSensitive', 'matchWholeWords', 'useGroupScoring', 'minActivations', 'minActivationsDepthMax', 'budgetTokens']);
  integer(value.worldInfo.scanDepth, 0, 1000); integer(value.worldInfo.recursionSteps, 0, 10);
  bool(value.worldInfo.caseSensitive); bool(value.worldInfo.matchWholeWords);
  if (value.worldInfo.useGroupScoring !== undefined) bool(value.worldInfo.useGroupScoring);
  for (const key of ['minActivations', 'minActivationsDepthMax', 'budgetTokens']) if (value.worldInfo[key] !== undefined) integer(value.worldInfo[key], 0, key === 'budgetTokens' ? 1000000 : 1000);
  shape(value.compression, ['enabled', 'keepFullTurns']); bool(value.compression.enabled); integer(value.compression.keepFullTurns, 1, 100);
  shape(value.takeover, ['recentTurns', 'stateProjection']); bool(value.takeover.stateProjection); integer(value.takeover.recentTurns, 1, 50);
  if (value.branches === undefined) value.branches = { autoGenerate: 0 };
  shape(value.branches, ['autoGenerate']); integer(value.branches.autoGenerate, 0, 4);
  return structuredClone(value) as unknown as PortableSettings;
}
export function applyPortableSettings(config: TavernConfig, value: PortableSettings): TavernConfig {
  const next = { ...config, ...parsePortableSettings(value) };
  const provider = config.providers.find((p) => p.id === config.defaultProvider);
  if (provider?.apiType === 'text' && (next.contextMode === 'takeover' || next.outputProtocol === 'game_tool')) throw new Error('便携设置与本机文本补全连接不兼容，请取消应用设置后恢复');
  return next;
}
