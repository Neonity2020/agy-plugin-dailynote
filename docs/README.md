# Daily Notes（每日笔记）— Antigravity 插件需求与设计文档

**Daily Notes（每日笔记）** 是一个专为 Google Antigravity（桌面端 App / Antigravity IDE / `agy` CLI）打造的侧边栏笔记插件：用户在辅助侧边栏即可像使用 Typora / Notion 一样**所见即所得（WYSIWYG）**地记录每日笔记，所有笔记、标签、历史版本与图片附件均持久化在用户本机 `~/.gemini/daily-notes/` 的 **SQLite 数据库**中，同时通过内置 **MCP Server** 与 **Skills** 与 Antigravity Agent 实现安全可控的双向协同。

---

## 1. 需求对齐结论总览

经过 4 轮需求对齐（`grill-me`），V1 的核心边界与关键决策已全部锁定如下：

| 维度 | 锁定决策 | 说明 |
| :--- | :--- | :--- |
| **插件名称与标识** | **Daily Notes（每日笔记）** / `daily-notes` | 基于 `agy-plugin-dailynote` pnpm monorepo（`packages/core` + `packages/plugin` + `apps/marketing`）开发，UI 展示名「每日笔记」 |
| **笔记作用域** | **全局按本地自然日共享**（`YYYY-MM-DD`） | 每天 1 篇整页自由文档，跨项目通用；支持正文自然 `#标签` 自动索引与顶部一键「关联当前项目」 |
| **交互与导航** | **顶部日期条 + 折叠式迷你日历 + 搜索入口** | 适配 320px–480px 窄侧边栏，不设常驻多栏目录树 |
| **WYSIWYG 编辑器** | **React + TypeScript + Vite + Tiptap (ProseMirror)** | 支持 Markdown 快捷语法即时渲染、选中悬浮工具栏（Bubble Menu）、`/` 斜杠插入菜单 |
| **V1 必备扩展块** | 6 项全部纳入 V1 | ① 任务清单 `- [ ]` / `- [x]`；② 行内代码与语法高亮代码块；③ 表格编辑；④ 图片粘贴/拖拽；⑤ 日期双链 `[[YYYY-MM-DD]]`；⑥ 所见即所得 ↔ Markdown 源码模式切换 |
| **新的一天启动态** | **默认空白页 + 昨日未完成待办顺延条** | 若前序有未勾选待办，顶部展示非侵入式「一键顺延到今天」轻提示条；V1 不做自定义每日模板 |
| **AI 协同方式** | **双向协同（内置 MCP Server + Skills + Rules）** | Agent 可读、检索、汇总待办、追加、勾选与带乐观锁更新；侧边栏提供「AI 总结今日」与选中文本「发送到对话」轻入口 |
| **防误改与同步** | **乐观锁 + 每次 AI 修改自动快照 + 实时同步** | AI 写入前自动在 `note_revisions` 备份当前版本，侧边栏轮询感知变化并支持一键撤销 |
| **本地持久化** | **SQLite（WAL + FTS5）+ 同级 `attachments/`** | 默认 `~/.gemini/daily-notes/notes.db`（支持 `DAILY_NOTES_DATA_DIR` 覆盖）；图片独立落盘存文件，DB 存元信息与引用 |
| **导入导出（V1）** | **单日导出 `.md` + 一键复制纯 Markdown** | 批量打包导出、直接导出 `.db`、从外部 Markdown 文件夹导入均延后至 V2 |

---

## 2. 文档导航

| 文档 | 定位与核心内容 | 适合阅读对象 |
| :--- | :--- | :--- |
| [**PRD.md**](./PRD.md) | 产品愿景、用户故事、V1 功能需求矩阵（P0/P1）、显式非目标（V2 Backlog）与验收标准 | 产品设计、全员对齐需求与验收口径 |
| [**UI_UX_SPEC.md**](./UI_UX_SPEC.md) | 窄侧边栏响应式布局、主题 Token 同步、迷你日历/搜索/编辑器/源码模式/冲突条等交互细节与快捷键 | 前端开发、UI/UX 设计与测试 |
| [**ARCHITECTURE.md**](./ARCHITECTURE.md) | Antigravity 插件目录与清单（`plugin.json`/`sidecar.json`/`mcp_config.json`）、Sidecar 与 MCP 双进程架构、REST API、MCP 工具契约与安全边界 | 后端/全栈开发、Agent 协同设计 |
| [**DATA_MODEL.md**](./DATA_MODEL.md) | 本地文件目录、完整 SQLite DDL（含 FTS5 `trigram` 中文全文索引）、Markdown 往返解析规范、并发锁与附件 GC 策略 | 数据库设计、后端核心层与迁移实现 |

---

## 3. 建议的 V1 实施路线图（Milestones）

1. **M1 — 工程骨架与本地存储核心**
   - 初始化插件清单（`plugin.json`、`sidecars/daily_notes/sidecar.json`、`mcp_config.json`）。
   - 完成 SQLite 核心层（`StorageAdapter`、WAL 配置、Schema 迁移、笔记读写、乐观锁、历史快照、FTS5 `trigram` 检索与附件落盘）。
2. **M2 — Sidecar HTTP 服务与侧边栏 WYSIWYG 编辑器**
   - 实现基于 `sidecar_sdk`（`SidecarApp`）的后端 REST API。
   - 完成 React + Vite + Tiptap 侧边栏 UI：日期切换、迷你日历、Bubble Menu、`/` 命令菜单、6 类 V1 扩展块（任务清单、代码块、表格、图片、日期双链、Markdown 源码切换）及自动防抖保存。
3. **M3 — 每日生命周期、导入导出与 AI 协同**
   - 实现昨日未完成待办一键顺延（含幂等去重）、`#标签` 与当前工作区项目关联、单日 `.md` 导出/复制。
   - 完成 Stdio MCP Server（7 个读写/检索/待办工具）、Skills（`/daily-summary`、`/daily-capture`）、`rules/AGENTS.md`、外部修改轮询同步与一键撤销快照。
4. **M4 — 验证与打包交付**
   - 端到端集成测试（Sidecar + MCP 并发读写、中英文搜索、图片粘贴与快照回滚、暗/亮主题切换）。
   - 执行 `agy plugin validate --strict` 校验并完成本地安装实测。
