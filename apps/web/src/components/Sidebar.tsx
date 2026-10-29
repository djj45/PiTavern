import { useRef, useState } from "react";
import type { ChatSummaryDto, CharacterDto } from "@pitavern/shared";
import { api } from "../api.ts";
import { ChatItemMenu } from "./ChatItemMenu.tsx";

interface SidebarProps {
  characters: CharacterDto[];
  selectedCharacter: string | null;
  onSelectCharacter: (name: string | null) => void;
  chats: ChatSummaryDto[];
  activeChatId: string | null;
  onOpenChat: (chatId: string) => void;
  onNewChat: () => void;
  onNewGroup: (name: string, members: string[]) => Promise<boolean>;
  onDeleteChat: (chatId: string) => void;
  /** 置顶/重命名/归档成功后刷新对话列表。 */
  onChatsChanged: () => void | Promise<void>;
  onCharactersChanged: () => void;
  onNotice: (message: string) => void;
  /** 移动端抽屉开合（md 以上恒开） */
  mobileOpen: boolean;
  onClose: () => void;
}

export function Sidebar({
  characters,
  selectedCharacter,
  onSelectCharacter,
  chats,
  activeChatId,
  onOpenChat,
  onNewChat,
  onNewGroup,
  onDeleteChat,
  onChatsChanged,
  onCharactersChanged,
  onNotice,
  mobileOpen,
  onClose,
}: SidebarProps) {
  const [archivedOpen, setArchivedOpen] = useState(false);
  const [importing, setImporting] = useState(false);
  const [groupOpen, setGroupOpen] = useState(false);
  const [groupName, setGroupName] = useState("新群聊");
  const [members, setMembers] = useState<string[]>([]);
  const [creating, setCreating] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const importCards = async (files: FileList) => {
    setImporting(true);
    try {
      for (const file of files) {
        try {
          const result = await api.importCharacter(file);
          onNotice("已导入 " + result.file + (result.warnings?.length ? "；" + result.warnings.join("；") : ""));
        } catch (e) {
          onNotice(`${file.name} 导入失败: ${(e as Error).message}`);
        }
      }
      onCharactersChanged();
    } finally {
      setImporting(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  const orderedChats = [...chats].sort((a, b) => Number(Boolean(b.pinned)) - Number(Boolean(a.pinned)));
  const visibleChats = orderedChats.filter((chat) => !chat.archived);
  const archivedChats = orderedChats.filter((chat) => chat.archived);

  const renderChatItem = (chat: ChatSummaryDto) => {
    const displayName = chat.displayName?.trim() || chat.group?.name || chat.character;
    return (
      <li key={chat.id} className="group relative">
        <button
          type="button"
          onClick={() => { onOpenChat(chat.id); onClose(); }}
          className={`w-full rounded-md px-2 py-1.5 pr-8 text-left ${
            chat.id === activeChatId ? "bg-tavern-raised" : "hover:bg-tavern-raised/60"
          }`}
        >
          <div className="flex min-w-0 items-center gap-1 text-sm text-tavern-text">
            {chat.pinned && <span aria-hidden="true" className="shrink-0">📌</span>}
            <span className="truncate">{displayName}</span>
          </div>
          <div className="truncate text-xs text-tavern-dim">
            {chat.lastMessage || "(空)"} · {chat.messageCount} 条
          </div>
        </button>
        <ChatItemMenu
          chat={chat}
          displayName={displayName}
          onChatsChanged={onChatsChanged}
          onDeleteChat={onDeleteChat}
          onNotice={onNotice}
        />
      </li>
    );
  };

  return (
    <>
      {mobileOpen && (
        <button
          type="button"
          aria-label="关闭菜单"
          onClick={onClose}
          className="fixed inset-0 z-30 bg-black/50 md:hidden"
        />
      )}
      <aside
        className={`fixed inset-y-0 left-0 z-40 flex w-72 shrink-0 flex-col border-r border-tavern-border bg-tavern-panel transition-transform duration-200 md:static md:z-auto md:w-64 md:translate-x-0 md:transition-none ${
          mobileOpen ? "translate-x-0" : "-translate-x-full"
        }`}
      >
        <div className="border-b border-tavern-border p-3">
          <button
            type="button"
          onClick={onNewChat}
          className="w-full rounded-md bg-tavern-accent/15 px-3 py-1.5 text-sm font-medium text-tavern-accent hover:bg-tavern-accent/25"
        >
          ＋ 开始新对话
        </button>
        <button type="button" className="mt-2 w-full rounded border border-tavern-border px-3 py-1.5 text-sm" onClick={() => setGroupOpen((value) => !value)}>＋ 新建群聊</button>
        {groupOpen && <form aria-label="新建群聊" onSubmit={(event) => {
          event.preventDefault(); if (creating) return; setCreating(true);
          void onNewGroup(groupName, members).then((ok) => { if (ok) { setGroupOpen(false); setMembers([]); onClose(); } }).finally(() => setCreating(false));
        }} className="mt-2 flex flex-col gap-2 text-xs">
          <input aria-label="群聊名称" value={groupName} maxLength={100} onChange={(e) => setGroupName(e.target.value)} className="rounded border border-tavern-border bg-tavern-bg p-2" />
          <p>按勾选顺序发言（2–12 位）：</p>
          {characters.map((c) => <label key={c.name} className="flex gap-2"><input type="checkbox" checked={members.includes(c.name)} disabled={creating || (!members.includes(c.name) && members.length >= 12)} onChange={(e) => setMembers((old) => e.target.checked ? [...old, c.name] : old.filter((name) => name !== c.name))} />{c.name}{members.includes(c.name) ? " · " + (members.indexOf(c.name) + 1) : ""}</label>)}
          <button type="submit" disabled={creating || members.length < 2 || !groupName.trim()} className="rounded bg-tavern-accent p-2 text-tavern-bg disabled:opacity-40">{creating ? "创建中…" : "创建群聊"}</button>
        </form>}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <section className="p-2">
          <h3 className="flex items-center gap-2 px-2 pb-1 text-xs font-medium text-tavern-dim">
            <span>角色 {characters.length > 0 && `(${characters.length})`}</span>
            <button
              type="button"
              disabled={importing}
              onClick={() => fileRef.current?.click()}
              className="ml-auto rounded border border-tavern-border px-1.5 py-0.5 text-tavern-dim hover:border-tavern-accent-dim hover:text-tavern-text disabled:opacity-50"
            >
              {importing ? "导入中…" : "＋ 导入"}
            </button>
            <input
              ref={fileRef}
              type="file"
              accept=".png,.json,.charx,.byaf"
              multiple
              hidden
              onChange={(e) => e.target.files?.length && void importCards(e.target.files)}
            />
          </h3>
          {characters.length === 0 && (
            <p className="px-2 py-1 text-xs leading-5 text-tavern-dim">
              点「＋导入」上传角色卡 PNG / JSON / CharX / BYAF，或放入数据目录的 characters/
            </p>
          )}
          <div className="flex flex-wrap gap-1.5 p-1">
            <button
              type="button"
              onClick={() => onSelectCharacter(null)}
              className={`rounded-full px-2.5 py-1 text-xs ${
                selectedCharacter === null ? "bg-tavern-accent text-tavern-bg" : "bg-tavern-raised text-tavern-dim hover:text-tavern-text"
              }`}
            >
              全部
            </button>
            {characters.map((c) => (
              <button
                key={c.name}
                type="button"
                onClick={() => onSelectCharacter(c.name)}
                title={c.description.slice(0, 200)}
                className={`rounded-full px-2.5 py-1 text-xs ${
                  selectedCharacter === c.name
                    ? "bg-tavern-accent text-tavern-bg"
                    : "bg-tavern-raised text-tavern-dim hover:text-tavern-text"
                }`}
              >
                {c.name}
              </button>
            ))}
          </div>
        </section>

        <section className="p-2">
          <h3 className="px-2 pb-1 text-xs font-medium text-tavern-dim">对话 ({visibleChats.length})</h3>
          {visibleChats.length === 0 && <p className="px-2 py-1 text-xs text-tavern-dim">暂无对话</p>}
          <ul aria-label="对话列表">
            {visibleChats.map(renderChatItem)}
          </ul>
          {archivedChats.length > 0 && (
            <div className="mt-1 border-t border-tavern-border pt-1">
              <button
                type="button"
                aria-expanded={archivedOpen}
                onClick={() => setArchivedOpen((value) => !value)}
                className="flex w-full items-center gap-1 rounded-md px-2 py-1.5 text-left text-xs text-tavern-dim hover:bg-tavern-raised/60 hover:text-tavern-text"
              >
                <span>已归档 ({archivedChats.length})</span>
                <span aria-hidden="true" className="ml-auto">{archivedOpen ? "▾" : "▸"}</span>
              </button>
              {archivedOpen && (
                <ul aria-label="已归档对话" className="mt-1">
                  {archivedChats.map(renderChatItem)}
                </ul>
              )}
            </div>
          )}
        </section>
      </div>
      </aside>
    </>
  );
}
