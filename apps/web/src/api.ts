import type {
  AuthorNoteDto,
  AuthorNoteSnapshotDto,
  ChatBackupDto,
  GenerationPageDto,
  ChatBackupPreviewDto,
  ChatPageDto,
  ChatSnapshotDto,
  ChatSummaryDto,
  CharacterDto,
  ConnectionDto,
  PresetSummaryDto,
  WorldSummaryDto,
  LibraryResourceDto,
  LibraryDocumentDto,
  LibraryBackupPreviewDto,
} from "@pitavern/shared";

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `${res.status} ${res.statusText}`);
  }
  return res.json() as Promise<T>;
}

export const api = {
  library: () => fetch("/api/library").then((r) => json<LibraryResourceDto[]>(r)),
  libraryDocument: (id: string) => fetch("/api/library/document?" + new URLSearchParams({ id })).then((r) => json<LibraryDocumentDto>(r)),
  saveLibraryDocument: (document: LibraryDocumentDto) => fetch("/api/library/document", {
    method: "PUT", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id: document.resource.id, revision: document.revision, data: document.data }),
  }).then((r) => json<LibraryDocumentDto>(r)),
  createWorld: (name: string) => fetch("/api/library/world", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name }) })
    .then((r) => json<LibraryDocumentDto>(r)),
  previewLibraryBackup: (file: File) => fetch("/api/library-backup/preview", { method: "POST", headers: { "Content-Type": "application/octet-stream" }, body: file })
    .then((r) => json<LibraryBackupPreviewDto>(r)),
  discardLibraryBackup: (id: string) => fetch("/api/library-backup/preview?" + new URLSearchParams({ id }), { method: "DELETE" }).then((r) => json<{ ok: true }>(r)),
  restoreLibraryBackup: (id: string) => fetch("/api/library-backup/restore", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id }) })
    .then((r) => json<{ stDataDir: string; previousDataDir: string; restartRequired: true }>(r)),
  exportLibraryBackup: async () => {
    const response = await fetch("/api/library-backup/export");
    if (!response.ok) { await json(response); throw new Error("导出失败"); }
    return response.blob();
  },
  authorNote: (chatId: string) => fetch("/api/chat/author-note?" + new URLSearchParams({ chatId }))
    .then((r) => json<AuthorNoteSnapshotDto>(r)),
  saveAuthorNote: (chatId: string, note: AuthorNoteDto, revision: string) =>
    fetch("/api/chat/author-note", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ chatId, note, revision }) })
      .then((r) => json<AuthorNoteSnapshotDto>(r)),
  activity: (chatId: string, before?: string) => fetch("/api/chat/activity?" + new URLSearchParams({ chatId, ...(before ? { before } : {}) }))
    .then((r) => json<GenerationPageDto>(r)),
  connection: () => fetch("/api/connection").then((r) => json<ConnectionDto>(r)),
  saveConnection: (patch: Partial<Omit<ConnectionDto, "providers">> & {
    providers?: Array<ConnectionDto["providers"][number] & { apiKey?: string }>;
  }) =>
    fetch("/api/connection", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    }).then((r) => json<{ ok: boolean; restartRequired?: boolean }>(r)),
  testConnection: () =>
    fetch("/api/connection/test", { method: "POST" }).then((r) =>
      json<{ ok: boolean; provider?: string; model?: string; error?: string }>(r),
    ),
  testVectors: () => fetch("/api/vectors/test", { method: "POST" }).then((r) => json<{ ok: boolean; dimensions: number }>(r)),
  characters: () => fetch("/api/characters").then((r) => json<CharacterDto[]>(r)),
  presets: () => fetch("/api/presets").then((r) => json<PresetSummaryDto[]>(r)),
  worlds: () => fetch("/api/worlds").then((r) => json<WorldSummaryDto[]>(r)),
  chats: (character?: string) =>
    fetch(`/api/chats${character ? `?character=${encodeURIComponent(character)}` : ""}`).then((r) =>
      json<ChatSummaryDto[]>(r),
    ),
  createChat: (character: string, greeting?: string) =>
    fetch("/api/chats", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ character, greeting }),
    }).then((r) => json<{ id: string }>(r)),
  chat: (id: string) =>
    fetch(`/api/chats/${id.split("/").map(encodeURIComponent).join("/")}`).then((r) =>
      json<ChatSnapshotDto>(r),
    ),
  deleteChat: (id: string) =>
    fetch(`/api/chats/${id.split("/").map(encodeURIComponent).join("/")}`, { method: "DELETE" }).then((r) =>
      json<{ ok: boolean }>(r),
    ),
  editMessage: (chatId: string, messageId: string, text: string, expectedText: string) =>
    fetch("/api/chat/message", {
      method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chatId, messageId, text, expectedText }),
    }).then((r) => json<{ ok: boolean }>(r)),
  history: (chatId: string, before: number, revision: string) =>
    fetch("/api/chat/history?" + new URLSearchParams({ chatId, before: String(before), revision })).then((r) => json<ChatPageDto>(r)),
  selectReply: (chatId: string, userMessageId: string, selected: number, revision: string) =>
    fetch("/api/chat/reply", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chatId, userMessageId, selected, revision }) }).then((r) => json<{ ok: boolean }>(r)),
  backups: (chatId: string, before?: string) => fetch("/api/chat/backups?" + new URLSearchParams({ chatId, ...(before ? { before } : {}) }))
    .then((r) => json<{ backups: ChatBackupDto[]; before: string | null }>(r)),
  previewBackup: (chatId: string, backupId: string) => fetch("/api/chat/backup?" + new URLSearchParams({ chatId, backupId }))
    .then((r) => json<ChatBackupPreviewDto>(r)),
  restoreBackup: (chatId: string, backupId: string, revision: string) =>
    fetch("/api/chat/backup/restore", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chatId, backupId, revision }) }).then((r) => json<{ ok: boolean }>(r)),
  importCharacter: (file: File) =>
    fetch("/api/import/character", {
      method: "POST",
      headers: { "Content-Type": "application/octet-stream", "x-file-name": encodeURIComponent(file.name) },
      body: file,
    }).then((r) => json<{ ok: boolean; file: string }>(r)),
  importWorld: (name: string, data: unknown) =>
    fetch("/api/import/world", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, data }),
    }).then((r) => json<{ ok: boolean; name: string; entryCount: number }>(r)),
};

/** 聊天导出下载地址（format: md | jsonl） */
export function chatExportUrl(chatId: string, format: "md" | "jsonl"): string {
  return `/api/chats/${chatId.split("/").map(encodeURIComponent).join("/")}/export?format=${format}`;
}
