/**
 * dsh-delete-chat — host half.
 *
 * A session manager exposing four Remote methods to the browser half:
 *   list()                    → every session with title / cwd / liveness / archive flag
 *   archive({sessionId})      → hide a session
 *   unarchive({sessionId})    → restore a hidden session
 *   inspectDelete({sessionId})→ whether (and where) a session's log file can be deleted
 *   deleteSession({sessionId})→ permanently remove a non-live session's log file
 *
 * Delivery follows the third-party plugin pattern: this module imports no
 * `@deepseek-ai/*` runtime package and instead reads the host process's own
 * service instances through `ctx.get(...)`. The browser reaches these methods
 * through a hand-written `typertRemote` binding plus the `./typert` manifest
 * (registered by `dsh-typert-loader`), which is what makes `remote.delChat.*`
 * exist on the client.
 */

export const name = 'del-chat'

/** The registry-global archived session ids, or an empty list when unavailable. */
function archivedIdsOf(registry) {
  if (registry === undefined) return []
  try {
    return registry.archivedSessionIds.map((id) => String(id))
  } catch {
    return []
  }
}

/** Parent directory of a Windows or POSIX path, without importing node:path. */
function parentDir(p) {
  const i = Math.max(p.lastIndexOf('\\'), p.lastIndexOf('/'))
  return i > 0 ? p.slice(0, i) : p
}

/**
 * The canonical session-log basenames the JSONL backend writes, mirrored from
 * `sessionFormatLogFilename` + `compressionSuffix`: format generation 0 is
 * `session.jsonl`, every later generation carries a lowercase `vN` component
 * before the suffix (`session.v3.jsonl`), and `.zstd` is appended when the
 * configured encoding is Zstandard.
 *
 * The `vN` form is the common case — the shipped format generation is **v3**, so
 * on a real profile the artifacts are named `session.v3.jsonl.zstd`. A prefix
 * test against `session.jsonl` accepts only the legacy generation and rejects
 * every current one, which is what produced "产物文件名异常，已拒绝删除".
 */
const SESSION_LOG_BASENAME = /^session(?:\.v[1-9][0-9]*)?\.jsonl(?:\.zstd)?$/

/**
 * Unwrap the `title` projection value. It is the title string itself; the
 * `{ title }` shape is tolerated as well.
 * @returns the title, or null when absent or blank.
 */
function titleFromValue(value) {
  if (typeof value === 'string' && value.length > 0) return value
  if (value !== null && typeof value === 'object' && typeof value.title === 'string' && value.title.length > 0) {
    return value.title
  }
  return null
}

/**
 * The exact fork-inherited prefix length the projection cache binds a record to.
 *
 * `cachedSnapshot`/`cachedPredecessorTitle` match on a lifecycle identity that
 * includes this length, and passing anything else simply never matches. The
 * header exposes only `isSeeded` — the length is Session state — so an unseeded
 * session passes 0, and a seeded one is read from the cache's OWN stored
 * identity row (a read-only peek) so the lookup can still match. Passing 0 for
 * a seeded session would be safe but silent: the identity check rejects it.
 * @returns the inherited event count to pass to the cache.
 */
function inheritedCountFor(ctx, header) {
  if (header.isSeeded !== true) return 0
  try {
    const row = ctx.get('storageDomain')?.get('session_projcache')?.table('sessions')?.get(String(header.id))
    const stored = row?.identity?.inheritedEventCount
    if (typeof stored === 'number' && Number.isSafeInteger(stored) && stored >= 0) return stored
  } catch {
    // No peek available; the cache lookup below simply will not match.
  }
  return 0
}

/**
 * Read one session's title straight from its persisted projection-cache row.
 *
 * The cache table is keyed by session id, and the row carries the lifecycle
 * identity it was written under. Accepting the row only when `createdAt` and
 * `cwd` equal the listed header's keeps the guarantee that validation exists
 * for — a reused id or a swapped persistence root cannot serve an unrelated
 * title — without also requiring the `formatVersion`/`isSeeded`/inherited-length
 * fields that rows written by an older format never had.
 * @returns the title, or null when the row is absent, unrelated, or untitled.
 */
function titleFromCacheRow(ctx, header) {
  try {
    const row = ctx.get('storageDomain')?.get('session_projcache')?.table('sessions')?.get(String(header.id))
    if (row === undefined) return null
    const identity = row.identity
    if (identity === undefined) return null
    if (identity.createdAt !== header.createdAt) return null
    if (identity.cwd !== header.cwd) return null
    return titleFromValue(row.rows?.title?.val)
  } catch {
    // An unreadable row renders untitled rather than failing the listing.
    return null
  }
}

/**
 * Resolve one session's title WITHOUT folding its event log.
 *
 * `sessionQuery.readTitleSnapshots` folds the COMPLETE log of every requested
 * session. Measured on a real corpus (43.5 MB compressed / 322 MB decompressed
 * / 1.26M events) that is ~15 s per call, which freezes the settings page. The
 * title is already a registered projection, so it is read from the live
 * projection table for attached sessions and from the persisted projection
 * cache for every other session — both are metadata reads.
 * @returns the title, or null when no cheap source has one yet.
 */
function resolveTitle(ctx, header, liveSession) {
  if (liveSession !== undefined) {
    const projections = ctx.get('sessionProjections')
    if (projections !== undefined) {
      try {
        const title = titleFromValue(projections.snapshot(liveSession)?.values?.title)
        if (title !== null) return title
      } catch {
        // Fall through to the in-memory title service.
      }
    }
    const sessionTitle = ctx.get('sessionTitle')
    if (sessionTitle !== undefined) {
      try {
        const title = titleFromValue(sessionTitle.get(liveSession))
        if (title !== null) return title
      } catch {
        // A live title that is not folded yet falls through to the checkpoint.
      }
    }
    // Fall through: an attached session whose title has not been folded yet can
    // still have one in its persisted checkpoint.
  }

  // Persisted session: the persisted projection cache.
  //
  // Read the row BY ID first and accept it when the format-independent
  // lifecycle facts match. The cache's own validated reads
  // (`cachedSnapshot` / `cachedPredecessorTitle`) additionally compare
  // `formatVersion`, `isSeeded` and the inherited prefix length; rows written by
  // an older format carry only `{createdAt, cwd}`, so those reads reject every
  // such row and the whole page rendered untitled. `createdAt` + `cwd` are the
  // facts that identity validation exists to pin (they already distinguish one
  // lifecycle from a reused id or a swapped persistence root), and they match
  // every real row on disk.
  const rowTitle = titleFromCacheRow(ctx, header)
  if (rowTitle !== null) return rowTitle

  const cache = ctx.get('sessionProjectionCache')
  if (cache === undefined) return null
  const inherited = inheritedCountFor(ctx, header)
  try {
    const title = titleFromValue(cache.cachedSnapshot(header, inherited, ['title'])?.values?.title)
    if (title !== null) return title
  } catch {
    // Fall through to the predecessor hint.
  }
  try {
    return titleFromValue(cache.cachedPredecessorTitle(header, inherited)?.values?.title)
  } catch {
    return null
  }
}

/**
 * Resolve one session's persistence artifact and whether it may be deleted.
 *
 * `sessionPersistence.list()` returns `SessionPersistenceSnapshot` objects —
 * `{ header, revision, eventCount?, sizeBytes? }` — so the session identity is
 * NESTED under `.header`; the snapshot itself has no `id`. Matching on
 * `snapshot.id` misses every stored session and made every delete refuse with
 * "会话不存在".
 *
 * @returns `{ deletable, reason, path, dir }` — `reason`/`path`/`dir` are null
 *   (never undefined) so the Remote result stays JSON-safe.
 */
async function inspectDeletable(ctx, sessionId) {
  const sessions = ctx.get('sessions')
  if (sessions !== undefined && sessions.get(sessionId) !== undefined) {
    return { deletable: false, reason: '该会话正在运行，无法删除', path: null, dir: null }
  }

  const persistence = ctx.get('sessionPersistence')
  if (persistence === undefined) {
    return { deletable: false, reason: '存储服务不可用', path: null, dir: null }
  }

  let snapshot
  let listError = null
  try {
    const snapshots = await persistence.list()
    snapshot = snapshots.find((s) => s !== null && typeof s === 'object' && String(s.header?.id) === sessionId)
  } catch (error) {
    listError = error
    snapshot = undefined
  }
  if (snapshot === undefined) {
    if (listError !== null) {
      return {
        deletable: false,
        reason: `读取会话存储失败：${String((listError && listError.message) || listError)}`,
        path: null,
        dir: null,
      }
    }
    return { deletable: false, reason: '会话不存在或没有可删除的日志文件', path: null, dir: null }
  }

  // A created-but-unmaterialized session is visible to this process from
  // `create` until its first flush, but owns no artifact yet.
  if (typeof persistence.hasPendingSession === 'function' && persistence.hasPendingSession(sessionId) === true) {
    return { deletable: false, reason: '该会话尚未写入磁盘日志，没有可删除的文件', path: null, dir: null }
  }

  // `locate` is the backend's own refusal-diagnostics hook and the only source
  // of the on-disk path; the public persistence seam exposes no path lookup.
  if (typeof persistence.locate !== 'function') {
    return { deletable: false, reason: '当前存储后端不暴露单会话文件，无法安全删除', path: null, dir: null }
  }

  let loc
  try {
    loc = persistence.locate(snapshot.header)
  } catch {
    loc = undefined
  }
  if (loc === undefined || loc === null || loc.kind !== 'jsonl' || typeof loc.path !== 'string') {
    return { deletable: false, reason: '无法解析会话文件路径', path: null, dir: null }
  }

  const base = String(loc.path).split(/[\\/]/).pop() ?? ''
  if (!SESSION_LOG_BASENAME.test(base)) {
    return { deletable: false, reason: '产物文件名异常，已拒绝删除', path: null, dir: null }
  }

  return { deletable: true, reason: null, path: String(loc.path), dir: parentDir(String(loc.path)) }
}

function createService(ctx) {
  const service = {
    /** Every session, newest first inside each archive group. */
    async list() {
      const query = ctx.get('sessionQuery')
      const registry = ctx.get('workspaceRegistry')
      const sessions = ctx.get('sessions')
      const archivedIds = archivedIdsOf(registry)
      const archivedSet = new Set(archivedIds)

      if (query === undefined) return { sessions: [] }

      const records = await query.listSessions()

      const liveSet = new Set()
      const liveById = new Map()
      if (sessions !== undefined) {
        for (const s of sessions.list()) {
          liveSet.add(String(s.id))
          liveById.set(String(s.id), s)
        }
      }

      const out = records.map((r) => {
        const id = String(r.header.id)
        const cwd = r.header.cwd
        return {
          id,
          title: resolveTitle(ctx, r.header, liveById.get(id)),
          cwd: typeof cwd === 'string' && cwd.length > 0 ? cwd : null,
          createdAt: Number(r.header.createdAt) || 0,
          live: liveSet.has(id) || r.live === true,
          archived: archivedSet.has(id),
        }
      })
      out.sort((a, b) => (a.archived === b.archived ? b.createdAt - a.createdAt : a.archived ? -1 : 1))
      return { sessions: out }
    },

    /** Archive (hide) one session durably. */
    async archive(request) {
      const registry = ctx.get('workspaceRegistry')
      if (registry === undefined) throw new Error('workspace registry unavailable')
      await registry.archiveSession(String(request.sessionId))
      return { archivedSessionIds: archivedIdsOf(registry) }
    },

    /**
     * Unarchive (restore) one session by removing it from the registry-global
     * archive set. Goes through the registry's own state setter so its
     * in-memory cache stays consistent with the durable domain.
     */
    async unarchive(request) {
      const registry = ctx.get('workspaceRegistry')
      const storageDomain = ctx.get('storageDomain')
      if (registry === undefined || storageDomain === undefined) {
        throw new Error('workspace registry unavailable')
      }
      const domain = storageDomain.get('workspace')
      if (domain === undefined) throw new Error('workspace domain unavailable')

      const state = domain.global.get()
      const archived = state.archivedSessionIds ?? []
      const next = archived.filter((id) => String(id) !== String(request.sessionId))
      if (next.length === archived.length) {
        return { archivedSessionIds: archived.map((id) => String(id)) }
      }
      const nextState = { ...state, archivedSessionIds: next }
      if (typeof registry.setState === 'function') {
        await registry.setState(nextState)
      } else {
        await domain.global.set(nextState)
        registry.state = nextState
      }
      return { archivedSessionIds: next.map((id) => String(id)) }
    },

    /** Whether one session's log file can be deleted, and where it is. */
    async inspectDelete(request) {
      return await inspectDeletable(ctx, String(request.sessionId))
    },

    /**
     * Permanently delete one non-live session's persistence log file, then
     * detach it from workspace accounting and from the archive set.
     */
    async deleteSession(request) {
      const sessionId = String(request.sessionId)
      const info = await inspectDeletable(ctx, sessionId)
      if (!info.deletable) throw new Error(info.reason ?? 'session is not deletable')

      const shell = ctx.get('shell')
      if (shell === undefined) throw new Error('shell service unavailable')

      // Remove the transcript, then the session-owned directory that held it.
      // The directory removal is deliberately NON-recursive: it succeeds only
      // when the directory is empty, so a session-owned artifact a future
      // version starts writing there is left in place instead of swept away.
      const quoted = info.path.replace(/'/g, "''")
      const quotedDir = String(info.dir).replace(/'/g, "''")
      const command = [
        `Remove-Item -LiteralPath '${quoted}' -Force -ErrorAction Stop`,
        `if (Test-Path -LiteralPath '${quotedDir}') { Remove-Item -LiteralPath '${quotedDir}' -Force -ErrorAction SilentlyContinue }`,
      ].join('\n')
      const spec = shell.resolve({ command })
      let result = await shell.run(spec)

      // The artifact and its directory live in the session store, which is
      // outside the session workspace, so the executor's default file policy can
      // fence this command out — the default is derived from the deployment, not
      // from the folder being deleted. When it denies the write, retry once under
      // the narrowest scope that can hold the artifact: its own project
      // directory. The command is fixed and its single path came from the
      // persistence backend's own `locate()` and was validated, never from the
      // caller, so this re-scopes the sandbox to exactly the directory this
      // plugin manages instead of widening it.
      let denial = result.sandbox?.denied === true ? result : null
      if (denial !== null) {
        try {
          const scoped = shell.resolve({
            command,
            sandboxPolicy: { mode: 'workspace-write', workspaceRoot: parentDir(String(info.dir)) },
          })
          const retry = await shell.run(scoped)
          if (retry.sandbox?.denied !== true) {
            result = retry
            denial = null
          }
        } catch {
          // Keep the original denial: it is the honest report.
        }
      }

      if (denial !== null) {
        throw new Error('沙箱拒绝了删除（会话文件位于工作区之外）')
      }
      if (result.exitCode !== 0) {
        throw new Error(`删除命令失败（exit ${result.exitCode}）`)
      }

      // The file is gone; accounting cleanup is best-effort.
      try {
        await service.unarchive({ sessionId })
      } catch {
        // The session no longer exists in the archive set anyway.
      }
      const registry = ctx.get('workspaceRegistry')
      if (registry !== undefined) {
        try {
          for (const workspace of registry.list()) {
            await workspace.detachSession(sessionId)
          }
        } catch {
          // Accounting is cosmetic once the log is gone.
        }
      }

      return { path: info.path }
    },
  }

  // Hand-written Typert Gateway binding: the same visible, frozen shape
  // `bindTypertRemote()` produces, without importing the runtime package.
  Object.defineProperty(service, 'typertRemote', {
    configurable: false,
    enumerable: false,
    writable: false,
    value: { service, serviceKey: 'delChat', namespace: 'delChat' },
  })

  return service
}

export function apply(ctx) {
  ctx.provide('delChat', createService(ctx))
}
