import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type FormEvent } from "react";
import { createPortal } from "react-dom";
import type { ChatSummaryDto } from "@pitavern/shared";
import { api } from "../api.ts";

export interface ChatItemMenuProps {
  chat: ChatSummaryDto;
  /** 当前显示名：displayName 优先，否则群聊名 / 角色名。 */
  displayName: string;
  onChatsChanged: () => void | Promise<void>;
  onDeleteChat: (chatId: string) => void;
  onNotice: (message: string) => void;
}

interface MenuPosition {
  top?: number;
  bottom?: number;
  left: number;
  width: number;
  maxHeight: number;
}

const MENU_WIDTH = 192;
const MENU_GAP = 6;
const VIEWPORT_PADDING = 8;
const MENU_MAX_HEIGHT = 224;

const menuItemClass =
  "flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm text-tavern-text hover:bg-tavern-raised focus:bg-tavern-raised focus:outline-none disabled:cursor-not-allowed disabled:opacity-40";

/** 对话列表项右侧的“⋯”按钮 + 浮层菜单（置顶 / 重命名 / 归档 / 删除）。 */
export function ChatItemMenu({ chat, displayName, onChatsChanged, onDeleteChat, onNotice }: ChatItemMenuProps) {
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const renameInputRef = useRef<HTMLInputElement>(null);
  const inputId = useId();
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<MenuPosition | null>(null);
  const [touch, setTouch] = useState(false);
  const [busy, setBusy] = useState(false);
  const [renameOpen, setRenameOpen] = useState(false);
  const [renameValue, setRenameValue] = useState(displayName);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deletePending, setDeletePending] = useState(false);

  useEffect(() => {
    const media = window.matchMedia("(hover: none), (pointer: coarse)");
    const update = () => setTouch(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);

  const closeMenu = useCallback((restoreFocus = false) => {
    setOpen(false);
    setPosition(null);
    if (restoreFocus) triggerRef.current?.focus();
  }, []);

  const placeMenu = useCallback(() => {
    const trigger = triggerRef.current;
    if (!trigger) return;
    const rect = trigger.getBoundingClientRect();
    const width = Math.min(MENU_WIDTH, window.innerWidth - VIEWPORT_PADDING * 2);
    const rightAligned = Math.min(rect.right, window.innerWidth - VIEWPORT_PADDING);
    const left = Math.max(VIEWPORT_PADDING, Math.min(rightAligned - width, window.innerWidth - width - VIEWPORT_PADDING));
    const below = window.innerHeight - rect.bottom - VIEWPORT_PADDING - MENU_GAP;
    const above = rect.top - VIEWPORT_PADDING - MENU_GAP;
    const openUp = below < MENU_MAX_HEIGHT && above > below;
    const maxHeight = Math.max(96, Math.min(MENU_MAX_HEIGHT, openUp ? above : below));
    if (openUp) {
      setPosition({ bottom: window.innerHeight - rect.top + MENU_GAP, left, width, maxHeight });
    } else {
      setPosition({ top: rect.bottom + MENU_GAP, left, width, maxHeight });
    }
  }, []);

  useLayoutEffect(() => {
    if (!open) return;
    placeMenu();
    const handleLayout = () => placeMenu();
    window.addEventListener("resize", handleLayout);
    window.addEventListener("scroll", handleLayout, true);
    return () => {
      window.removeEventListener("resize", handleLayout);
      window.removeEventListener("scroll", handleLayout, true);
    };
  }, [open, placeMenu]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (triggerRef.current?.contains(target) || menuRef.current?.contains(target)) return;
      closeMenu();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      closeMenu(true);
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open, closeMenu]);

  useEffect(() => {
    if (!renameOpen && !deleteOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      setRenameOpen(false);
      setDeleteOpen(false);
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [renameOpen, deleteOpen]);

  useEffect(() => {
    if (renameOpen) renameInputRef.current?.focus();
  }, [renameOpen]);

  const applyMeta = async (patch: { pinned?: boolean; archived?: boolean; displayName?: string | null }, failure: string) => {
    if (busy) return false;
    setBusy(true);
    try {
      await api.updateChatMeta(chat.id, patch);
      await onChatsChanged();
      return true;
    } catch (error) {
      onNotice(`${failure}: ${(error as Error).message}`);
      return false;
    } finally {
      setBusy(false);
    }
  };

  const togglePin = () => {
    closeMenu();
    void applyMeta({ pinned: !chat.pinned }, chat.pinned ? "取消置顶失败" : "置顶失败");
  };

  const toggleArchive = () => {
    closeMenu();
    void applyMeta({ archived: !chat.archived }, chat.archived ? "取消归档失败" : "归档失败");
  };

  const openRename = () => {
    closeMenu();
    setRenameValue(displayName);
    setRenameOpen(true);
  };

  const submitRename = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy) return;
    const name = renameValue.trim();
    const ok = await applyMeta({ displayName: name ? name : null }, "重命名失败");
    if (ok) setRenameOpen(false);
  };

  const openDelete = () => {
    closeMenu();
    setDeleteOpen(true);
  };

  const confirmDelete = async () => {
    if (deletePending) return;
    setDeletePending(true);
    try {
      await onDeleteChat(chat.id);
      setDeleteOpen(false);
    } finally {
      setDeletePending(false);
    }
  };

  const triggerVisibility = open
    ? "opacity-100"
    : touch
      ? "opacity-100"
      : "opacity-0 group-hover:opacity-100 group-focus-within:opacity-100";

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        disabled={busy}
        aria-label={`对话操作：${displayName}`}
        aria-haspopup="menu"
        aria-expanded={open}
        title="对话操作"
        onClick={(event) => {
          event.stopPropagation();
          if (open) closeMenu();
          else setOpen(true);
        }}
        className={`absolute right-1 top-1/2 z-10 -translate-y-1/2 rounded px-1.5 py-0.5 text-lg leading-none text-tavern-dim hover:bg-tavern-raised hover:text-tavern-text focus:outline-none focus-visible:ring-2 focus-visible:ring-tavern-accent disabled:opacity-40 max-md:opacity-100 ${triggerVisibility}`}
      >
        ⋯
      </button>

      {open && position && createPortal(
        <div
          ref={menuRef}
          role="menu"
          aria-label="对话操作菜单"
          aria-busy={busy}
          style={{
            position: "fixed",
            top: position.top,
            bottom: position.bottom,
            left: position.left,
            width: position.width,
            maxHeight: position.maxHeight,
            zIndex: 60,
          }}
          className="overflow-y-auto rounded-lg border border-tavern-border bg-tavern-panel p-1 text-sm text-tavern-text shadow-2xl"
          onPointerDown={(event) => event.stopPropagation()}
        >
          <button type="button" role="menuitem" disabled={busy} onClick={togglePin} className={menuItemClass}>
            <span aria-hidden="true">📌</span>
            <span>{chat.pinned ? "取消置顶" : "置顶"}</span>
          </button>
          <button type="button" role="menuitem" disabled={busy} onClick={openRename} className={menuItemClass}>
            <span aria-hidden="true">✏️</span>
            <span>重命名</span>
          </button>
          <button type="button" role="menuitem" disabled={busy} onClick={toggleArchive} className={menuItemClass}>
            <span aria-hidden="true">🗄️</span>
            <span>{chat.archived ? "取消归档" : "归档"}</span>
          </button>
          <button type="button" role="menuitem" disabled={busy} onClick={openDelete}
            className={`${menuItemClass} text-red-400 hover:bg-red-500/10 focus:bg-red-500/10`}>
            <span aria-hidden="true">🗑️</span>
            <span>删除</span>
          </button>
        </div>,
        document.body,
      )}

      {renameOpen && createPortal(
        <div
          className="fixed inset-0 z-[70] flex items-center justify-center bg-black/60 p-4"
          onPointerDown={(event) => { if (event.target === event.currentTarget) setRenameOpen(false); }}
        >
          <form
            role="dialog"
            aria-modal="true"
            aria-label="重命名对话"
            onSubmit={(event) => void submitRename(event)}
            className="w-full max-w-sm rounded-xl border border-tavern-border bg-tavern-panel p-5 text-tavern-text shadow-2xl"
          >
            <h2 className="text-base font-medium">重命名对话</h2>
            <label htmlFor={inputId} className="mt-3 block text-xs text-tavern-dim">对话名称</label>
            <input
              ref={renameInputRef}
              id={inputId}
              aria-label="对话名称"
              maxLength={100}
              value={renameValue}
              onChange={(event) => setRenameValue(event.target.value)}
              className="mt-1 w-full rounded-lg border border-tavern-border bg-tavern-bg px-3 py-2 text-sm text-tavern-text focus:border-tavern-accent focus:outline-none"
            />
            <div className="mt-4 flex justify-end gap-2">
              <button type="button" onClick={() => setRenameOpen(false)}
                className="rounded-lg border border-tavern-border px-4 py-2 text-sm hover:bg-tavern-raised">
                取消
              </button>
              <button type="submit" disabled={busy}
                className="rounded-lg bg-tavern-accent px-4 py-2 text-sm font-medium text-tavern-bg disabled:cursor-not-allowed disabled:opacity-40">
                {busy ? "保存中…" : "保存"}
              </button>
            </div>
          </form>
        </div>,
        document.body,
      )}

      {deleteOpen && createPortal(
        <div
          className="fixed inset-0 z-[70] flex items-center justify-center bg-black/60 p-4"
          onPointerDown={(event) => { if (event.target === event.currentTarget) setDeleteOpen(false); }}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-label="删除对话"
            className="w-full max-w-sm rounded-xl border border-tavern-border bg-tavern-panel p-5 text-tavern-text shadow-2xl"
          >
            <h2 className="text-base font-medium">删除对话</h2>
            <p className="mt-2 text-sm leading-6 text-tavern-dim">删除对话？此操作不可恢复。</p>
            <div className="mt-4 flex justify-end gap-2">
              <button type="button" onClick={() => setDeleteOpen(false)}
                className="rounded-lg border border-tavern-border px-4 py-2 text-sm hover:bg-tavern-raised">
                取消
              </button>
              <button type="button" disabled={deletePending} onClick={() => void confirmDelete()}
                className="rounded-lg bg-red-500/90 px-4 py-2 text-sm font-medium text-white hover:bg-red-500 disabled:cursor-not-allowed disabled:opacity-40">
                {deletePending ? "删除中…" : "删除"}
              </button>
            </div>
          </div>
        </div>,
        document.body,
      )}
    </>
  );
}
