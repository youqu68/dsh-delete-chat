# Changelog

All notable changes to this plugin are documented here. Versions follow the npm
releases of `dsh-delete-chat`.

## 0.2.0 — 2026-10-19

First release adapted to the **official** DeepSeek Harness (`@deepseek-ai/dsh`
0.2.x, verified against 0.2.1-rc.2) while remaining compatible with the 0.1.x
line. It also carries the 0.1.2 fixes below, which had never been published.

### Fixed — the plugin did not load at all on 0.2.x

- **The hand-written Typert codecs were rejected, so neither half mounted.**
  The codec contract changed between harness lines: 0.1.x validates
  `codec.schema` (a zod v4 schema) and decodes with `schema.parse()`, while
  0.2.x validates a `codec.create()` factory and decodes with
  `create().parse()`. Every codec in `./typert` and in the client contribution
  now carries **both** spellings pointing at the same schema, so one artifact
  passes either loader. Without this, `dsh-typert-loader` threw
  `... has no create() factory` while registering the manifest (no settings
  page, no callable `remote.delChat.*`) and `remote.$mount()` threw in the
  browser.

- **Deletion no longer depends on `ctx.shell`.** The shell seam lost
  `run(spec)` on 0.2.x (it is now `execute(spec)` + `execution.result()`), so
  every delete threw `shell.run is not a function`. The artifact is now
  removed with `node:fs` directly from the trusted host plugin: a plugin is
  in-process code, the path still comes from the persistence backend's own
  `locate()` and is validated, and this also fixes two older defects — the
  hard-coded PowerShell command never worked on macOS/Linux, and the shell call
  inherited the deployment's file policy (so the session store could be fenced
  out on a deployment whose default write root was elsewhere, which is what
  the removed 0.1.2 "retry under `workspace-write`" hack worked around).

- **Session titles resolve on 0.2.x again.** `cachedSnapshot` lost its
  `inheritedEventCount` argument (`(meta, keys?)`) and `cachedPredecessorTitle`
  lost it too (`(meta)`), so the old three-argument call passed a number as
  `keys` and the cheap title fast path died for cold sessions. Both arities are
  tried, keyed off the running service's arity, and the persisted-cache row
  read (the format-independent `createdAt` + `cwd` identity check) is still
  tried first.

### Fixed — archive / unarchive semantics on 0.2.x

- **Archiving a session with running work is a decision, not an error.**
  0.2.x `archiveSession()` refuses an active session with
  `WorkspaceActiveSessionError` (carrying the activity families) unless the
  caller passes `{ stopActivity: true }`, exactly like the native sidebar.
  `archive` now returns `{ needsStop: true, activity }` as data, the page shows
  what is still running and offers **停止并归档**, and the confirmed retry
  forwards `stopActivity: true`. A session with no running work archives in
  one call as before, and the 0.1.x line (which has no activity gate) is
  unchanged.

- **Unarchive uses the real registry operation.** 0.2.x adds
  `workspaceRegistry.unarchiveSession(id)`; the plugin previously hand-wrote
  the `workspace` storage-domain state. The registry operation is used when
  present and the old durable-domain write remains only as the 0.1.x fallback.

### Fixed — deletion removes the whole session, not just one file

- **Every canonical log generation is removed.** `locate()` always spells the
  *current* generation path (`session.v4.jsonl.zstd` on 0.2.x) without touching
  the filesystem, and a store upgraded from 0.1.x usually keeps older
  generations: a measured real store had 48 artifacts across 32 session
  directories, **22 directories with no v4 file at all** and **10 holding two
  generations**. The old code therefore either failed with ENOENT after
  reporting the session deletable, or deleted one generation and let the
  highest surviving one *resurrect the session on the next read*. The session
  directory is now enumerated and every `session[.vN].jsonl[.zstd]` file in it
  is removed, so format generations v0–v4 (and future ones) are all covered.

- **The POSIX `session.lock` lease file is cleared.** It is session-owned
  debris once the log is gone, and leaving it kept the non-recursive directory
  removal from succeeding. It is removed only when it is the sole remaining
  entry.

- **The session directory is still removed non-recursively.** Unknown files
  written by another component are never swept away; the page reports when the
  directory was kept because it was non-empty.

### Added

- A per-row **“旧格式”** note for sessions the backend reports as
  `migration-required`, so deleting a pre-migration log is not a surprise.
- `test/validate-compat.mjs`: validates the built Typert manifest against every
  installed harness generation's real `validateTypertManifest` (0.1.5 and
  0.2.1 on this machine) and decodes the archive request/result through the
  schema each line would use. `npm test` runs it; it skips cleanly when no
  harness is installed. Override locations with `DSH_HARNESS_DIRS`.
- The host validation suite now exercises the delete path against **real files
  in a temp directory** (canonical names, coexisting generations, leftovers,
  directory-name guard) and the whole archive/unarchive matrix, instead of
  mocks that could hide contract drift.

### Changed

- `export const inject = ['remote', 'slots']` in the browser half: `slots` is
  provided by `dsh-client-ui-renderer`, and reading it without declaring it let
  the page silently never register if the module activated early.

### Notes

- 0.2.0 is the first published release that contains the 0.1.2 fixes; npm
  `latest` was still 0.1.1.
- Verified against the official `@deepseek-ai/dsh@0.2.1-rc.2` and the
  0.1.5-rc.2 runtime. The official 0.2.x harness itself requires Node ≥ 24.2;
  this package's own engines floor stays at Node 20 for the 0.1.x line.

## 0.1.2 — 2026-09-13

> Never published on npm; superseded by 0.2.0, whose delete path replaces the
> shell-based removal described below.

### Fixed

- **Deleting a session works again.** `inspectDeletable` read
  `sessionPersistence.list()` and matched `snapshot.id`, but that method
  resolves `SessionPersistenceSnapshot` objects — `{ header, revision,
  eventCount?, sizeBytes? }` — whose identity is **nested under `.header`**.
  Nothing ever matched, so every delete refused with **“会话不存在”** before
  `deleteSession` was reached. The lookup now matches `snapshot.header.id`.

  Two inventions went with it: the persistence seam has no
  `supportsRawArtifacts` property (the capability probe now checks the backend's
  real `locate()` hook, which is the only source of the on-disk path), and a
  created-but-unmaterialized session is now refused through the backend's own
  `hasPendingSession()` instead of being mistaken for a missing one. A
  persistence listing that throws is reported as a storage error rather than as
  an absent session.

  The functional test's persistence mock returned bare headers plus the invented
  `supportsRawArtifacts`, which is exactly why this defect passed every check;
  the mock now returns real snapshots, and three guards pin the contract.

- **Deleting a *current*-format session works.** The artifact-name guard accepted
  only names starting with `session.jsonl`, but generation 0 is the only
  generation named that way: every later generation carries a `.vN` component, and
  the shipped format generation is **v3** — so a current artifact is
  `session.v3.jsonl.zstd` and was refused with **“产物文件名异常，已拒绝删除”**.

  The guard now matches the backend's canonical names — `session.jsonl` or
  `session.vN.jsonl` (lowercase, no leading zero), each with the optional `.zstd`
  suffix — and still refuses anything else, including `session.v0.jsonl`,
  migration temporaries, and a plain `session.log`. Measured on a real profile:
  34 artifacts on disk, 14 of them the `v3` form the old prefix test rejected, and
  0 legitimate names refused by the new guard.

- **Deleting a session no longer depends on where the harness was launched.**
  The artifact and its directory live in the session store, which is outside the
  session workspace, and a plugin's `shell.resolve()` inherits the *deployment's*
  file policy rather than the calling session's. Deletion was therefore refused
  on any deployment whose default write root does not cover the session store —
  measured directly on a real profile: a write into the session store went
  through while a write into the directory the harness was launched in was fenced
  out, and the same command with an explicitly scoped policy then succeeded in
  both places.

  A denial now retries the same fixed command once under `workspace-write` scoped
  to the artifact's own project directory — the narrowest root that can hold it.
  The scope is chosen by the plugin, but the single path in the command still
  comes from the persistence backend's `locate()` and is validated before use, so
  this narrows the fence to the directory this plugin manages rather than
  widening it. A denial that survives the retry is still reported as such.

- **Session titles are visible again in the settings page.** 0.1.1 moved the
  title source from a log fold (which cost ~15 s per listing on a real corpus)
  to the persisted projection cache, but only called
  `sessionProjectionCache.cachedSnapshot(meta)` — a **three**-argument call whose
  lifecycle identity includes the fork-inherited prefix length. With that
  argument missing the identity never matched, the lookup returned `undefined`,
  and **every row rendered untitled**.

  The fix reads the cache **row by session id** and accepts it when the
  format-independent lifecycle facts match the listed header (`createdAt` +
  `cwd`) — the facts identity validation exists to pin, since they already
  distinguish one lifecycle from a reused id or a swapped persistence root.
  Rows written by an older format carry only `{createdAt, cwd}`, so the cache's
  own `cachedSnapshot` / `cachedPredecessorTitle` (which additionally compare
  `formatVersion`, `isSeeded` and the inherited length) reject every one of
  them; those service reads remain as the fallback for rows in the current
  format, and an attached session whose title is not folded yet now falls
  through to its checkpoint instead of rendering untitled.

  A functional test pins all three: the row path resolves a title, a **stale
  identity is rejected** rather than served, and a rejected row falls through to
  the service reads. `list()` still folds **zero** session logs.

### Changed

- **A deleted session no longer leaves its directory behind.** `deleteSession`
  removed the session's persistence artifact but left the now-empty
  `sessions/<project>/<sessionId>/` directory in place. The removal command now
  also drops that directory.

  The directory removal is deliberately **non-recursive**: it succeeds only when
  the directory is empty, so a session-owned artifact written there by a future
  version survives instead of being swept away.

  Artifact removal itself is unchanged — an exact `-LiteralPath` removal that
  fails loudly, with the live-session, non-file-backend and unexpected-filename
  guards, the two-step confirmation, and the accounting/archive cleanup intact.

### Not deleted (by design)

- Per-session rows in the persisted **projection cache**
  (`$DSH_HOME/storages/session_projcache.json`, about 5.6 KB per session) and any
  per-session data owned by other plugins. The harness itself never prunes these
  on any deletion path, and the rows are inert: reads validate them against the
  log's stored identity before accepting them.

## 0.1.1 — 2026-09-12

### Fixed

- **The settings page no longer freezes on a large history.** `list()` resolved
  every session's title through `sessionQuery.readTitleSnapshots`, which folds
  that session's complete event log. Measured on a real corpus (20 logs,
  43.5 MB compressed, 322 MB decompressed, 1.26 M events) a single listing cost
  about **15 s**, and the cost grows with history.

  Titles now come from the registered `title` projection — the live projection
  table for attached sessions, the persisted projection cache for everything
  else — so no session log is folded during a listing. Titles render exactly as
  before; the registry's own archived-session set, the delete guards, and the
  two-step confirmation are unchanged.

## 0.1.0 — 2026-09-10

### Added

- A **会话管理** (Session Manager) settings page listing every session with its
  title, working directory, and creation time, split into _archived_ and
  _active_ groups.
- **Archive** and **unarchive**, backed by the workspace registry's durable
  archive set; archiving hides a session without touching its log, and
  unarchiving restores it to the sidebar.
- **Delete** behind a two-step confirmation: the first click resolves and shows
  the exact persistence artifact that would be removed, the second performs it.
  The host refuses live sessions, refuses backends that expose no per-session
  artifact, refuses an unexpected artifact filename, and surfaces a sandbox
  denial instead of forcing the removal. A successful delete also detaches the
  session from workspace accounting and from the archive set.
