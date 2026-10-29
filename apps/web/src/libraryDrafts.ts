import type { LibraryDocumentDto } from '@pitavern/shared';
export interface LibraryDraft { version: 1; updatedAt: string; document: LibraryDocumentDto }
const key = (scope: string, id: string) => 'PiTavern.library.draft.v1:' + encodeURIComponent(scope) + ':' + encodeURIComponent(id);
export function readLibraryDraft(scope: string, id: string): LibraryDraft | null {
  const raw = localStorage.getItem(key(scope, id));
  if (!raw) return null;
  const value = JSON.parse(raw) as LibraryDraft;
  if (value.version !== 1 || value.document?.resource?.id !== id || typeof value.document.revision !== 'string' || !value.document.data) throw new Error('本地草稿格式无效，请清除该草稿');
  return value;
}
export function writeLibraryDraft(scope: string, document: LibraryDocumentDto): void {
  localStorage.setItem(key(scope, document.resource.id), JSON.stringify({ version: 1, updatedAt: new Date().toISOString(), document } satisfies LibraryDraft));
}
export function removeLibraryDraft(scope: string, id: string): void { localStorage.removeItem(key(scope, id)); }
