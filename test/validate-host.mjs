/**
 * Structural validation of the built host half.
 *
 * Imports the real `lib/index.js` and `lib/typert.host.js`, runs `apply()`
 * against a mock Cordis context, and asserts the service surface, the
 * `typertRemote` gateway binding, and the shape of every Typert invocation.
 */
import { pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

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

for (const inv of TYPERT?.invocations ?? []) {
  ok(inv.service === 'delChat', `typert ${inv.id}: service=${inv.service}`)
  ok(inv.namespace === 'delChat', `typert ${inv.id}: namespace=${inv.namespace}`)
  ok(inv.invocation?.kind === 'direct', `typert ${inv.id}: invocation kind`)
  ok(inv.result?.mode === 'strict', `typert ${inv.id}: result codec mode`)
  ok(typeof inv.result?.schema?.parse === 'function', `typert ${inv.id}: result schema has no parse()`)
  for (const p of inv.parameters ?? []) {
    ok(p.source === 'json', `typert ${inv.id}: parameter ${p.name} source must be json`)
    ok(p.codec?.mode === 'strict', `typert ${inv.id}: parameter ${p.name} codec mode`)
    ok(
      typeof p.codec?.schema?.parse === 'function',
      `typert ${inv.id}: parameter ${p.name} codec has no parse()`,
    )
  }
}

// ── inspectDelete contract ───────────────────────────────────────────────────
// `sessionPersistence.list()` resolves `SessionPersistenceSnapshot` objects —
// `{ header, revision, eventCount?, sizeBytes? }` — so the session identity is
// NESTED under `.header` and a match on a top-level `id` finds nothing and
// silently refuses every delete. These checks pin the real seam contract.
const HEADER = { id: 'session-contract-0001', createdAt: 1726000000000, cwd: 'D:\\proj' }
const ARTIFACT = `C:\\sess\\${HEADER.id}\\session.jsonl.zstd`
const realSnapshotBackend = {
  hasPendingSession: () => false,
  async list() {
    return [{ header: HEADER, revision: 0, sizeBytes: 4096 }]
  },
  locate: (meta) => ({ kind: 'jsonl', path: `C:\\sess\\${meta.id}\\session.jsonl.zstd` }),
}
const mkService = (persistence, sessions = { get: () => undefined }) => {
  const bag = new Map()
  host.apply({
    get: (name) => {
      if (name === 'sessionPersistence') return persistence
      if (name === 'sessions') return sessions
      return undefined
    },
    provide: (key, value) => {
      bag.set(key, value)
      return () => {}
    },
    effect: () => () => {},
    on: () => () => {},
  })
  return bag.get('delChat')
}

const stored = await mkService(realSnapshotBackend).inspectDelete({ sessionId: HEADER.id })
ok(stored.deletable === true, `inspectDelete: a stored session must be deletable (reason=${JSON.stringify(stored.reason)})`)
ok(stored.path === ARTIFACT, `inspectDelete: path=${JSON.stringify(stored.path)}`)
ok(stored.dir === `C:\\sess\\${HEADER.id}`, `inspectDelete: dir=${JSON.stringify(stored.dir)}`)

const bareHeaders = await mkService({
  hasPendingSession: () => false,
  async list() {
    return [HEADER]
  },
  locate: realSnapshotBackend.locate,
}).inspectDelete({ sessionId: HEADER.id })
ok(bareHeaders.deletable === false, 'inspectDelete: a backend returning bare headers must be refused, not mis-read')

const liveSession = await mkService(realSnapshotBackend, {
  get: (id) => (id === HEADER.id ? { id } : undefined),
}).inspectDelete({ sessionId: HEADER.id })
ok(liveSession.deletable === false, 'inspectDelete: a live session must be refused')

const unmaterialized = await mkService({
  hasPendingSession: () => true,
  async list() {
    return [{ header: HEADER, revision: 0 }]
  },
  locate: realSnapshotBackend.locate,
}).inspectDelete({ sessionId: HEADER.id })
ok(unmaterialized.deletable === false, 'inspectDelete: an unmaterialized session owns no artifact')

const listFailure = await mkService({
  hasPendingSession: () => false,
  async list() {
    throw new Error('listing-boom')
  },
  locate: realSnapshotBackend.locate,
}).inspectDelete({ sessionId: HEADER.id })
ok(
  listFailure.deletable === false && /listing-boom/.test(String(listFailure.reason)),
  `inspectDelete: a listing failure must surface as a storage error (reason=${JSON.stringify(listFailure.reason)})`,
)

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
console.log('inspectDelete     : snapshot.header lookup, live/unmaterialized/listing-failure refusals')

if (problems.length === 0) {
  console.log('\nhost: PASS')
} else {
  console.log('\nhost: FAIL')
  for (const p of problems) console.log('  x', p)
  process.exitCode = 1
}
