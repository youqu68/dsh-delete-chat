# dsh-delete-chat

A DeepSeek Harness session manager: a settings page that lists every session and lets you archive (hide), unarchive (restore), and permanently delete sessions.

一个 DeepSeek Harness 会话管理插件：在设置页中列出全部会话，并支持归档（隐藏）、取消归档（恢复显示）与永久删除会话。

Works with the official `@deepseek-ai/dsh` 0.2.x harness (verified against
0.2.1-rc.2) and with the 0.1.x line. One codebase: the few seams that changed
between the lines are feature-detected at runtime.

## What it does / 功能

- **List** every session with its title, working directory, and creation time, split into *archived* and *active* groups. Sessions whose log is still an older format generation are marked **旧格式**.
- **Archive** a session to hide it from the sidebar. If the session still has running work, the page says what is running and offers **停止并归档** — the same stop-and-archive decision the native sidebar asks for. Archiving is fully reversible.
- **Unarchive** a session to make it visible again.
- **Delete** a session permanently: removes **every** canonical log generation in the session's own directory, then the now-empty directory, then detaches it from workspace accounting and from the archive set.

Permanent deletion does not exist in the official harness, so that — plus the
two-step confirmation that shows the exact files — is this plugin's unique
value. Archive/unarchive duplicate the native sidebar on 0.2.x; they are kept
for the 0.1.x line and for doing everything from one page.

## Install / 安装

```sh
dsh plugin --profile web add dsh-delete-chat
```

The package declares `dsh.bundle.patch`, so the command installs it **and** reconciles it into `dsh.profile.bundles` — no profile file editing. Restart `dsh web` to mount it.

The package must be installed under its **bare package name** (not by absolute
path): the host-face Typert manifest is resolved by package name, and a
path-mounted row would load the browser half but never register
`remote.delChat.*`.

## Usage / 使用

Open **Settings → 会话管理** (Session Manager).

## Safety / 安全边界

- **Archive is not delete.** Archiving only hides a session; its log stays on disk and `取消归档` restores it.
- **Live sessions cannot be deleted.** A running session's delete button is disabled, and the host refuses the call even if it is reached directly. A created-but-never-flushed session owns no file and is refused too.
- **Delete is permanent and two-step.** The first click shows the exact path (and every generation file) that will be removed; only a second click deletes anything.
- **Only the session's own artifacts are touched.** The directory comes from the persistence backend's own `locate()`, and the plugin then requires that the directory's name is exactly the session id, and only removes basenames matching the backend's canonical generation names — `session.jsonl`, `session[.vN].jsonl`, each optionally `.zstd`. Anything else in that directory survives, and the directory itself is removed only when empty (the POSIX `session.lock` lease file is cleared as session-owned debris).
- **Why deletion is in-process.** A host plugin is trusted in-process code; the previous shell-based removal inherited the deployment's file policy (so a deployment whose default write root did not cover the session store could not delete) and its PowerShell command never worked on macOS/Linux. The path still comes from the backend and is validated here, never from the caller.
- **Projection-cache and search rows.** The per-session projection checkpoint under `$DSH_HOME/storages/session_projcache` is left alone by design: reads validate it against the log's identity, so a stale row is never served for a deleted session. Full-text search is disabled in the shipped Web profile; if a deployment enables it, the index reconciles deleted sources on its next observation — no restart needed.

## Architecture / 结构

One dual-face package:

| Piece | File | Role |
| --- | --- | --- |
| Host plugin | `lib/index.js` | `apply(ctx)` provides the `delChat` service |
| Host manifest | `lib/typert.host.js` | the `./typert` Typert contribution that exposes `delChat` over the gateway |
| Browser plugin | `lib/client.js` | the `settings.section` page, mounted through `exports["./client"]` |
| Mount | `cordis.patch.yml` | one `insert` row: `del-chat → dsh-delete-chat` |

The browser half reaches the host through `remote.delChat.*`. The host half imports no `@deepseek-ai/*` runtime package — it reads the host process's own services with `ctx.get(...)` and binds itself to the gateway with a hand-written `typertRemote` binding, so no code-generation step is needed to build this plugin.

Every Typert codec carries both harness spellings of a strict codec —
`{ mode: 'strict', typeSymbol, schema, create: () => schema }` — because 0.1.x
validates/decodes `codec.schema`, while 0.2.x validates a `create()` factory and
decodes `create().parse(...)`. One artifact passes either loader.

Exposed Remote methods:

```
delChat.list()                      → { sessions: [...] }
delChat.archive({ sessionId, stopActivity? })
                                    → { archivedSessionIds, needsStop, activity }
delChat.unarchive({ sessionId })    → { archivedSessionIds }
delChat.inspectDelete({ sessionId })→ { deletable, reason, path, dir, files }
delChat.deleteSession({ sessionId })→ { path, removed, dirRemoved }
```

## Development / 开发

```sh
npm install
npm run build     # esbuild → lib/index.js, lib/typert.host.js, lib/client.js
npm test          # builds, then validates both halves + cross-harness compat
```

`npm run build` writes the published artifacts:

- `lib/index.js` — the host plugin, bundled to ESM.
- `lib/typert.host.js` — copied verbatim from `src/typert.host.js`.
- `lib/client.js` — the browser bundle wrapped in the `window.__ModuleLoader__.load({ id, factory })` envelope the DSH client module system executes, with `react` left external for the shell's static module table.

`npm test` runs three suites:

1. `test/validate-host.mjs` — imports the built host half against a mock Cordis
   context and exercises the deletion contract on **real files in a temp
   directory** (canonical generation names, coexisting v3/v4 generations,
   non-canonical leftovers, directory-name guard) plus the archive/unarchive
   matrix and the title fast path for both cache signatures.
2. `test/validate-client.mjs` — executes the built browser bundle against a fake
   `window.__ModuleLoader__` and a react shim, asserting the registration id,
   the exports/inject list, the Remote descriptors, and the
   `settings.section` registration.
3. `test/validate-compat.mjs` — validates the built manifest with the **real**
   `validateTypertManifest` of every installed harness generation it can find
   (0.1.5 and 0.2.1 locally) and decodes the archive request/result through the
   schema each line uses. It skips cleanly when no harness is installed; point
   it at other installs with `DSH_HARNESS_DIRS` (semicolon-separated
   `...\node_modules\@deepseek-ai` directories).

## License

MIT
