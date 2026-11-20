# Changelog

[中文](CHANGELOG.md) | English

## [0.1.1] - 2026-11-21

### Features
- Added npm package distribution with a one-command `npx agy-piggy@latest` installer (`bin/agy-piggy.mjs`), supporting installation, upgrades and `--uninstall`.
- Updated the installer to stage a clean `agy-piggy/` directory containing only runtime files before invoking `agy plugin install`, keeping `.git`, `dist`, development scripts and npm metadata out of the global plugins directory.
- Updated `npm run pack:plugin` so the `.tgz` archive uses the standard npm top-level `package/` layout (with a public `package.json` stripped of `"private"` and dev scripts, plus an LF/0755 `bin` entry), matching the exact tarball published to npm; `.zip` remains a standalone plugin bundle.

### Design Rationale
- Because `agy plugin install` does not fetch packages directly from npm, shipping a lightweight `bin` wrapper that stages a clean runtime bundle gives users the same one-line `npx agy-piggy@latest` experience.

### Notes & Caveats
- Upgrading from `0.1.0` with `npx agy-piggy@latest` replaces the installed plugin in place while preserving your outbox queue.
- Publish only the generated `dist/agy-piggy-0.1.1.tgz` tarball; the repository root keeps `"private": true`.

## [0.1.0] - 2026-11-21

### Features
- Added the self-contained Antigravity plugin `agy-piggy`, subscribing to `PreInvocation`, `PostToolUse` and `Stop` via `hooks.json` to emit `message`, `tool`/`toolError` and `turn`/`agentError` events under `source: "antigravity"`.
- Added a persistent outbox and single-instance detached `--flush` worker: the synchronous hook only persists metadata atomically and spawns background delivery when needed, supporting offline replay, `429` `Retry-After` backoff and preserving events older than 7 days on disk.
- Added native discovery for `OwnerDocument` archives by reading `owner-archive-selection.json` (`<ownerDocumentPath>.work-events`) alongside standard `work-endpoint`, desktop marker files and legacy directories.
- Added native Antigravity CLI validation and installation support (`agy plugin validate --strict`, `agy plugin install`) alongside self-contained `.zip` and `.tgz` release archives.

### Design Rationale
- Because Antigravity hooks block the agent loop synchronously, offloading HTTP delivery and directory ACL verification to a detached `--flush` process keeps hook latency minimal while preserving reliability across game restarts.
- Keeping the plugin free of `rules/`, `skills/` and `mcp_config.json` guarantees zero model context overhead.

### Notes & Caveats
- Requires Node.js 22.0 or later in `PATH` and an active dsh-piggy work-event endpoint (enable external connections in settings or launch with `--work-events`).
- Deduplicates `PreInvocation` and `Stop` by `conversationId` and step anchors; no prompt text, code or tool arguments are stored or transmitted.
