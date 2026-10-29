import { useEffect, useRef, useState } from "react";
import type { RegexScript } from "@pitavern/shared/regex";
import { MessageContent } from "./MessageContent.tsx";
import { fieldClass, buttonClass } from "./libraryStyles.ts";

const placements = [[0, "全部显示"], [1, "用户输入"], [2, "AI 输出"], [3, "斜杠命令（保留项）"], [5, "世界书"], [6, "推理"]] as const;
export function RegexEditor({ scripts, onChange }: { scripts: RegexScript[]; onChange: (scripts: RegexScript[]) => void }) {
  const [index, setIndex] = useState(0);
  const [input, setInput] = useState("示例文本");
  const [preview, setPreview] = useState("");
  const [placement, setPlacement] = useState(2);
  const [depth, setDepth] = useState(0);
  const [layer, setLayer] = useState<"display" | "prompt">("display");
  const [char, setChar] = useState("角色");
  const [user, setUser] = useState("旅人");
  const [error, setError] = useState("");
  const [running, setRunning] = useState(false);
  const worker = useRef<Worker | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => { worker.current?.terminate(); clearTimeout(timer.current); }, []);
  const script = scripts[index];
  const patch = (value: Partial<RegexScript>) => onChange(scripts.map((s, i) => i === index ? { ...s, ...value } : s));
  const move = (direction: number) => {
    const next = [...scripts]; const other = index + direction;
    [next[index], next[other]] = [next[other], next[index]]; onChange(next); setIndex(other);
  };
  const run = () => {
    worker.current?.terminate(); clearTimeout(timer.current); setError(""); setRunning(true); setPreview("");
    const current = new Worker(new URL("../regexPreview.worker.ts", import.meta.url), { type: "module" });
    worker.current = current;
    const finish = () => { current.terminate(); worker.current = null; clearTimeout(timer.current); setRunning(false); };
    current.onmessage = (event: MessageEvent<{ text?: string; error?: string }>) => { finish(); setPreview(event.data.text ?? ""); setError(event.data.error ?? ""); };
    current.onerror = () => { finish(); setError("预览执行失败"); };
    timer.current = setTimeout(() => { finish(); setError("预览超时，请简化表达式或缩短输入"); }, 1500);
    current.postMessage({ text: input, scripts, context: { placement, depth, layer, env: { char, user, variables: {}, readOnly: true } } });
  };
  return <div className="space-y-4">
    <p className="text-xs leading-5 text-tavern-dim">执行顺序：全局 → 当前预设 → 当前角色卡。提示词正则参与 ST 桥接模式，显示正则适用于全部模式，存档保留原文。预览只测试本来源的脚本。</p>
    <div className="flex flex-wrap items-end gap-2">
      <label className="min-w-0 flex-1">脚本（{scripts.length}）<select aria-label="正则脚本" value={scripts.length ? index : ""} onChange={(e) => setIndex(Number(e.target.value))} className={fieldClass}>
        {!scripts.length && <option value="">暂无脚本</option>}{scripts.map((s, i) => <option key={i} value={i}>{s.disabled ? "⏸ " : ""}{s.scriptName || `脚本 ${i + 1}`}</option>)}
      </select></label>
      <button type="button" onClick={() => { onChange([...scripts, { id: crypto.randomUUID(), scriptName: "新脚本", findRegex: "", replaceString: "", placement: [2], disabled: true }]); setIndex(scripts.length); }} className={buttonClass}>新增脚本</button>
      <button type="button" disabled={!script} onClick={() => { onChange(scripts.filter((_, i) => i !== index)); setIndex(Math.max(0, index - 1)); }} className={buttonClass}>删除脚本</button>
      <button type="button" aria-label="脚本上移" disabled={!script || index === 0} onClick={() => move(-1)} className={buttonClass}>↑</button>
      <button type="button" aria-label="脚本下移" disabled={!script || index === scripts.length - 1} onClick={() => move(1)} className={buttonClass}>↓</button>
    </div>
    {script && <>
      <label className="block">脚本名称<input value={script.scriptName ?? ""} onChange={(e) => patch({ scriptName: e.target.value })} className={fieldClass} /></label>
      <label className="block">查找表达式<textarea aria-label="查找表达式" rows={2} value={script.findRegex} onChange={(e) => patch({ findRegex: e.target.value })} placeholder="/pattern/gs" className={fieldClass + " font-mono"} /></label>
      <label className="block">替换内容<textarea aria-label="替换内容" rows={4} value={script.replaceString} onChange={(e) => patch({ replaceString: e.target.value })} className={fieldClass + " font-mono"} /></label>
      <div className="flex flex-wrap gap-4">
        <label className="flex items-center gap-2"><input type="checkbox" checked={!script.disabled} onChange={(e) => patch({ disabled: !e.target.checked })} />启用脚本</label>
        {placements.map(([value, label]) => <label key={value} className="flex items-center gap-2"><input type="checkbox" checked={script.placement.includes(value)} onChange={(e) => patch({ placement: e.target.checked ? [...script.placement, value] : script.placement.filter((p) => p !== value) })} />{label}</label>)}
      </div>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <label>作用层<select className={fieldClass} value={script.markdownOnly && !script.promptOnly ? "display" : script.promptOnly && !script.markdownOnly ? "prompt" : "both"}
          onChange={(e) => patch({ markdownOnly: e.target.value === "display", promptOnly: e.target.value === "prompt" })}><option value="both">显示与提示词</option><option value="display">仅显示</option><option value="prompt">仅提示词</option></select></label>
        <label>查找宏替换<select className={fieldClass} value={script.substituteRegex ?? 0} onChange={(e) => patch({ substituteRegex: Number(e.target.value) })}><option value={0}>关闭</option><option value={1}>原文替换</option><option value={2}>转义替换</option></select></label>
        {(["minDepth", "maxDepth"] as const).map((key, i) => <label key={key}>{i ? "最大深度" : "最小深度"}<input type="number" min={-1} step={1} placeholder="不限" className={fieldClass} value={script[key] ?? ""} onChange={(e) => patch({ [key]: e.target.value === "" ? null : Number(e.target.value) })} /></label>)}
      </div>
      <label className="block">捕获内容裁剪（每行一项）<textarea rows={2} className={fieldClass} value={(script.trimStrings ?? []).join("\n")} onChange={(e) => patch({ trimStrings: e.target.value.split("\n") })} /></label>
    </>}
    <details className="rounded-lg border border-tavern-border p-3" open><summary className="cursor-pointer">预览本来源脚本</summary>
      <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-3">
        <label>预览层<select className={fieldClass} value={layer} onChange={(e) => setLayer(e.target.value as typeof layer)}><option value="display">显示</option><option value="prompt">提示词</option></select></label>
        <label>文本类型<select className={fieldClass} value={placement} onChange={(e) => setPlacement(Number(e.target.value))}>{placements.map(([n, label]) => <option key={n} value={n}>{label}</option>)}</select></label>
        <label>深度<input type="number" min={0} step={1} value={depth} onChange={(e) => setDepth(Number(e.target.value))} className={fieldClass} /></label>
        <label>角色名<input className={fieldClass} value={char} onChange={(e) => setChar(e.target.value)} /></label>
        <label>用户名<input className={fieldClass} value={user} onChange={(e) => setUser(e.target.value)} /></label>
      </div>
      <label className="mt-3 block">测试文本<textarea aria-label="正则测试文本" rows={4} maxLength={10000} value={input} onChange={(e) => setInput(e.target.value)} className={fieldClass} /></label>
      <button type="button" disabled={running} onClick={run} className={buttonClass + " mt-3"}>{running ? "预览中…" : "运行预览"}</button>
      {error && <p role="alert" className="mt-3 text-red-400">{error}</p>}
      <div aria-label="正则预览结果" className="mt-3 break-words rounded-lg bg-tavern-bg p-3"><MessageContent text={preview} /></div>
      <p className="mt-2 text-xs text-tavern-dim">预览使用独立线程与只读变量，不会修改聊天。更改脚本后请重新运行预览。</p>
    </details>
  </div>;
}
