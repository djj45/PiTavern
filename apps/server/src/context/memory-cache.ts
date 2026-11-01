import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { buildWorkingContext, CONTEXT_ALGORITHM, contentHash, contextSourceHash, extractContextFacts, isContextHistory, prepareWorkingSources, textParts, type ContextFact, type WorkingSetInput } from "./working-set.ts";
interface CachedFacts { algorithm: string; key: string; digest: string; facts: ContextFact[] }

/** Disposable, bounded source index. No files, chat metadata, or final budget-dependent prompts are cached. */
export class ContextFactCache {
  constructor(private readonly entries: Map<string, unknown> = new Map(), private readonly capacity = 16) {}
  get(input: WorkingSetInput, scope: string): { facts: ContextFact[]; status: "hit" | "rebuilt" } {
    const { sources, compressionEnd } = prepareWorkingSources(input);
    // The current agent loop grows without changing the completed-history index.
    const completed = sources.slice(0, compressionEnd);
    const perspective = input.world && "viewpointId" in input.world ? [input.world.viewpointId,input.world.knowledgeKey,input.world.questKey,
      ...(input.world.schemaVersion===4?[contentHash(JSON.stringify(input.world))]:[])] : [];
    const key = contextSourceHash(completed, JSON.stringify([scope, input.sourceRevision ?? "",perspective]));
    const raw = this.entries.get(key) as Partial<CachedFacts> | undefined;
    if (raw?.algorithm === CONTEXT_ALGORITHM && raw.key === key && Array.isArray(raw.facts)
      && raw.digest === contentHash(JSON.stringify(raw.facts)) && validSources(completed, raw.facts)) {
      this.entries.delete(key); this.entries.set(key, raw);
      return { facts: structuredClone(raw.facts), status: "hit" };
    }
    const facts = extractContextFacts(completed);
    const entry: CachedFacts = { algorithm: CONTEXT_ALGORITHM, key, digest: contentHash(JSON.stringify(facts)), facts: structuredClone(facts) };
    this.entries.set(key, entry);
    while (this.entries.size > Math.max(1, this.capacity)) this.entries.delete(this.entries.keys().next().value!);
    return { facts, status: "rebuilt" };
  }
}
function validSources(messages: AgentMessage[], facts: ContextFact[]): boolean {
  const sources = new Map<string, { text: string; hash: string; turn: number; role: string }>();
  let turn = 0;
  messages.forEach((m, i) => {
    if (m.role === "user" && isContextHistory(m)) turn++;
    for (const p of textParts(m)) sources.set(`${i}:${p.part}`, { text: p.text, hash: contentHash(p.text), turn, role: m.role });
  });
  const kinds = new Set(["clue", "promise", "event", "summary", "narrative", "intent", "tool_receipt"]);
  return facts.every((f) => {
    if (!f || !kinds.has(f.kind) || typeof f.text !== "string" || !f.source) return false;
    const s = f.source, original = sources.get(`${s.message}:${s.part}`);
    if (!original || !Number.isInteger(s.start) || !Number.isInteger(s.end) || s.start < 0 || s.end <= s.start || s.end > original.text.length) return false;
    return s.hash === original.hash && s.turn === original.turn && s.role === original.role && original.text.slice(s.start, s.end) === f.text;
  });
}
export function buildCachedWorkingContext(input: WorkingSetInput, cache: ContextFactCache, scope: string) {
  if (!input.config.enabled) return buildWorkingContext(input);
  const indexed = cache.get(input, scope);
  const result = buildWorkingContext(input, indexed.facts);
  result.diagnostics.cache = indexed.status;
  return result;
}
