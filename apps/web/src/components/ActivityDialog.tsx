import { useEffect, useState } from "react";
import type { ChatActivityDto, ContextDiagnosticsDto, GenerationRecordDto } from "@pitavern/shared";
import { api } from "../api.ts";
import { TOOL_META } from "../chatItems.ts";

export const GENERATION_STATUS: Record<GenerationRecordDto["status"], string> = {
  running: "生成中", succeeded: "成功", failed: "失败", aborted: "已停止", interrupted: "服务中断",
};
const KIND = { send: "发送", regenerate: "重新生成", retry: "重试" };
const number = (value: number) => value.toLocaleString("zh-CN");

export function ContextDiagnostics({ context }: { context: ContextDiagnosticsDto }) {
  const [filter, setFilter] = useState("all");
  const [query, setQuery] = useState("");
  const decisions = context.assembly.worldInfo.filter((entry) => (filter === "all" || entry.status === filter) &&
    `${entry.world} ${entry.label} ${entry.reason}`.toLowerCase().includes(query.toLowerCase()));
  const counts = [
    ["模型上下文", context.contextWindow], ["输出预留", context.outputReserved], ["安全余量", context.safetyMargin],
    ["可用输入预算", context.inputBudget], ["压缩前", context.beforeTokens], ["发送前", context.afterTokens],
  ] as const;
  return <section aria-label="上下文诊断" className="space-y-3">
    <h3 className="font-medium text-tavern-accent">上下文诊断 · 第 {context.request} 次请求</h3>
    <p className="text-xs text-tavern-dim">计数方式：{context.tokenizer}。{context.counting === "tokenizer"
      ? "正文使用 tokenizer 计数，聊天封装和工具开销仍为估算；账单以接口回传为准。"
      : "当前模型未匹配编码器，以下为估算；可在模型设置中指定计数方式。"}</p>
    <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm">{counts.map(([label, value]) =>
      <div key={label} className="flex justify-between gap-2"><dt className="text-tavern-dim">{label}</dt><dd>{number(value)}</dd></div>)}</dl>
    <p className={context.overBudget ? "text-sm text-amber-300" : "text-xs text-tavern-dim"}>
      {context.overBudget ? "超过输入预算，本次请求未发送。" : "输入预算内。"}
      {context.compressedMessages ? ` 压缩了 ${context.compressedTurns} 轮、${context.compressedMessages} 条旧消息。` : " 未压缩历史。"}
      {context.assembly.omittedHistoryMessages > 0 && ` 接管窗口另省略 ${context.assembly.omittedHistoryMessages} 条旧消息。`}
    </p>
    <dl className="grid grid-cols-2 gap-1 rounded border border-tavern-border p-3 text-xs">
      {([ ["系统提示", context.breakdown.system], ["对话及工具结果", context.breakdown.conversation],
        ["工具声明", context.breakdown.tools], ["消息/模板封装", context.breakdown.framing] ] as const).map(([label, value]) =>
        <div key={label} className="flex justify-between gap-2 pr-2"><dt className="text-tavern-dim">{label}</dt><dd>{number(value)}</dd></div>)}
    </dl>
    <div>
      <h4 className="mb-2 text-sm">世界书组装筛选 · {context.assembly.worldInfoTotal} 条</h4>
      <div className="mb-2 flex flex-wrap gap-2 text-xs">
        <select aria-label="世界书筛选状态" value={filter} onChange={(event) => setFilter(event.target.value)}
          className="rounded border border-tavern-border bg-tavern-bg p-1.5">
          <option value="all">全部</option><option value="included">已注入</option><option value="skipped">未注入</option>
        </select>
        <input aria-label="查找世界书诊断" placeholder="按世界书、关键词或原因查找" value={query} onChange={(event) => setQuery(event.target.value)}
          className="min-w-0 flex-1 rounded border border-tavern-border bg-tavern-bg p-1.5" />
      </div>
      <ul className="max-h-60 space-y-2 overflow-y-auto text-xs">{decisions.map((entry, index) =>
        <li key={`${entry.world}:${entry.uid}:${index}`} className="rounded border border-tavern-border p-2">
          <span className={entry.status === "included" ? "text-tavern-accent" : "text-tavern-dim"}>{entry.status === "included" ? "已注入" : "未注入"}</span>
          <span className="ml-2 break-words">{entry.world} / {entry.label}</span>
          <p className="mt-1 text-tavern-dim">{entry.reason}{entry.tokens !== undefined ? ` · ${number(entry.tokens)} tokens` : ""}</p>
        </li>)}</ul>
      {!decisions.length && <p className="text-xs text-tavern-dim">没有符合筛选条件的条目。</p>}
      {context.assembly.worldInfoTotal > context.assembly.worldInfo.length && <p className="mt-2 text-xs text-tavern-dim">诊断保留前 {context.assembly.worldInfo.length} 条；其余条目仍按正常规则处理。</p>}
    </div>
  </section>;
}

export function ActivityDialog({ chatId, activity, onClose }: { chatId: string; activity: ChatActivityDto; onClose: () => void }) {
  const [older, setOlder] = useState<GenerationRecordDto[]>([]);
  const [before, setBefore] = useState(activity.before);
  const [selected, setSelected] = useState(activity.records[0]?.id);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const map = new Map(older.map((record) => [record.id, record]));
  for (const record of activity.records) map.set(record.id, record);
  const records = [...map.values()].sort((a, b) => b.id.localeCompare(a.id));
  const run = records.find((record) => record.id === selected) ?? records[0];
  useEffect(() => {
    setOlder((previous) => {
      const merged = new Map(previous.map((record) => [record.id, record]));
      for (const record of activity.records) merged.set(record.id, record);
      return [...merged.values()];
    });
  }, [activity.records]);
  useEffect(() => {
    const listener = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    window.addEventListener("keydown", listener);
    return () => window.removeEventListener("keydown", listener);
  }, [onClose]);
  const load = async () => {
    if (!before || loading) return;
    setLoading(true); setError("");
    try {
      const page = await api.activity(chatId, before);
      setOlder((previous) => [...previous, ...page.records]); setBefore(page.before);
    } catch (cause) { setError((cause as Error).message); }
    finally { setLoading(false); }
  };
  return <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-3" onClick={onClose}>
    <div role="dialog" aria-modal="true" aria-labelledby="activity-title" onClick={(event) => event.stopPropagation()}
      className="flex max-h-[92vh] w-full max-w-4xl flex-col rounded-xl border border-tavern-border bg-tavern-panel p-4 shadow-xl">
      <div className="mb-3 flex items-center justify-between"><h2 id="activity-title" className="font-medium">生成记录与上下文诊断</h2>
        <button autoFocus type="button" onClick={onClose} aria-label="关闭生成记录" className="rounded border border-tavern-border px-2 py-1 text-sm">关闭</button></div>
      <p className="mb-3 text-xs text-tavern-dim">共 {activity.totalGenerations} 次生成。失败、停止与候选切换均保留已发生的记录；旧版和导入聊天的历史用量无法补算。</p>
      <div className="flex min-h-0 flex-col gap-4 overflow-y-auto md:grid md:grid-cols-[13rem_1fr]">
        <nav aria-label="生成记录列表" className="max-h-44 shrink-0 space-y-2 overflow-y-auto md:max-h-none">
          {records.map((record) => <button key={record.id} type="button" onClick={() => setSelected(record.id)}
            className={`block w-full rounded border p-2 text-left text-xs ${run?.id === record.id ? "border-tavern-accent bg-tavern-accent/10" : "border-tavern-border"}`}>
            {KIND[record.kind]} · {GENERATION_STATUS[record.status]}<span className="mt-1 block text-tavern-dim">{new Date(record.startedAt).toLocaleString()}</span>
            <span className="mt-1 block break-all">{record.model} · {number(record.usage.totalTokens)} tokens</span>
          </button>)}
          {before && <button type="button" onClick={() => void load()} disabled={loading} className="w-full rounded border border-tavern-border p-2 text-xs">{loading ? "加载中…" : "加载更早的生成记录"}</button>}
          {error && <p role="alert" className="text-xs text-red-300">{error}</p>}
        </nav>
        {run ? <div className="min-w-0 space-y-4">
          <p className="text-sm">{KIND[run.kind]} · {GENERATION_STATUS[run.status]} · {run.provider} / {run.model}</p>
          {run.error && <p className="break-words text-xs text-amber-300">{run.error}</p>}
          <p className="text-xs text-tavern-dim">接口回传：输入 {number(run.usage.input)} · 输出 {number(run.usage.output)} · 缓存读取 {number(run.usage.cacheRead)} · 缓存写入 {number(run.usage.cacheWrite)} · 合计 {number(run.usage.totalTokens)} tokens。{run.usage.responsesWithUsage}/{run.usage.responses} 次模型响应含非零用量。</p>
          {run.context ? <ContextDiagnostics context={run.context} /> : <p className="text-xs text-tavern-dim">尚无请求诊断，可能在组装上下文前已结束。</p>}
          <section><h3 className="mb-2 text-sm">本次工具活动 · {run.tools.length} 次</h3>
            {run.tools.map((tool) => <details key={tool.key} className="mb-2 rounded border border-tavern-border p-2 text-xs">
              <summary className="cursor-pointer break-words">{TOOL_META[tool.toolName]?.label ?? tool.toolName} · {tool.status === "running" ? "调用中" : tool.status === "error" ? "失败" : "完成"}{tool.durationMs !== undefined ? ` · ${tool.durationMs}ms` : ""}</summary>
              {tool.summary && <p className="my-2 break-words">{tool.summary}</p>}
              <pre className="max-h-52 overflow-auto whitespace-pre-wrap break-all text-tavern-dim">{JSON.stringify(tool.args, null, 2)}</pre>
            </details>)}
          </section>
        </div> : <p className="text-sm text-tavern-dim">还没有生成记录。</p>}
      </div>
    </div>
  </div>;
}
