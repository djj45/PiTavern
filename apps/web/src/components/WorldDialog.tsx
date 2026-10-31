import { useEffect, useState } from "react";
import type { WorldChatStateDto, WorldEvent, WorldSnapshot, WorldTemplate, WorldTemplateSummaryDto } from "@pitavern/shared/world";
import { api } from "../api.ts";

interface WorldDialogProps {
  chatId: string;
  revision: string;
  world?: WorldChatStateDto;
  messageCount: number;
  busy: boolean;
  onClose: () => void;
  onChanged: (message: string) => void;
}

const fieldClass = "w-full rounded border border-tavern-border bg-tavern-bg p-2 text-sm text-tavern-text outline-none focus:border-tavern-accent-dim disabled:opacity-50";

function nameOf(entries: Array<{ id: string; name: string }> | undefined, id: string | undefined): string {
  if (!id) return "—";
  return entries?.find((entry) => entry.id === id)?.name ?? id;
}

function clockLabel(minutes: number): string {
  const day = Math.floor(minutes / 1440) + 1;
  const minute = minutes % 1440;
  return `第${day}天 ${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`;
}

function eventText(event: WorldEvent, template?: WorldTemplate): string {
  const actor = nameOf(template?.actors, event.actorId);
  if (event.type === "purchase" && event.targetId && event.itemId && event.quantity !== undefined) {
    return `${actor} 花费 ${Math.abs(event.moneyDelta ?? 0)} 向 ${nameOf(template?.actors, event.targetId)} 购买 ${event.quantity} 件${nameOf(template?.items, event.itemId)}`;
  }
  if (event.type === "transfer" && event.targetId && event.itemId && event.quantity !== undefined) {
    return `${actor} 向 ${nameOf(template?.actors, event.targetId)} 转移 ${event.quantity} 件${nameOf(template?.items, event.itemId)}`;
  }
  return event.actorId && event.summary.startsWith(event.actorId + " ") ? actor + event.summary.slice(event.actorId.length) : event.summary;
}

function statusView(world: WorldChatStateDto) {
  const snapshot = world.snapshot;
  const template = world.template;
  if (!snapshot) {
    return <p role="alert" className="text-sm text-amber-400">世界快照不可读取{world.error ? `：${world.error}` : ""}</p>;
  }
  const playerId = template?.initial.actorId;
  const money = playerId ? snapshot.money[playerId] : undefined;
  const inventory = playerId ? snapshot.inventory.filter((entry) => entry.ownerId === playerId) : [];
  const present = snapshot.scene.presentActorIds.map((id) => nameOf(template?.actors, id)).join("、") || "无";
  return (
    <div className="space-y-3 text-sm">
      <div className="grid gap-2 sm:grid-cols-2">
        <div className="rounded-lg border border-tavern-border bg-tavern-bg/60 p-2.5">
          <p className="text-xs text-tavern-dim">时间</p>
          <p className="mt-0.5 text-tavern-text">{clockLabel(snapshot.clockMinutes)}</p>
        </div>
        <div className="rounded-lg border border-tavern-border bg-tavern-bg/60 p-2.5">
          <p className="text-xs text-tavern-dim">地点</p>
          <p className="mt-0.5 text-tavern-text">{nameOf(template?.locations, snapshot.scene.locationId)}</p>
        </div>
        <div className="rounded-lg border border-tavern-border bg-tavern-bg/60 p-2.5">
          <p className="text-xs text-tavern-dim">在场</p>
          <p className="mt-0.5 text-tavern-text">{present}</p>
        </div>
        <div className="rounded-lg border border-tavern-border bg-tavern-bg/60 p-2.5">
          <p className="text-xs text-tavern-dim">金钱 / 随身物品</p>
          <p className="mt-0.5 text-tavern-text">{money === undefined ? "未记录" : `${money} · ${inventory.length ? inventory.map((entry) => `${nameOf(template?.items, entry.itemId)}×${entry.quantity}`).join("、") : "无"}`}</p>
        </div>
      </div>
      {snapshot.recentEvents.length > 0 && (
        <div>
          <p className="mb-1 text-xs text-tavern-dim">最近变化</p>
          <ul className="space-y-1 rounded-lg border border-tavern-border bg-tavern-bg/60 p-2.5 text-xs text-tavern-text">
            {snapshot.recentEvents.slice(-5).map((event) => (
              <li key={event.id} className="truncate" title={event.summary}>{clockLabel(event.worldTimeMinutes)} · {eventText(event, template)}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

export function WorldDialog({ chatId, revision, world, messageCount, busy, onClose, onChanged }: WorldDialogProps) {
  const [templates, setTemplates] = useState<WorldTemplateSummaryDto[]>([]);
  const [templateId, setTemplateId] = useState("");
  const [loadingTemplates, setLoadingTemplates] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (world) return;
    let cancelled = false;
    setLoadingTemplates(true);
    void api.worldTemplates().then((list) => {
      if (cancelled) return;
      setTemplates(list);
      setTemplateId((current) => current || list[0]?.id || "");
    }).catch((cause: Error) => {
      if (!cancelled) setError("读取世界模板失败：" + cause.message);
    }).finally(() => {
      if (!cancelled) setLoadingTemplates(false);
    });
    return () => { cancelled = true; };
  }, [world]);

  useEffect(() => {
    if (world?.snapshot) setDraft(JSON.stringify(world.snapshot, null, 2));
  }, [world?.snapshot]);

  const locked = busy || saving;
  const template = world?.template;
  const snapshot = world?.snapshot;
  const readOnly = world?.capability.mode !== "enabled";

  const initialize = async () => {
    if (!templateId || locked) return;
    setSaving(true);
    setError("");
    try {
      await api.initializeWorld(chatId, templateId, revision, true);
      onChanged("世界已初始化");
      onClose();
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const startEdit = () => {
    if (!snapshot) return;
    setDraft(JSON.stringify(snapshot, null, 2));
    setError("");
    setEditing(true);
  };

  const saveCorrection = async () => {
    if (locked) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(draft);
    } catch {
      setError("JSON 解析失败，请检查括号、引号和逗号");
      return;
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      setError("修正内容必须是一个 JSON 对象");
      return;
    }
    setSaving(true);
    setError("");
    try {
      await api.correctWorld(chatId, revision, parsed as WorldSnapshot);
      setEditing(false);
      onChanged("世界状态已修正");
      onClose();
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" role="presentation">
      <section role="dialog" aria-label="世界状态" className="flex max-h-[90vh] w-full max-w-2xl flex-col overflow-hidden rounded-2xl border border-tavern-border bg-tavern-panel shadow-2xl">
        <header className="flex items-start gap-3 border-b border-tavern-border p-4">
          <div className="min-w-0 flex-1">
            <h2 className="text-base font-medium text-tavern-text">世界状态</h2>
            <p className="mt-0.5 text-xs text-tavern-dim">
              {world ? `${world.templateName}${template ? ` · 模板 v${template.templateVersion} / 规则 v${template.rulesVersion}` : ""}` : "当前聊天尚未绑定世界模板"}
            </p>
          </div>
          {world && (
            <span className={`shrink-0 rounded-full px-2 py-0.5 text-xs ${readOnly ? "bg-amber-400/15 text-amber-300" : "bg-emerald-400/15 text-emerald-300"}`}>
              {readOnly ? "只读" : "可写入"}
            </span>
          )}
          <button type="button" aria-label="关闭世界状态" onClick={onClose}
            className="rounded-lg border border-tavern-border px-2 py-1 text-xs text-tavern-dim hover:border-tavern-accent-dim hover:text-tavern-text">关闭</button>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto p-4">
          {error && <p role="alert" className="mb-3 rounded-lg border border-red-400/40 bg-red-400/10 p-2 text-sm text-red-300">{error}</p>}
          {!world ? (
            <div className="space-y-3">
              <p className="text-sm leading-6 text-tavern-text">
                未启用世界引擎的聊天仍使用普通聊天变量。启用后，模型可通过 <code>world_query</code> 查询权威状态，并通过 <code>world_command</code> 提交移动、交易和推进时间。
              </p>
              {messageCount > 1 && (
                <p className="rounded-lg border border-amber-400/30 bg-amber-400/10 p-2.5 text-sm leading-6 text-amber-200">
                  这是已有内容的聊天。中途绑定会从初始世界状态开始，历史正文不会重算；旧回合检查和分支候选会回填同一份初始快照。
                </p>
              )}
              <label className="block text-sm text-tavern-dim">
                <span className="mb-1 block">世界模板</span>
                <select aria-label="世界模板" value={templateId} disabled={loadingTemplates || locked || templates.length === 0}
                  onChange={(event) => setTemplateId(event.target.value)} className={fieldClass}>
                  {templates.length === 0 && <option value="">没有可用模板</option>}
                  {templates.map((entry) => <option key={entry.id} value={entry.id}>{entry.name}</option>)}
                </select>
              </label>
              {templates.find((entry) => entry.id === templateId)?.description && (
                <p className="text-xs leading-5 text-tavern-dim">{templates.find((entry) => entry.id === templateId)!.description}</p>
              )}
              <div className="flex items-center justify-end gap-2">
                <button type="button" onClick={onClose} disabled={locked}
                  className="rounded-lg border border-tavern-border px-3 py-1.5 text-sm text-tavern-dim hover:text-tavern-text disabled:opacity-40">取消</button>
                <button type="button" onClick={() => void initialize()} disabled={locked || !templateId}
                  className="rounded-lg bg-tavern-accent px-3 py-1.5 text-sm font-medium text-tavern-bg disabled:opacity-40">
                  {saving ? "初始化中…" : "启用世界"}
                </button>
              </div>
            </div>
          ) : (
            <div className="space-y-3">
              {readOnly && (
                <p className="rounded-lg border border-amber-400/30 bg-amber-400/10 p-2.5 text-sm leading-6 text-amber-200">
                  世界当前只读{world.capability.reason ? `（${world.capability.reason}）` : ""}。查看不受影响；修正快照后仍以聊天 JSONL 为准。
                </p>
              )}
              {statusView(world)}
              {editing ? (
                <div className="space-y-2">
                  <label className="block text-sm text-tavern-dim">
                    <span className="mb-1 block">修正快照 JSON（保存时校验模板引用，revision 自动 +1；只影响当前状态和当前候选，重生成会从该回合前快照恢复）</span>
                    <textarea aria-label="世界快照 JSON" value={draft} onChange={(event) => setDraft(event.target.value)}
                      rows={18} spellCheck={false} className={`${fieldClass} resize-y font-mono text-xs leading-5`} />
                  </label>
                  <div className="flex items-center justify-end gap-2">
                    <button type="button" onClick={() => { setEditing(false); setError(""); }} disabled={locked}
                      className="rounded-lg border border-tavern-border px-3 py-1.5 text-sm text-tavern-dim hover:text-tavern-text disabled:opacity-40">取消修正</button>
                    <button type="button" onClick={() => void saveCorrection()} disabled={locked}
                      className="rounded-lg bg-tavern-accent px-3 py-1.5 text-sm font-medium text-tavern-bg disabled:opacity-40">
                      {saving ? "保存中…" : "保存修正"}
                    </button>
                  </div>
                </div>
              ) : (
                <div className="flex items-center justify-end gap-2">
                  <button type="button" onClick={startEdit} disabled={locked || !snapshot || !template}
                    className="rounded-lg border border-tavern-border px-3 py-1.5 text-sm text-tavern-dim hover:border-tavern-accent-dim hover:text-tavern-text disabled:opacity-40">修正状态</button>
                  <button type="button" onClick={onClose} disabled={locked}
                    className="rounded-lg border border-tavern-border px-3 py-1.5 text-sm text-tavern-dim hover:text-tavern-text disabled:opacity-40">关闭</button>
                </div>
              )}
            </div>
          )}
        </div>
      </section>
    </div>
  );
}
