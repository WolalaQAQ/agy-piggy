# AGY Piggy

中文 | [English](README.en.md)

AGY Piggy 是一个自包含的 Antigravity 插件，让 [dsh-piggy](https://github.com/CLICGGER-TYPES/dsh-piggy) 桌宠随你在 Antigravity 中的工作成长。

插件通过 Antigravity 原生 `hooks.json` 监听对话输入、工具执行和回合结束事件，在本地发件箱落盘后由后台独立进程投递到游戏的官方工作事件 HTTP 接口（`source: "antigravity"`）。插件不注入规则、技能或 MCP 工具，不占用模型上下文，也不分发或启动桌宠。

| 组件 | 要求 |
|---|---|
| Node.js | 22.0 或以上（需在 `PATH` 中） |
| dsh-piggy | 支持工作事件协议 v1，启用「外部连接」或以 `--work-events` 启动 |
| 插件版本 | 0.1.0 |

## 快速开始

### 1. 安装插件

克隆仓库并使用 Antigravity 原生 CLI 安装：

```sh
git clone https://github.com/WolalaQAQ/agy-piggy.git
agy plugin install ./agy-piggy
```

或从 [Releases](https://github.com/WolalaQAQ/agy-piggy/releases) 下载 `.zip` / `.tgz` 离线归档并解压后执行 `agy plugin install ./agy-piggy`。无 `agy` CLI 的环境可进入仓库目录运行 `node scripts/install-agy.mjs --copy`（将插件复制到 `~/.gemini/config/plugins/agy-piggy`）。

卸载插件使用 `agy plugin uninstall agy-piggy`（或 `node scripts/install-agy.mjs --uninstall`），已保存的事件队列保留在 `PLUGIN_DATA` 中。

### 2. 开启桌宠工作事件接口

在 dsh-piggy 桌面设置中开启「外部连接」，或以 `--work-events` 参数启动游戏。之后在 Antigravity 正常对话与调用工具即可自动投递事件。

## 事件映射与去重

插件只提取事件标识、类型与时间戳，不上传对话正文、代码或工具输出：

| Antigravity Hook | 映射类型 | 去重与过滤规则 |
|---|---|---|
| `PreInvocation` | `message` | 仅统计当前会话新增的 `USER_EXPLICIT` 用户输入（按 `conversationId` 与 `step_index` 去重，跳过子代理无用户输入会话） |
| `PostToolUse` | `tool` / `toolError` | 无 `error` 字段记为 `tool`，含非空 `error` 记为 `toolError`；跳过 `enter_plan_mode` 与 `exit_plan_mode` |
| `Stop` | `turn` / `agentError` | `terminationReason === "ERROR"` 记为 `agentError`；`NO_TOOL_CALL` 且 `fullyIdle !== false` 记为 `turn`；忽略 `USER_CANCELED` 等中断 |

Hook 主进程只执行同步落盘与按需派生后台 `--flush` 子进程，不阻塞 Agent 对话循环。收到游戏 `429` 限流响应时按 `Retry-After` 头退避；超过 7 天接收窗口的事件会保留在磁盘上并停止自动投递。

## 目录发现与可选配置

插件按以下顺序自动发现游戏的 `endpoint.json`（只读解析，不读写游戏存档）：

1. 显式配置 `config.json` 中的 `gameDirectory` 或环境变量 `AGY_PIGGY_GAME_ENDPOINT`
2. `PIGGY_OWNER_DOCUMENT_CONFIG` 指定的独立完整档目录
3. `PIGGY_USERDATA` 指定的用户数据目录（优先检查其 `owner-archive-selection.json` 指向的 `<ownerDocumentPath>.work-events`，再回退 `work-endpoint`）
4. 系统默认 `piggy` 数据目录（Windows `%APPDATA%/piggy`、macOS `~/Library/Application Support/piggy`、Linux `${XDG_DATA_HOME:-~/.local/share}/piggy`），同样优先识别 `owner-archive-selection.json` 完整档与 `work-endpoint`
5. 桌面标记文件 `$DSH_HOME/dsh-piggy/desktop-app.json`（或 `~/.dsh/dsh-piggy/desktop-app.json`）及旧版 `dsh-piggy` / `dsh-piggy-desktop` 目录

如需覆写默认行为，可在安装后的插件目录创建 `config.json`（不随 Git 提交）：

| 字段 | 类型 | 说明 |
|---|---|---|
| `enabled` | boolean | 为 `false` 时停用事件上报（默认值 `true`；也可通过环境变量 `AGY_PIGGY_DISABLED=1` 临时关闭） |
| `directory` | string | 自定义发件箱队列目录的绝对路径（默认依次使用 `AGY_PIGGY_DATA_DIR`、`PLUGIN_DATA`、系统配置目录下的 `agy-piggy-plugin`） |
| `gameDirectory` | string | 自定义游戏 `endpoint.json` 所在目录的绝对路径 |

反馈问题时请勿分享游戏目录下的 `endpoint.json`，其中包含本机访问令牌。

## 开发与校验

插件运行与校验仅使用 Node.js 内置模块，无需安装第三方依赖：

```sh
npm run check
npm run pack:plugin
agy plugin validate --strict .
```

版本变化见 [CHANGELOG](CHANGELOG.md)。

## 许可

[MIT](LICENSE)
