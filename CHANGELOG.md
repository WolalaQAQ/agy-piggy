# 变更记录

中文 | [English](CHANGELOG.en.md)

## [0.1.1] - 2026-11-21

### Features
- 新增 npm 包分发与 `npx agy-piggy@latest` 一键安装器（`bin/agy-piggy.mjs`），支持直接安装、更新与 `--uninstall` 卸载。
- 安装器调用 `agy plugin install` 前先暂存只包含运行时文件的纯净 `agy-piggy/` 目录，避免将 `.git`、`dist`、开发脚本或 npm 元数据写入全局插件目录。
- 调整 `npm run pack:plugin` 生成的 `.tgz` 为 npm 标准 `package/` 顶层结构（含去除了私有标记与开发脚本的公开 `package.json` 及 LF/0755 `bin` 入口），确保 GitHub Release `.tgz` 与 npm 发布包完全一致；`.zip` 保持纯插件结构。

### Design Rationale
- Antigravity 原生 `agy plugin install` 目前不直接从 npm 拉取包，通过提供轻量 `bin` 入口封装暂存目录与原生安装命令，让用户可以用一行 `npx agy-piggy@latest` 获得与 OpenCode 插件一致的安装体验。

### Notes & Caveats
- 从 `0.1.0` 升级时直接运行 `npx agy-piggy@latest` 即可原地替换安装，已保存的事件队列保留不变。
- `npm publish` 时只发布 `npm run pack:plugin` 生成的 `dist/agy-piggy-0.1.1.tgz`，仓库根目录保留 `"private": true`。

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
