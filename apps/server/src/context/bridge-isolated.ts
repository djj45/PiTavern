import { Worker } from "node:worker_threads";
import type { TokenizerSetting } from "@pitavern/shared";
import type { AssembledContext, BridgeInput } from "./bridge.ts";

/** Run the entire synchronous scanner/regex pipeline off the HTTP/WS event loop. */
export function assembleBridgeIsolated(input: BridgeInput, modelId: string, tokenizer?: TokenizerSetting, signal?: AbortSignal, timeoutMs = 2000): Promise<AssembledContext> {
  signal?.throwIfAborted();
  const { countTokens: _countTokens, ...options } = input.options;
  const worker = new Worker(
    `const { workerData } = require('node:worker_threads');
     import('tsx/esm/api').then(({ tsImport }) => tsImport(workerData.module, workerData.parent)).catch(error => { throw error; });`,
    { eval: true, workerData: { input: { ...input, options }, modelId, tokenizer,
      module: new URL("./bridge-worker.ts", import.meta.url).href, parent: import.meta.url },
      resourceLimits: { maxOldGenerationSizeMb: 256 } },
  );
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer = setTimeout(() => finish(new Error("上下文工作线程启动超时，请重试")), 15000);
    const finish = (error?: Error, result?: AssembledContext) => {
      if (settled) return;
      settled = true; clearTimeout(timer); signal?.removeEventListener("abort", abort);
      void worker.terminate();
      if (error) reject(error); else resolve(result!);
    };
    const abort = () => finish(new Error("已停止上下文组装"));
    signal?.addEventListener("abort", abort, { once: true });
    // Check again after subscribing so an abort cannot slip between the two checks.
    if (signal?.aborted) { abort(); return; }
    worker.on("message", (message) => {
      if (settled) return;
      if (message.ready) {
        clearTimeout(timer);
        timer = setTimeout(() => finish(new Error("正则或上下文组装超时（2 秒），请简化表达式或减少世界书扫描范围；本轮未发送模型请求")), timeoutMs);
      } else if (message.error) finish(new Error(message.error));
      else if (message.assembled) {
        if (input.variables) { for (const key of Object.keys(input.variables)) delete input.variables[key]; Object.assign(input.variables, message.variables); }
        if (input.options.timed) { for (const key of Object.keys(input.options.timed)) delete (input.options.timed as unknown as Record<string, unknown>)[key]; Object.assign(input.options.timed, message.timed); }
        finish(undefined, message.assembled);
      }
    });
    worker.on("error", (error) => finish(new Error("上下文工作线程失败：" + (error instanceof Error ? error.message : String(error)))));
    worker.on("exit", () => { if (!settled) finish(new Error("上下文工作线程意外退出")); });
  });
}
