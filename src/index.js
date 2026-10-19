/**
 * dsh-delete-chat — host half.
 *
 * A session manager exposing five Remote methods to the browser half:
 *   list()                    → every session with title / cwd / liveness / archive flag
 *   archive({sessionId})      → hide a session (or report the work that blocks it)
 *   unarchive({sessionId})    → restore a hidden session
 *   inspectDelete({sessionId})→ whether (and where) a session's log file can be deleted
 *   deleteSession({sessionId})→ permanently remove a non-live session's artifact
 *
 * Delivery follows the third-party plugin pattern: this module imports no
 * `@deepseek-ai/*` runtime package and instead reads the host process's own
 * service instances through `ctx.get(...)`. The browser reaches these methods
 * through a hand-written `typertRemote` binding plus the `./typert` manifest
 * (registered by `dsh-typert-loader`), which is what makes `remote.delChat.*`
 * exist on the client.
 *
 * Compatibility: the same source runs against DeepSeek Harness 0.1.x and the
 * 0.2.x line. Where a seam changed, the call is feature-detected rather than
 * version-gated:
 *   - `sessionProjectionCache.cachedSnapshot` gained a `keys` argument and lost
 *     its `inheritedEventCount` argument in 0.2.x, so both arities are tried.
 *   - `workspaceRegistry.unarchiveSession()` exists in 0.2.x; 0.1.x only has the
 *     durable workspace domain, which the fallback still drives.
 *   - 0.2.x `archiveSession()` refuses a session with running work unless
 *     `stopActivity` is passed. The refusal is reported to the caller (which can
 *     offer "stop and archive") instead of surfacing as a raw rejection.
 *   - The artifact is removed with `node:fs` instead of an injected shell: the
 *     previous shell call inherited the deployment's file policy, so deletion
 *     could be fenced out on a deployment whose default write root did not cover
 *     the session store, and the hard-coded PowerShell command never worked on
 *     macOS or Linux. The path is still resolved by the persistence backend and
 *     validated here; only a file inside the session's own directory whose name
 *     matches the backend's canonical generation names can be removed.
 */
import { promises as fsp } from 'node:fs'
import { basename, dirname, join } from 'node:path'

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

/**
 * The canonical session-log basenames the JSONL backend writes, mirrored from
 * `sessionFormatLogFilename` + `compressionSuffix`: format generation 0 is
 * `session.jsonl`, every later generation carries a lowercase `vN` component
 * before the suffix (`session.v3.jsonl`, `session.v4.jsonl`), and `.zstd` is
 * appended when the configured encoding is Zstandard.
 *
 * The `vN` form is the common case — the shipped format generation advances
 * with every format migration (v3 on 0.1.x, v4 on 0.2.x) — so a prefix test
 * against `session.jsonl` accepts only the legacy generation and rejects every
 * current one, which is what produced "产物文件名异常，已拒绝删除".
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
 * The exact fork-inherited prefix length a 0.1.x projection cache binds a record
 * to; 0.2.x dropped it from the listing reads. Only the 0.1.x arity needs it.
 *
 * The header exposes only `isSeeded`, so an unseeded session passes 0, and a
 * seeded one is read from the cache's OWN stored identity row (a read-only peek)
 * so the lookup can still match.
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
 * fields that rows written by an older format never had. The row shape
 * (`{ identity, rows: { title: { ver, seq, val } } }`) is unchanged between
 * 0.1.x and 0.2.x.
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

/** Call one projection-cache read and unwrap its title, or null when it misses. */
function cachedTitle(read) {
  try {
    return titleFromValue(read()?.values?.title)
  } catch {
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
  // lifecycle facts match. The cache's own validated reads additionally compare
  // `formatVersion`, `isSeeded` and (0.1.x) the inherited prefix length; rows
  // written by an older format carry only `{createdAt, cwd}`, so those reads
  // reject every such row and the whole page rendered untitled. `createdAt` +
  // `cwd` are the facts that identity validation exists to pin (they already
  // distinguish one lifecycle from a reused id or a swapped persistence root),
  // and they match every real row on disk.
  const rowTitle = titleFromCacheRow(ctx, header)
  if (rowTitle !== null) return rowTitle

  const cache = ctx.get('sessionProjectionCache')
  if (cache === undefined) return null

  // `cachedSnapshot` reads `(meta, inheritedEventCount, keys)` on 0.1.x and
  // `(meta, keys)` on 0.2.x. Try the arity the running service reports first,
  // then the other spelling: the wrong call can only miss or throw, both caught.
  const inherited = inheritedCountFor(ctx, header)
  const threeArg = typeof cache.cachedSnapshot?.length === 'number' && cache.cachedSnapshot.length >= 3
  const snapshotAttempts = threeArg
    ? [() => cache.cachedSnapshot(header, inherited, ['title']), () => cache.cachedSnapshot(header, ['title'])]
    : [() => cache.cachedSnapshot(header, ['title']), () => cache.cachedSnapshot(header, inherited, ['title'])]
  for (const attempt of snapshotAttempts) {
    const title = cachedTitle(attempt)
    if (title !== null) return title
  }

  // Predecessor hint: `(meta, inheritedEventCount)` on 0.1.x, `(meta)` on 0.2.x.
  const predecessorAttempts = [
    () => cache.cachedPredecessorTitle(header),
    () => cache.cachedPredecessorTitle(header, inherited),
  ]
  for (const attempt of predecessorAttempts) {
    const title = cachedTitle(attempt)
    if (title !== null) return title
  }
  return null
}

/**
 * The activity that refused an archive, or null when the error is not an
 * active-session refusal. Duck-typed on the `activity` array rather than the
 * class identity so the check survives a provider that reports its own family:
 * 0.2.x `WorkspaceActiveSessionError` carries `{ sessionId, activity }`.
 */
function activityOf(error) {
  const raw = error !== null && typeof error === 'object' ? error.activity : undefined
  if (!Array.isArray(raw)) return null
  return raw.map((entry) => {
    const kind = typeof entry?.kind === 'string' ? entry.kind : String(entry?.kind ?? 'activity')
    const items = Array.isArray(entry?.items)
      ? entry.items.map((item) => {
          const id = String(item?.id ?? '')
          return typeof item?.label === 'string' && item.label.length > 0 ? { id, label: item.label } : { id }
        })
      : []
    return { kind, items }
  })
}

/**
 * List the canonical session-log artifacts inside one session directory.
 *
 * The directory is `<root>/<project>/<sessionId>/`; enumerating it (instead of
 * trusting the single path `locate()` computes) also covers a session that only
 * has an OLDER format generation on disk: `locate()` always spells the
 * current-generation filename, so a 0.1.x-era `session.v3.jsonl.zstd` would
 * otherwise be reported deletable and then fail with ENOENT on 0.2.x.
 *
 * Sorted by generation, newest first: `session.v10` outranks `session.v3`, which
 * a lexicographic sort gets wrong.
 * @returns the matching basenames, or an empty list when the directory is gone.
 */
async function listSessionArtifacts(dir) {
  let entries
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true })
  } catch (error) {
    if (error?.code === 'ENOENT') return []
    throw error
  }
  return entries
    .filter((entry) => entry.isFile() && SESSION_LOG_BASENAME.test(entry.name))
    .map((entry) => entry.name)
    .sort((left, right) => generationOf(right) - generationOf(left) || left.localeCompare(right))
}

/**
 * The format generation a canonical artifact name carries; generation 0 is the
 * bare `session.jsonl` spelling.
 */
function generationOf(name) {
  const match = /^session(?:\.v([1-9][0-9]*))?\.jsonl/.exec(name)
  if (match === null) return 0
  return match[1] === undefined ? 0 : Number(match[1])
}

/**
 * Undo the JSONL backend's directory-segment escaping (`~XXXX` UTF-16 code
 * units, see its `encodeSegment`). Harness-generated ids are already safe
 * (`session-<uuid>`), so this only matters for an exotic id.
 */
function decodeSegment(segment) {
  return segment.replace(/~([0-9A-Fa-f]{4})/g, (_match, hex) => String.fromCharCode(Number.parseInt(hex, 16)))
}

/**
 * Validate that `dir` really is this session's own artifact directory: the
 * backend's layout groups sessions as `<project>/<sessionId>/`, and the id must
 * be the final segment (possibly escaped). A backend bug that returned another
 * session's or an unrelated directory is refused here rather than deleted.
 * @returns true when the directory basename is the session id.
 */
function isOwnSessionDirectory(dir, sessionId) {
  const base = basename(dir)
  return base === sessionId || decodeSegment(base) === sessionId
}

/**
 * Resolve one session's persistence snapshot.
 *
 * `stat(id)` is preferred over `list().find()`: on 0.2.x a listing fingerprints
 * the whole historical corpus (expensive) and one duplicated id anywhere makes
 * the whole listing throw, which would mask this session's state. `stat` is
 * per-id, cheaper, and exists on both harness lines; `list` stays as the
 * fallback for a backend that only implements the public listing.
 * @returns `{ snapshot, error }` — `snapshot` is undefined when absent.
 */
async function resolveSnapshot(persistence, sessionId) {
  try {
    if (typeof persistence.stat === 'function') {
      const snapshot = await persistence.stat(sessionId)
      return { snapshot: snapshot === null ? undefined : snapshot, error: null }
    }
    const snapshots = await persistence.list()
    return {
      snapshot: snapshots.find((s) => s !== null && typeof s === 'object' && String(s.header?.id) === sessionId),
      error: null,
    }
  } catch (error) {
    return { snapshot: undefined, error }
  }
}

/**
 * Resolve one session's persistence artifact and whether it may be deleted.
 *
 * A snapshot is `{ header, revision, eventCount?, sizeBytes?, formatStatus? }`:
 * the session identity is NESTED under `.header`, and `formatStatus` says
 * whether the log on disk is the current generation.
 *
 * @returns `{ deletable, reason, path, dir, files }` — string/null fields stay
 *   JSON-safe, and `files` names everything a confirmed delete would remove.
 */
async function inspectDeletable(ctx, sessionId) {
  const sessions = ctx.get('sessions')
  if (sessions !== undefined && sessions.get(sessionId) !== undefined) {
    return { deletable: false, reason: '该会话正在运行，无法删除', path: null, dir: null, files: [] }
  }

  const persistence = ctx.get('sessionPersistence')
  if (persistence === undefined) {
    return { deletable: false, reason: '存储服务不可用', path: null, dir: null, files: [] }
  }

  const { snapshot, error: storageError } = await resolveSnapshot(persistence, sessionId)
  if (snapshot === undefined) {
    if (storageError !== null) {
      return {
        deletable: false,
        reason: `读取会话存储失败：${String((storageError && storageError.message) || storageError)}`,
        path: null,
        dir: null,
        files: [],
      }
    }
    return { deletable: false, reason: '会话不存在或没有可删除的日志文件', path: null, dir: null, files: [] }
  }

  if (snapshot.header === undefined || String(snapshot.header.id) !== sessionId) {
    return { deletable: false, reason: '存储返回了不属于该会话的记录，已拒绝删除', path: null, dir: null, files: [] }
  }

  // A created-but-unmaterialized session is visible to this process from
  // `create` until its first flush, but owns no artifact yet. The hook is a
  // JSONL-backend method, present in both lines but outside the public seam.
  if (typeof persistence.hasPendingSession === 'function' && persistence.hasPendingSession(sessionId) === true) {
    return { deletable: false, reason: '该会话尚未写入磁盘日志，没有可删除的文件', path: null, dir: null, files: [] }
  }

  // `locate` is the backend's refusal-diagnostics hook; the public persistence
  // seam exposes no path lookup. It is used as a DIRECTORY HINT only: it always
  // spells the current format generation, which need not be the artifact on
  // disk (a pre-upgrade session only has an older generation).
  if (typeof persistence.locate !== 'function') {
    return { deletable: false, reason: '当前存储后端不暴露单会话文件，无法安全删除', path: null, dir: null, files: [] }
  }

  let loc
  try {
    loc = persistence.locate(snapshot.header)
  } catch {
    loc = undefined
  }
  if (loc === undefined || loc === null || loc.kind !== 'jsonl' || typeof loc.path !== 'string') {
    return { deletable: false, reason: '无法解析会话文件路径', path: null, dir: null, files: [] }
  }

  const located = loc.path
  const base = basename(located)
  if (!SESSION_LOG_BASENAME.test(base)) {
    return { deletable: false, reason: '产物文件名异常，已拒绝删除', path: null, dir: null, files: [] }
  }
  const dir = dirname(located)
  if (!isOwnSessionDirectory(dir, sessionId)) {
    return { deletable: false, reason: '会话目录与会话 id 不一致，已拒绝删除', path: null, dir: null, files: [] }
  }

  let files
  try {
    files = await listSessionArtifacts(dir)
  } catch (error) {
    return {
      deletable: false,
      reason: `读取会话目录失败：${String((error && error.message) || error)}`,
      path: null,
      dir: null,
      files: [],
    }
  }
  if (files.length === 0) {
    return { deletable: false, reason: '没有可删除的日志文件（磁盘上已不存在）', path: null, dir: null, files: [] }
  }

  // Report the path the backend names when it is one of the artifacts; otherwise
  // the NEWEST generation on disk is the authoritative one (the backend reads the
  // highest surviving generation).
  const path = join(dir, files.includes(base) ? base : files[0])
  return { deletable: true, reason: null, path, dir, files }
}

/**
 * Remove one session id from the registry-global archive set.
 *
 * 0.2.x exposes the registry operation directly. 0.1.x does not, so the durable
 * workspace domain is written through the registry's own setter (when present)
 * to keep its in-memory cache consistent with the domain.
 */
async function removeFromArchiveSet(ctx, sessionId) {
  const registry = ctx.get('workspaceRegistry')
  if (registry === undefined) return
  if (typeof registry.unarchiveSession === 'function') {
    await registry.unarchiveSession(sessionId)
    return
  }
  const storageDomain = ctx.get('storageDomain')
  if (storageDomain === undefined) return
  const domain = storageDomain.get('workspace')
  if (domain === undefined) return
  const state = domain.global.get()
  const archived = state.archivedSessionIds ?? []
  const next = archived.filter((id) => String(id) !== String(sessionId))
  if (next.length === archived.length) return
  const nextState = { ...state, archivedSessionIds: next }
  if (typeof registry.setState === 'function') {
    await registry.setState(nextState)
  } else {
    await domain.global.set(nextState)
    registry.state = nextState
  }
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

      const liveById = new Map()
      if (sessions !== undefined) {
        for (const s of sessions.list()) liveById.set(String(s.id), s)
      }

      const out = records.map((r) => {
        const id = String(r.header.id)
        const cwd = r.header.cwd
        return {
          id,
          title: resolveTitle(ctx, r.header, liveById.get(id)),
          cwd: typeof cwd === 'string' && cwd.length > 0 ? cwd : null,
          createdAt: Number(r.header.createdAt) || 0,
          live: liveById.has(id) || r.live === true,
          archived: archivedSet.has(id),
          // 'migration-required' means only an older log generation is on disk;
          // deletion still works (it removes that generation) but the row says so.
          formatStatus: typeof r.formatStatus === 'string' ? r.formatStatus : 'current',
        }
      })
      out.sort((a, b) => (a.archived === b.archived ? b.createdAt - a.createdAt : a.archived ? -1 : 1))
      return { sessions: out }
    },

    /**
     * Archive (hide) one session durably.
     *
     * 0.2.x refuses to archive a session with running work unless the caller
     * opts into stopping it, so the refusal is returned as data
     * (`needsStop: true` + the activity families) and the caller decides; the
     * second call passes `stopActivity: true`. 0.1.x has no activity gate, so it
     * always succeeds there.
     */
    async archive(request) {
      const registry = ctx.get('workspaceRegistry')
      if (registry === undefined) throw new Error('workspace registry unavailable')
      const sessionId = String(request.sessionId)
      const stopActivity = request.stopActivity === true
      try {
        await registry.archiveSession(sessionId, stopActivity ? { stopActivity: true } : undefined)
        return { archivedSessionIds: archivedIdsOf(registry), needsStop: false, activity: [] }
      } catch (error) {
        const activity = activityOf(error)
        if (activity === null) throw error
        return { archivedSessionIds: archivedIdsOf(registry), needsStop: true, activity }
      }
    },

    /** Unarchive (restore) one session. */
    async unarchive(request) {
      const registry = ctx.get('workspaceRegistry')
      if (registry === undefined) throw new Error('workspace registry unavailable')
      await removeFromArchiveSet(ctx, String(request.sessionId))
      return { archivedSessionIds: archivedIdsOf(registry) }
    },

    /** Whether one session's log file can be deleted, and where it is. */
    async inspectDelete(request) {
      return await inspectDeletable(ctx, String(request.sessionId))
    },

    /**
     * Permanently delete one non-live session's persistence log file, then
     * detach it from workspace accounting and from the archive set.
     *
     * The artifact is unlinked directly: a plugin is trusted host code, and the
     * previous shell call inherited the deployment's file policy, which fences
     * out the session store on deployments whose default write root is
     * elsewhere. Only canonical generation files inside the session's own
     * directory are removed; the directory itself is removed only when empty.
     */
    async deleteSession(request) {
      const sessionId = String(request.sessionId)
      const info = await inspectDeletable(ctx, sessionId)
      if (!info.deletable) throw new Error(info.reason ?? 'session is not deletable')

      let removed = 0
      for (const file of info.files) {
        try {
          await fsp.unlink(join(info.dir, file))
          removed += 1
        } catch (error) {
          if (error?.code === 'ENOENT') continue
          throw new Error(`删除会话文件失败（${file}）：${String((error && error.message) || error)}`)
        }
      }
      if (removed === 0) throw new Error('没有可删除的日志文件（磁盘上已不存在）')

      // POSIX deployments leave a session-owned `session.lock` lease file in the
      // directory (Windows uses a named semaphore and writes nothing). It is
      // debris once every log generation is gone, and leaving it would keep the
      // directory from being removed, so it is dropped only when it is the sole
      // remaining entry.
      try {
        const remaining = await fsp.readdir(info.dir)
        if (remaining.length === 1 && remaining[0] === 'session.lock') {
          await fsp.unlink(join(info.dir, 'session.lock'))
        }
      } catch (error) {
        if (error?.code !== 'ENOENT') {
          // Cosmetic: the transcript is already gone.
        }
      }

      // Deliberately non-recursive: it succeeds only when the directory is
      // empty, so a session-owned artifact a future version starts writing
      // there survives instead of being swept away.
      let dirRemoved = false
      try {
        await fsp.rmdir(info.dir)
        dirRemoved = true
      } catch (error) {
        if (error?.code === 'ENOENT') dirRemoved = true
        else if (error?.code !== 'ENOTEMPTY' && error?.code !== 'EEXIST') {
          // Cosmetic: the transcript is already gone.
        }
      }

      // The file is gone; accounting cleanup is best-effort.
      try {
        await removeFromArchiveSet(ctx, sessionId)
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

      return { path: info.path, removed, dirRemoved }
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
