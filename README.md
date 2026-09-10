# dsh-delete-chat

A DeepSeek Harness session manager: a settings page that lists every session and lets you archive (hide), unarchive (restore), and permanently delete sessions.

一个 DeepSeek Harness 会话管理插件：在设置页中列出全部会话，并支持归档（隐藏）、取消归档（恢复显示）与永久删除会话。

## What it does / 功能

- **List** every session with its title, working directory, and creation time, split into *archived* and *active* groups.
- **Archive** a session to hide it from the sidebar. The log is kept, so archiving is fully reversible.
- **Unarchive** a session to make it visible again.
- **Delete** a session permanently: removes its persistence log file, then detaches it from workspace accounting and from the archive set.

## Install / 安装

```sh
dsh plugin --profile web add dsh-delete-chat
```

The package declares `dsh.bundle.patch`, so the command installs it **and** reconciles it into `dsh.profile.bundles` — no profile file editing. Restart `dsh web` to mount it.

## Usage / 使用

Open **Settings → 会话管理** (Session Manager).

## Safety / 安全边界

- **Archive is not delete.** Archiving only hides a session; its log stays on disk and `取消归档` restores it.
- **Live sessions cannot be deleted.** A running session's delete button is disabled, and the host refuses the call even if it is reached directly.
- **Delete is permanent and two-step.** The first click shows the exact file path that will be removed; only a second click deletes anything.
- **Only the session's own artifact is touched.** The host resolves the path through `sessionPersistence.locate()`, refuses anything whose filename is not `session.jsonl*`, and refuses backends that expose no per-session artifact (for example a SQLite store).
- **Sandbox-aware.** Session files live under `$DSH_HOME/sessions`, outside the workspace. If the host's shell sandbox denies the removal, the plugin surfaces that denial instead of forcing it, and the file can be deleted by hand.
- **Search index.** A deleted session disappears from the session list immediately; a full-text search index may keep a stale row until the next DSH restart, which is the documented reconciliation point.

## Architecture / 结构

One dual-face package:

| Piece | File | Role |
| --- | --- | --- |
| Host plugin | `lib/index.js` | `apply(ctx)` provides the `delChat` service |
| Host manifest | `lib/typert.host.js` | the `./typert` Typert contribution that exposes `delChat` over the gateway |
| Browser plugin | `lib/client.js` | the `settings.section` page, mounted through `exports["./client"]` |
| Mount | `cordis.patch.yml` | one `insert` row: `del-chat → dsh-delete-chat` |

The browser half reaches the host through `remote.delChat.*`. The host half imports no `@deepseek-ai/*` runtime package — it reads the host process's own services with `ctx.get(...)` and binds itself to the gateway with a hand-written `typertRemote` binding, so no code-generation step is needed to build this plugin.

Exposed Remote methods:

```
delChat.list()                      → { sessions: [...] }
delChat.archive({ sessionId })      → { archivedSessionIds: [...] }
delChat.unarchive({ sessionId })    → { archivedSessionIds: [...] }
delChat.inspectDelete({ sessionId })→ { deletable, reason, path, dir }
delChat.deleteSession({ sessionId })→ { path }
```

## Development / 开发

```sh
npm install
npm run build     # esbuild → lib/index.js, lib/typert.host.js, lib/client.js
npm test          # structural validation of both halves
```

`npm run build` writes the published artifacts:

- `lib/index.js` — the host plugin, bundled to ESM.
- `lib/typert.host.js` — copied verbatim from `src/typert.host.js`.
- `lib/client.js` — the browser bundle wrapped in the `window.__ModuleLoader__.load({ id, factory })` envelope the DSH client module system executes, with `react` left external for the shell's static module table.

`npm test` imports the built host half against a mock Cordis context (exports, provided service, `typertRemote` binding, manifest shape) and executes the built browser bundle against a fake `window.__ModuleLoader__` plus a react shim, asserting the registration id, the exports, the Remote descriptors, and the `settings.section` registration.

## License

MIT
