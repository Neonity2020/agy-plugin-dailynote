export interface ProjectLink {
  workspace_uri: string;
  workspace_name: string;
  linked_by: 'user' | 'agent';
  created_at: string;
}

export interface BacklinkItem {
  date: string;
  title: string;
  updated_at: string | null;
}

export interface PendingTodoItem {
  text: string;
  hash: string;
}

export interface YesterdayPending {
  source_date: string;
  count: number;
  items: PendingTodoItem[];
}

export interface DailyNote {
  date: string;
  exists: boolean;
  title: string;
  content_md: string;
  plain_text: string;
  word_count: number;
  todo_total: number;
  todo_done: number;
  revision: number;
  last_editor: 'user' | 'agent' | 'system';
  carry_over_from: string | null;
  carry_over_dismissed: number;
  created_at: string | null;
  updated_at: string | null;
  last_agent_at: string | null;
  tags: string[];
  projects: ProjectLink[];
  backlinks: BacklinkItem[];
  yesterday_pending: YesterdayPending | null;
}

export interface NoteMeta {
  date: string;
  exists: boolean;
  revision: number;
  updated_at: string | null;
  last_editor: 'user' | 'agent' | 'system';
  last_agent_at: string | null;
  todo_total: number;
  todo_done: number;
}

export interface CalendarDay {
  date: string;
  has_note: boolean;
  todo_total: number;
  todo_done: number;
}

export interface SearchResultItem {
  date: string;
  title: string;
  snippet: string;
  todo_total: number;
  todo_done: number;
  tags: string[];
  projects: ProjectLink[];
  updated_at: string | null;
}

export interface TagCount {
  tag: string;
  count: number;
}

export interface ProjectSummary {
  workspace_uri: string;
  workspace_name: string;
  count: number;
}

export interface RevisionRecord {
  id: number;
  revision: number;
  source: 'agent' | 'restore_backup' | 'manual_checkpoint' | 'carry_over_backup';
  summary: string;
  created_at: string;
  content_md: string;
  preview: string;
}

export interface AttachmentUploadResult {
  id: string;
  url: string;
  render_url: string;
  mime_type: string;
  byte_size: number;
  orig_name: string;
  rel_path: string;
  created_at: string;
}

export interface ConflictState {
  serverNote: DailyNote;
  localMarkdown: string;
}
