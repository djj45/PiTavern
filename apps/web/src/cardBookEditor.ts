/** A view adapter only: writes changed fields back into the original V2/V3 book. */
export type CardBook = Record<string, unknown> & { entries: Record<string, unknown>[] };
export type WorldView = Record<string, unknown> & { entries: Record<string, Record<string, unknown>> };
type Mapping = { direct?: string[]; extension?: string[]; fallback?: unknown };
const mappings: Record<string, Mapping> = {
  key: { direct: ['keys'], fallback: [] }, keysecondary: { direct: ['secondary_keys'], fallback: [] },
  comment: { direct: ['comment', 'name'], fallback: '' }, content: { direct: ['content'], fallback: '' },
  constant: { direct: ['constant'], fallback: false }, selective: { direct: ['selective'], fallback: true },
  order: { direct: ['insertion_order'], extension: ['order'], fallback: 100 },
  vectorized: { extension: ['vectorized'], direct: ['vectorized'], fallback: false },
  selectiveLogic: { extension: ['selectiveLogic'], direct: ['selective_logic'], fallback: 0 },
  depth: { extension: ['depth'], fallback: 4 }, role: { extension: ['role'], fallback: 0 },
  probability: { extension: ['probability'], direct: ['probability'], fallback: 100 },
  useProbability: { extension: ['useProbability'], direct: ['useProbability'], fallback: true },
  caseSensitive: { direct: ['case_sensitive'], extension: ['case_sensitive', 'caseSensitive'] },
  matchWholeWords: { extension: ['match_whole_words', 'matchWholeWords'] },
  scanDepth: { extension: ['scan_depth', 'scanDepth'] },
  excludeRecursion: { extension: ['exclude_recursion', 'excludeRecursion'], fallback: false },
  preventRecursion: { extension: ['prevent_recursion', 'preventRecursion'], fallback: false },
  delayUntilRecursion: { direct: ['delayed'], extension: ['delay_until_recursion', 'delayUntilRecursion'], fallback: false },
  sticky: { direct: ['sticky'], extension: ['sticky'], fallback: 0 },
  cooldown: { direct: ['cooldown'], extension: ['cooldown'], fallback: 0 },
  delay: { direct: ['delay'], extension: ['delay'], fallback: 0 },
  group: { extension: ['group'], direct: ['group'], fallback: '' },
  groupOverride: { extension: ['group_override', 'groupOverride'], fallback: false },
  groupWeight: { extension: ['group_weight', 'groupWeight'], fallback: 100 },
  useGroupScoring: { extension: ['use_group_scoring', 'useGroupScoring'] },
  outletName: { extension: ['outlet_name', 'outletName'], fallback: '' },
};
const directFirst = new Set(['key', 'keysecondary', 'comment', 'content', 'constant', 'selective', 'order', 'caseSensitive', 'delayUntilRecursion', 'sticky', 'cooldown', 'delay']);
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const sourceKey = '__pitavern_source_index__';
export function cardBookToWorld(book: CardBook): WorldView {
  const entries: WorldView['entries'] = {};
  book.entries.forEach((entry, index) => {
    const ext = object(entry.extensions) ? entry.extensions : {};
    const view: Record<string, unknown> = { uid: index, [sourceKey]: index, disable: entry.enabled === false, position: typeof ext.position === 'number' ? ext.position : entry.position === 'after_char' ? 1 : 0 };
    for (const [key, mapping] of Object.entries(mappings)) {
      const direct = (mapping.direct ?? []).map((name) => entry[name]);
      const extension = (mapping.extension ?? []).map((name) => ext[name]);
      view[key] = (directFirst.has(key) ? [...direct, ...extension] : [...extension, ...direct]).find((value) => value != null) ?? mapping.fallback;
    }
    entries[String(index)] = view;
  });
  return { entries };
}
export function updateCardBook(book: CardBook, next: WorldView): CardBook {
  const before = cardBookToWorld(book);
  const usedIds = new Set(book.entries.map((entry, index) => String(entry.id ?? index)));
  const entries = Object.entries(next.entries).map(([key, view]) => {
    const index = typeof view[sourceKey] === 'number' ? view[sourceKey] as number : -1;
    const original = book.entries[index];
    const entry: Record<string, unknown> = original ? structuredClone(original) : { keys: [], secondary_keys: [], content: '', enabled: true, insertion_order: 100, extensions: {} };
    const previous = index >= 0 ? before.entries[String(index)] : {};
    if (!before.entries[key] || index < 0) {
      let id = 0; while (usedIds.has(String(id))) id++;
      entry.id = id; usedIds.add(String(id));
    }
    if (view.disable !== previous.disable) entry.enabled = view.disable !== true;
    if (view.position !== previous.position) {
      const ext = object(entry.extensions) ? entry.extensions : {};
      entry.extensions = { ...ext, position: view.position };
      entry.position = Number(view.position) === 1 ? 'after_char' : 'before_char';
    }
    for (const [field, mapping] of Object.entries(mappings)) {
      if (JSON.stringify(view[field]) === JSON.stringify(previous[field])) continue;
      const ext = object(entry.extensions) ? { ...entry.extensions } : {};
      const direct = mapping.direct ?? []; const extension = mapping.extension ?? [];
      // Keep existing aliases in sync so an older reader cannot resurrect a stale value.
      for (const name of direct) if (Object.hasOwn(entry, name)) entry[name] = view[field];
      for (const name of extension) if (Object.hasOwn(ext, name)) ext[name] = view[field];
      if (directFirst.has(field) && direct.length) entry[direct[0]] = view[field];
      else if (extension.length) ext[extension[0]] = view[field];
      else if (direct.length) entry[direct[0]] = view[field];
      if (extension.length) entry.extensions = ext;
    }
    return entry;
  });
  return { ...book, entries };
}
