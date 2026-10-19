/**
 * Smoke test of the built browser half, without a browser.
 *
 * The bundle is written for the DSH client module system, so this installs a
 * fake `window.__ModuleLoader__` plus a react shim, executes the real
 * `lib/client.js`, and inspects the registration the shell would consume:
 * the module id, the `apply`/`inject` exports, the `$mount`ed Remote
 * descriptors (including the DUAL codec spelling both harness lines accept),
 * and the `settings.section` registration.
 */
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

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
function makeElement(type, props, ...children) {
  return { type, props: props ?? {}, children: children.flat() }
}
const React = {
  createElement: makeElement,
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
ok(exports?.inject?.includes('slots'), 'client: inject must list "slots" (the settings page target)')

// Exercise apply() against a mock client ctx so $mount and the slot wiring run.
const mounted = []
const injected = []
const registrations = []
const mockApi = {
  list: async () => ({ ok: true, value: { sessions: [] } }),
  archive: async () => ({ ok: true, value: { archivedSessionIds: [], needsStop: false, activity: [] } }),
  unarchive: async () => ({ ok: true, value: { archivedSessionIds: [] } }),
  inspectDelete: async () => ({ ok: true, value: { deletable: false, reason: 'x', path: null, dir: null, files: [] } }),
  deleteSession: async () => ({ ok: true, value: { path: 'p', removed: 1, dirRemoved: true } }),
}
const slotsService = {
  inject: (key, callback) => {
    injected.push(key)
    // Emulate a live declaration: run the callback exactly as the shell does.
    callback()
    return () => {}
  },
  register: (options, component) => {
    registrations.push({ options, component })
    return () => {}
  },
}

const services = {
  remote: {
    $mount: async (contribution) => {
      mounted.push(contribution)
      return () => {}
    },
  },
  'remote.delChat': mockApi,
  slots: slotsService,
}

await exports.apply({
  get(name) {
    return services[name]
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

/**
 * The client contribution is validated by the client Typert registry. 0.2.x
 * requires a `create()` factory on every strict codec and 0.1.x requires
 * `schema.parse`; carrying only one spelling made `$mount` throw.
 */
function assertDualCodec(codecValue, subject) {
  ok(codecValue?.mode === 'strict', `${subject}: codec mode is not strict`)
  ok(typeof codecValue?.typeSymbol === 'string' && codecValue.typeSymbol.length > 0, `${subject}: missing typeSymbol`)
  ok(typeof codecValue?.create === 'function', `${subject}: strict codec has no create() factory (0.2.x mount rejects)`)
  ok(typeof codecValue?.schema?.parse === 'function', `${subject}: strict codec has no schema.parse() (0.1.x mount rejects)`)
  if (typeof codecValue?.create === 'function') {
    ok(codecValue.create() === codecValue.schema, `${subject}: create() and schema must be the same passthrough schema`)
  }
}

for (const d of contribution?.descriptors ?? []) {
  ok(d.namespace === 'delChat', `client ${d.id}: namespace`)
  ok(d.service === 'delChat', `client ${d.id}: service`)
  ok(d.invocation?.kind === 'direct', `client ${d.id}: invocation kind`)
  assertDualCodec(d.result, `client ${d.id}: result`)
  for (const p of d.parameters ?? []) {
    ok(p.source === 'json', `client ${d.id}: parameter ${p.name} source`)
    ok(typeof p.wire === 'string' && p.wire.length > 0, `client ${d.id}: parameter ${p.name} wire`)
    assertDualCodec(p.codec, `client ${d.id}: parameter ${p.name}`)
  }
}

ok(injected.includes('settings.section'), 'client: did not inject settings.section')
ok(registrations.length === 1, `client: expected one settings.section registration, got ${registrations.length}`)
const registrationEntry = registrations[0]
ok(registrationEntry?.options?.name === 'settings.section', `client: registration name = ${JSON.stringify(registrationEntry?.options?.name)}`)
ok(registrationEntry?.options?.id === 'del-chat', `client: registration id = ${JSON.stringify(registrationEntry?.options?.id)}`)
ok(registrationEntry?.options?.label === '会话管理', `client: registration label = ${JSON.stringify(registrationEntry?.options?.label)}`)
ok(typeof registrationEntry?.component === 'function', 'client: registration has no component')

// Render the registered wrapper once, then its inner component with the
// loading state the shim produces; the tree must be the session-manager root
// rather than an empty/undefined render.
const wrapperTree = registrationEntry.component({})
const tree = typeof wrapperTree?.type === 'function' ? wrapperTree.type(wrapperTree.props) : wrapperTree
const flat = JSON.stringify(tree)
ok(tree?.type === 'div' && tree?.props?.className === 'dc-root', 'client: component root is not dc-root')
ok(flat.includes('会话管理'), 'client: page title is missing from the rendered tree')
ok(flat.includes('刷新'), 'client: refresh control is missing from the rendered tree')

console.log('registration id  :', registration.id)
console.log('exports          :', Object.keys(exports).join(', '))
console.log('inject           :', JSON.stringify(exports.inject))
console.log('mounted package  :', contribution?.package)
console.log('descriptors      :', descriptorIds.length)
for (const id of descriptorIds) console.log('  -', id)
console.log('slots.inject     :', injected.join(', '))
console.log('settings section :', JSON.stringify(registrationEntry?.options))

if (problems.length === 0) {
  console.log('\nclient: PASS')
} else {
  console.log('\nclient: FAIL')
  for (const p of problems) console.log('  x', p)
  process.exitCode = 1
}
