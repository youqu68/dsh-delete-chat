# Changelog

All notable changes to this plugin are documented here. Versions follow the npm
releases of `dsh-delete-chat`.

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
