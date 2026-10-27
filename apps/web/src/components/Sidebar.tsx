import { useRef, useState } from "react";
import type { ChatSummaryDto, CharacterDto } from "@pitavern/shared";
import { api } from "../api.ts";

interface SidebarProps {
  characters: CharacterDto[];
  selectedCharacter: string | null;
  onSelectCharacter: (name: string | null) => void;
  chats: ChatSummaryDto[];
  activeChatId: string | null;
  onOpenChat: (chatId: string) => void;
  onNewChat: () => void;
  onDeleteChat: (chatId: string) => void;
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
  onDeleteChat,
  onCharactersChanged,
  onNotice,
  mobileOpen,
  onClose,
}: SidebarProps) {
  const [chatToDelete, setChatToDelete] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const importCards = async (files: FileList) => {
    setImporting(true);
    try {
      for (const file of files) {
        try {
          const result = await api.importCharacter(file);
          onNotice(`已导入 ${result.file}`);
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
              accept=".png,.json"
              multiple
              hidden
              onChange={(e) => e.target.files?.length && void importCards(e.target.files)}
            />
          </h3>
          {characters.length === 0 && (
            <p className="px-2 py-1 text-xs leading-5 text-tavern-dim">
              点「＋导入」上传角色卡 PNG / JSON，或放入数据目录的 characters/
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
          <h3 className="px-2 pb-1 text-xs font-medium text-tavern-dim">对话 ({chats.length})</h3>
          {chats.length === 0 && <p className="px-2 py-1 text-xs text-tavern-dim">暂无对话</p>}
          <ul>
            {chats.map((chat) => (
              <li key={chat.id} className="group relative">
                <button
                  type="button"
                  onClick={() => { onOpenChat(chat.id); onClose(); }}
                  className={`w-full rounded-md px-2 py-1.5 text-left ${
                    chat.id === activeChatId ? "bg-tavern-raised" : "hover:bg-tavern-raised/60"
                  }`}
                >
                  <div className="truncate pr-6 text-sm text-tavern-text">{chat.character}</div>
                  <div className="truncate pr-6 text-xs text-tavern-dim">
                    {chat.lastMessage || "(空)"} · {chat.messageCount} 条
                  </div>
                </button>
                {chatToDelete === chat.id ? (
                  <div className="absolute right-1 top-1/2 flex -translate-y-1/2 items-center gap-1 rounded bg-tavern-panel p-0.5 text-xs">
                    <button type="button" className="px-1 text-red-400" onClick={() => onDeleteChat(chat.id)}>
                      删
                    </button>
                    <button type="button" className="px-1 text-tavern-dim" onClick={() => setChatToDelete(null)}>
                      取
                    </button>
                  </div>
                ) : (
                  <button
                    type="button"
                    aria-label="删除对话"
                    onClick={() => setChatToDelete(chat.id)}
                    className="absolute right-1 top-1/2 hidden -translate-y-1/2 rounded px-1 text-xs text-tavern-dim hover:text-red-400 group-hover:block"
                  >
                    ✕
                  </button>
                )}
              </li>
            ))}
          </ul>
        </section>
      </div>
      </aside>
    </>
  );
}
