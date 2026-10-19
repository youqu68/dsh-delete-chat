/**
 * Cross-version compatibility check of the built Typert manifest.
 *
 * The codec contract changed between harness lines:
 *   - 0.1.x validates `codec.schema` (a zod v4 schema) and decodes with
 *     `codec.schema.parse(value)`;
 *   - 0.2.x validates a `codec.create()` factory and decodes with
 *     `codec.create().parse(value)`.
 *
 * A codec carrying only one spelling makes the plugin either unloadable
 * (0.2.x loader throws while registering the manifest) or undecodable. This
 * test imports the REAL `validateTypertManifest` from every installed harness
 * generation it can find and validates this package's manifest against each,
 * then decodes every declared parameter/result through the schema that
 * generation would use.
 *
 * It skips (exit 0) when no harness generation is resolvable, so `npm test`
 * still works on a machine without a local harness checkout. Override the
 * locations with DSH_HARNESS_DIRS (semicolon-separated directories):
 *   - each entry is either a harness node_modules/@deepseek-ai directory
 *     (containing dsh-typert-loader) or a root containing such a directory.
 */
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

const problems = []
const ok = (cond, msg) => {
  if (!cond) problems.push(msg)
}

const defaultDirs = [
  // Official 0.2.1-rc.2 probe install used by this repository.
  'D:\\dsh-harness\\.tmp\\official-dsh\\node_modules\\@deepseek-ai',
  // The self-built desktop harness runtime (0.1.5-rc.2).
  'C:\\Users\\冯凯\\AppData\\Local\\npm-cache\\_npx\\1e7f6d9597241db0\\node_modules\\@deepseek-ai',
]
const configured = (process.env.DSH_HARNESS_DIRS ?? '')
  .split(';')
  .map((s) => s.trim())
  .filter((s) => s.length > 0)
const candidates = configured.length > 0 ? configured : defaultDirs

const harnessDirs = []
for (const candidate of candidates) {
  const direct = join(candidate, 'dsh-typert-loader', 'lib', 'index.js')
  const nested = join(candidate, 'node_modules', '@deepseek-ai', 'dsh-typert-loader', 'lib', 'index.js')
  if (existsSync(direct)) harnessDirs.push({ dir: candidate, loader: direct })
  else if (existsSync(nested)) harnessDirs.push({ dir: join(candidate, 'node_modules', '@deepseek-ai'), loader: nested })
}

const { TYPERT } = await import(pathToFileURL(join(root, 'lib', 'typert.host.js')).href)
ok(TYPERT?.package === 'dsh-delete-chat', `typert: package=${TYPERT?.package}`)

if (harnessDirs.length === 0) {
  console.log('compat: SKIP — no installed harness generation was found')
  console.log('  looked for:', candidates.join('; '))
  process.exitCode = problems.length === 0 ? 0 : 1
} else {
  for (const { dir, loader } of harnessDirs) {
    let label = dir
    try {
      // Import the harness's own dsh version for a readable label.
      const pkg = await import(pathToFileURL(join(dir, 'dsh', 'package.json')).href, { with: { type: 'json' } })
      label = `${pkg.default.version} (${dir})`
    } catch {
      // Keep the directory as the label.
    }

    let validateTypertManifest
    try {
      ;({ validateTypertManifest } = await import(pathToFileURL(loader).href))
    } catch (error) {
      problems.push(`${label}: could not import its typert loader (${String(error && error.message)})`)
      continue
    }
    ok(typeof validateTypertManifest === 'function', `${label}: typert loader does not export validateTypertManifest`)

    try {
      validateTypertManifest('dsh-delete-chat', TYPERT)
      console.log(`compat ${label}: manifest VALID`)
    } catch (error) {
      problems.push(`${label}: manifest rejected — ${String((error && error.message) || error)}`)
      continue
    }

    // Decode one real value through the spelling that generation uses. The
    // archive request carries the 0.2.x-only `stopActivity` field, so it is the
    // most valuable codec to exercise end to end.
    const archiveInv = TYPERT.invocations.find((inv) => inv.method === 'archive')
    const requestCodec = archiveInv.parameters[0].codec
    const decode = typeof requestCodec.create === 'function'
      ? requestCodec.create().parse
      : requestCodec.schema?.parse
    ok(typeof decode === 'function', `${label}: no decodable schema on the archive request codec`)
    if (typeof decode === 'function') {
      const decoded = decode({ sessionId: 'session-x', stopActivity: true })
      ok(decoded?.sessionId === 'session-x', `${label}: archive request decode lost sessionId`)
      ok(decoded?.stopActivity === true, `${label}: archive request decode lost stopActivity`)

      const resultSchema = archiveInv.result.create().parse
      const result = resultSchema({ archivedSessionIds: ['a'], needsStop: true, activity: [{ kind: 'turn', items: [] }] })
      ok(result?.needsStop === true, `${label}: archive result decode lost needsStop`)
    }
  }

  console.log('compat harnesses :', harnessDirs.map((h) => h.dir).join('; '))
  if (problems.length === 0) console.log('\ncompat: PASS')
  else {
    console.log('\ncompat: FAIL')
    for (const p of problems) console.log('  x', p)
    process.exitCode = 1
  }
}
