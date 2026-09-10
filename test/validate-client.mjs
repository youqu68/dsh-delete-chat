/**
 * Smoke test of the built browser half, without a browser.
 *
 * The bundle is written for the DSH client module system, so this installs a
 * fake `window.__ModuleLoader__` plus a react shim, executes the real
 * `lib/client.js`, and inspects the registration the shell would consume:
 * the registration id, the `apply`/`inject` exports, the `$mount`ed Remote
 * descriptors, and the `settings.section` registration.
 */
import { pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

const problems = []
const ok = (cond, msg) => {
  if (!cond) problems.push(msg)
}

const METHODS = ['list', 'archive', 'unarchive', 'inspectDelete', 'deleteSession']

let registration
globalThis.window = {
  __ModuleLoader__: {
    load(reg) {
      registration = reg
    },
  },
}

// `document` stays undefined on purpose: the bundle only injects its
// stylesheet when a document exists, so this exercises the module envelope.
const React = {
  createElement: (type, props, ...children) => ({ type, props, children }),
  useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
  useEffect: () => {},
  useCallback: (fn) => fn,
}
const requireShim = (id) => {
  if (id === 'react') return React
  throw new Error(`unexpected external module requested: ${id}`)
}

await import(pathToFileURL(join(root, 'lib', 'client.js')).href)

ok(registration !== undefined, 'client: __ModuleLoader__.load was never called')
ok(registration?.id === 'dsh-delete-chat', `client: registration id = ${JSON.stringify(registration?.id)}`)
ok(typeof registration?.factory === 'function', 'client: factory is not a function')

const exports = registration.factory(requireShim)
ok(typeof exports?.apply === 'function', 'client: no apply export')
ok(Array.isArray(exports?.inject), 'client: inject is not an array')
ok(exports?.inject?.includes('remote'), 'client: inject must list "remote"')

// Exercise apply() against a mock client ctx so $mount and the slot wiring run.
const mounted = []
const injected = []
const mockApi = {
  list: async () => ({ ok: true, value: { sessions: [] } }),
  archive: async () => ({ ok: true, value: { archivedSessionIds: [] } }),
  unarchive: async () => ({ ok: true, value: { archivedSessionIds: [] } }),
  inspectDelete: async () => ({ ok: true, value: { deletable: false, reason: 'x', path: null, dir: null } }),
  deleteSession: async () => ({ ok: true, value: { path: 'p' } }),
}

await exports.apply({
  remote: {
    $mount: async (contribution) => {
      mounted.push(contribution)
      return () => {}
    },
  },
  get(name) {
    if (name === 'remote.delChat') return mockApi
    if (name === 'slots') {
      return {
        inject: (key) => {
          injected.push(key)
          return () => {}
        },
        register: () => () => {},
      }
    }
    return undefined
  },
  effect: () => () => {},
  on: () => () => {},
})

ok(mounted.length === 1, `client: expected exactly one $mount, got ${mounted.length}`)
const contribution = mounted[0]
ok(contribution?.package === 'dsh-delete-chat', `client: contribution package = ${contribution?.package}`)

const descriptorIds = (contribution?.descriptors ?? []).map((d) => d.id)
for (const m of METHODS) {
  ok(descriptorIds.includes(`dsh-delete-chat#delChat/${m}`), `client: missing descriptor for ${m}`)
}
for (const d of contribution?.descriptors ?? []) {
  ok(d.namespace === 'delChat', `client ${d.id}: namespace`)
  ok(d.invocation?.kind === 'direct', `client ${d.id}: invocation kind`)
  ok(d.result?.mode === 'strict', `client ${d.id}: result codec mode`)
  ok(typeof d.result?.schema?.parse === 'function', `client ${d.id}: result schema has no parse()`)
  for (const p of d.parameters ?? []) {
    ok(p.source === 'json', `client ${d.id}: parameter ${p.name} source`)
    ok(p.codec?.mode === 'strict', `client ${d.id}: parameter ${p.name} codec mode`)
    ok(
      typeof p.codec?.schema?.parse === 'function',
      `client ${d.id}: parameter ${p.name} codec has no parse()`,
    )
  }
}
ok(injected.includes('settings.section'), 'client: did not inject settings.section')

console.log('registration id  :', registration.id)
console.log('exports          :', Object.keys(exports).join(', '))
console.log('inject           :', JSON.stringify(exports.inject))
console.log('mounted package  :', contribution?.package)
console.log('descriptors      :', descriptorIds.length)
for (const id of descriptorIds) console.log('  -', id)
console.log('slots.inject     :', injected.join(', '))

if (problems.length === 0) {
  console.log('\nclient: PASS')
} else {
  console.log('\nclient: FAIL')
  for (const p of problems) console.log('  x', p)
  process.exitCode = 1
}
