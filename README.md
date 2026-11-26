# Daily Notes（每日笔记）— Antigravity 插件

**Daily Notes（每日笔记）** 是一个运行在 Google Antigravity 辅助侧边栏（Auxiliary Side Pane）的轻量化、所见即所得（WYSIWYG）每日笔记插件，采用 **pnpm monorepo** 管理插件本体、共享存储核心与营销落地页。

## 核心特性

- **按自然日收口**：以本机时区 `YYYY-MM-DD` 为唯一主键，打开即写，支持惰性创建与防抖自动保存。
- **Tiptap WYSIWYG + 源码双模**：支持即时 Markdown 快捷输入、Bubble Menu、`/` 斜杠指令、任务清单、语法高亮代码块、横向滚动表格、图片粘贴/拖拽、`[[YYYY-MM-DD]]` 日期双链以及 WYSIWYG ↔ Markdown 源码双向无损切换。
- **本地私有存储**：基于 Node.js 内置 `node:sqlite`（WAL 模式 + FTS5 `trigram` 中英文全文检索），默认存储于 `~/.gemini/daily-notes/`（可通过 `DAILY_NOTES_DATA_DIR` 重定向）。
- **AI 双向协同与安全护栏**：内置 Stdio MCP Server（7 个读写/检索/待办工具 + MCP Resources 支持 Composer `@` 引用）、`/daily-summary` 与 `/daily-capture` Skills、以及写入前自动快照 + 乐观锁冲突检测 + 侧边栏一键撤销。
  - **Composer `@` 引用**：支持在对话输入框通过 `@` 直接引用 `daily-notes://today`（今日笔记）、`daily-notes://yesterday`（昨日笔记）、`daily-notes://todos/open`（近 7 天未完成待办）、`daily-notes://recent`（近 14 天笔记索引）以及具体日期笔记 `daily-notes://notes/YYYY-MM-DD`。

## Monorepo 目录结构

```text
agy-plugin-dailynote/
├── pnpm-workspace.yaml
├── package.json
├── packages/
│   ├── core/               # @daily-notes/core — SQLite WAL + FTS5 核心、Markdown 解析与附件管理
│   └── plugin/             # @daily-notes/plugin — 可零依赖直接安装的 Antigravity 插件本体
└── apps/
    └── marketing/          # @daily-notes/marketing — Astro 静态营销落地页
```

## 本地开发与构建

> 运行环境要求：Node.js `>= 22.5.0`（支持原生 `node:sqlite` 与 FTS5 `trigram`）与 `pnpm`（可通过 `corepack enable` 启用）。

```bash
# 安装整个工作区依赖
pnpm install

# 类型检查 + 构建插件产物（dist/ + sidecar main.mjs + mcp/server.mjs）与营销站点
pnpm build

# 仅构建插件本体
pnpm build:plugin

# 运行全量自动化测试套件（core + plugin）
pnpm test

# 独立启动 Sidecar HTTP 服务进行浏览器调试（默认 http://127.0.0.1:4175）
DAILY_NOTES_DATA_DIR=/tmp/dn-dev pnpm dev:sidecar
```

## 插件安装与校验

构建后的插件入口位于 `packages/plugin/`（已内联 `@daily-notes/core` 与运行时依赖，可脱离 monorepo 独立运行）：

```bash
agy plugin validate --strict ./packages/plugin
agy plugin install ./packages/plugin
```

## 营销站点（`apps/marketing/`）

`apps/marketing/` 是独立于插件运行时的 Astro 静态落地页，用于对外介绍插件并提供 GitHub 下载入口，不会被打包进插件。

```bash
pnpm dev:marketing      # 本地预览 http://localhost:4321
pnpm build:marketing    # 输出纯静态 apps/marketing/dist/
```
