# Daily Notes（每日笔记）— Antigravity 插件

**Daily Notes（每日笔记）** 是一个运行在 Google Antigravity 辅助侧边栏（Auxiliary Side Pane）的轻量化、所见即所得（WYSIWYG）每日笔记插件。

## 核心特性

- **按自然日收口**：以本机时区 `YYYY-MM-DD` 为唯一主键，打开即写，支持惰性创建与防抖自动保存。
- **Tiptap WYSIWYG + 源码双模**：支持即时 Markdown 快捷输入、Bubble Menu、`/` 斜杠指令、任务清单、语法高亮代码块、横向滚动表格、图片粘贴/拖拽、`[[YYYY-MM-DD]]` 日期双链以及 WYSIWYG ↔ Markdown 源码双向无损切换。
- **本地私有存储**：基于 Node.js 内置 `node:sqlite`（WAL 模式 + FTS5 `trigram` 中英文全文检索），默认存储于 `~/.gemini/daily-notes/`（可通过 `DAILY_NOTES_DATA_DIR` 重定向）。
- **AI 双向协同与安全护栏**：内置 Stdio MCP Server（7 个读写/检索/待办工具）、`/daily-summary` 与 `/daily-capture` Skills、以及写入前自动快照 + 乐观锁冲突检测 + 侧边栏一键撤销。

## 本地开发与构建

> 运行环境要求：Node.js `>= 22.5.0`（支持原生 `node:sqlite` 与 FTS5 `trigram`）。

```bash
# 安装构建期依赖
npm install

# 类型检查 + 构建前端静态产物(sidecars/daily_notes/dist/) + 打包独立 MCP Server(mcp/server.mjs)
npm run build

# 运行完整自动化测试套件
npm test

# 独立启动 Sidecar HTTP 服务进行浏览器调试（默认 http://127.0.0.1:4175）
DAILY_NOTES_DATA_DIR=/tmp/dn-dev npm run dev:sidecar
```

## 插件安装与校验

```bash
agy plugin validate --strict .
agy plugin install .
```
