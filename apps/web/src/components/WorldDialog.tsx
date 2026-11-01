import {QuestLog} from "./QuestLog.tsx";
import { useEffect, useState } from "react";
import type { WorldChatMigrationPreviewDto, WorldChatStateDto, WorldEvent, WorldSnapshot, WorldTemplate, WorldTemplateSummaryDto, WorldTemplateVersionDto } from "@pitavern/shared/world";
import { api, ApiError } from "../api.ts";

interface WorldDialogProps {
  chatId: string;
  revision: string;
  world?: WorldChatStateDto;
  messageCount: number;
  busy: boolean;
  onClose: () => void;
  onChanged: (message: string) => void;
  onOpenBackups: () => void;
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
          <ul aria-label="最近世界变化" className="max-h-48 space-y-1 overflow-y-auto rounded-lg border border-tavern-border bg-tavern-bg/60 p-2.5 text-xs text-tavern-text">
            {snapshot.recentEvents.map((event) => (
              <li key={event.id} className="break-words">{clockLabel(event.worldTimeMinutes)} · {eventText(event, template)}</li>
            ))}
          </ul>
        </div>
      )}
      {snapshot.schemaVersion===4 && <p className="text-xs text-tavern-dim">等待会推进世界时间，人物可能离开或返回。查看状态、刷新和恢复不会推进时间。</p>}
    </div>
  );
}

export function WorldDialog({ chatId, revision, world, messageCount, busy, onClose, onChanged, onOpenBackups }: WorldDialogProps) {
  const [templates, setTemplates] = useState<WorldTemplateSummaryDto[]>([]);
  const [templateId, setTemplateId] = useState("");
  const [versions, setVersions] = useState<WorldTemplateVersionDto[]>([]);
  const [targetHash, setTargetHash] = useState("");
  const [migration, setMigration] = useState<WorldChatMigrationPreviewDto | null>(null);
  const [loadingVersions, setLoadingVersions] = useState(false);
  const [migrationError, setMigrationError] = useState("");
  const [migrationBusy, setMigrationBusy] = useState(false);
  const [appliedBackup, setAppliedBackup] = useState("");
  const [loadingTemplates, setLoadingTemplates] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [author,setAuthor]=useState<{snapshot:WorldSnapshot;template?:WorldTemplate}|null>(null);
  const [authorLoading,setAuthorLoading]=useState(false);
  const loadAuthor=async()=>{setAuthorLoading(true);setError("");try {const value=await api.worldAuthor(chatId);setAuthor(value);return value;} catch(cause){setError((cause as Error).message);return null;} finally{setAuthorLoading(false);}};

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
    setVersions([]); setTargetHash(""); setMigration(null); setMigrationError("");
    if((world?.snapshot?.schemaVersion??0)>=2 && !author) return;
    const templateId = world?.template?.templateId;
    if (!templateId) return;
    let cancelled = false;
    setLoadingVersions(true);
    void api.worldTemplateVersions(templateId).then((list) => {
      if (cancelled) return;
      // 同哈希的发布名称/描述也可能变化；是否无需迁移由整聊天预览判断。
      setVersions(list);
      setTargetHash(list[0]?.contentHash ?? "");
    }).catch(() => {
      // 内置模板没有模板库版本列表，不提供更新入口。
    }).finally(() => {
      if (!cancelled) setLoadingVersions(false);
    });
    return () => { cancelled = true; };
  }, [world?.template?.templateId, world?.snapshot?.templateHash,author]);

  const locked = busy || saving;
  const template = world?.template;
  const snapshot = world?.snapshot;
  const readOnly = world?.capability.mode !== "enabled";
  const migrationChanges = migration
    ? [...new Map(migration.locations.flatMap((location) => location.changes).filter((change) => !change.blocking)
      .map((change) => [`${change.entity}|${change.id ?? ""}|${change.action}|${change.detail ?? ""}`, change])).values()].slice(0, 40)
    : [];
  const migrationBlocked = migration?.blocking ?? [];

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

  const startEdit = async () => {
    if (!snapshot) return;
    const value=await loadAuthor();if(!value)return;
    setDraft(JSON.stringify(value.snapshot, null, 2));
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

  const previewMigration = async () => {
    if (locked || !targetHash) return;
    setMigrationBusy(true); setMigrationError(""); setMigration(null);
    try {
      setMigration(await api.previewWorldMigration(chatId, targetHash));
    } catch (cause) {
      if (cause instanceof ApiError && cause.status === 422) {
        const body = cause.body as { preview?: WorldChatMigrationPreviewDto } | null;
        if (body?.preview) setMigration(body.preview);
      }
      setMigrationError((cause as Error).message);
    } finally {
      setMigrationBusy(false);
    }
  };

  const applyMigration = async () => {
    if (!migration?.applyable || locked) return;
    if (!window.confirm("确定把整份聊天的所有活动世界、候选、检查点和隐藏后续更新到该模板版本？历史正文不会改写；迁移前会自动备份。")) return;
    setMigrationBusy(true); setMigrationError("");
    try {
      const result = await api.applyWorldMigration(chatId, targetHash, migration.revision, migration.previewHash);
      setAppliedBackup(result.backupId ?? "");
      setMigration(null);
      onChanged(result.noop ? "目标模板已是当前版本，无需迁移" : "世界模板已更新；所有分支和检查点已使用新版本");
    } catch (cause) {
      setMigrationError((cause as Error).message);
    } finally {
      setMigrationBusy(false);
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
              {snapshot?.quests&&<QuestLog quests={snapshot.quests}/>}
              <section aria-label="已知线索" className="space-y-2 rounded-lg border border-tavern-border p-3">
                <h3 className="text-sm font-medium">已知线索</h3>
                {snapshot?.knownFacts.length ? <ul className="space-y-2 text-sm">{snapshot.knownFacts.map(fact=><li key={fact.id} className="break-words"><p>{fact.text}</p><p className="text-xs text-tavern-dim">来源：{fact.source.type === "public" ? "公共事实" : fact.source.type === "initial" ? "初始已知" : `第 ${fact.source.turn} 轮交互`}{"interactionId" in fact.source && fact.source.interactionId ? ` · ${snapshot.publicInteractions.find(i=>i.id===("interactionId" in fact.source ? fact.source.interactionId : undefined))?.name ?? "交互"}` : ""}{"fromActorId" in fact.source && fact.source.fromActorId ? ` · ${nameOf(template?.actors,fact.source.fromActorId)}` : ""}</p></li>)}</ul> : <p className="text-xs text-tavern-dim">尚无已知线索。</p>}
              </section>
              <div className="space-y-2"><button type="button" disabled={busy || authorLoading} onClick={()=>{if(author){setAuthor(null);setEditing(false);setDraft("");}else void loadAuthor();}} className="rounded border border-tavern-border px-3 py-2 text-sm">{author ? "关闭作者视图" : authorLoading ? "读取作者视图…" : "作者视图（含秘密）"}</button>
                {author && <section aria-label="作者世界视图" className="space-y-2 rounded border border-amber-400/40 p-3 text-xs"><h3 className="font-medium">作者视图：完整事实与知情关系</h3><p>本地管理数据包含全部秘密。JSONL、模板导出和备份也包含完整秘密；分享前需另行处理。此视图不会发送给玩家模型。</p><button type="button" disabled={busy || authorLoading} onClick={()=>void loadAuthor()} className="rounded border border-tavern-border px-2 py-1">刷新作者视图</button><details><summary>查看完整模板与知识快照 JSON</summary><pre className="max-h-64 overflow-auto whitespace-pre-wrap break-all">{JSON.stringify(author,null,2)}</pre></details></section>}
              </div>
              {((snapshot?.schemaVersion??0)<2 || author) && <section aria-label="更新世界模板" className="rounded-lg border border-tavern-border bg-tavern-bg/50 p-3">
                <div className="flex flex-wrap items-center gap-2">
                  <h3 className="text-sm font-medium text-tavern-text">更新模板</h3>
                  <span className="text-xs text-tavern-dim">覆盖全部候选、检查点与隐藏后续；历史正文不变</span>
                </div>
                {loadingVersions && <p className="mt-2 text-xs text-tavern-dim">正在读取已发布版本…</p>}
                {!loadingVersions && versions.length === 0 && (
                  <p className="mt-2 text-xs leading-5 text-tavern-dim">没有可用的已发布版本。内置模板不能在这里更新；自定义模板需先在「世界模板」中发布。</p>
                )}
                {versions.length > 0 && (
                  <div className="mt-2 space-y-2">
                    <label className="block text-xs text-tavern-dim">目标版本
                      <select aria-label="目标模板版本" className={fieldClass + " mt-1"} value={targetHash}
                        disabled={locked || migrationBusy || !!appliedBackup}
                        onChange={(event) => { setTargetHash(event.target.value); setMigration(null); setMigrationError(""); setAppliedBackup(""); }}>
                        {versions.map((version) => <option key={version.contentHash} value={version.contentHash}>
                          {version.name} · v{version.templateVersion}{version.description ? " · " + version.description.slice(0, 60) : ""}
                        </option>)}
                      </select>
                    </label>
                    <div className="flex flex-wrap items-center gap-2">
                      <button type="button" onClick={() => void previewMigration()} disabled={locked || migrationBusy || !targetHash || !!appliedBackup}
                        className="rounded-lg border border-tavern-border px-3 py-1.5 text-sm text-tavern-text hover:border-tavern-accent-dim disabled:opacity-40">
                        {migrationBusy ? "读取预览中…" : "预览迁移差异"}
                      </button>
                      {migrationError && <span role="alert" className="text-xs text-red-300">{migrationError}</span>}
                    </div>
                    {migration && (
                      <div className="space-y-2 rounded-lg border border-tavern-border bg-tavern-bg p-2.5">
                        <p className="break-words text-sm text-tavern-text">
                          目标：{migration.target.name ?? migration.target.templateId} · v{migration.target.templateVersion}
                          {migration.target.description ? <span className="block text-xs text-tavern-dim">{migration.target.description}</span> : null}
                        </p>
                        <p className="text-xs text-tavern-dim">
                          世界恢复点 {migration.counts.worlds} · 更新 {migration.counts.migrated} · 无变化 {migration.counts.unchanged}
                          {migration.counts.noWorld > 0 ? " · 原本无世界 " + migration.counts.noWorld : ""}
                          {migration.counts.blocked > 0 ? " · 阻断 " + migration.counts.blocked : ""}
                        </p>
                        {migration.noop && <p className="rounded border border-emerald-400/30 bg-emerald-400/10 p-2 text-xs text-emerald-300">目标已是当前版本，无需迁移。</p>}
                        {!migration.applyable && !migration.noop && (
                          <div role="alert" className="rounded border border-red-400/40 bg-red-400/10 p-2 text-xs text-red-300">
                            <p className="font-medium">无法应用；先修复以下世界快照：</p>
                            <ul className="mt-1 list-disc space-y-1 pl-4">
                              {migrationBlocked.map((location) => <li key={location.path} className="break-all">
                                {location.label}：{location.blocking.map((change) => change.detail ?? change.label).join("；")}
                              </li>)}
                            </ul>
                          </div>
                        )}
                        {migrationChanges.length > 0 && (
                          <ul aria-label="迁移差异" className="max-h-44 space-y-1 overflow-y-auto text-xs text-tavern-text">
                            {migrationChanges.map((change) => <li key={change.entity + "|" + (change.id ?? "") + "|" + change.action + "|" + (change.detail ?? "")} className="break-words">
                              {change.entity} · {change.label}{change.detail ? " — " + change.detail : ""}
                            </li>)}
                          </ul>
                        )}
                        {migration.warnings.length > 0 && (
                          <ul className="space-y-1 text-xs text-amber-300">
                            {migration.warnings.map((warning) => <li key={warning} className="break-words">· {warning}</li>)}
                          </ul>
                        )}
                        {migration.applyable && (
                          <button type="button" onClick={() => void applyMigration()} disabled={locked || migrationBusy}
                            className="rounded-lg bg-tavern-accent px-3 py-1.5 text-sm font-medium text-tavern-bg disabled:opacity-40">
                            {migrationBusy ? "应用中…" : "应用迁移并备份"}
                          </button>
                        )}
                      </div>
                    )}
                    {appliedBackup && (
                      <p role="status" className="rounded-lg border border-emerald-400/30 bg-emerald-400/10 p-2 text-xs leading-5 text-emerald-300">
                        模板已更新，迁移前备份已创建。
                        <button type="button" onClick={onOpenBackups} className="ml-2 underline">打开备份与恢复</button>
                      </p>
                    )}
                    <p className="text-[11px] leading-4 text-tavern-dim">迁移只改模板引用和需要补充的新角色；金额、库存、时间、正文、变量和候选顺序不变。初始值变化默认只影响新聊天。</p>
                  </div>
                )}
              </section>}
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
                  {((snapshot?.schemaVersion??0)<2 || author) && <button type="button" onClick={()=>void startEdit()} disabled={locked || authorLoading || !snapshot || !template}
                    className="rounded-lg border border-tavern-border px-3 py-1.5 text-sm text-tavern-dim hover:border-tavern-accent-dim hover:text-tavern-text disabled:opacity-40">修正状态</button>}
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
