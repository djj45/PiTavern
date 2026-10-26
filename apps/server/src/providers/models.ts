import {
  createModels,
  createProvider,
  type ApiKeyAuth,
  type Model,
  type Models,
} from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import type { ProviderConfig, TavernConfig } from "../config.ts";

/** 从 apiKey 固定解析的 auth（密钥来自 config.json，不进交互登录流程） */
function staticApiKeyAuth(providerName: string, apiKey: string | undefined): ApiKeyAuth {
  return {
    name: `${providerName} API Key`,
    login: async () => {
      throw new Error(`请在 PiTavern 设置中填写 ${providerName} 的 API Key`);
    },
    resolve: async () => (apiKey ? { auth: { apiKey } } : undefined),
  };
}

/** 把配置里的中转列表变成 pi Models 集合；配置变更后重建 */
export function buildModels(config: TavernConfig): Models {
  const models = createModels();
  for (const p of config.providers) {
    if (!p.baseUrl || p.models.length === 0) continue;
    const provider = createProvider({
      id: p.id,
      name: p.name || p.id,
      baseUrl: p.baseUrl,
      auth: { apiKey: staticApiKeyAuth(p.name || p.id, p.apiKey) },
      models: p.models.map(
        (m): Model<"openai-completions"> => ({
          id: m.id,
          name: m.name || m.id,
          api: "openai-completions",
          provider: p.id,
          baseUrl: p.baseUrl,
          reasoning: m.reasoning ?? false,
          input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: m.contextWindow ?? 1_000_000,
          maxTokens: m.maxTokens ?? 16_384,
          // 中转站普遍只认旧字段 max_tokens，覆盖 pi-ai 的自动探测
          compat: { maxTokensField: "max_tokens" },
        }),
      ),
      api: openAICompletionsApi(),
    });
    models.setProvider(provider);
  }
  return models;
}

export function resolveModel(models: Models, config: TavernConfig): Model<"openai-completions"> {
  const model = models.getModel(config.defaultProvider, config.defaultModel);
  if (!model) {
    const available = models
      .getModels()
      .map((m) => `${m.provider}/${m.id}`)
      .join(", ");
    throw new Error(
      available
        ? `默认模型 ${config.defaultProvider}/${config.defaultModel} 不存在。可用: ${available}`
        : "尚未配置任何模型连接，请先在设置里添加中转/供应商",
    );
  }
  return model as Model<"openai-completions">;
}

export function providerDtoList(config: TavernConfig) {
  return config.providers.map((p: ProviderConfig) => ({
    id: p.id,
    name: p.name,
    baseUrl: p.baseUrl,
    hasApiKey: Boolean(p.apiKey),
    models: p.models.map((m) => ({
      id: m.id,
      name: m.name,
      reasoning: m.reasoning ?? false,
      contextWindow: m.contextWindow ?? 1_000_000,
      maxTokens: m.maxTokens ?? 16_384,
    })),
  }));
}
