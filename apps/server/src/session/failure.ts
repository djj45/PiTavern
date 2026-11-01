import type { GenerationRecordDto } from "@pitavern/shared";

/** Only fixed labels cross the player boundary: provider errors may echo secrets or credentials. */
export function generationFailure(cause: unknown): { code: NonNullable<GenerationRecordDto["failureCode"]>; publicMessage: string } {
  const detail = cause instanceof Error ? cause.message : String(cause);
  const prefix = "本轮生成未完成，世界与知识未提交。";
  if (/模型输出为空|未返回正文|正文为空|empty (?:model )?(?:response|output)/i.test(detail)) {
    return { code: "output", publicMessage: prefix + "模型未返回可用正文，可能只有思考或空内容。可重试本轮，或切换支持工具调用的模型连接。" };
  }
  if (/Stream ended without finish_reason/i.test(detail)) {
    return { code: "provider", publicMessage: prefix + "模型响应流缺少完成标记，请检查中转的流式输出兼容性或切换连接。" };
  }
  const code = /预算/.test(detail) ? "budget" : /正文阶段禁止|正文输出被截断/.test(detail) ? "output" :
    /变化|冲突|修改/.test(detail) ? "conflict" : /叙事计划|叙事数据包|引用/.test(detail) ? "plan" : "provider";
  return { code, publicMessage: prefix };
}
