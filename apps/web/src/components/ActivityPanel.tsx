import { memo } from "react";
import { isToolItem, TOOL_META, type ChatItem } from "../chatItems.ts";

import type { UsageStats } from "../chatState.ts";

interface ActivityPanelProps {
  items: ChatItem[];
  usage: UsageStats;
  projection?: string;
  onClose?: () => void;
}

function fmt(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

export const ActivityPanel = memo(function ActivityPanel({ items, usage, projection, onClose }: ActivityPanelProps) {
  const tools = items.filter(isToolItem);
  const byTool = new Map<string, number>();
  for (const t of tools) byTool.set(t.toolName, (byTool.get(t.toolName) ?? 0) + 1);
  const recalls = tools.filter((t) => t.toolName === "tavern_recall_history");
  const refused = recalls.filter((t) => t.summary?.startsWith("被拒")).length;
  const fullReads = recalls.filter((t) => t.summary?.includes("完整正文")).length;

  return (
    // 小屏为右侧浮层（可关闭），lg 起为常驻侧栏
    <aside className="fixed inset-y-0 right-0 z-40 flex w-72 max-w-[85vw] flex-col overflow-y-auto border-l border-tavern-border bg-tavern-panel p-4 text-shadow-sm shadow-2xl lg:static lg:z-auto lg:max-w-none lg:shadow-none">
      <h3 className="mb-3 flex items-center gap-2 font-medium text-tavern-accent">
        本轮活动
        {onClose && (
          <button type="button" onClick={onClose} className="ml-auto rounded border border-tavern-border px-1.5 text-xs text-tavern-dim hover:text-tavern-text lg:hidden">
            ✕
          </button>
        )}
      </h3>

      {projection && (
        <section className="mb-5">
          <h4 className="mb-2 text-xs font-medium text-tavern-dim">现场状态投影（每轮结算更新）</h4>
          <p className="whitespace-pre-wrap rounded-lg border border-tavern-accent/30 bg-tavern-accent/5 px-3 py-2 text-xs leading-5 text-tavern-text">
            {projection}
          </p>
        </section>
      )}

      <section className="mb-5">
        <h4 className="mb-2 text-xs font-medium text-tavern-dim">用量统计</h4>
        <dl className="grid grid-cols-2 gap-y-1.5 text-tavern-text">
          <dt className="text-tavern-dim">对话轮次</dt>
          <dd className="text-right">{usage.turns}</dd>
          <dt className="text-tavern-dim">输入 tokens</dt>
          <dd className="text-right">{fmt(usage.input)}</dd>
          <dt className="text-tavern-dim">输出 tokens</dt>
          <dd className="text-right">{fmt(usage.output)}</dd>
          <dt className="text-tavern-dim">合计</dt>
          <dd className="text-right font-medium">{fmt(usage.totalTokens)}</dd>
        </dl>
      </section>

      <section className="mb-5">
        <h4 className="mb-2 text-xs font-medium text-tavern-dim">工具调用（本次会话）</h4>
        {byTool.size === 0 ? (
          <p className="text-xs text-tavern-dim">还没有工具调用。角色缺少设定或需要回忆旧剧情时会自动调用。</p>
        ) : (
          <ul className="flex flex-col gap-1.5">
            {[...byTool.entries()].map(([name, count]) => (
              <li key={name} className="flex items-center justify-between">
                <span className="text-tavern-text">
                  {TOOL_META[name]?.icon ?? "🔧"} {TOOL_META[name]?.label ?? name}
                </span>
                <span className="text-tavern-dim">×{count}</span>
              </li>
            ))}
          </ul>
        )}
        {recalls.length > 0 && (
          <p className="mt-2 text-xs text-tavern-dim">
            召回 {recalls.length} 次（完整正文 {fullReads}、被限额拒绝 {refused}）
            <br />
            预算：每轮 ≤6 次；读完整正文后冷却 10 轮（运行时强制）
          </p>
        )}
      </section>

      <section>
        <h4 className="mb-2 text-xs font-medium text-tavern-dim">机制说明</h4>
        <ul className="list-disc space-y-1 pl-4 text-xs leading-5 text-tavern-dim">
          <li>世界书未注入的资料由模型按需检索，零命中不等于不存在</li>
          <li>召回制历史：token 随"这轮需要什么"增长，而不是随历史长度</li>
          <li>限额与冷却由服务端强制执行，不依赖模型自觉</li>
        </ul>
      </section>
    </aside>
  );
});
