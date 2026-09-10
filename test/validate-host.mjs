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
ok(TYPERT?.package === 'dsh-del-chat', `typert: package=${TYPERT?.package}`)
ok(TYPERT?.face === 'host', `typert: face=${TYPERT?.face}`)
ok(Array.isArray(TYPERT?.invocations), 'typert: invocations is not an array')

const ids = (TYPERT?.invocations ?? []).map((i) => i.id)
for (const m of METHODS) ok(ids.includes(`dsh-del-chat#delChat/${m}`), `typert: missing invocation for ${m}`)

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

if (problems.length === 0) {
  console.log('\nhost: PASS')
} else {
  console.log('\nhost: FAIL')
  for (const p of problems) console.log('  x', p)
  process.exitCode = 1
}
