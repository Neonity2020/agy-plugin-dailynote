import type {
  AttachmentUploadResult,
  CalendarDay,
  DailyNote,
  NoteMeta,
  ProjectLink,
  ProjectSummary,
  RevisionRecord,
  SearchResultItem,
  TagCount,
} from '../types';

export class ApiError extends Error {
  code: string;
  status: number;
  details?: Record<string, unknown>;

  constructor(code: string, message: string, status = 400, details?: Record<string, unknown>) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

interface Envelope<T> {
  ok: boolean;
  data?: T;
  error?: {
    code: string;
    message: string;
    details?: Record<string, unknown>;
  };
}

function getFetchFn(): typeof fetch {
  if (typeof window !== 'undefined' && window.sidecar?.fetch) {
    return window.sidecar.fetch.bind(window.sidecar);
  }
  return fetch.bind(window);
}

async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
  const fetchFn = getFetchFn();
  const res = await fetchFn(url, init);
  let body: Envelope<T> | null = null;
  try {
    body = (await res.json()) as Envelope<T>;
  } catch {
    throw new ApiError('INVALID_RESPONSE', `服务端返回非 JSON 响应 (${res.status})`, res.status);
  }
  if (!res.ok || !body?.ok) {
    const err = body?.error;
    throw new ApiError(
      err?.code || 'REQUEST_FAILED',
      err?.message || `请求失败 (${res.status})`,
      res.status,
      err?.details,
    );
  }
  return body.data as T;
}

function buildQuery(params: Record<string, string | number | undefined | null>): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== '') {
      sp.set(k, String(v));
    }
  }
  const str = sp.toString();
  return str ? `?${str}` : '';
}

export async function fetchNote(date: string): Promise<DailyNote> {
  return requestJson<DailyNote>(`/api/note${buildQuery({ date })}`, { method: 'GET' });
}

export async function fetchNoteMeta(date: string): Promise<NoteMeta> {
  return requestJson<NoteMeta>(`/api/note/meta${buildQuery({ date })}`, { method: 'GET' });
}

export async function saveNote(payload: {
  date: string;
  content_md: string;
  expected_revision?: number;
  force?: boolean;
}): Promise<DailyNote> {
  return requestJson<DailyNote>('/api/note/save', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
}

export async function carryOverTodos(payload: {
  date: string;
  action: 'apply' | 'dismiss';
  source_date?: string;
}): Promise<{ note: DailyNote; carried_count: number; skipped_count: number }> {
  return requestJson('/api/note/carry-over', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
}

export async function addNoteProject(payload: {
  date: string;
  workspace_uri: string;
  workspace_name: string;
}): Promise<{ projects: ProjectLink[] }> {
  return requestJson('/api/note/projects/add', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
}

export async function removeNoteProject(payload: {
  date: string;
  workspace_uri: string;
}): Promise<{ projects: ProjectLink[] }> {
  return requestJson('/api/note/projects/remove', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
}

export async function fetchCalendar(params: {
  month: string;
  tag?: string;
  workspace_uri?: string;
}): Promise<{ month: string; days: CalendarDay[] }> {
  return requestJson(`/api/calendar${buildQuery(params)}`, { method: 'GET' });
}

export async function searchNotes(params: {
  q?: string;
  tag?: string;
  workspace_uri?: string;
  from?: string;
  to?: string;
  limit?: number;
  offset?: number;
}): Promise<{ total: number; items: SearchResultItem[] }> {
  return requestJson(`/api/search${buildQuery(params)}`, { method: 'GET' });
}

export async function fetchTags(q = ''): Promise<{ tags: TagCount[] }> {
  return requestJson(`/api/tags${buildQuery({ q })}`, { method: 'GET' });
}

export async function fetchAllProjects(): Promise<{ projects: ProjectSummary[] }> {
  return requestJson('/api/projects', { method: 'GET' });
}

export async function fetchRevisions(date: string, limit = 50): Promise<{ revisions: RevisionRecord[] }> {
  return requestJson(`/api/note/revisions${buildQuery({ date, limit })}`, { method: 'GET' });
}

export async function restoreRevision(payload: {
  date: string;
  id: number;
  expected_revision?: number;
}): Promise<DailyNote> {
  return requestJson<DailyNote>('/api/note/revisions/restore', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
}

function fileToBase64(file: File | Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const res = String(reader.result || '');
      const comma = res.indexOf(',');
      resolve(comma >= 0 ? res.slice(comma + 1) : res);
    };
    reader.onerror = () => reject(reader.error || new Error('读取文件失败'));
    reader.readAsDataURL(file);
  });
}

export async function uploadAttachment(
  file: File,
  noteDate: string,
): Promise<AttachmentUploadResult> {
  const dataBase64 = await fileToBase64(file);
  return requestJson<AttachmentUploadResult>('/api/attachment/upload', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      note_date: noteDate,
      orig_name: file.name || 'pasted-image.png',
      data_base64: dataBase64,
    }),
  });
}

export async function exportNoteMarkdown(date: string, frontmatter = false): Promise<string> {
  const fetchFn = getFetchFn();
  const res = await fetchFn(
    `/api/note/export${buildQuery({ date, frontmatter: frontmatter ? '1' : '0' })}`,
    { method: 'GET' },
  );
  if (!res.ok) {
    throw new ApiError('EXPORT_FAILED', `导出失败 (${res.status})`, res.status);
  }
  return res.text();
}

export interface WorkspaceInfo {
  uri: string;
  name: string;
}

export function extractWorkspaceName(uri: string): string {
  const cleaned = uri.replace(/^file:\/\//, '').replace(/\/+$/, '');
  const parts = cleaned.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] || uri;
}

export async function getActiveWorkspaces(): Promise<WorkspaceInfo[]> {
  try {
    const uris = window.sidecar?.getWorkspaceUris
      ? await window.sidecar.getWorkspaceUris()
      : [];
    const list = Array.isArray(uris) ? uris.filter((u) => typeof u === 'string' && u.trim()) : [];
    if (list.length > 0) {
      return list.map((uri) => ({ uri, name: extractWorkspaceName(uri) }));
    }
  } catch {
    // ignore workspace bridge errors
  }

  // Fallback query param ?workspace= for standalone dev/testing
  const params = new URLSearchParams(window.location.search);
  const wsParam = params.get('workspace');
  if (wsParam && wsParam.trim()) {
    return [{ uri: wsParam.trim(), name: extractWorkspaceName(wsParam.trim()) }];
  }
  return [];
}

export async function sendMessageToAgent(prompt: string): Promise<'sent' | 'copied'> {
  if (window.sidecar?.agent?.sendMessage) {
    try {
      await window.sidecar.agent.sendMessage(prompt);
      return 'sent';
    } catch {
      // fall through to clipboard fallback
    }
  }
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(prompt);
  }
  return 'copied';
}
