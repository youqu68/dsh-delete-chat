/**
 * Structural + functional validation of the built host half.
 *
 * Imports the real `lib/index.js` and `lib/typert.host.js`, runs `apply()`
 * against a mock Cordis context, and asserts:
 *   - the service surface and the `typertRemote` gateway binding;
 *   - the Typert invocation shape, including the DUAL codec spelling that both
 *     the 0.1.x (`codec.schema.parse`) and 0.2.x (`codec.create().parse`)
 *     gateways/loaders require;
 *   - the deletion contract against real files in a temp directory;
 *   - the 0.2.x archive activity refusal surfaced as data;
 *   - the unarchive path on both harness lines.
 */
import { promises as fsp } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const at = (name) => pathToFileURL(join(root, 'lib', name)).href

const problems = []
const ok = (cond, msg) => {
  if (!cond) problems.push(msg)
}

const METHODS = ['list', 'archive', 'unarchive', 'inspectDelete', 'deleteSession']

// ── host plugin ──────────────────────────────────────────────────────────────
const host = await import(at('index.js'))
ok(typeof host.apply === 'function', 'host: apply is not a function')
ok(host.name === 'del-chat', `host: unexpected name ${JSON.stringify(host.name)}`)

const provided = new Map()
host.apply({
  get: () => undefined,
  provide: (key, value) => {
    provided.set(key, value)
    return () => {}
  },
  effect: () => () => {},
  on: () => () => {},
})

ok(provided.has('delChat'), 'host: apply did not provide the delChat service')
const service = provided.get('delChat')
for (const m of METHODS) ok(typeof service[m] === 'function', `service: missing method ${m}`)

const binding = service.typertRemote
ok(binding !== undefined, 'service: missing typertRemote binding')
ok(binding?.serviceKey === 'delChat', `binding: serviceKey=${binding?.serviceKey}`)
ok(binding?.namespace === 'delChat', `binding: namespace=${binding?.namespace}`)
ok(binding?.service === service, 'binding: service is not the same object')
ok(
  Object.getOwnPropertyDescriptor(service, 'typertRemote')?.enumerable === false,
  'binding: typertRemote should be non-enumerable',
)

// ── Typert manifest ──────────────────────────────────────────────────────────
const { TYPERT } = await import(at('typert.host.js'))
ok(TYPERT !== undefined, 'typert: no TYPERT export')
ok(TYPERT?.package === 'dsh-delete-chat', `typert: package=${TYPERT?.package}`)
ok(TYPERT?.face === 'host', `typert: face=${TYPERT?.face}`)
ok(Array.isArray(TYPERT?.invocations), 'typert: invocations is not an array')

const ids = (TYPERT?.invocations ?? []).map((i) => i.id)
for (const m of METHODS) ok(ids.includes(`dsh-delete-chat#delChat/${m}`), `typert: missing invocation for ${m}`)

/**
 * A codec must satisfy BOTH harness lines: 0.2.x validates a `create()` factory
 * and decodes with `create().parse()`, while 0.1.x validates `schema._zod` and
 * decodes with `schema.parse()`. A codec carrying only one spelling was the
 * break that made the plugin unloadable on 0.2.x.
 */
function assertDualCodec(codecValue, subject) {
  ok(codecValue?.mode === 'strict', `${subject}: codec mode is not strict`)
  ok(typeof codecValue?.typeSymbol === 'string' && codecValue.typeSymbol.length > 0, `${subject}: missing typeSymbol`)
  ok(typeof codecValue?.create === 'function', `${subject}: strict codec has no create() factory (0.2.x loader rejects)`)
  ok(typeof codecValue?.schema?.parse === 'function', `${subject}: strict codec has no schema.parse() (0.1.x loader rejects)`)
  if (typeof codecValue?.create === 'function') {
    const built = codecValue.create()
    ok(typeof built?.parse === 'function', `${subject}: create() did not return a schema with parse()`)
    ok(built === codecValue.schema, `${subject}: create() and schema must be the same zod schema`)
  }
}

for (const inv of TYPERT?.invocations ?? []) {
  ok(inv.service === 'delChat', `typert ${inv.id}: service=${inv.service}`)
  ok(inv.namespace === 'delChat', `typert ${inv.id}: namespace=${inv.namespace}`)
  ok(inv.invocation?.kind === 'direct', `typert ${inv.id}: invocation kind`)
  assertDualCodec(inv.result, `typert ${inv.id}: result`)
  for (const p of inv.parameters ?? []) {
    ok(p.source === 'json', `typert ${inv.id}: parameter ${p.name} source must be json`)
    ok(typeof p.wire === 'string' && p.wire.length > 0, `typert ${inv.id}: parameter ${p.name} has no wire`)
    assertDualCodec(p.codec, `typert ${inv.id}: parameter ${p.name}`)
  }
}

// The archive request must accept the 0.2.x `stopActivity` opt-in; an unknown
// key would be stripped by the host codec and the second call would loop.
const archiveInv = (TYPERT?.invocations ?? []).find((inv) => inv.method === 'archive')
const archiveSchema = archiveInv?.parameters?.[0]?.codec?.create?.()
ok(archiveSchema?.safeParse?.({ sessionId: 's1', stopActivity: true })?.success === true,
  'typert archive: request codec must accept { sessionId, stopActivity }')
const archiveResultSchema = archiveInv?.result?.create?.()
ok(archiveResultSchema?.safeParse?.({ archivedSessionIds: [], needsStop: true, activity: [{ kind: 'turn', items: [] }] })?.success === true,
  'typert archive: result codec must accept needsStop + activity')

// ── inspectDelete / deleteSession against real files ─────────────────────────
const HEADER = { id: 'session-contract-0001', createdAt: 1726000000000, cwd: 'D:\\proj' }

/** Build a real session directory and a persistence mock that points at it. */
async function makeSession(t, { locatedName = 'session.v4.jsonl.zstd', files = undefined } = {}) {
  const dir = join(t.root, HEADER.id)
  await fsp.mkdir(dir, { recursive: true })
  for (const name of files ?? [locatedName]) {
    await fsp.writeFile(join(dir, name), '{}', 'utf8')
  }
  const persistence = {
    hasPendingSession: () => false,
    async list() {
      return [{ header: HEADER, revision: 0, sizeBytes: 4096 }]
    },
    locate: () => ({ kind: 'jsonl', path: join(dir, locatedName) }),
  }
  return { dir, persistence }
}

const mkService = (ctxParts) => {
  const bag = new Map()
  host.apply({
    get: (name) => ctxParts[name],
    provide: (key, value) => {
      bag.set(key, value)
      return () => {}
    },
    effect: () => () => {},
    on: () => () => {},
  })
  return bag.get('delChat')
}

const workspace = await fsp.mkdtemp(join(tmpdir(), 'dsh-delete-chat-host-'))
try {
  // A canonical current-format artifact is deletable.
  {
    const t = { root: join(workspace, 'stored') }
    const { persistence } = await makeSession(t)
    const info = await mkService({ sessionPersistence: persistence, sessions: { get: () => undefined } }).inspectDelete({ sessionId: HEADER.id })
    ok(info.deletable === true, `inspectDelete: a stored session must be deletable (reason=${JSON.stringify(info.reason)})`)
    ok(info.path === join(t.root, HEADER.id, 'session.v4.jsonl.zstd'), `inspectDelete: path=${JSON.stringify(info.path)}`)
    ok(info.dir === join(t.root, HEADER.id), `inspectDelete: dir=${JSON.stringify(info.dir)}`)
    ok(Array.isArray(info.files) && info.files.length === 1, `inspectDelete: files=${JSON.stringify(info.files)}`)
  }

  // Every canonical generation name the backend can write must be accepted.
  for (const name of [
    'session.jsonl',
    'session.jsonl.zstd',
    'session.v3.jsonl',
    'session.v3.jsonl.zstd',
    'session.v4.jsonl.zstd',
    'session.v12.jsonl.zstd',
  ]) {
    const t = { root: join(workspace, 'names-' + name.replaceAll('.', '_')) }
    const { persistence } = await makeSession(t, { locatedName: name })
    const info = await mkService({ sessionPersistence: persistence }).inspectDelete({ sessionId: HEADER.id })
    ok(info.deletable === true, `inspectDelete: canonical artifact "${name}" must be deletable (reason=${JSON.stringify(info.reason)})`)
  }

  // Non-canonical names stay refused.
  for (const name of ['session.log', 'session.v0.jsonl', 'session.v3.jsonl.bak', 'session.migration.abc.jsonl.zstd.tmp', 'elsewhere.jsonl']) {
    const t = { root: join(workspace, 'bad-' + name.replaceAll('.', '_')) }
    const { persistence } = await makeSession(t, { locatedName: name })
    const info = await mkService({ sessionPersistence: persistence }).inspectDelete({ sessionId: HEADER.id })
    ok(info.deletable === false, `inspectDelete: non-canonical artifact "${name}" must be refused`)
  }

  // Only an older generation on disk (0.2.x reports the current-generation path):
  // the newest backend spelling must still find and remove the older generation.
  {
    const t = { root: join(workspace, 'older-generation') }
    const { persistence } = await makeSession(t, { locatedName: 'session.v4.jsonl.zstd', files: ['session.v3.jsonl.zstd'] })
    const svc = mkService({ sessionPersistence: persistence })
    const info = await svc.inspectDelete({ sessionId: HEADER.id })
    ok(info.deletable === true, 'inspectDelete: a session with only an older generation on disk must be deletable')
    ok(info.files.includes('session.v3.jsonl.zstd'), `inspectDelete: older generation must be in files (${JSON.stringify(info.files)})`)
    const result = await svc.deleteSession({ sessionId: HEADER.id })
    ok(result.removed === 1, `deleteSession: removed=${result.removed}`)
    ok(result.dirRemoved === true, 'deleteSession: the emptied session directory must be removed')
    const left = await fsp.readdir(dirname(join(t.root, HEADER.id)))
    ok(!left.includes(HEADER.id), 'deleteSession: the session directory must be gone')
  }

  // A real delete removes the artifact and the now-empty directory.
  {
    const t = { root: join(workspace, 'delete-one') }
    const { persistence } = await makeSession(t)
    const detached = []
    const registry = {
      archivedSessionIds: [HEADER.id],
      list: () => [{ detachSession: async (id) => detached.push(id) }],
      unarchiveSession: async (id) => {
        registry.archivedSessionIds = registry.archivedSessionIds.filter((x) => x !== id)
      },
    }
    const svc = mkService({ sessionPersistence: persistence, sessions: { get: () => undefined }, workspaceRegistry: registry })
    const result = await svc.deleteSession({ sessionId: HEADER.id })
    ok(result.path === join(t.root, HEADER.id, 'session.v4.jsonl.zstd'), `deleteSession: reported path=${JSON.stringify(result.path)}`)
    ok(result.removed === 1, `deleteSession: removed=${result.removed}`)
    ok(result.dirRemoved === true, 'deleteSession: dirRemoved must be true')
    ok(registry.archivedSessionIds.length === 0, 'deleteSession: the id must be removed from the archive set')
    ok(detached.includes(HEADER.id), 'deleteSession: the id must be detached from workspace accounting')
    const exists = await fsp.stat(join(t.root, HEADER.id)).then(() => true, () => false)
    ok(exists === false, 'deleteSession: the session directory must be gone')
  }

  // Non-canonical leftovers keep the directory (non-recursive by design).
  {
    const t = { root: join(workspace, 'leftover') }
    const { persistence } = await makeSession(t, { files: ['session.v4.jsonl.zstd', 'notes.txt'] })
    const result = await mkService({ sessionPersistence: persistence }).deleteSession({ sessionId: HEADER.id })
    ok(result.dirRemoved === false, 'deleteSession: a non-empty directory must be kept')
    const left = await fsp.readdir(join(t.root, HEADER.id))
    ok(left.length === 1 && left[0] === 'notes.txt', `deleteSession: unknown files must survive (${JSON.stringify(left)})`)
  }

  // Coexisting generations: EVERY generation is removed, so the backend can
  // never resurrect the session from a surviving older log on the next read.
  {
    const t = { root: join(workspace, 'two-generations') }
    const { persistence } = await makeSession(t, {
      locatedName: 'session.v4.jsonl.zstd',
      files: ['session.v3.jsonl.zstd', 'session.v4.jsonl.zstd'],
    })
    const svc = mkService({ sessionPersistence: persistence })
    const info = await svc.inspectDelete({ sessionId: HEADER.id })
    ok(info.deletable === true && info.files.length === 2, `inspectDelete: both generations must be listed (${JSON.stringify(info.files)})`)
    const result = await svc.deleteSession({ sessionId: HEADER.id })
    ok(result.removed === 2, `deleteSession: both generations must be removed (removed=${result.removed})`)
    ok(result.dirRemoved === true, 'deleteSession: the directory must be removed once every generation is gone')
  }

  // The reported path is the NEWEST generation on disk when locate() names a
  // file that does not exist (v10 must outrank v3, not sort lexicographically).
  {
    const t = { root: join(workspace, 'generation-order') }
    const { persistence } = await makeSession(t, {
      locatedName: 'session.v12.jsonl.zstd',
      files: ['session.v3.jsonl', 'session.v10.jsonl'],
    })
    const info = await mkService({ sessionPersistence: persistence }).inspectDelete({ sessionId: HEADER.id })
    ok(info.deletable === true, 'inspectDelete: generation-order case must be deletable')
    ok(info.files[0] === 'session.v10.jsonl', `inspectDelete: files must be ordered newest generation first (${JSON.stringify(info.files)})`)
    ok(
      String(info.path).endsWith('session.v10.jsonl'),
      `inspectDelete: the reported path must be the newest existing generation (${JSON.stringify(info.path)})`,
    )
  }

  // A backend exposing only stat() (the preferred, per-id read) is enough.
  {
    const t = { root: join(workspace, 'stat-only') }
    const dir = join(t.root, HEADER.id)
    await fsp.mkdir(dir, { recursive: true })
    await fsp.writeFile(join(dir, 'session.v4.jsonl.zstd'), '{}', 'utf8')
    let statCalls = 0
    const persistence = {
      async stat(id) {
        statCalls += 1
        return id === HEADER.id ? { header: HEADER, revision: 0 } : undefined
      },
      hasPendingSession: () => false,
      locate: () => ({ kind: 'jsonl', path: join(dir, 'session.v4.jsonl.zstd') }),
    }
    const svc = mkService({ sessionPersistence: persistence })
    const info = await svc.inspectDelete({ sessionId: HEADER.id })
    ok(info.deletable === true, 'inspectDelete: a stat()-only backend must resolve the session')
    ok(statCalls === 1, `inspectDelete: stat() must be preferred over list() (calls=${statCalls})`)
    const result = await svc.deleteSession({ sessionId: HEADER.id })
    ok(result.removed === 1 && result.dirRemoved === true, 'deleteSession: stat()-only backend must delete the artifact')

    // A stat() failure is a storage error, not an absent session.
    const broken = await mkService({
      sessionPersistence: {
        async stat() {
          throw new Error('duplicate JSONL session id')
        },
        locate: () => ({ kind: 'jsonl', path: join(dir, 'session.v4.jsonl.zstd') }),
      },
    }).inspectDelete({ sessionId: HEADER.id })
    ok(
      broken.deletable === false && /duplicate JSONL session id/.test(String(broken.reason)),
      `inspectDelete: a stat() failure must surface as a storage error (reason=${JSON.stringify(broken.reason)})`,
    )
  }

  // An id containing characters the backend escapes in the directory name is
  // still recognized as this session's own directory.
  {
    const exoticId = 'session-exotic/id'
    const t = { root: join(workspace, 'encoded-id') }
    const encoded = 'session-exotic~002Fid'
    const dir = join(t.root, encoded)
    await fsp.mkdir(dir, { recursive: true })
    await fsp.writeFile(join(dir, 'session.v4.jsonl.zstd'), '{}', 'utf8')
    const info = await mkService({
      sessionPersistence: {
        async stat() {
          return { header: { id: exoticId, createdAt: 1, cwd: '/proj' }, revision: 0 }
        },
        hasPendingSession: () => false,
        locate: () => ({ kind: 'jsonl', path: join(dir, 'session.v4.jsonl.zstd') }),
      },
    }).inspectDelete({ sessionId: exoticId })
    ok(info.deletable === true, `inspectDelete: an escaped directory id must be accepted (reason=${JSON.stringify(info.reason)})`)
  }

  // Refusal paths.
  {
    const t = { root: join(workspace, 'bare') }
    const dir = join(t.root, HEADER.id)
    await fsp.mkdir(dir, { recursive: true })
    await fsp.writeFile(join(dir, 'session.v4.jsonl.zstd'), '{}', 'utf8')
    const bareHeaders = await mkService({
      sessionPersistence: {
        hasPendingSession: () => false,
        async list() {
          return [HEADER]
        },
        locate: () => ({ kind: 'jsonl', path: join(dir, 'session.v4.jsonl.zstd') }),
      },
    }).inspectDelete({ sessionId: HEADER.id })
    ok(bareHeaders.deletable === false, 'inspectDelete: a backend returning bare headers must be refused, not mis-read')

    const liveSession = await mkService({
      sessionPersistence: { hasPendingSession: () => false, async list() { return [{ header: HEADER, revision: 0 }] }, locate: () => ({ kind: 'jsonl', path: join(dir, 'session.v4.jsonl.zstd') }) },
      sessions: { get: (id) => (id === HEADER.id ? { id } : undefined) },
    }).inspectDelete({ sessionId: HEADER.id })
    ok(liveSession.deletable === false, 'inspectDelete: a live session must be refused')

    const unmaterialized = await mkService({
      sessionPersistence: {
        hasPendingSession: () => true,
        async list() {
          return [{ header: HEADER, revision: 0 }]
        },
        locate: () => ({ kind: 'jsonl', path: join(dir, 'session.v4.jsonl.zstd') }),
      },
    }).inspectDelete({ sessionId: HEADER.id })
    ok(unmaterialized.deletable === false, 'inspectDelete: an unmaterialized session owns no artifact')

    const listFailure = await mkService({
      sessionPersistence: {
        hasPendingSession: () => false,
        async list() {
          throw new Error('listing-boom')
        },
        locate: () => ({ kind: 'jsonl', path: join(dir, 'session.v4.jsonl.zstd') }),
      },
    }).inspectDelete({ sessionId: HEADER.id })
    ok(
      listFailure.deletable === false && /listing-boom/.test(String(listFailure.reason)),
      `inspectDelete: a listing failure must surface as a storage error (reason=${JSON.stringify(listFailure.reason)})`,
    )

    // A directory that is not named after the session id is refused: a buggy
    // backend must not be able to aim the delete at someone else's directory.
    const foreign = await mkService({
      sessionPersistence: {
        hasPendingSession: () => false,
        async list() {
          return [{ header: HEADER, revision: 0 }]
        },
        locate: () => ({ kind: 'jsonl', path: join(t.root, 'not-the-session-id', 'session.v4.jsonl.zstd') }),
      },
    }).inspectDelete({ sessionId: HEADER.id })
    ok(foreign.deletable === false, 'inspectDelete: a directory not named after the session id must be refused')
  }
} finally {
  await fsp.rm(workspace, { recursive: true, force: true })
}

// ── archive / unarchive ──────────────────────────────────────────────────────
{
  const calls = []
  const registry = {
    archivedSessionIds: [],
    archiveSession: async (id, options) => {
      calls.push({ id, options })
      registry.archivedSessionIds = [...registry.archivedSessionIds.filter((x) => x !== id), id]
    },
    unarchiveSession: async (id) => {
      registry.archivedSessionIds = registry.archivedSessionIds.filter((x) => x !== id)
    },
  }
  const svc = mkService({ workspaceRegistry: registry })
  const result = await svc.archive({ sessionId: 's1' })
  ok(result.needsStop === false && result.archivedSessionIds.includes('s1'), 'archive: a free session must archive')
  ok(calls[0].options === undefined, 'archive: no options must be passed for the ordinary path')

  await svc.archive({ sessionId: 's2', stopActivity: true })
  ok(calls[1].options?.stopActivity === true, 'archive: stopActivity must be forwarded to the registry')
  const restored = await svc.unarchive({ sessionId: 's1' })
  ok(
    restored.archivedSessionIds.length === 1 && restored.archivedSessionIds[0] === 's2',
    `unarchive: 0.2.x registry.unarchiveSession must be used (${JSON.stringify(restored.archivedSessionIds)})`,
  )
}
{
  // 0.2.x refusal: the registry throws WorkspaceActiveSessionError with activity.
  const refusing = {
    archivedSessionIds: [],
    async archiveSession() {
      const error = new Error('session is active')
      error.sessionId = 's1'
      error.activity = [
        { kind: 'turn' },
        { kind: 'job', items: [{ id: 'job-1', label: 'build' }] },
      ]
      throw error
    },
  }
  const svc = mkService({ workspaceRegistry: refusing })
  const result = await svc.archive({ sessionId: 's1' })
  ok(result.needsStop === true, 'archive: an active-session refusal must return needsStop=true instead of throwing')
  ok(result.activity.length === 2, `archive: activity must be reported (${JSON.stringify(result.activity)})`)
  ok(result.activity[1].items[0].label === 'build', 'archive: activity items must keep their labels')
}
{
  // 0.1.x line: no unarchiveSession — the durable workspace domain is written
  // through the registry's own setter.
  let stored = { archivedSessionIds: ['s1', 's2'] }
  const domain = { global: { get: () => stored, set: async (next) => { stored = next } } }
  const registry = { archivedSessionIds: ['s1', 's2'] }
  const svc = mkService({
    workspaceRegistry: registry,
    storageDomain: { get: (name) => (name === 'workspace' ? domain : undefined) },
  })
  registry.setState = async (next) => {
    stored = next
    registry.archivedSessionIds = next.archivedSessionIds
  }
  const result = await svc.unarchive({ sessionId: 's1' })
  ok(result.archivedSessionIds.length === 1 && result.archivedSessionIds[0] === 's2', `unarchive fallback: ${JSON.stringify(result.archivedSessionIds)}`)
  ok(stored.archivedSessionIds.length === 1, 'unarchive fallback: the workspace domain state must drop the id')
}

// ── title resolution without folding logs ────────────────────────────────────
{
  const HEADER2 = { id: 's-title', createdAt: 1726000000000, cwd: '/proj' }
  const rows = new Map([
    ['s-title', { identity: { createdAt: HEADER2.createdAt, cwd: HEADER2.cwd }, rows: { title: { ver: 1, seq: 0, val: '缓存标题' } } }],
  ])
  const ctxParts = {
    sessionQuery: {
      async listSessions() {
        return [{ header: HEADER2, live: false, persisted: true }]
      },
    },
    storageDomain: {
      get: () => ({ table: () => ({ get: (id) => rows.get(id) }) }),
    },
    sessionProjectionCache: {
      // 0.2.x arity: (meta, keys)
      cachedSnapshot(meta, keys) {
        ok(Array.isArray(keys), 'title: 0.2.x cachedSnapshot must receive the keys array as its second argument')
        return { values: { title: '服务标题' } }
      },
      cachedPredecessorTitle() {
        return undefined
      },
    },
  }
  const svc = mkService(ctxParts)
  const listed = await svc.list()
  ok(listed.sessions.length === 1, 'list: one row')
  ok(listed.sessions[0].title === '缓存标题', `list: the cache row must win over the service read (got ${JSON.stringify(listed.sessions[0].title)})`)
  ok(listed.sessions[0].formatStatus === 'current', `list: formatStatus default (got ${JSON.stringify(listed.sessions[0].formatStatus)})`)

  // With no row, the 0.2.x two-argument cache read must supply the title.
  rows.clear()
  const listed2 = await svc.list()
  ok(listed2.sessions[0].title === '服务标题', `list: 0.2.x cachedSnapshot fallback must supply a title (got ${JSON.stringify(listed2.sessions[0].title)})`)
}
{
  // 0.1.x arity: (meta, inheritedEventCount, keys).
  const HEADER3 = { id: 's-title-015', createdAt: 1726000000000, cwd: '/proj', isSeeded: false }
  const ctxParts = {
    sessionQuery: {
      async listSessions() {
        return [{ header: HEADER3, live: false, persisted: true }]
      },
    },
    sessionProjectionCache: {
      cachedSnapshot(meta, inherited, keys) {
        ok(inherited === 0, `title: 0.1.x cachedSnapshot must receive inheritedEventCount (got ${JSON.stringify(inherited)})`)
        ok(Array.isArray(keys), 'title: 0.1.x cachedSnapshot must receive the keys array third')
        return { values: { title: '旧版标题' } }
      },
      cachedPredecessorTitle() {
        return undefined
      },
    },
  }
  const svc = mkService(ctxParts)
  const listed = await svc.list()
  ok(listed.sessions[0].title === '旧版标题', `list: 0.1.x cachedSnapshot fallback must supply a title (got ${JSON.stringify(listed.sessions[0].title)})`)
}

// ── report ───────────────────────────────────────────────────────────────────
console.log('host exports      :', Object.keys(host).join(', '))
console.log('provided services :', [...provided.keys()].join(', '))
console.log(
  'service methods   :',
  METHODS.filter((m) => typeof service[m] === 'function').length,
  '/',
  METHODS.length,
)
console.log('typert invocations:', ids.length)
for (const id of ids) console.log('  -', id)
console.log('codecs            : dual (schema.parse for 0.1.x, create().parse for 0.2.x)')
console.log('delete            : real files in a temp dir, canonical names only, non-recursive directory')
console.log('archive           : activity refusal surfaced as data, stopActivity forwarded')
console.log('titles            : cache row first, then both cachedSnapshot arities')

if (problems.length === 0) {
  console.log('\nhost: PASS')
} else {
  console.log('\nhost: FAIL')
  for (const p of problems) console.log('  x', p)
  process.exitCode = 1
}
