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
        // A session without a folded title renders untitled.
      }
    }
    return null
  }

  const cache = ctx.get('sessionProjectionCache')
  if (cache !== undefined) {
    try {
      return titleFromValue(cache.cachedSnapshot(header)?.values?.title)
    } catch {
      // An unreadable cache entry renders untitled.
    }
  }
  return null
}

/**
 * Resolve one session's persistence artifact and whether it may be deleted.
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

  let header
  try {
    const list = await persistence.list()
    header = list.find((h) => String(h.id) === sessionId)
  } catch {
    header = undefined
  }
  if (header === undefined) {
    return { deletable: false, reason: '会话不存在', path: null, dir: null }
  }

  if (persistence.supportsRawArtifacts !== true) {
    return { deletable: false, reason: '当前存储后端不暴露单会话文件，无法安全删除', path: null, dir: null }
  }

  const loc = persistence.locate(header)
  if (loc === undefined || loc.kind !== 'jsonl') {
    return { deletable: false, reason: '无法解析会话文件路径', path: null, dir: null }
  }

  const base = String(loc.path).split(/[\\/]/).pop() ?? ''
  if (!base.startsWith('session.jsonl')) {
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

      const quoted = info.path.replace(/'/g, "''")
      const spec = shell.resolve({ command: `Remove-Item -LiteralPath '${quoted}' -Force -ErrorAction Stop` })
      const result = await shell.run(spec)

      if (result.sandbox && result.sandbox.denied) {
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
