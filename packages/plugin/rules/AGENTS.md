# Daily Notes（每日笔记）Agent 协同规范

当 `daily-notes` 插件启用时，调用 `daily-notes` MCP 工具读写用户的每日笔记须严格遵守以下安全规则：

1. **先读后写原则**：
   - 在修改、勾选或覆盖任何日期的笔记前，必须先调用 `daily_notes_get` 读取目标日期的最新内容与 `revision`。
   - 调用 `daily_notes_toggle_todo` 或 `daily_notes_update` 时，必须传入刚获取的 `expected_revision` 与清晰的 `summary` 说明。

2. **优先使用增量工具**：
   - 追加新纪要、结论、踩坑记录或待办时，**优先使用 `daily_notes_append`**（可指定 `heading` 归入对应小节，避免触碰其他段落）。
   - 仅修改待办勾选状态时，**必须使用 `daily_notes_toggle_todo`**。
   - 仅当确实需要重构或替换特定章节/整篇内容且获得用户明确意图时，才使用 `daily_notes_update`。

3. **绝不覆盖冲突与绝不虚构**：
   - 严禁虚构不存在的历史笔记内容、日期或待办事项；如实基于 `daily_notes_get` / `daily_notes_list_range` / `daily_notes_search` 的返回结果作答。
   - 严禁擅自删除用户手动编写的段落（除非用户明确要求删改）。
   - 若工具返回 `REVISION_CONFLICT`（乐观锁冲突），**禁止自动盲目重试覆盖**；须向用户说明服务端最新版本内容并与用户确认合并方案。

4. **写后透明告知**：
   - 每次通过 MCP 写入或修改笔记成功后，须在回复中明确告知用户：写入的目标日期、最新版本号（`revision`），以及「如不满意可在侧边栏底部/提示条点击一键撤销」。

5. **Composer `@` 引用每日笔记**：
   - `daily-notes` MCP Server 通过 MCP Resources 暴露 `daily-notes://today`、`daily-notes://yesterday`、`daily-notes://todos/open`、`daily-notes://recent` 以及按日资源 `daily-notes://notes/YYYY-MM-DD`。
   - 当用户在对话输入框通过 `@` 引用每日笔记资源或提及 `@daily-notes` / `@每日笔记` 时，须优先基于挂载的资源内容（或调用 `read_resource` / `daily_notes_get` 读取最新正文）作答；如需修改被引用笔记，仍须严格遵守前述先读最新 `revision` 与优先增量写入规则。
