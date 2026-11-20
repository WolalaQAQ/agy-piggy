# 变更记录

中文 | [English](CHANGELOG.en.md)

## [0.1.0] - 2026-11-21

### Features
- 新增自包含 Antigravity 插件 `agy-piggy`，通过 `hooks.json` 监听 `PreInvocation`、`PostToolUse` 与 `Stop`，分别映射为 `message`、`tool`/`toolError` 与 `turn`/`agentError`，以 `source: "antigravity"` 投递至 dsh-piggy 官方工作事件接口。
- 新增持久发件箱与单实例后台投递进程（`--flush`）：Hook 主进程仅做本地原子落盘并按需派生分离后台进程，支持离线积压自动补投、HTTP `429` 按 `Retry-After` 退避以及超过 7 天接收窗口的事件现场保留。
- 原生支持新版桌面端独立完整档发现契约：自动只读识别 `owner-archive-selection.json` 指向的 `<ownerDocumentPath>.work-events`，并向后兼容默认 `work-endpoint`、桌面标记文件及旧版配置目录。
- 支持 Antigravity 原生 CLI 校验与安装（`agy plugin validate --strict`、`agy plugin install`），并提供自包含 `.zip` 与 `.tgz` 离线发布包。

### Design Rationale
- Antigravity Hooks 在执行循环中同步阻塞运行，将文件 ACL 校验指纹化、HTTP 投递剥离到独立 `--flush` 后台进程，既保证断网或游戏关闭时不丢事件，又避免阻塞对话交互。
- 插件不提供任何 `rules/`、`skills/` 或 `mcp_config.json`，让模型上下文保持零额外占用。

### Notes & Caveats
- 需要本机安装 Node.js 22.0 或以上，且 dsh-piggy 已开启工作事件接口（桌面设置开启「外部连接」或以 `--work-events` 启动）。
- 插件按 `conversationId` 与步骤锚点对 `PreInvocation` 和 `Stop` 去重；不保存或上传任何会话正文与工具参数。
