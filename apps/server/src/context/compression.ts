import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { buildWorkingContext } from "./working-set.ts";
export { contextChars } from "./working-set.ts";
export interface CompressionConfig {
  enabled: boolean;
  /** 按用户发言划分轮次，工具调用不额外占一轮。 */
  keepFullTurns: number;
}
export type CompressionResult = Pick<ReturnType<typeof buildWorkingContext>, "messages" | "stats">;
export function inputBudgetChars(contextWindow: number, maxTokens: number): number {
  return Math.max(1, Math.floor((contextWindow - maxTokens) * 1.5 * 0.9));
}
/** Compatibility entry point; production and verification use the same pure working-set builder. */
export function compressHistory(messages: AgentMessage[], config: CompressionConfig, budget: number,
  measure?: (messages: AgentMessage[]) => number): CompressionResult {
  return buildWorkingContext({ messages, config, budget, measure });
}
