import { parentPort, workerData } from "node:worker_threads";
import { assembleBridgeContext, type BridgeInput } from "./bridge.ts";
import { createTokenCounter } from "./tokens.ts";
import type { TokenizerSetting } from "@pitavern/shared";

const { input, modelId, tokenizer } = workerData as { input: BridgeInput; modelId: string; tokenizer?: TokenizerSetting };
try {
  input.options.countTokens = createTokenCounter(modelId, tokenizer).count;
  parentPort!.postMessage({ ready: true });
  const assembled = assembleBridgeContext(input);
  parentPort!.postMessage({ assembled, variables: input.variables, timed: input.options.timed });
} catch (cause) { parentPort!.postMessage({ error: cause instanceof Error ? cause.message : String(cause) }); }
