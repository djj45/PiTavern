import type { Message } from "@earendil-works/pi-ai";
import { contentText, getSystemMessageText } from "@earendil-works/pi-ai/utils/text";
import { INSTRUCT_TEMPLATES, type InstructTemplate } from "@pitavern/shared";
import { substituteMacros } from "./macros.ts";

/** 接受 ST instruct 导出的字段；不把 context/story-string 预设误当 instruct。 */
export function normalizeInstruct(raw: unknown): InstructTemplate {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("instruct 预设必须是 JSON 对象");
  const value = raw as Record<string, unknown>;
  for (const key of ["input_sequence", "output_sequence"]) {
    if (typeof value[key] !== "string") throw new Error(`instruct 预设缺少 ${key}`);
  }
  const result: InstructTemplate = {
    name: "自定义", input_sequence: "", output_sequence: "", system_sequence: "",
    input_suffix: "", output_suffix: "", system_suffix: "", stop_sequence: "",
    wrap: false, macro: true, names_behavior: "none", system_same_as_user: false, sequences_as_stop_strings: true,
  };
  const strings = ["name", "input_sequence", "output_sequence", "system_sequence", "input_suffix", "output_suffix", "system_suffix",
    "first_input_sequence", "last_input_sequence", "first_output_sequence", "last_output_sequence", "last_system_sequence", "stop_sequence",
    "story_string_prefix", "story_string_suffix", "user_alignment_message"] as const;
  for (const key of strings) {
    if (value[key] !== undefined && typeof value[key] !== "string") throw new Error(`instruct.${key} 必须是字符串`);
    if (typeof value[key] === "string") result[key] = value[key];
  }
  for (const key of ["wrap", "macro", "system_same_as_user", "sequences_as_stop_strings"] as const) {
    if (value[key] !== undefined && typeof value[key] !== "boolean") throw new Error(`instruct.${key} 必须是布尔值`);
    if (typeof value[key] === "boolean") result[key] = value[key];
  }
  if (value.names_behavior === "none" || value.names_behavior === "always" || value.names_behavior === "force") result.names_behavior = value.names_behavior;
  return result;
}

export function renderInstruct(
  messages: Message[], template: InstructTemplate = INSTRUCT_TEMPLATES.ChatML,
  names = { char: "Assistant", user: "User" },
): { prompt: string; stop: string[] } {
  const expand = (text: string, name: string) => template.macro
    ? substituteMacros(text.replace(/\{\{name\}\}/gi, () => name), { ...names, readOnly: true }) : text;
  const separator = template.wrap ? "\n" : "";
  let story = "";
  if (template.story_string_prefix !== undefined || template.story_string_suffix !== undefined) {
    const count = messages.findIndex((m) => m.role !== "system");
    const headCount = count < 0 ? messages.length : count;
    const head = messages.slice(0, headCount).map((m) => getSystemMessageText(m as Extract<Message, { role: "system" }>)).join("\n");
    if (head) story = (template.story_string_prefix ? expand(template.story_string_prefix, "System") + separator : "") +
      head + expand(template.story_string_suffix ?? "", "System");
    messages = messages.slice(headCount);
  }
  const firstConversation = messages.findIndex((m) => m.role !== "system");
  if (firstConversation >= 0 && messages[firstConversation].role === "assistant" && template.user_alignment_message) {
    messages = [...messages];
    messages.splice(firstConversation, 0, { role: "user", content: expand(template.user_alignment_message, names.user), timestamp: 0 });
  }
  const firstUser = messages.findIndex((m) => m.role === "user");
  const firstAssistant = messages.findIndex((m) => m.role === "assistant");
  const lastUser = messages.findLastIndex((m) => m.role === "user");
  const chunks = messages.map((message, index) => {
    if (message.role === "toolResult" || (message.role === "assistant" && message.content.some((c) => c.type === "toolCall"))) {
      throw new Error("文本补全接口不支持工具调用历史，请使用聊天补全接口");
    }
    const user = message.role === "user";
    const system = message.role === "system";
    const name = system ? "System" : user ? names.user : names.char;
    let prefix = system ? (template.system_same_as_user ? template.input_sequence : template.system_sequence)
      : user ? template.input_sequence : template.output_sequence;
    if (user) {
      if (index === firstUser && template.first_input_sequence) prefix = template.first_input_sequence;
      else if (index === lastUser && template.last_input_sequence) prefix = template.last_input_sequence;
    } else if (!system && index === firstAssistant && template.first_output_sequence) prefix = template.first_output_sequence;
    const suffix = system ? (template.system_same_as_user ? template.input_suffix : template.system_suffix)
      : user ? template.input_suffix : template.output_suffix;
    const content = system ? getSystemMessageText(message) : contentText(message.content);
    const named = !system && template.names_behavior === "always" ? `${name}: ${content}` : content;
    return [expand(prefix, name), named + (expand(suffix, name) || separator)].filter(Boolean).join(separator);
  });
  const prefix = expand(template.last_output_sequence || template.output_sequence, names.char);
  let tail = template.names_behavior === "always" ? `${separator}${prefix}${separator}${names.char}:`
    : `${separator}${prefix}`;
  if (template.wrap) tail = tail.trimEnd();
  if (template.names_behavior !== "always") tail += separator;
  const sequences = [template.stop_sequence];
  if (template.sequences_as_stop_strings) sequences.push(
    expand(template.input_sequence, names.user), expand(template.output_sequence, names.char),
    expand(template.first_output_sequence ?? "", names.char), expand(template.last_output_sequence ?? "", names.char),
    expand(template.system_sequence, "System"), expand(template.last_system_sequence ?? "", "System"),
  );
  const stop = [...new Set(sequences.flatMap((s) => s.split("\n")).filter((s) => s.trim()).map((s) => separator + expand(s, names.char)))];
  return { prompt: story + chunks.join("") + tail, stop };
}
