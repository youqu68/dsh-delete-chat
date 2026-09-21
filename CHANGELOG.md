# Changelog

All notable changes to this plugin are documented here. Versions follow the npm
releases of `dsh-delete-chat`.

## 0.1.2 — 2026-09-13

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
