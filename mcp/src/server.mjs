import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import {
  NotesError,
  createNotesService,
  getLocalDateString,
  openDatabase,
} from '../../core/index.mjs';

function okResult(payload) {
  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify(payload, null, 2),
      },
    ],
  };
}

function errResult(err) {
  if (err instanceof NotesError || (err && typeof err.code === 'string')) {
    const payload = {
      ok: false,
      error: {
        code: err.code,
        message: err.message,
        ...(err.details !== undefined ? { details: err.details } : {}),
      },
    };
    return {
      isError: true,
      content: [
        {
          type: 'text',
          text: JSON.stringify(payload, null, 2),
        },
      ],
    };
  }
  return {
    isError: true,
    content: [
      {
        type: 'text',
        text: JSON.stringify(
          {
            ok: false,
            error: {
              code: 'INTERNAL_ERROR',
              message: err?.message || String(err),
            },
          },
          null,
          2,
        ),
      },
    ],
  };
}

function wrapTool(fn) {
  return async (args) => {
    try {
      const result = await fn(args || {});
      return okResult(result);
    } catch (err) {
      return errResult(err);
    }
  };
}

export function createDailyNotesMcpServer({ dataDir } = {}) {
  const dbCtx = openDatabase({ dataDir });
  const service = createNotesService(dbCtx);

  const server = new McpServer(
    {
      name: 'daily-notes',
      version: '0.1.0',
    },
    {
      capabilities: {
        tools: {},
      },
    },
  );

  // 1. daily_notes_get
  server.registerTool(
    'daily_notes_get',
    {
      description:
        '读取指定自然日（YYYY-MM-DD，默认本机今天）的每日笔记全文、revision 版本号、标签、关联项目与待办统计。修改或更新笔记前必须先调用此工具获取最新 revision。',
      inputSchema: {
        date: z
          .string()
          .optional()
          .describe('目标日期 YYYY-MM-DD，省略时默认读取本机今天'),
      },
      annotations: { readOnlyHint: true },
    },
    wrapTool(({ date }) => {
      const note = service.getNote(date || getLocalDateString());
      return {
        exists: note.exists,
        date: note.date,
        title: note.title,
        content_md: note.content_md,
        revision: note.revision,
        last_editor: note.last_editor,
        tags: note.tags,
        projects: note.projects,
        backlinks: note.backlinks,
        todo_total: note.todo_total,
        todo_done: note.todo_done,
        updated_at: note.updated_at,
      };
    }),
  );

  // 2. daily_notes_list_range
  server.registerTool(
    'daily_notes_list_range',
    {
      description:
        '按日期范围批量读取每日笔记摘要（最大跨度 90 天）。默认仅返回摘要、字数与待办统计以节省上下文，设置 include_content=true 可一并返回正文。',
      inputSchema: {
        start_date: z.string().describe('起始日期 YYYY-MM-DD'),
        end_date: z.string().describe('结束日期 YYYY-MM-DD'),
        tag: z.string().optional().describe('可选：按 #标签 过滤（不含或含 # 均可）'),
        workspace_uri: z.string().optional().describe('可选：按关联工作区 URI 过滤'),
        include_content: z
          .boolean()
          .optional()
          .describe('是否包含完整 Markdown 正文（默认 false）'),
      },
      annotations: { readOnlyHint: true },
    },
    wrapTool(({ start_date, end_date, tag, workspace_uri, include_content }) =>
      service.listRange({
        start_date,
        end_date,
        tag,
        workspace_uri,
        include_content: Boolean(include_content),
      }),
    ),
  );

  // 3. daily_notes_search
  server.registerTool(
    'daily_notes_search',
    {
      description:
        '全文与多维检索历史每日笔记，支持中英文关键词（3 字及以上走 FTS5 trigram，1-2 字自动走子串降级）、#标签、关联项目及日期范围过滤。',
      inputSchema: {
        query: z.string().optional().describe('搜索关键词（支持中文和英文）'),
        tag: z.string().optional().describe('按标签过滤'),
        workspace_uri: z.string().optional().describe('按关联工作区 URI 过滤'),
        from: z.string().optional().describe('起始日期 YYYY-MM-DD'),
        to: z.string().optional().describe('结束日期 YYYY-MM-DD'),
        limit: z.number().int().min(1).max(100).optional().describe('返回条数上限（默认 30）'),
      },
      annotations: { readOnlyHint: true },
    },
    wrapTool(({ query, tag, workspace_uri, from, to, limit }) =>
      service.searchNotes({
        q: query || '',
        tag: tag || '',
        workspace_uri: workspace_uri || '',
        from: from || '',
        to: to || '',
        limit: limit ?? 30,
      }),
    ),
  );

  // 4. daily_notes_get_open_todos
  server.registerTool(
    'daily_notes_get_open_todos',
    {
      description:
        '扫描最近 N 天（默认 7 天）或指定日期区间内所有未勾选的 `- [ ]` 待办事项，返回所属日期、revision、行号与任务文本。',
      inputSchema: {
        days: z.number().int().min(1).max(90).optional().describe('向前回溯天数（默认 7）'),
        start_date: z.string().optional().describe('可选起始日期 YYYY-MM-DD'),
        end_date: z.string().optional().describe('可选结束日期 YYYY-MM-DD'),
        workspace_uri: z.string().optional().describe('可选工作区 URI 过滤'),
      },
      annotations: { readOnlyHint: true },
    },
    wrapTool(({ days, start_date, end_date, workspace_uri }) =>
      service.getOpenTodos({ days, start_date, end_date, workspace_uri }),
    ),
  );

  // 5. daily_notes_append
  server.registerTool(
    'daily_notes_append',
    {
      description:
        '安全写入首选工具：向指定日期（默认今天）的笔记追加 Markdown 内容（若提供 heading 且存在则追加到该小节末尾，否则建新小节或追加至文末）。写前自动存档历史快照以便侧边栏一键撤销。',
      inputSchema: {
        date: z.string().optional().describe('目标日期 YYYY-MM-DD，默认今天'),
        markdown: z.string().min(1).describe('要追加的 Markdown 内容'),
        heading: z.string().optional().describe('可选：目标小节标题（例如 "排查记录"）'),
        workspace_uri: z.string().optional().describe('可选：同时关联工作区 URI'),
        workspace_name: z.string().optional().describe('可选：工作区展示名称'),
        summary: z.string().optional().describe('本次写入的简明摘要（记录到历史快照）'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    wrapTool(({ date, markdown, heading, workspace_uri, workspace_name, summary }) => {
      const result = service.appendNote({
        date: date || getLocalDateString(),
        markdown,
        heading,
        workspace_uri,
        workspace_name,
        summary,
      });
      return {
        ok: true,
        date: result.note.date,
        revision: result.note.revision,
        snapshot_id: result.snapshot_id,
        todo_total: result.note.todo_total,
        todo_done: result.note.todo_done,
        tags: result.note.tags,
        projects: result.note.projects,
        updated_at: result.note.updated_at,
      };
    }),
  );

  // 6. daily_notes_toggle_todo
  server.registerTool(
    'daily_notes_toggle_todo',
    {
      description:
        '定点勾选或取消勾选某日笔记中的任务项（`- [ ]` ↔ `- [x]`）。强制校验 expected_revision 乐观锁，写前自动存快照。',
      inputSchema: {
        date: z.string().optional().describe('目标日期 YYYY-MM-DD，默认今天'),
        expected_revision: z.number().int().nonnegative().describe('必填：先通过 daily_notes_get 读取到的最新 revision'),
        line_number: z.number().int().positive().optional().describe('任务所在的 1-based 行号'),
        match_text: z.string().optional().describe('任务文本匹配片段（若未提供 line_number）'),
        completed: z.boolean().describe('目标完成状态：true 为勾选 [x]，false 为取消勾选 [ ]'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    wrapTool(({ date, expected_revision, line_number, match_text, completed }) => {
      const result = service.toggleTodo({
        date: date || getLocalDateString(),
        expected_revision,
        line_number,
        match_text,
        completed,
        editor: 'agent',
      });
      return {
        ok: true,
        date: result.note.date,
        revision: result.note.revision,
        changed: result.changed,
        line_number: result.line_number,
        text: result.text,
        completed: result.completed,
        snapshot_id: result.snapshot_id,
      };
    }),
  );

  // 7. daily_notes_update
  server.registerTool(
    'daily_notes_update',
    {
      description:
        '受控覆盖更新：仅在需要整体重写或替换某个小节时使用。必须先调用 daily_notes_get 并传入 expected_revision 与 summary；若版本不一致会返回 REVISION_CONFLICT 且绝不强行覆盖，写前自动存快照。',
      inputSchema: {
        date: z.string().optional().describe('目标日期 YYYY-MM-DD，默认今天'),
        expected_revision: z.number().int().nonnegative().describe('必填：先读取到的最新 revision'),
        mode: z.enum(['replace', 'replace_section']).describe('replace 整篇替换；replace_section 仅替换指定 heading 下内容'),
        heading: z.string().optional().describe('当 mode=replace_section 时必填的目标标题'),
        markdown: z.string().describe('新的 Markdown 内容'),
        summary: z.string().min(1).describe('必填：本次更新的原因或摘要'),
      },
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    wrapTool(({ date, expected_revision, mode, heading, markdown, summary }) => {
      const result = service.updateNoteControlled({
        date: date || getLocalDateString(),
        expected_revision,
        mode,
        heading,
        markdown,
        summary,
      });
      return {
        ok: true,
        date: result.note.date,
        revision: result.note.revision,
        snapshot_id: result.snapshot_id,
        todo_total: result.note.todo_total,
        todo_done: result.note.todo_done,
        updated_at: result.note.updated_at,
      };
    }),
  );

  return {
    server,
    dbCtx,
    service,
    async close() {
      await server.close();
      dbCtx.close();
    },
  };
}

async function main() {
  const instance = createDailyNotesMcpServer();
  const transport = new StdioServerTransport();

  const shutdown = async () => {
    try {
      await instance.close();
    } catch {
      // Ignore cleanup errors during shutdown
    }
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  process.stdin.on('end', shutdown);

  await instance.server.connect(transport);
}

main().catch((err) => {
  console.error('[daily-notes mcp] fatal error:', err);
  process.exit(1);
});
