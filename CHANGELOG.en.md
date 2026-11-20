# Changelog

[中文](CHANGELOG.md) | English

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
