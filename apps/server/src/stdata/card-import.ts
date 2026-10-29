import fs from 'node:fs';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { readCardArchive, archivePath, CARD_ARCHIVE_LIMITS } from './card-archive-zip.ts';
import { object, atomicWrite } from './files.ts';
import type { CharacterCard } from './types.ts';
type Json = Record<string, unknown>;
const string = (value: unknown) => typeof value === 'string' ? value : '';
const records = (value: unknown): Json[] => Array.isArray(value) && value.every(object) ? value : [];
const macros = (value: unknown) => string(value).replace(/#\{user\}:/gi, '{{user}}:').replace(/#\{character\}:/gi, '{{char}}:').replace(/(?<!\{)\{character\}(?!\})/gi, '{{char}}').replace(/(?<!\{)\{user\}(?!\})/gi, '{{user}}');
const examples = (value: unknown) => records(value).filter((item) => string(item.text)).map((item) => '<START>\n' + macros(item.text)).join('\n');
function jsonFile(files: Map<string, Buffer>, name: string): Json {
  const file = files.get(archivePath(name));
  if (!file) throw new Error('归档缺少文件：' + name);
  const value: unknown = JSON.parse(file.toString('utf8'));
  if (!object(value)) throw new Error('归档 JSON 不是对象：' + name);
  return value;
}
function rasterExtension(buffer: Buffer): string | undefined {
  if (buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'png';
  if (buffer[0] === 255 && buffer[1] === 216 && buffer[2] === 255) return 'jpg';
  if (['GIF87a', 'GIF89a'].includes(buffer.toString('ascii', 0, 6))) return 'gif';
  if (buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP') return 'webp';
  return undefined;
}
function embeddedPath(uri: unknown): string | undefined {
  if (typeof uri !== 'string') return undefined;
  const prefix = ['embeded://', 'embedded://', '__asset:'].find((item) => uri.trim().toLowerCase().startsWith(item));
  return prefix ? archivePath(uri.trim().slice(prefix.length)) : undefined;
}
function ensureDirectory(dir: string): void {
  if (fs.existsSync(dir)) {
    if (!fs.lstatSync(dir).isDirectory() || fs.lstatSync(dir).isSymbolicLink()) throw new Error('导入目录不是普通目录');
  } else fs.mkdirSync(dir);
}
function chatFromScenario(scenario: Json, character: string, user: string, archiveId: string, index: number): string {
  const overrides = { scenario: macros(scenario.narrative), mesExample: examples(scenario.exampleMessages), systemPrompt: macros(scenario.formattingInstructions) };
  const lines: Json[] = [{ user_name: user, character_name: character, chat_metadata: { _pitavernByaf: { version: 1, archiveId, scenarioIndex: index, ...overrides }, scenario: overrides.scenario } }];
  const first = records(scenario.firstMessages)[0];
  if (first && string(first.text)) lines.push({ name: character, is_user: false, is_system: false, mes: macros(first.text), send_date: new Date().toISOString() });
  if (scenario.messages !== undefined && (!Array.isArray(scenario.messages) || scenario.messages.some((item) => !object(item)))) throw new Error('BYAF 场景消息结构无效');
  if (records(scenario.messages).length > 50000) throw new Error('BYAF 场景最多 50000 条消息');
  const date = (value: unknown) => { const n = typeof value === 'number' ? value : typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : Date.parse(string(value)); return Number.isFinite(n) && Math.abs(n) < 8.64e15 ? new Date(n).toISOString() : new Date(0).toISOString(); };
  for (const message of records(scenario.messages)) {
    if (message.type === 'human') {
      if (typeof message.text !== 'string') throw new Error('BYAF 用户消息缺少文本');
      lines.push({ name: user, is_user: true, is_system: false, mes: macros(message.text), send_date: date(message.createdAt) });
    } else if (message.type === 'ai') {
      if (!Array.isArray(message.outputs) || !message.outputs.length || message.outputs.some((item) => !object(item) || typeof item.text !== 'string')) throw new Error('BYAF 助手消息缺少有效候选');
      const outputs = records(message.outputs);
      let selected = 0;
      for (let i = 1; i < outputs.length; i++) if (date(outputs[i].activeTimestamp ?? outputs[i].createdAt) > date(outputs[selected].activeTimestamp ?? outputs[selected].createdAt)) selected = i;
      lines.push({ name: character, is_user: false, is_system: false, mes: macros(outputs[selected].text), send_date: date(outputs[selected].createdAt), swipes: outputs.map((item) => macros(item.text)), swipe_id: selected });
    } else throw new Error('BYAF 含不支持的消息类型，原库未改变');
  }
  const result = lines.map((line) => JSON.stringify(line)).join('\n') + '\n';
  if (Buffer.byteLength(result) > CARD_ARCHIVE_LIMITS.file) throw new Error('BYAF 单个聊天超过 32 MiB');
  return result;
}

export interface CardArchiveImportResult { file: string; warnings: string[]; chats: number; assets: number }
/** Reference: SillyTavern release/src/{charx,byaf}.js. Never fetch remote assets or execute scripts. */
export async function importCardArchive(root: string, fileName: string, buffer: Buffer, existingNames: ReadonlySet<string>, userName: string): Promise<CardArchiveImportResult> {
  const format = fileName.toLowerCase().endsWith('.charx') ? 'charx' : fileName.toLowerCase().endsWith('.byaf') ? 'byaf' : undefined;
  if (!format) throw new Error('未知角色归档格式');
  const files = await readCardArchive(buffer), warnings: string[] = [];
  let card: Json, avatar: Buffer | undefined, scenarios: Json[] = [];
  if (format === 'charx') {
    card = jsonFile(files, 'card.json');
    if (!['chara_card_v2', 'chara_card_v3'].includes(string(card.spec)) || !object(card.data)) throw new Error('CharX 需要 V2/V3 card.json');
    if (card.data.assets !== undefined && (!Array.isArray(card.data.assets) || card.data.assets.some((asset) => !object(asset)))) throw new Error('CharX 资源列表无效');
    const assets = records(card.data.assets);
    const icons = assets.filter((asset) => asset.type === 'icon');
    const icon = icons.find((asset) => string(asset.name).toLowerCase() === 'main') ?? icons[0];
    for (const asset of assets) { const name = embeddedPath(asset.uri); if (name && !files.has(name)) throw new Error('CharX 缺少嵌入资源：' + name); }
    const avatarPath = embeddedPath(icon?.uri); if (avatarPath) avatar = files.get(avatarPath);
    if (assets.some((asset) => /^https?:/i.test(string(asset.uri)))) warnings.push('外部资源链接已保留，不会自动下载');
  } else {
    const manifest = jsonFile(files, 'manifest.json');
    if (!Array.isArray(manifest.characters) || !manifest.characters.length || manifest.characters.some((item) => typeof item !== 'string')) throw new Error('BYAF manifest 缺少有效 characters 路径');
    const characterPath = archivePath(manifest.characters[0] as string), character = jsonFile(files, characterPath);
    if (manifest.characters.length > 1) warnings.push('BYAF 含多个角色，本次导入首个角色；其余数据保留在原归档');
    if (manifest.scenarios !== undefined && (!Array.isArray(manifest.scenarios) || manifest.scenarios.some((item) => typeof item !== 'string'))) throw new Error('BYAF scenarios 路径无效');
    scenarios = (manifest.scenarios as string[] ?? []).map((name) => jsonFile(files, name));
    const first = scenarios[0] ?? {};
    const author = object(manifest.author) ? manifest.author : {};
    if (character.loreItems !== undefined && (!Array.isArray(character.loreItems) || character.loreItems.some((item) => !object(item) || typeof item.key !== 'string' || typeof item.value !== 'string'))) throw new Error('BYAF loreItems 结构无效');
    card = { spec: 'chara_card_v2', spec_version: '2.0', data: {
      name: string(character.name) || string(character.displayName), description: macros(character.persona), personality: '', scenario: macros(first.narrative),
      first_mes: macros(records(first.firstMessages)[0]?.text), mes_example: examples(first.exampleMessages), creator_notes: string(author.backyardURL),
      system_prompt: macros(first.formattingInstructions), post_history_instructions: '', alternate_greetings: [...new Set(scenarios.slice(1).map((scenario) => macros(records(scenario.firstMessages)[0]?.text)).filter((value) => value && value !== macros(records(first.firstMessages)[0]?.text)))],
      character_book: { entries: records(character.loreItems).map((item, index) => ({ id: index, keys: macros(item.key).split(',').map((key) => key.trim()).filter(Boolean), content: macros(item.value), enabled: true, insertion_order: index, extensions: {} })), extensions: {} },
      tags: character.isNSFW === true ? ['nsfw'] : [], creator: string(author.name), character_version: '', extensions: { display_name: string(character.displayName) },
    } };
    const image = records(character.images)[0];
    if (image && string(image.path)) { const name = archivePath(path.posix.join(path.posix.dirname(characterPath), archivePath(string(image.path)))); avatar = files.get(name); if (!avatar) throw new Error('BYAF 缺少角色头像：' + name); }
    if (scenarios.length) warnings.push('BYAF 场景和聊天已导入；原模型参数与背景资源保留在归档，不会覆盖本机设置');
  }
  const body = card.data as Json;
  const name = string(body.name).trim();
  if (!name || name.length > 200 || /[\x00-\x1f]/.test(name) || body.extensions != null && !object(body.extensions)) throw new Error('归档角色名称或 extensions 无效');
  if (existingNames.has(name)) throw new Error('同名角色已存在；请先修改归档中的角色名称后再导入');
  const stem = path.basename(fileName).replace(/\.(charx|byaf)$/i, '').replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').trim();
  if (!stem || stem === '.' || stem === '..') throw new Error('归档文件名无效');
  const file = stem + '.json', target = path.join(root, 'characters', file);
  const chatDirectory = path.join(root, 'chats', name.replace(/[\\/:*?"<>|]/g, '_').trim() || '_');
  if (fs.existsSync(target) || (scenarios.length && fs.existsSync(chatDirectory))) throw new Error('角色文件或聊天目录已存在，拒绝覆盖');
  const archiveId = randomUUID(), extension = avatar && rasterExtension(avatar);
  if (avatar && !extension) warnings.push('头像格式暂不可显示，原文件已保留');
  body.name = name;
  body.extensions = { ...(body.extensions as Json ?? {}), pitavern_archive: { version: 1, id: archiveId, format, ...(extension ? { avatar: 'avatar.' + extension } : {}) } };
  const chats = scenarios.map((scenario, index) => chatFromScenario(scenario, name, userName, archiveId, index));
  for (const dir of [root, path.join(root, 'characters'), path.join(root, 'chats'), path.join(root, '.pitavern'), path.join(root, '.pitavern/imports')]) ensureDirectory(dir);
  const directory = path.join(root, '.pitavern/imports', archiveId); fs.mkdirSync(directory);
  // Keep failed staging output and the complete original archive for investigation/rollback.
  atomicWrite(path.join(directory, 'source.' + format), buffer);
  atomicWrite(path.join(directory, 'import.json'), JSON.stringify({ version: 1, format, file, importedAt: new Date().toISOString(), sha256: createHash('sha256').update(buffer).digest('hex'), entries: [...files].map(([name, data]) => ({ name, bytes: data.length })), warnings }, null, 2) + '\n');
  for (const [name, data] of files) atomicWrite(path.join(directory, 'files', name), data);
  if (avatar && extension) atomicWrite(path.join(directory, 'avatar.' + extension), avatar);
  const serialized = JSON.stringify(card, null, 2) + '\n';
  if (Buffer.byteLength(serialized) > 32 * 1024 ** 2) throw new Error('导入后角色卡超过 32 MiB 限制');
  const stagedCard = path.join(directory, 'imported-card.json'); atomicWrite(stagedCard, serialized);
  const stagedChats = path.join(directory, 'staged-chats');
  if (chats.length) { fs.mkdirSync(stagedChats); chats.forEach((content, index) => atomicWrite(path.join(stagedChats, 'byaf-' + String(index + 1).padStart(4, '0') + '.jsonl'), content)); }
  let activatedChats = false;
  try {
    if (chats.length) { fs.renameSync(stagedChats, chatDirectory); activatedChats = true; }
    fs.linkSync(stagedCard, target); // Exclusive atomic activation; never replace an existing card.
  } catch (error) {
    if (activatedChats) fs.renameSync(chatDirectory, stagedChats);
    throw error;
  }
  return { file, warnings, chats: chats.length, assets: files.size };
}

export function importedAvatar(root: string, extensions: Json): string {
  const info = extensions.pitavern_archive;
  if (!object(info) || info.version !== 1 || !/^[a-f0-9-]{36}$/.test(string(info.id)) || !/^avatar\.(png|jpg|gif|webp)$/.test(string(info.avatar))) return '';
  const file = path.join(root, '.pitavern/imports', string(info.id), string(info.avatar));
  try { return fs.lstatSync(file).isFile() && fs.realpathSync(file) === file ? file : ''; } catch { return ''; }
}
export function withImportedScenario(card: CharacterCard, metadata: Json): CharacterCard {
  const info = metadata._pitavernByaf;
  if (!object(info) || info.version !== 1) return card;
  const output = { ...card };
  for (const field of ['scenario', 'mesExample', 'systemPrompt'] as const) if (typeof info[field] === 'string') output[field] = info[field];
  return output;
}
