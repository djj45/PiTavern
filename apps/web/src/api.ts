import type {
  ChatSnapshotDto,
  ChatSummaryDto,
  CharacterDto,
  ConnectionDto,
  PresetSummaryDto,
  WorldSummaryDto,
} from "@pitavern/shared";

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `${res.status} ${res.statusText}`);
  }
  return res.json() as Promise<T>;
}

export const api = {
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
