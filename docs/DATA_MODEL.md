# Daily Notes（每日笔记）数据模型与持久化规范

## 1. 本地存储目录结构

所有用户数据默认保存在 `~/.gemini/daily-notes/`（用户可通过环境变量 `DAILY_NOTES_DATA_DIR` 覆盖为任意本地目录，如云盘同步目录或测试临时目录）：

```text
~/.gemini/daily-notes/                # ${DAILY_NOTES_DATA_DIR}
├── notes.db                          # SQLite 主数据库文件
├── notes.db-wal                      # WAL 日志（运行时由 SQLite 自动维护）
├── notes.db-shm                      # WAL 共享内存索引（运行时由 SQLite 自动维护）
└── attachments/                      # 粘贴/拖拽图片持久化目录
    └── 2026/
        └── 11/
            └── att_01JF3K9X8B2N4Q.png
```

> **设计原则**：
> - 数据库内只存相对路径 `rel_path`（如 `attachments/2026/11/att_01JF3K9X8B2N4Q.png`）与元信息，绝不将二进制图片直接写入 SQLite BLOB，确保数据库体积轻量、全文检索高速且导出的 Markdown 天然匹配附件模型。
> - 日期主键 `YYYY-MM-DD` 严格使用**用户本地时区自然日**计算，避免 UTC 时差导致凌晨笔记落入昨天或明天。

---

## 2. SQLite 连接 PRAGMA 规范

Sidecar 与 MCP Server 的每次数据库连接初始化均须依次执行以下 `PRAGMA`：

```sql
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;
PRAGMA temp_store = MEMORY;
```

- **`WAL + busy_timeout = 5000`**：允许 Sidecar 轮询读与 MCP Server 写入安全并发，短时锁争用由 SQLite 内核自动退避等待最多 5 秒。
- **写事务约定**：所有写操作使用 `BEGIN IMMEDIATE ... COMMIT`（或 `DatabaseSync` 事务包裹），提前获取写锁避免升级死锁（`SQLITE_BUSY`）。

---

## 3. 完整 SQLite Schema（DDL）

> 版本：`v1`（记录于 `schema_migrations`）

```sql
-- 1. Schema 版本迁移记录
CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL
);

-- 2. 每日笔记主表（按本地自然日唯一）
CREATE TABLE IF NOT EXISTS notes (
  date TEXT PRIMARY KEY CHECK (date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  title TEXT NOT NULL DEFAULT '',
  content_md TEXT NOT NULL DEFAULT '',
  plain_text TEXT NOT NULL DEFAULT '',
  word_count INTEGER NOT NULL DEFAULT 0,
  todo_total INTEGER NOT NULL DEFAULT 0,
  todo_done INTEGER NOT NULL DEFAULT 0,
  revision INTEGER NOT NULL DEFAULT 1,
  last_editor TEXT NOT NULL DEFAULT 'user' CHECK (last_editor IN ('user', 'agent', 'system')),
  carry_over_from TEXT CHECK (carry_over_from IS NULL OR carry_over_from GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  carry_over_dismissed INTEGER NOT NULL DEFAULT 0 CHECK (carry_over_dismissed IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_agent_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_notes_updated_at ON notes(updated_at DESC);

-- 3. 中文 + 英文全文检索虚拟表（FTS5 trigram + 触发器自动同步）
CREATE VIRTUAL TABLE IF NOT EXISTS notes_fts USING fts5(
  date UNINDEXED,
  content_md,
  plain_text,
  content='notes',
  content_rowid='rowid',
  tokenize='trigram'
);

CREATE TRIGGER IF NOT EXISTS notes_ai AFTER INSERT ON notes BEGIN
  INSERT INTO notes_fts(rowid, date, content_md, plain_text)
  VALUES (new.rowid, new.date, new.content_md, new.plain_text);
END;

CREATE TRIGGER IF NOT EXISTS notes_ad AFTER DELETE ON notes BEGIN
  INSERT INTO notes_fts(notes_fts, rowid, date, content_md, plain_text)
  VALUES ('delete', old.rowid, old.date, old.content_md, old.plain_text);
END;

CREATE TRIGGER IF NOT EXISTS notes_au AFTER UPDATE OF content_md, plain_text ON notes BEGIN
  INSERT INTO notes_fts(notes_fts, rowid, date, content_md, plain_text)
  VALUES ('delete', old.rowid, old.date, old.content_md, old.plain_text);
  INSERT INTO notes_fts(rowid, date, content_md, plain_text)
  VALUES (new.rowid, new.date, new.content_md, new.plain_text);
END;

-- 4. 正文 #标签 索引表
CREATE TABLE IF NOT EXISTS note_tags (
  note_date TEXT NOT NULL REFERENCES notes(date) ON DELETE CASCADE,
  tag TEXT NOT NULL,
  PRIMARY KEY (note_date, tag)
);

CREATE INDEX IF NOT EXISTS idx_note_tags_tag_date ON note_tags(tag, note_date DESC);

-- 5. 可选工作区项目关联表
CREATE TABLE IF NOT EXISTS note_projects (
  note_date TEXT NOT NULL REFERENCES notes(date) ON DELETE CASCADE,
  workspace_uri TEXT NOT NULL,
  workspace_name TEXT NOT NULL,
  linked_by TEXT NOT NULL DEFAULT 'user' CHECK (linked_by IN ('user', 'agent')),
  created_at TEXT NOT NULL,
  PRIMARY KEY (note_date, workspace_uri)
);

CREATE INDEX IF NOT EXISTS idx_note_projects_ws_date ON note_projects(workspace_uri, note_date DESC);

-- 6. 日期双链 [[YYYY-MM-DD]] 索引表
CREATE TABLE IF NOT EXISTS note_links (
  source_date TEXT NOT NULL REFERENCES notes(date) ON DELETE CASCADE,
  target_date TEXT NOT NULL CHECK (target_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  PRIMARY KEY (source_date, target_date)
);

CREATE INDEX IF NOT EXISTS idx_note_links_target ON note_links(target_date, source_date DESC);

-- 7. 历史快照表（AI 写入前 / 回滚前自动备份）
CREATE TABLE IF NOT EXISTS note_revisions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  note_date TEXT NOT NULL REFERENCES notes(date) ON DELETE CASCADE,
  revision INTEGER NOT NULL,
  content_md TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('agent', 'restore_backup', 'manual_checkpoint', 'carry_over_backup')),
  summary TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_note_revisions_date_rev ON note_revisions(note_date, revision DESC, id DESC);

-- 8. 本地图片附件元信息表
CREATE TABLE IF NOT EXISTS attachments (
  id TEXT PRIMARY KEY,
  note_date TEXT REFERENCES notes(date) ON DELETE SET NULL,
  rel_path TEXT NOT NULL UNIQUE,
  orig_name TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  byte_size INTEGER NOT NULL CHECK (byte_size > 0),
  sha256 TEXT NOT NULL,
  created_at TEXT NOT NULL,
  orphaned_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_attachments_note_date ON attachments(note_date);
CREATE INDEX IF NOT EXISTS idx_attachments_orphaned_at ON attachments(orphaned_at);

-- 9. 昨日待办顺延幂等去重表
CREATE TABLE IF NOT EXISTS todo_carryovers (
  target_date TEXT NOT NULL REFERENCES notes(date) ON DELETE CASCADE,
  source_date TEXT NOT NULL CHECK (source_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  item_hash TEXT NOT NULL,
  carried_at TEXT NOT NULL,
  PRIMARY KEY (target_date, source_date, item_hash)
);
```

---

## 4. 中英文全文检索策略（FTS5 `trigram` + 短词降级）

SQLite 默认的 `unicode61` 分词器按空白与标点切词，无法对无空格连续中文做子串分词检索；而 `fts5` 的 `trigram` 分词器按每 3 个连续字符建立倒排索引，同时支持中英文任意子串匹配。但 `trigram` 对 **1–2 个字符的短查询**（如 `笔记`、`AI`）无法生成三元组：

| 搜索关键词长度（去除首尾空白后） | 查询路径 | SQL 说明 |
| :--- | :--- | :--- |
| **`length(q) >= 3`** | **FTS5 `trigram` 主通道** | 对 `plain_text` / `content_md` 执行双引号安全包裹查询：`notes_fts MATCH '"' || replace(q, '"', '""') || '"'`，使用 `snippet(notes_fts, 2, '<mark>', '</mark>', '...', 24)` 生成命中片段 |
| **`length(q) BETWEEN 1 AND 2`** | **`LIKE` 子串降级通道** | 退化为 `n.plain_text LIKE '%' || escape_like(q) || '%' ESCAPE '\'`（按 `date DESC` 排序），由应用层在命中文本前后截取 `48` 字符生成高亮片段 |
| **空关键词 + 标签/项目过滤** | **纯关系表索引查询** | 直接通过 `note_tags` / `note_projects` 联合查询并按 `date DESC` 返回摘要 |

> **日历活跃度判定**：为避免仅点击过「忽略顺延」或关联了项目但正文为空的行在日历中显示错误圆点，日历查询统一以 `length(trim(n.content_md)) > 0` 作为 `has_note = 1` 的判断标准。

---

## 5. 规范化 Markdown 与元素提取规则

### 5.1 Canonical Markdown 格式约定
所有编辑态与存储态统一以 **GFM + 日期双链** 为唯一持久化规范：
- 标题：`# `、`## `、`### `
- 任务清单：`- [ ] 未完成`、`- [x] 已完成`
- 代码块：标准围栏代码块 ```` ```lang ... ``` ````
- 表格：标准 GFM 管道表格 `| col1 | col2 |`
- 图片：正文内引用统一写为 `![alt](/api/attachments/<id>)`；执行**单日导出 `.md`** 时，若用户选择独立文件，自动将图片说明或相对路径注释附带保留（如保留本地路径注释或可配置转换，确保导出 Markdown 语义清晰）。
- 日期双链：统一写为 `[[YYYY-MM-DD]]`（仅匹配合法日历日期）。

### 5.2 元数据与索引提取规则（每次写入事务内同步更新）
每次创建或更新 `notes.content_md` 时，在同一写事务内由 `core/markdown.mjs` 计算并同步以下派生数据：

1. **`plain_text` 与 `word_count`**：剥离 Markdown 标记字符、图片 URL、代码块语法围栏后得到纯文本用于搜索和字数统计（中文按字计，英文按词计）。
2. **待办计数（`todo_total` / `todo_done`）**：仅统计**非围栏代码块内部**的行首任务项（匹配 `/^\s*(?:[-*+]|\d+\.)\s+\[([ xX])\]\s+/gm`）。
3. **标签提取（`note_tags`）**：
   - 先剔除围栏代码块（```` ```...``` ````）、行内代码（`` `...` ``）、Markdown 链接 URL（`[...](...#anchor)`）及行首标题 `# ` 符号。
   - 正则提取形如 `(?:^|[\s(（【])#([\p{L}\p{N}_][\p{L}\p{N}_/-]{0,48})` 的标签，统一保留原始大小写或规范小写去重写入 `note_tags`（V1 统一转小写存入 `tag` 或保留展示名并做小写归一化，避免 `#AI` 与 `#ai` 分裂）。
4. **日期双链提取（`note_links`）**：
   - 剔除代码块与行内代码后，匹配 `/\[\[(\d{4}-\d{2}-\d{2})\]\]/g` 并校验日期合法性（如过滤 `2026-02-30`），先删后插更新 `note_links`。

---

## 6. 生命周期、快照与附件回收策略

### 6.1 惰性创建（Lazy Creation）
- 访问尚无记录的日期时，`GET /api/notes/:date` 不往数据库写空行，仅返回虚拟响应 `{ date, exists: false, content_md: '', revision: 0, ... }`。
- 仅当用户输入非空内容保存、执行待办顺延、关联项目或显式点击「忽略顺延提示」时，才在 `notes` 表写入对应行；若用户清空某天全部内容，允许保留行（`content_md = ''`）以便维持 `revision` 与历史快照可追溯，但日历小圆点自动隐藏。

### 6.2 昨日待办顺延幂等机制
1. 打开「今天」且今日尚无内容、未点击过忽略时，服务端向前回溯最近一篇 `date < today` 且 `todo_total > todo_done` 的笔记（回溯窗口默认最近 30 天，避免极早期遗留干扰）。
2. 用户点击「一键顺延」后，服务端提取源日期未勾选行，对每行内容做空白归一化后计算 `item_hash = sha256(normalizedText)`，查询 `todo_carryovers` 过滤已顺延项，仅将尚未顺延的条目追加到今日顶部 `## 待办顺延 (来自 YYYY-MM-DD)`（或直接作为任务列表置顶），并在 `notes.carry_over_from` 与 `todo_carryovers` 中记录，保证重复点击零重复。

### 6.3 历史快照留存上限
- 每次 Agent 写入（`daily_notes_append` / `daily_notes_toggle_todo` / `daily_notes_update`）、冲突加载覆写、以及历史回滚前备份，均在 `note_revisions` 插入一条修改前快照。
- 单篇笔记默认保留最近 **50 条**快照（每次插入后按 `id DESC` 裁剪超出部分），兼顾防误改回滚与单库体积控制。

### 6.4 附件延迟孤儿清理（Orphan GC）
由于历史快照 `note_revisions` 中仍可能引用用户后来从当前正文删掉的图片，**不能在用户删图瞬间直接物理删除磁盘图片**：
1. 正文保存时，扫描 `content_md` 中引用的 `/api/attachments/<id>` 集合；若某附件不再出现在当前正文，且检查该笔记尚存的 `note_revisions` 也都不再引用该 `<id>`，则标记 `attachments.orphaned_at = now()`（若再次被引用则重置为 `NULL`）。
2. 插件 Sidecar 启动时（或每日低峰后台任务）清理 `orphaned_at` 超过 **7 天**的记录：先删除磁盘 `attachments/YYYY/MM/...` 文件，再删除 `attachments` 表对应行。
