/**
 * 共享核心层公共出口（Sidecar 与 MCP Server 都从这里引用）。
 */

export * from './config.mjs';
export * from './storage-adapter.mjs';
export * from './db.mjs';
export * from './markdown.mjs';
export * from './attachments.mjs';
export * from './notes-service.mjs';

import { openDatabase } from './db.mjs';
import { createNotesService } from './notes-service.mjs';

/**
 * 一步打开数据库并返回服务实例（调用方负责 close 时同时关闭 adapter）。
 *
 * @param {{ dataDir?: string, env?: Record<string, string | undefined>, now?: () => Date }} [options]
 * @returns {Promise<{ service: import('./notes-service.mjs').NotesService, adapter: import('./storage-adapter.mjs').StorageAdapter, dataDir: string, dbPath: string }>}
 */
export async function openService(options = {}) {
  const { adapter, dataDir, dbPath } = await openDatabase(options);
  const service = createNotesService({ adapter, dataDir, now: options.now });
  return { service, adapter, dataDir, dbPath };
}
