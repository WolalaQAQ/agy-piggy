# AGY Piggy

[中文](README.md) | English

AGY Piggy is a self-contained Antigravity plugin that lets your [dsh-piggy](https://github.com/CLICGGER-TYPES/dsh-piggy) desktop pet grow as you work in Antigravity.

The plugin uses Antigravity's native `hooks.json` to observe user prompts, tool calls and turn completions, persists metadata to a local outbox, and delivers work events from a detached background process to the game's official HTTP API (`source: "antigravity"`). It registers no rules, skills or MCP tools, consumes zero model context tokens, and neither bundles nor launches the game.

| Component | Requirement |
|---|---|
| Node.js | 22.0 or later (available in `PATH`) |
| dsh-piggy | Supports work-event protocol v1, with external connections enabled or launched with `--work-events` |
| Plugin version | 0.1.1 |

## Quick start

### 1. Install the plugin

Install the latest stable release from npm in one command:

```sh
npx agy-piggy@latest
```

The installer pulls the package and invokes your local `agy plugin install` to register and enable the plugin (falling back to a managed copy at `~/.gemini/config/plugins/agy-piggy` if the `agy` CLI is unavailable). To pin a version, run `npx agy-piggy@0.1.1`.

Without npm, clone the repository and install with the Antigravity CLI:

```sh
git clone https://github.com/WolalaQAQ/agy-piggy.git
agy plugin install ./agy-piggy
```

You can also download `.zip` or `.tgz` archives from [Releases](https://github.com/WolalaQAQ/agy-piggy/releases): extract `.zip` and run `agy plugin install ./agy-piggy`, or extract `.tgz` and run `node ./package/bin/agy-piggy.mjs`.

To uninstall while preserving your event queue in `PLUGIN_DATA`, run `agy plugin uninstall agy-piggy` or `npx agy-piggy@latest --uninstall`.

### 2. Enable the game's work-event API

Enable external connections in dsh-piggy desktop settings, or launch the game with `--work-events`. Then use Antigravity normally.

## Event mapping and deduplication

The plugin records only event identifiers, types and timestamps, with no chat text, code or tool output:

| Antigravity Hook | Work event type | Deduplication and filtering |
|---|---|---|
| `PreInvocation` | `message` | Counts new `USER_EXPLICIT` prompts per conversation (`conversationId` + `step_index`), skipping subagent sessions without explicit user input |
| `PostToolUse` | `tool` / `toolError` | Emits `tool` without `error`, or `toolError` when `error` is non-empty; skips `enter_plan_mode` and `exit_plan_mode` |
| `Stop` | `turn` / `agentError` | Emits `agentError` on `ERROR`, and `turn` on `NO_TOOL_CALL` when `fullyIdle !== false`; ignores `USER_CANCELED` and incomplete steps |

The synchronous hook only persists the event and spawns a detached `--flush` child process when needed, keeping the agent loop unblocked. If the game responds with HTTP `429`, delivery backs off according to `Retry-After`. Events older than the 7-day acceptance window remain on disk without further automatic retries.

## Endpoint discovery and optional config

The plugin searches for the game's `endpoint.json` in the following order (read-only metadata inspection; game save files are never read or modified):

1. Explicit `gameDirectory` in `config.json` or environment variable `AGY_PIGGY_GAME_ENDPOINT`
2. Owner-document runtime config in `PIGGY_OWNER_DOCUMENT_CONFIG`
3. Custom `PIGGY_USERDATA` directory (checking `<ownerDocumentPath>.work-events` from `owner-archive-selection.json` first, then `work-endpoint`)
4. Default platform `piggy` data directory (`%APPDATA%/piggy` on Windows, `~/Library/Application Support/piggy` on macOS, `${XDG_DATA_HOME:-~/.local/share}/piggy` on Linux), checking `owner-archive-selection.json` before `work-endpoint`
5. Desktop marker files (`$DSH_HOME/dsh-piggy/desktop-app.json` and `~/.dsh/dsh-piggy/desktop-app.json`) and legacy `dsh-piggy` / `dsh-piggy-desktop` directories

To override defaults, create `config.json` inside the installed plugin directory (ignored by Git):

| Field | Type | Description |
|---|---|---|
| `enabled` | boolean | Set to `false` to disable reporting (default `true`; also respects `AGY_PIGGY_DISABLED=1`) |
| `directory` | string | Absolute path for the plugin outbox directory (defaults to `AGY_PIGGY_DATA_DIR`, `PLUGIN_DATA`, or `agy-piggy-plugin` under user config) |
| `gameDirectory` | string | Absolute path to the game directory containing `endpoint.json` |

Do not share `endpoint.json` when reporting issues, as it holds your local authentication token.

## Development and verification

The plugin and its checks use Node.js built-in modules only:

```sh
npm run check
npm run pack:plugin
agy plugin validate --strict .
```

See [CHANGELOG](CHANGELOG.en.md) for release notes.

## License

[MIT](LICENSE)
