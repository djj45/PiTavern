import type {
  AuthorNoteDto,
  AuthorNoteSnapshotDto,
  BranchIndexDto,
  BranchMetaPatchDto,
  BranchPreviewDto,
  BranchPathStepDto,
  BranchSearchDto,
  BranchSwitchResultDto,
  ChatBackupDto,
  GenerationPageDto,
  ChatBackupPreviewDto,
  ChatPageDto,
  ChatSnapshotDto,
  ChatSummaryDto,
  CharacterDto,
  ConnectionDto,
  DiscoveredModelDto,
  ModelDiscoveryRequest,
  PresetSummaryDto,
  WorldSummaryDto,
  LibraryResourceDto,
  LibraryDocumentDto,
  LibraryBackupPreviewDto,
  LibraryBackupJobDto,
  LibraryBackupStorageDto,
  LibraryHistoryPageDto,
  LibraryHistoryPreviewDto,
} from "@pitavern/shared";
import type { WorldSnapshot, WorldTemplateSummaryDto } from "@pitavern/shared/world";

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `${res.status} ${res.statusText}`);
  }
  return res.json() as Promise<T>;
}

export const api = {
  startLibraryBackupJob: (options: { action: "export" | "import" | "restore"; includeSettings?: boolean; previewId?: string; applySettings?: boolean }) => fetch("/api/library-backup/jobs", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(options) }).then((r) => json<LibraryBackupJobDto>(r)),
  libraryBackupJob: (id: string, signal?: AbortSignal) => fetch("/api/library-backup/jobs/" + encodeURIComponent(id), { signal }).then((r) => json<LibraryBackupJobDto>(r)),
  cancelLibraryBackupJob: (id: string) => fetch("/api/library-backup/jobs/" + encodeURIComponent(id) + "/cancel", { method: "POST" }).then((r) => json<LibraryBackupJobDto>(r)),
  uploadLibraryBackupJob: (id: string, file: File, progress: (bytes: number) => void) => new Promise<void>((resolve, reject) => {
    const xhr = new XMLHttpRequest(); xhr.open("POST", "/api/library-backup/jobs/" + encodeURIComponent(id) + "/upload"); xhr.setRequestHeader("Content-Type", "application/octet-stream");
    xhr.upload.onprogress = (event) => progress(event.loaded);
    xhr.onload = () => { if (xhr.status >= 200 && xhr.status < 300) resolve(); else reject(new Error("上传请求失败，请查看任务结果")); };
    xhr.onerror = () => reject(new Error("上传连接中断")); xhr.onabort = () => reject(new Error("上传已取消")); xhr.send(file);
  }),
  libraryBackupStorage: () => fetch("/api/library-backup/storage").then((r) => json<LibraryBackupStorageDto>(r)),
  removeLibraryBackupArtifact: (id: string, confirmation: string) => fetch("/api/library-backup/storage", { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id, confirmation }) }).then((r) => json<{ ok: true }>(r)),
  library: () => fetch("/api/library").then((r) => json<LibraryResourceDto[]>(r)),
  libraryDocument: (id: string) => fetch("/api/library/document?" + new URLSearchParams({ id })).then((r) => json<LibraryDocumentDto>(r)),
  saveLibraryDocument: (document: LibraryDocumentDto) => fetch("/api/library/document", {
    method: "PUT", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id: document.resource.id, revision: document.revision, data: document.data }),
  }).then((r) => json<LibraryDocumentDto>(r)),
  libraryHistory: (id: string, before?: string) => fetch("/api/library/history?" + new URLSearchParams({ id, ...(before ? { before } : {}) })).then((r) => json<LibraryHistoryPageDto>(r)),
  previewLibraryHistory: (id: string, backupId: string) => fetch("/api/library/history/preview?" + new URLSearchParams({ id, backupId })).then((r) => json<LibraryHistoryPreviewDto>(r)),
  restoreLibraryHistory: (id: string, backupId: string, revision: string) => fetch("/api/library/history/restore", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id, backupId, revision }) }).then((r) => json<LibraryDocumentDto>(r)),
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
  discoverModels: (draft: ModelDiscoveryRequest, signal?: AbortSignal) => fetch("/api/connection/models", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(draft), signal,
  }).then((r) => json<{ models: DiscoveredModelDto[] }>(r)),
  setModelThinkingLevel: (providerId: string, modelId: string, thinkingLevel: NonNullable<ConnectionDto["thinkingLevel"]>) =>
    fetch("/api/connection/model", { method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ providerId, modelId, thinkingLevel }) }).then((r) => json<{ ok: boolean; thinkingLevel: string }>(r)),
  resetConnectionDefaults: () =>
    fetch("/api/connection/reset", { method: "POST" }).then((r) => json<{ ok: boolean }>(r)),
  saveConnection: (patch: Partial<Omit<ConnectionDto, "providers">> & {
    providers?: Array<ConnectionDto["providers"][number] & { apiKey?: string }>;
  }) =>
    fetch("/api/connection", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    }).then((r) => json<{ ok: boolean; restartRequired?: boolean }>(r)),
  testConnection: (target?: { providerId: string; modelId: string }) =>
    fetch("/api/connection/test", {
      method: "POST",
      ...(target ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(target) } : {}),
    }).then((r) => json<{ ok: boolean; provider?: string; model?: string; error?: string }>(r)),
  testVectors: () => fetch("/api/vectors/test", { method: "POST" }).then((r) => json<{ ok: boolean; dimensions: number }>(r)),
  characters: () => fetch("/api/characters").then((r) => json<CharacterDto[]>(r)),
  presets: () => fetch("/api/presets").then((r) => json<PresetSummaryDto[]>(r)),
  worlds: () => fetch("/api/worlds").then((r) => json<WorldSummaryDto[]>(r)),
  worldTemplates: () => fetch("/api/world/templates").then((r) => json<WorldTemplateSummaryDto[]>(r)),
  initializeWorld: (chatId: string, templateId: string, revision: string, allowExisting = true) =>
    fetch("/api/chat/world/initialize", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chatId, templateId, revision, allowExisting }) }).then((r) => json<{ ok: boolean }>(r)),
  correctWorld: (chatId: string, revision: string, snapshot: WorldSnapshot) =>
    fetch("/api/chat/world/correct", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chatId, revision, snapshot }) }).then((r) => json<{ ok: boolean }>(r)),
  chats: (character?: string) =>
    fetch(`/api/chats${character ? `?character=${encodeURIComponent(character)}` : ""}`).then((r) =>
      json<ChatSummaryDto[]>(r),
    ),
  runScript: (chatId: string, source: string, revision: string) => fetch("/api/chat/script", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ chatId, source, revision }),
  }).then((r) => json<{ pipe: string; notices: string[]; steps: number }>(r)),
  createGroup: (name: string, members: string[]) => fetch("/api/groups", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name, members }),
  }).then((r) => json<{ id: string }>(r)),
  createChat: (character: string, greeting?: string, worldTemplateId?: string) =>
    fetch("/api/chats", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ character, greeting, ...(worldTemplateId ? { worldTemplateId } : {}) }),
    }).then((r) => json<{ id: string }>(r)),
  selectGreeting: (chatId: string, selected: number, revision: string) => fetch("/api/chat/greeting", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ chatId, selected, revision }),
  }).then((r) => json<{ ok: boolean }>(r)),
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
  branchIndex: (chatId: string) => fetch("/api/chat/branch-index?" + new URLSearchParams({ chatId })).then((r) => json<BranchIndexDto>(r)),
  branchPreview: (chatId: string, nodeId: string, offset = 0, limit = 20) =>
    fetch("/api/chat/branch-preview?" + new URLSearchParams({ chatId, nodeId, offset: String(offset), limit: String(limit) })).then((r) => json<BranchPreviewDto>(r)),
  searchBranches: (chatId: string, query: string, cursor = 0, limit = 100) =>
    fetch("/api/chat/branch-search?" + new URLSearchParams({ chatId, q: query, cursor: String(cursor), limit: String(limit) })).then((r) => json<BranchSearchDto>(r)),
  switchBranchPath: (chatId: string, revision: string, path: BranchPathStepDto[]) =>
    fetch("/api/chat/branch-switch", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chatId, revision, path }) }).then((r) => json<BranchSwitchResultDto>(r)),
  updateBranchMeta: (chatId: string, revision: string, nodeId: string, patch: BranchMetaPatchDto) =>
    fetch("/api/chat/branch-meta", { method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chatId, revision, nodeId, patch }) }).then((r) => json<BranchSwitchResultDto>(r)),
  updateBranchMetas: (chatId: string, revision: string, nodeIds: string[], patch: BranchMetaPatchDto) =>
    fetch("/api/chat/branch-meta-bulk", { method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chatId, revision, nodeIds, patch }) }).then((r) => json<BranchSwitchResultDto>(r)),
  /** 侧栏对话菜单：置顶 / 归档 / 重命名（服务端写入 chat_metadata）。 */
  updateChatMeta: (chatId: string, patch: { pinned?: boolean; archived?: boolean; displayName?: string | null }) =>
    fetch("/api/chat/meta", { method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chatId, ...patch }) }).then((r) => json<{ ok: boolean }>(r)),
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
    }).then((r) => json<{ ok: boolean; file: string; warnings?: string[]; chats?: number; assets?: number }>(r)),
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
