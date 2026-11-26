export {
  daysBetween,
  expandHomeDir,
  getLocalDateString,
  isValidDateString,
  isValidMonthString,
  monthDateBounds,
  nowIso,
  resolveDataDir,
  shiftDateString,
} from './config.mjs';
export { StorageAdapter } from './storage-adapter.mjs';
export { CURRENT_SCHEMA_VERSION, openDatabase, runMigrations } from './db.mjs';
export {
  appendMarkdown,
  buildCarryOverSection,
  buildShortSnippet,
  countWords,
  escapeLike,
  extractMetadata,
  formatExportMarkdown,
  normalizeLineEndings,
  normalizeTodoText,
  replaceSectionMarkdown,
  sha256Hex,
  toggleTodoLine,
} from './markdown.mjs';
export {
  ATTACHMENT_ID_RE,
  MAX_ATTACHMENT_BYTES,
  cleanupOrphanedAttachments,
  detectImageMime,
  getAttachment,
  resolveSafeAttachmentPath,
  saveAttachment,
  syncNoteAttachments,
} from './attachments.mjs';
export { NotesError, createNotesService } from './notes-service.mjs';
