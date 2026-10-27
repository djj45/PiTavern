import fs from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import type { TavernConfig } from "../config.ts";
import { worldEntryKey, type WiEntry } from "./worldinfo.ts";

const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const validVector = (value: unknown): value is number[] => Array.isArray(value) && value.length > 0 &&
  value.every((n) => typeof n === "number" && Number.isFinite(n)) && value.some((n) => n !== 0);

/** OpenAI 兼容 embeddings；顺序以响应 index 为准，不依赖响应数组顺序。 */
export async function embedTexts(config: TavernConfig, inputs: string[], signal?: AbortSignal): Promise<number[][]> {
  const provider = config.providers.find((p) => p.id === config.vectors.providerId);
  if (!provider?.baseUrl || !config.vectors.model.trim()) throw new Error("请先配置向量连接和 embedding 模型");
  const url = `${provider.baseUrl.replace(/\/+$/, "")}/embeddings`;
  const timeout = AbortSignal.timeout(30_000);
  const response = await fetch(url, {
    method: "POST", headers: { "Content-Type": "application/json", ...(provider.apiKey ? { Authorization: `Bearer ${provider.apiKey}` } : {}) },
    body: JSON.stringify({ model: config.vectors.model, input: inputs, encoding_format: "float" }),
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
  });
  if (!response.ok) throw new Error(`向量接口返回 HTTP ${response.status}`);
  const body = await response.json() as { data?: Array<{ index: number; embedding: unknown }> };
  if (!Array.isArray(body.data) || body.data.length !== inputs.length) throw new Error("向量接口返回的条目数不匹配");
  const result: number[][] = [];
  for (const item of body.data) {
    if (!Number.isInteger(item.index) || item.index < 0 || item.index >= inputs.length || result[item.index] || !validVector(item.embedding)) {
      throw new Error("向量接口返回的索引或 embedding 无效");
    }
    result[item.index] = item.embedding;
  }
  if (result.some((v) => v.length !== result[0].length)) throw new Error("向量接口返回了不同维度");
  return result;
}

function cosine(a: number[], b: number[]): number {
  let dot = 0, left = 0, right = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; left += a[i] ** 2; right += b[i] ** 2; }
  return dot / Math.sqrt(left * right);
}

/** 内容寻址缓存：模型/地址/维度/内容变化自动使用新索引，旧缓存不会误用。 */
export async function retrieveVectorEntries(
  config: TavernConfig, entries: WiEntry[], messages: string[], dataDir: string, signal?: AbortSignal,
): Promise<Set<string>> {
  if (!config.vectors.enabled) return new Set();
  const candidates = entries.filter((e) => e.vectorized && !e.disabled && !e.constant && e.content.trim());
  const query = messages.slice(-Math.max(1, config.vectors.queryMessages)).join("\n").trim();
  if (!query || !candidates.length) return new Set();
  const [queryVector] = await embedTexts(config, [query], signal);
  const provider = config.providers.find((p) => p.id === config.vectors.providerId)!;
  const namespace = digest(JSON.stringify([provider.baseUrl, config.vectors.model, queryVector.length]));
  const cacheDir = path.join(dataDir, ".pitavern", "vectors", namespace);
  await fs.mkdir(cacheDir, { recursive: true });
  const texts = [...new Set(candidates.map((e) => e.content))];
  const cached = new Map<string, number[]>();
  const missing: string[] = [];
  for (const text of texts) {
    signal?.throwIfAborted();
    try {
      const vector: unknown = JSON.parse(await fs.readFile(path.join(cacheDir, `${digest(text)}.json`), "utf8"));
      if (validVector(vector) && vector.length === queryVector.length) { cached.set(text, vector); continue; }
    } catch { /* 缓存不存在或损坏时重新生成。 */ }
    missing.push(text);
  }
  for (let start = 0; start < missing.length; start += 32) {
    const batch = missing.slice(start, start + 32);
    const vectors = await embedTexts(config, batch, signal);
    for (let i = 0; i < batch.length; i++) {
      if (vectors[i].length !== queryVector.length) throw new Error("查询与条目向量维度不一致，请检查 embedding 服务");
      cached.set(batch[i], vectors[i]);
      const file = path.join(cacheDir, `${digest(batch[i])}.json`);
      const temporary = `${file}.${randomUUID()}.tmp`;
      await fs.writeFile(temporary, JSON.stringify(vectors[i]));
      await fs.rename(temporary, file);
    }
  }
  return new Set(candidates.map((entry) => ({ entry, score: cosine(queryVector, cached.get(entry.content)!) }))
    .filter(({ score }) => score >= config.vectors.scoreThreshold)
    .sort((a, b) => b.score - a.score || a.entry.order - b.entry.order)
    .slice(0, config.vectors.maxEntries).map(({ entry }) => worldEntryKey(entry)));
}
