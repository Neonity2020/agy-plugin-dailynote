# Daily Notes（每日笔记）

Daily Notes 是面向 Google Antigravity（桌面端 App / Antigravity IDE / `agy` CLI）的侧边栏每日笔记插件：在辅助侧边栏中即开即写，全部内容、标签、历史快照与图片附件都保存在本机目录的 SQLite 数据库中，并可通过内置 MCP Server 与 Agent 双向协同。

当前仓库进度：**M1 — 工程骨架与本地存储核心**。插件清单、共享核心层（`core/`）与自动化测试已就位；Sidecar HTTP 服务、前端界面与 MCP Server 分别属于 M2 / M3。

## 目录速览

| 路径 | 作用 |
| :--- | :--- |
| `plugin.json` | Antigravity 插件主清单 |
| `sidecars/daily_notes/sidecar.json` | 侧边栏 UI Sidecar 声明 |
| `mcp_config.json` | MCP Server 注册配置 |
| `rules/AGENTS.md` | 插件启用期间生效的 Agent 写作约束 |
| `core/` | Sidecar 与 MCP 共享的存储核心（零第三方运行时依赖） |
| `tests/core/` | 基于 `node:test` 的核心层单元与并发测试 |

## 快速开始

要求 Node.js `>= 22.5.0`（使用内置 `node:sqlite` 与 FTS5 `trigram`）。

```bash
npm test
```

数据默认写入 `~/.gemini/daily-notes/`，可用环境变量 `DAILY_NOTES_DATA_DIR` 重定向。

完整需求、架构与数据模型见 [docs/README.md](./docs/README.md)。
