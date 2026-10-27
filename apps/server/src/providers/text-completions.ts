import type { AssistantMessage, ProviderStreams } from "@earendil-works/pi-ai";
import { AssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";
import { getCurrentTools } from "@earendil-works/pi-ai/utils/transcript";
import type { InstructTemplate } from "@pitavern/shared";
import { renderInstruct } from "../context/instruct.ts";

/** 将 OpenAI 兼容 /completions 适配到 pi 事件流，保持停止/错误/用量协议一致。 */
export function textCompletionsApi(template: InstructTemplate, defaultUser: string): ProviderStreams {
  const stream: ProviderStreams["stream"] = (model, context, options = {}) => {
    const events = new AssistantMessageEventStream();
    const message: AssistantMessage = {
      role: "assistant", api: model.api, provider: model.provider, model: model.id,
      content: [], stopReason: "stop", timestamp: Date.now(),
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    };
    void (async () => {
      let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
      try {
        if (getCurrentTools(context.messages).length) throw new Error("文本补全接口不支持工具调用");
        const sampling = options.samplingParams ?? {};
        const { prompt, stop } = renderInstruct(context.messages, template, {
          char: typeof sampling.pitavern_char === "string" ? sampling.pitavern_char : "Assistant",
          user: typeof sampling.pitavern_user === "string" ? sampling.pitavern_user : defaultUser,
        });
        const params: Record<string, unknown> = {};
        for (const key of ["top_p", "top_k", "min_p", "frequency_penalty", "presence_penalty", "repetition_penalty"]) {
          if (typeof sampling[key] === "number") params[key] = sampling[key];
        }
        const timeout = AbortSignal.timeout(options.timeoutMs ?? 120_000);
        const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
        const response = await (options.fetch ?? fetch)(`${model.baseUrl.replace(/\/+$/, "")}/completions`, {
          method: "POST", signal,
          headers: { "Content-Type": "application/json", ...(options.apiKey ? { Authorization: `Bearer ${options.apiKey}` } : {}) },
          body: JSON.stringify({ ...params, model: model.id, prompt, stream: true, max_tokens: options.maxTokens ?? model.maxTokens,
            ...(options.temperature !== undefined ? { temperature: options.temperature } : {}), ...(stop.length ? { stop } : {}) }),
        });
        if (!response.ok) throw new Error(`文本补全接口返回 HTTP ${response.status}`);
        const block = { type: "text" as const, text: "" };
        message.content.push(block);
        events.push({ type: "start", partial: message });
        events.push({ type: "text_start", contentIndex: 0, partial: message });
        let complete = false;
        const consume = (raw: string) => {
          if (raw.trim() === "[DONE]") { complete = true; return; }
          const data = JSON.parse(raw) as { error?: unknown; choices?: Array<{ index?: number; text?: string; finish_reason?: string | null }>; usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } };
          if (data.error) throw new Error("文本补全接口返回生成错误");
          const choice = data.choices?.find((c) => c.index === 0 || c.index === undefined);
          if (typeof choice?.text === "string" && choice.text) {
            block.text += choice.text;
            events.push({ type: "text_delta", contentIndex: 0, delta: choice.text, partial: message });
          }
          if (choice?.finish_reason) {
            complete = true;
            message.stopReason = choice.finish_reason === "length" ? "length" : "stop";
          }
          if (data.usage) {
            message.usage.input = data.usage.prompt_tokens ?? 0;
            message.usage.output = data.usage.completion_tokens ?? 0;
            message.usage.totalTokens = data.usage.total_tokens ?? message.usage.input + message.usage.output;
          }
        };
        if (response.headers.get("content-type")?.includes("application/json")) {
          consume(await response.text());
          if (!complete && block.text) complete = true;
        } else {
          if (!response.body) throw new Error("文本补全接口没有响应流");
          reader = response.body.getReader();
          const decoder = new TextDecoder();
          let buffer = "";
          let doneMarker = false;
          const flush = (eof = false) => {
            buffer = buffer.replace(/\r\n/g, "\n");
            let boundary: number;
            while ((boundary = buffer.indexOf("\n\n")) >= 0 || (eof && buffer.trim())) {
              if (boundary < 0) boundary = buffer.length;
              const frame = buffer.slice(0, boundary);
              buffer = buffer.slice(boundary + 2);
              const data = frame.split("\n").filter((s) => s.startsWith("data:")).map((s) => s.slice(5).trimStart()).join("\n");
              if (data) { consume(data); if (data.trim() === "[DONE]") doneMarker = true; }
            }
          };
          while (!doneMarker) {
            const { value, done } = await reader.read();
            buffer += decoder.decode(value, { stream: !done });
            flush(done);
            if (done) break;
          }
        }
        options.signal?.throwIfAborted();
        if (!complete) throw new Error("文本补全响应流提前结束，请重试");
        events.push({ type: "text_end", contentIndex: 0, content: block.text, partial: message });
        events.push({ type: "done", reason: message.stopReason as "stop" | "length", message });
      } catch (error) {
        message.stopReason = options.signal?.aborted ? "aborted" : "error";
        message.errorMessage = error instanceof Error ? error.message : String(error);
        events.push({ type: "error", reason: message.stopReason, error: message });
      } finally {
        await reader?.cancel().catch(() => {});
        events.end();
      }
    })();
    return events;
  };
  return { stream, streamSimple: stream };
}
