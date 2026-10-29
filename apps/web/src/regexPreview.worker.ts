import { applyRegex, parseFindRegex, type RegexContext, type RegexScript } from "@pitavern/shared/regex";

self.onmessage = (event: MessageEvent<{ text: string; scripts: RegexScript[]; context: RegexContext; strict?: boolean }>) => {
  try {
    for (const script of event.data.scripts) {
      if (event.data.strict && !script.disabled && !Number(script.substituteRegex) && !parseFindRegex(script.findRegex)) throw new Error(`无效表达式：${script.scriptName || script.findRegex}`);
    }
    self.postMessage({ text: applyRegex(event.data.text, event.data.scripts, event.data.context) });
  } catch (cause) { self.postMessage({ error: (cause as Error).message }); }
};
