import type { DiscoveredModelDto, ModelDiscoveryRequest } from "@pitavern/shared";
import type { ProviderConfig } from "../config.ts";

const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_MODELS = 10_000;

export class ModelDiscoveryError extends Error {
  constructor(message: string, readonly status = 502) { super(message); }
}

function normalizeBaseUrl(value: unknown): string {
  try {
    if (typeof value !== "string" || value.length > 4096) throw new Error();
    const url = new URL(value.trim());
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error();
    return url.href.replace(/\/+$/, "");
  } catch {
    throw new ModelDiscoveryError("请填写有效的 HTTP(S) 接口地址，包含 /v1 等接口前缀，不含账号、查询参数或片段", 400);
  }
}

/** One explicit OpenAI-compatible GET /models; never saves or registers models. */
export async function discoverModels(
  providers: readonly ProviderConfig[],
  input: ModelDiscoveryRequest,
  options: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<DiscoveredModelDto[]> {
  const baseUrl = normalizeBaseUrl(input?.baseUrl);
  if (input.apiKey !== undefined && (typeof input.apiKey !== "string" || input.apiKey.length > 16_384)) {
    throw new ModelDiscoveryError("API Key 格式不正确", 400);
  }
  const saved = providers.find((p) => p.id === input.providerId);
  let apiKey = input.apiKey?.trim();
  if (!apiKey && saved?.apiKey) {
    // A blank field may reuse a saved credential only at its saved destination.
    if (baseUrl !== normalizeBaseUrl(saved.baseUrl)) {
      throw new ModelDiscoveryError("接口地址已更改，请重新填写 API Key 后获取模型列表", 400);
    }
    apiKey = saved.apiKey;
  }
  const timeout = AbortSignal.timeout(options.timeoutMs ?? 15_000);
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
  try {
    const response = await fetch(baseUrl + "/models", {
      headers: { Accept: "application/json", ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}) },
      redirect: "error",
      signal,
    });
    if (!response.ok) {
      await response.body?.cancel();
      const hint = response.status === 401 || response.status === 403 ? "，请检查 API Key 和访问权限"
        : response.status === 404 || response.status === 405 ? "，此服务可能不支持模型列表，请手动添加模型" : "，请稍后重试或手动添加模型";
      throw new ModelDiscoveryError(`获取模型列表失败（HTTP ${response.status}）${hint}`);
    }
    if (!response.body) throw new ModelDiscoveryError("服务未返回模型列表");
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > MAX_RESPONSE_BYTES) {
          await reader.cancel();
          throw new ModelDiscoveryError("模型列表超过 2 MiB，请手动添加模型");
        }
        chunks.push(value);
      }
    } finally { reader.releaseLock(); }
    let payload: unknown;
    try { payload = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
    catch { throw new ModelDiscoveryError("服务未返回有效 JSON 模型列表，请手动添加模型"); }
    if (!payload || typeof payload !== "object" || !("data" in payload) || !Array.isArray(payload.data)) {
      throw new ModelDiscoveryError("服务返回的模型列表格式不兼容（需要 data 数组），请手动添加模型");
    }
    if (payload.data.length > MAX_MODELS) throw new ModelDiscoveryError("模型数量超过 10000，请手动添加模型");
    const models = new Map<string, DiscoveredModelDto>();
    for (const entry of payload.data) {
      if (!entry || typeof entry !== "object" || typeof entry.id !== "string") continue;
      const id = entry.id.trim();
      if (!id || id.length > 1024 || /[\u0000-\u001f\u007f]/.test(id) || models.has(id)) continue;
      const name = typeof entry.name === "string" && entry.name.trim() && entry.name.length <= 1024 ? entry.name.trim() : id;
      models.set(id, { id, name });
    }
    if (payload.data.length && !models.size) throw new ModelDiscoveryError("模型列表中没有有效的模型 ID，请手动添加模型");
    return [...models.values()].sort((a, b) => a.id.localeCompare(b.id));
  } catch (error) {
    if (options.signal?.aborted) throw new ModelDiscoveryError("获取模型列表已取消", 499);
    if (timeout.aborted) throw new ModelDiscoveryError("获取模型列表超时，请稍后重试或手动添加模型", 504);
    if (error instanceof ModelDiscoveryError) throw error;
    throw new ModelDiscoveryError("无法连接模型列表接口，请检查地址、网络和服务状态，或手动添加模型");
  }
}
