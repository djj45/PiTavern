import { crc32, deflateRawSync } from 'node:zlib';
export const tinyPng = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=', 'base64');
export const fixtureBook = () => ({ name: '合成卡内世界书', extensions: { unknownBook: true }, entries: [{ id: 42, keys: ['旅馆'], secondary_keys: ['旅人'], comment: '卡内初始条目', content: '卡内初始内容', enabled: true, insertion_order: 50, position: 'before_char', case_sensitive: false, unknownEntry: { keep: [1, 2] }, extensions: { unknownExtension: true, position: 0, group_weight: 25, groupWeight: 25, order: 50, sticky: 1 } }] });
export const fixtureCard = (name = '归档向导') => ({ spec: 'chara_card_v3', spec_version: '3.0', outerUnknown: { keep: true }, data: { name, description: '合成描述', first_mes: '欢迎，旅人。', character_book: fixtureBook(), extensions: { unknownCard: true, regex_scripts: [] }, assets: [{ type: 'icon', name: 'main', uri: 'embeded://assets/main.png', ext: 'png' }] } });
export function cardPng(card: unknown): Buffer {
  const chunk = (keyword: string, value: string) => {
    const payload = Buffer.from(keyword + '\0' + value, 'latin1'); const chunk = Buffer.alloc(payload.length + 12);
    chunk.writeUInt32BE(payload.length); chunk.write('tEXt', 4); payload.copy(chunk, 8); chunk.writeUInt32BE(crc32(chunk.subarray(4, chunk.length - 4)), chunk.length - 4); return chunk;
  };
  const encoded = Buffer.from(JSON.stringify(card)).toString('base64');
  return Buffer.concat([tinyPng.subarray(0, -12), chunk('Comment', 'preserved'), chunk('chara', encoded), chunk('ccv3', encoded), tinyPng.subarray(-12)]);
}
export function zipFixture(files: [string, Buffer | string][], options: { stored?: boolean; prefix?: Buffer } = {}): Buffer {
  const local: Buffer[] = [], central: Buffer[] = []; let offset = 0;
  for (const [name, input] of files) {
    const data = Buffer.from(input), encoded = Buffer.from(name), compressed = options.stored ? data : deflateRawSync(data), method = options.stored ? 0 : 8;
    const header = Buffer.alloc(30); header.writeUInt32LE(0x04034b50); header.writeUInt16LE(20, 4); header.writeUInt16LE(0x800, 6); header.writeUInt16LE(method, 8);
    header.writeUInt32LE(crc32(data), 14); header.writeUInt32LE(compressed.length, 18); header.writeUInt32LE(data.length, 22); header.writeUInt16LE(encoded.length, 26);
    const directory = Buffer.alloc(46); directory.writeUInt32LE(0x02014b50); directory.writeUInt16LE(0x314, 4); directory.writeUInt16LE(20, 6); directory.writeUInt16LE(0x800, 8); directory.writeUInt16LE(method, 10);
    directory.writeUInt32LE(crc32(data), 16); directory.writeUInt32LE(compressed.length, 20); directory.writeUInt32LE(data.length, 24); directory.writeUInt16LE(encoded.length, 28); directory.writeUInt32LE(offset, 42);
    local.push(header, encoded, compressed); central.push(directory, encoded); offset += header.length + encoded.length + compressed.length;
  }
  const directory = Buffer.concat(central), end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10); end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([options.prefix ?? Buffer.alloc(0), ...local, directory, end]);
}
export const charxFixture = (name = '归档向导', options: Parameters<typeof zipFixture>[1] = {}) => zipFixture([['card.json', JSON.stringify(fixtureCard(name))], ['assets/main.png', tinyPng], ['assets/unknown.dat', 'preserved unknown asset']], options);
export const byafFixture = () => zipFixture([
  ['manifest.json', JSON.stringify({ characters: ['characters/guide.json'], scenarios: ['scenarios/one.json', 'scenarios/two.json'], author: { name: '合成作者', backyardURL: 'https://example.invalid/fixture' } })],
  ['characters/guide.json', JSON.stringify({ name: 'BYAF向导', displayName: '显示名称', persona: '{character}欢迎{user}', images: [{ path: 'guide.png' }], loreItems: [{ key: '旅馆,旅人', value: '归档内的世界书' }], unknown: 'preserved' })],
  ['characters/guide.png', tinyPng],
  ['scenarios/one.json', JSON.stringify({ narrative: '首个场景', formattingInstructions: '首场景指令', firstMessages: [{ text: '#{character}: 欢迎{user}' }], exampleMessages: [{ text: '#{user}: 你好' }], messages: [{ type: 'human', text: '你好', createdAt: 1000 }, { type: 'ai', outputs: [{ text: '旧候选', createdAt: 2000, activeTimestamp: 2000 }, { text: '选中候选', createdAt: 3000, activeTimestamp: 4000 }] }] })],
  ['scenarios/two.json', JSON.stringify({ narrative: '第二个独立场景', formattingInstructions: '第二场景指令', firstMessages: [{ text: '另一个开场' }], messages: [] })],
]);
