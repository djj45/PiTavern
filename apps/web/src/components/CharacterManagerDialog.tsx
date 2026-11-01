import { useEffect, useRef, useState } from "react";
import type { CharacterCardEditorDto, CharacterCardFieldsDto, CharacterCardSummaryDto } from "@pitavern/shared";
import { api, ApiError } from "../api.ts";
import { buttonClass, fieldClass } from "./libraryStyles.ts";

interface CharacterManagerDialogProps {
  onClose: () => void;
  /** 保存/导入/复制/删除后刷新侧栏角色与聊天列表。 */
  onChanged: () => void;
}

interface CardForm {
  description: string;
  personality: string;
  scenario: string;
  firstMes: string;
  mesExample: string;
  creatorNotes: string;
  systemPrompt: string;
  postHistoryInstructions: string;
  alternateGreetings: string[];
  /** 保持用户输入原文（含逗号/空格），保存时再拆分为数组。 */
  tagsText: string;
}

type TextFieldKey = Exclude<keyof CardForm, "alternateGreetings" | "tagsText">;

function errorText(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function formFromEditor(editor: CharacterCardEditorDto): CardForm {
  return {
    description: editor.description,
    personality: editor.personality,
    scenario: editor.scenario,
    firstMes: editor.firstMes,
    mesExample: editor.mesExample,
    creatorNotes: editor.creatorNotes,
    systemPrompt: editor.systemPrompt,
    postHistoryInstructions: editor.postHistoryInstructions,
    alternateGreetings: [...editor.alternateGreetingTexts],
    tagsText: editor.tags.join(", "),
  };
}

function cleanTags(values: string[]): string[] {
  return values.map((value) => value.trim()).filter(Boolean);
}

function cleanGreetings(values: string[]): string[] {
  return values.filter((value) => value.trim().length > 0);
}

function fieldsFromForm(form: CardForm): CharacterCardFieldsDto {
  return {
    description: form.description,
    personality: form.personality,
    scenario: form.scenario,
    firstMes: form.firstMes,
    mesExample: form.mesExample,
    creatorNotes: form.creatorNotes,
    systemPrompt: form.systemPrompt,
    postHistoryInstructions: form.postHistoryInstructions,
    alternateGreetings: cleanGreetings(form.alternateGreetings),
    tags: cleanTags(form.tagsText.split(/[,，]/)),
  };
}

/** 与服务端已保存状态比较时使用相同归一化，避免仅空白差异被当成未保存。 */
function fieldsFromEditor(editor: CharacterCardEditorDto): CharacterCardFieldsDto {
  return {
    description: editor.description,
    personality: editor.personality,
    scenario: editor.scenario,
    firstMes: editor.firstMes,
    mesExample: editor.mesExample,
    creatorNotes: editor.creatorNotes,
    systemPrompt: editor.systemPrompt,
    postHistoryInstructions: editor.postHistoryInstructions,
    alternateGreetings: cleanGreetings(editor.alternateGreetingTexts),
    tags: cleanTags(editor.tags),
  };
}

function sameFields(left: CharacterCardFieldsDto, right: CharacterCardFieldsDto): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function isEditorDto(value: unknown): value is CharacterCardEditorDto {
  const candidate = value as Partial<CharacterCardEditorDto> | null;
  return !!candidate && typeof candidate === "object"
    && typeof candidate.name === "string"
    && typeof candidate.revision === "string"
    && typeof candidate.spec === "string"
    && Array.isArray(candidate.alternateGreetingTexts);
}

function formatLabel(value: CharacterCardEditorDto["format"] | CharacterCardSummaryDto["format"]): string {
  return value === "png" ? "PNG" : "JSON";
}

function matchesQuery(item: CharacterCardSummaryDto, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  return [item.name, item.file, item.description, ...item.tags].some((text) => text.toLowerCase().includes(needle));
}

export default function CharacterManagerDialog({ onClose, onChanged }: CharacterManagerDialogProps) {
  const dialog = useRef<HTMLDialogElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const [list, setList] = useState<CharacterCardSummaryDto[]>([]);
  const [query, setQuery] = useState("");
  const [editor, setEditor] = useState<CharacterCardEditorDto | null>(null);
  const [form, setForm] = useState<CardForm | null>(null);
  const [copyName, setCopyName] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");

  const dirty = !!editor && !!form && !sameFields(fieldsFromForm(form), fieldsFromEditor(editor));
  const filtered = list.filter((item) => matchesQuery(item, query));

  const refreshList = async (): Promise<CharacterCardSummaryDto[]> => {
    const entries = await api.characterCards();
    setList(entries);
    return entries;
  };

  const applyEditor = (value: CharacterCardEditorDto) => {
    setEditor(value);
    setForm(formFromEditor(value));
  };

  useEffect(() => {
    if (dialog.current && !dialog.current.open) dialog.current.showModal();
    let cancelled = false;
    setLoading(true);
    void api.characterCards()
      .then((entries) => { if (!cancelled) setList(entries); })
      .catch((cause: unknown) => { if (!cancelled) setError("读取角色卡列表失败：" + errorText(cause)); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => {
      cancelled = true;
      if (dialog.current?.open) dialog.current.close();
    };
  }, []);

  const confirmDiscard = (action: string): boolean =>
    !dirty || window.confirm("当前角色卡有未保存的修改，确定放弃并" + action + "？");

  const requestClose = () => {
    if (busy) return;
    if (dirty && !window.confirm("当前角色卡有未保存的修改，确定关闭角色卡管理？")) return;
    onClose();
  };

  const selectCard = async (item: CharacterCardSummaryDto) => {
    if (busy || editor?.name === item.name) return;
    if (!confirmDiscard("切换角色卡")) return;
    setBusy(true); setError(""); setStatus("");
    try {
      applyEditor(await api.characterCard(item.name));
      setCopyName("");
    } catch (cause) {
      setError("读取角色卡「" + item.name + "」失败：" + errorText(cause));
    } finally {
      setBusy(false);
    }
  };

  const refresh = async () => {
    if (busy) return;
    setBusy(true); setError("");
    try {
      await refreshList();
    } catch (cause) {
      setError("刷新角色卡列表失败：" + errorText(cause));
    } finally {
      setBusy(false);
    }
  };

  const importFile = async (file: File | undefined) => {
    // 先清空 input：取消确认或忙时也允许再次选择同一文件触发 change。
    if (fileInput.current) fileInput.current.value = "";
    if (!file || busy) return;
    if (!confirmDiscard("导入角色卡")) return;
    setBusy(true); setError(""); setStatus("");
    try {
      const result = await api.importCharacter(file);
      const entries = await refreshList();
      setStatus("已导入 " + result.file + (result.warnings?.length ? "；" + result.warnings.join("；") : ""));
      const imported = entries.find((entry) => entry.file === result.file || entry.file.endsWith("/" + result.file));
      if (imported) {
        try {
          applyEditor(await api.characterCard(imported.name));
          setCopyName("");
        } catch (cause) {
          setError("已导入 " + result.file + "，但打开新角色卡失败：" + errorText(cause));
        }
      }
      onChanged();
    } catch (cause) {
      setError("导入角色卡失败：" + errorText(cause));
    } finally {
      setBusy(false);
    }
  };

  const save = async () => {
    if (busy || !editor || !form) return;
    const target = editor;
    const fields = fieldsFromForm(form);
    if (fields.tags.length > 100) { setError("标签最多 100 个"); return; }
    if (fields.alternateGreetings.length > 100) { setError("备用开场白最多 100 条"); return; }
    setBusy(true); setError(""); setStatus("");
    let saved: CharacterCardEditorDto;
    try {
      saved = await api.saveCharacterCard(target.name, target.revision, fields);
    } catch (cause) {
      if (cause instanceof ApiError && cause.status === 409) {
        setError("保存冲突：" + errorText(cause) + "；已重新载入最新内容，本地未保存的修改已丢弃");
        try {
          applyEditor(await api.characterCard(target.name));
          await refreshList();
          onChanged();
        } catch (reloadCause) {
          setError("保存冲突：" + errorText(cause) + "；重新载入失败：" + errorText(reloadCause));
        }
      } else {
        setError("保存角色卡失败：" + errorText(cause));
      }
      setBusy(false);
      return;
    }
    setStatus("已保存角色卡「" + target.name + "」；新聊天将使用新的开场白与系统提示，已有聊天内容不变");
    try {
      applyEditor(isEditorDto(saved) ? saved : await api.characterCard(target.name));
      await refreshList();
      onChanged();
    } catch (cause) {
      setError("角色卡已保存，但重新载入失败：" + errorText(cause));
    } finally {
      setBusy(false);
    }
  };

  const duplicate = async () => {
    if (busy || !editor) return;
    const source = editor;
    const requested = copyName.trim();
    if (requested && requested === source.name) { setError("副本名称不能与原角色卡相同"); return; }
    if (!window.confirm("确定复制角色卡「" + source.name + "」" + (requested ? "为「" + requested + "」" : "为默认副本") + "？复制不会包含聊天记录。")) return;
    setBusy(true); setError(""); setStatus("");
    try {
      const created = await api.duplicateCharacterCard(source.name, requested || undefined);
      const createdName = typeof created?.name === "string" && created.name ? created.name : requested || source.name + " 副本";
      await refreshList();
      setCopyName("");
      setStatus("已复制角色卡「" + createdName + "」；聊天记录不会复制，可在左侧列表打开");
      onChanged();
    } catch (cause) {
      setError("复制角色卡失败：" + errorText(cause));
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (busy || !editor) return;
    const target = editor;
    const chatWarning = target.chatCount > 0
      ? "该卡当前有 " + target.chatCount + " 个聊天；删除后这些聊天仍在，但打开时会显示“找不到角色卡”。"
      : "该卡当前没有聊天。";
    if (!window.confirm("确定删除角色卡「" + target.name + "」？只删除角色卡文件，不会删除聊天、群聊或世界书。" + chatWarning)) return;
    setBusy(true); setError(""); setStatus("");
    try {
      const result = await api.deleteCharacterCard(target.name);
      const kept = typeof result?.chatCount === "number" ? result.chatCount : target.chatCount;
      setEditor(null); setForm(null); setCopyName("");
      await refreshList();
      setStatus("已删除角色卡「" + target.name + "」；保留 " + kept + " 个聊天（不会级联删除）");
      onChanged();
    } catch (cause) {
      setError("删除角色卡失败：" + errorText(cause));
    } finally {
      setBusy(false);
    }
  };

  const exportCard = () => {
    if (!editor) return;
    const anchor = document.createElement("a");
    anchor.href = api.characterCardExportUrl(editor.name);
    anchor.download = editor.name + (editor.format === "png" ? ".png" : ".json");
    anchor.rel = "noopener";
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    setStatus("已开始导出 " + formatLabel(editor.format) + " 原文件" + (dirty ? "（未保存的修改不会导出）" : ""));
  };

  const updateText = (key: TextFieldKey, value: string) => {
    setForm((current) => current ? { ...current, [key]: value } : current);
  };

  const updateGreeting = (index: number, value: string) => {
    setForm((current) => {
      if (!current) return current;
      const next = [...current.alternateGreetings];
      next[index] = value;
      return { ...current, alternateGreetings: next };
    });
  };

  const renderEditor = () => {
    if (!editor || !form) {
      return (
        <div className="rounded-lg border border-dashed border-tavern-border p-4 text-sm leading-6 text-tavern-dim">
          从左侧列表选择角色卡进入编辑，或点「＋ 导入」上传 PNG / JSON / CharX / BYAF。
          <p className="mt-2 text-xs">管理页只修改常用字段；角色卡名称不可更改，卡内世界书与正则请到「资料」中编辑。</p>
        </div>
      );
    }

    const textArea = (key: TextFieldKey, label: string, rows = 4) => (
      <label className="block min-w-0 text-xs text-tavern-dim">{label}
        <textarea aria-label={label} className={fieldClass} rows={rows} maxLength={100000} disabled={busy}
          value={form[key]} onChange={(event) => updateText(key, event.target.value)} />
      </label>
    );

    return (
      <div className="min-w-0 space-y-4">
        <div className="flex flex-wrap items-start gap-2 rounded-lg border border-tavern-border p-3">
          <div className="min-w-0 flex-1">
            <h3 className="break-words font-medium">编辑：{editor.name}</h3>
            <p className="mt-0.5 break-words text-xs text-tavern-dim">
              {formatLabel(editor.format)} · {editor.file} · {editor.spec || "未知规范"}
              {editor.characterVersion ? " · 版本 " + editor.characterVersion : ""}
            </p>
          </div>
          <span className={"shrink-0 rounded-full px-2 py-0.5 text-xs " + (dirty ? "bg-amber-400/15 text-amber-300" : "bg-tavern-raised text-tavern-dim")}>
            {dirty ? "有未保存修改" : "未保存修改：无"}
          </span>
        </div>

        <div className="grid min-w-0 gap-2 sm:grid-cols-3">
          <label className="min-w-0 text-xs text-tavern-dim">名称（只读）
            <input aria-label="角色卡名称" className={fieldClass + " opacity-70"} value={editor.name} readOnly aria-readonly="true" />
          </label>
          <label className="min-w-0 text-xs text-tavern-dim">格式（只读）
            <input aria-label="角色卡格式" className={fieldClass + " opacity-70"} value={formatLabel(editor.format)} readOnly aria-readonly="true" />
          </label>
          <label className="min-w-0 text-xs text-tavern-dim">聊天数（只读）
            <input aria-label="关联聊天数" className={fieldClass + " opacity-70"} value={String(editor.chatCount)} readOnly aria-readonly="true" />
          </label>
        </div>

        <div className="flex flex-wrap gap-2">
          <button type="button" disabled={busy || !dirty} onClick={() => void save()}
            className="rounded-lg bg-tavern-accent px-3 py-2 text-sm text-tavern-bg disabled:opacity-40">
            {busy ? "处理中…" : dirty ? "保存角色卡" : "已保存"}
          </button>
          <button type="button" disabled={busy} onClick={exportCard} className={buttonClass}>导出角色卡</button>
          <button type="button" disabled={busy} onClick={() => void remove()}
            className={buttonClass + " border-red-400/50 text-red-300"}>删除角色卡</button>
        </div>
        <p className="text-xs leading-5 text-tavern-dim">
          保存只更新下方字段并使用文件内容哈希检查冲突；PNG 像素、V2/V3 数据块、未知字段与卡片扩展保持不变。空字段允许保存。
        </p>

        {textArea("description", "描述")}
        {textArea("personality", "性格")}
        {textArea("scenario", "场景")}
        {textArea("firstMes", "默认开场白")}

        <section aria-label="备用开场白" className="min-w-0 space-y-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="text-sm font-medium">备用开场白（{form.alternateGreetings.length}）</h3>
            <button type="button" disabled={busy || form.alternateGreetings.length >= 100}
              onClick={() => setForm((current) => current ? { ...current, alternateGreetings: [...current.alternateGreetings, ""] } : current)}
              className={buttonClass}>添加备用开场白</button>
          </div>
          {form.alternateGreetings.length === 0 && <p className="text-xs text-tavern-dim">没有备用开场白；新聊天只能使用默认开场白。</p>}
          {form.alternateGreetings.map((text, index) => (
            <div key={index} className="flex min-w-0 flex-col gap-2 sm:flex-row sm:items-start">
              <label className="min-w-0 flex-1 text-xs text-tavern-dim">备用开场白 {index + 1}
                <textarea aria-label={"备用开场白 " + (index + 1)} className={fieldClass} rows={3} maxLength={100000}
                  disabled={busy} value={text} onChange={(event) => updateGreeting(index, event.target.value)} />
              </label>
              <button type="button" aria-label={"删除备用开场白 " + (index + 1)} disabled={busy}
                onClick={() => setForm((current) => current ? {
                  ...current,
                  alternateGreetings: current.alternateGreetings.filter((_, position) => position !== index),
                } : current)}
                className="shrink-0 rounded-lg border border-tavern-border px-3 py-2 text-sm text-red-300 disabled:opacity-40 sm:mt-5">删除</button>
            </div>
          ))}
          <p className="text-xs text-tavern-dim">最多 100 条，单条最多 100000 字符；保存后新聊天可选择这些开场白。</p>
        </section>

        {textArea("mesExample", "示例对话")}
        {textArea("creatorNotes", "作者备注")}
        {textArea("systemPrompt", "系统提示")}
        {textArea("postHistoryInstructions", "历史后指令")}

        <label className="block min-w-0 text-xs text-tavern-dim">标签（逗号分隔）
          <input aria-label="标签" className={fieldClass} maxLength={100000} disabled={busy}
            value={form.tagsText} placeholder="标签1, 标签2"
            onChange={(event) => setForm((current) => current ? { ...current, tagsText: event.target.value } : current)} />
        </label>

        <section aria-label="卡内世界书与正则提示" className="min-w-0 rounded-lg border border-tavern-border bg-tavern-bg/60 p-3 text-xs leading-5 text-tavern-dim">
          <h3 className="text-sm font-medium text-tavern-text">卡内世界书 / 正则</h3>
          <p className="break-words">
            卡内世界书 {editor.characterBookEntries} 条{editor.worldName ? " · 世界引用「" + editor.worldName + "」" : " · 无世界引用"}。
            本页不编辑卡内世界书和正则脚本，请到顶栏「资料」→「世界书」/「正则脚本」中查看和修改。
          </p>
          <p>当前卡片共有 {editor.chatCount} 个聊天；编辑字段不会改写已有聊天正文、开场白记录和历史前缀。</p>
        </section>

        <section aria-label="复制角色卡" className="min-w-0 space-y-2 rounded-lg border border-tavern-border p-3">
          <h3 className="text-sm font-medium">复制角色卡</h3>
          <div className="flex min-w-0 flex-col gap-2 sm:flex-row sm:items-end">
            <label className="min-w-0 flex-1 text-xs text-tavern-dim">新名称（留空自动命名）
              <input aria-label="副本名称" className={fieldClass} value={copyName} maxLength={100} disabled={busy}
                placeholder={editor.name + " 副本"} onChange={(event) => setCopyName(event.target.value)} />
            </label>
            <button type="button" disabled={busy} onClick={() => void duplicate()} className={buttonClass + " sm:mb-0.5"}>复制角色卡</button>
          </div>
          <p className="text-xs leading-5 text-tavern-dim">复制生成独立文件，保留头像、未知字段和卡内世界书，但不复制聊天记录。</p>
        </section>
      </div>
    );
  };

  return (
    <dialog ref={dialog} aria-labelledby="character-manager-title"
      onCancel={(event) => { event.preventDefault(); requestClose(); }}
      className="m-0 flex h-[100dvh] max-h-none w-screen max-w-none flex-col overflow-hidden border-0 bg-tavern-panel p-0 text-tavern-text backdrop:bg-black/60">
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-tavern-border bg-tavern-panel p-3">
        <h2 id="character-manager-title" className="mr-auto font-medium">角色卡管理{dirty ? " · 未保存" : ""}</h2>
        <button type="button" disabled={busy} onClick={requestClose} className={buttonClass}>关闭角色卡管理</button>
      </div>

      {(error || status) && (
        <div className="shrink-0 space-y-1.5 border-b border-tavern-border px-3 py-2">
          {error && <p role="alert" className="break-words rounded-lg border border-red-400/40 bg-red-400/10 p-2.5 text-sm text-red-300">{error}</p>}
          {status && <p role="status" className="break-words rounded-lg border border-tavern-accent/40 bg-tavern-accent/10 p-2.5 text-sm text-tavern-accent">{status}</p>}
        </div>
      )}

      <div className="grid min-h-0 flex-1 grid-cols-1 overflow-y-auto lg:grid-cols-[320px_minmax(0,1fr)] lg:overflow-hidden">
        <aside className="min-w-0 border-b border-tavern-border bg-tavern-panel/60 lg:min-h-0 lg:overflow-y-auto lg:border-b-0 lg:border-r">
          <div className="space-y-2 border-b border-tavern-border p-3">
            <div className="flex flex-wrap gap-2">
              <button type="button" disabled={busy || loading} onClick={() => fileInput.current?.click()} className={buttonClass}>＋ 导入</button>
              <input ref={fileInput} type="file" accept=".png,.json,.charx,.byaf" hidden aria-label="导入角色卡文件"
                onChange={(event) => void importFile(event.target.files?.[0])} />
              <button type="button" disabled={busy || loading} onClick={() => void refresh()} className={buttonClass}>刷新列表</button>
            </div>
            <label className="block text-xs text-tavern-dim">搜索角色卡
              <input aria-label="搜索角色卡" className={fieldClass} value={query} disabled={loading}
                placeholder="名称、标签、描述或文件名" onChange={(event) => setQuery(event.target.value)} />
            </label>
            <p className="text-xs text-tavern-dim">共 {list.length} 张 · 显示 {filtered.length} 张</p>
          </div>
          {loading && <p role="status" className="p-3 text-xs text-tavern-dim">正在读取角色卡…</p>}
          {!loading && list.length === 0 && (
            <p className="p-3 text-xs leading-5 text-tavern-dim">characters/ 目录里还没有角色卡，点「＋ 导入」上传 PNG / JSON / CharX / BYAF。</p>
          )}
          {!loading && list.length > 0 && filtered.length === 0 && (
            <p className="p-3 text-xs text-tavern-dim">没有匹配「{query.trim()}」的角色卡。</p>
          )}
          <ul aria-label="角色卡列表" className="max-h-64 space-y-1.5 overflow-y-auto p-2 lg:max-h-none">
            {filtered.map((item) => (
              <li key={item.name}>
                <button type="button" aria-label={"编辑角色卡 " + item.name} aria-pressed={editor?.name === item.name}
                  disabled={busy} onClick={() => void selectCard(item)}
                  className={"flex w-full min-w-0 gap-2 rounded-lg border p-2 text-left disabled:opacity-60 " + (editor?.name === item.name ? "border-tavern-accent bg-tavern-raised" : "border-tavern-border hover:border-tavern-accent-dim")}>
                  {item.avatarUrl
                    ? <img src={item.avatarUrl} alt="" className="h-10 w-10 shrink-0 rounded-md object-cover" />
                    : <span aria-hidden="true" className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md bg-tavern-raised text-xs text-tavern-dim">{item.name.slice(0, 1)}</span>}
                  <span className="min-w-0 flex-1">
                    <span className="flex min-w-0 items-center gap-1">
                      <span className="truncate text-sm text-tavern-text">{item.name}</span>
                      <span className="shrink-0 rounded-full bg-tavern-raised px-1.5 py-0.5 text-[10px] text-tavern-dim">{formatLabel(item.format)}</span>
                    </span>
                    <span className="mt-0.5 block truncate text-xs text-tavern-dim">{item.description || "无描述"}</span>
                    {item.tags.length > 0 && (
                      <span className="mt-1 flex min-w-0 flex-wrap gap-1 text-[10px] text-tavern-dim">
                        {item.tags.slice(0, 3).map((tag) => <span key={tag} className="max-w-full truncate rounded-full bg-tavern-raised px-1.5 py-0.5">{tag}</span>)}
                        {item.tags.length > 3 && <span>+{item.tags.length - 3}</span>}
                      </span>
                    )}
                    <span className="mt-1 block break-words text-[11px] leading-4 text-tavern-dim">
                      聊天 {item.chatCount} · 卡内世界书 {item.characterBookEntries} · {item.worldName ? "世界 " + item.worldName : "无世界引用"}
                    </span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </aside>

        <section className="min-w-0 space-y-3 p-3 lg:min-h-0 lg:overflow-y-auto">
          {renderEditor()}
        </section>
      </div>
    </dialog>
  );
}
