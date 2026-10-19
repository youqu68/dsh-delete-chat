/**
 * dsh-delete-chat — Host-face Typert manifest.
 *
 * Structurally identical to a `@deepseek-ai/dsh-typert-generator` artifact:
 * `dsh-typert-loader` imports this module through the package's `./typert`
 * export, validates it, and registers every invocation with the Typert
 * gateway, which is what makes `remote.delChat.*` callable from the browser.
 *
 * Every codec must be `{ mode: 'strict', typeSymbol, ... }` with a zod v4
 * schema. The schema is carried in TWO spellings because the codec contract
 * changed between harness lines:
 *   - 0.1.x validates `codec.schema` (`_zod` + `parse`) and decodes with
 *     `codec.schema.parse(value)`;
 *   - 0.2.x validates a `create()` factory (`codec.create().parse(value)`).
 * Carrying both fields makes one artifact pass either loader; each line reads
 * only the field it knows, and both point at the same zod schema.
 */
import { z } from 'zod'

const nonEmpty = z.string().min(1)

/** One session row rendered by the settings page. */
const sessionSchema = z.object({
  id: nonEmpty,
  title: z.union([z.string(), z.null()]),
  cwd: z.union([z.string(), z.null()]),
  createdAt: z.number(),
  live: z.boolean(),
  archived: z.boolean(),
  /** `current`, or `migration-required` when only an older log generation exists. */
  formatStatus: z.string(),
})

const listRequestSchema = z.object({}).strict()
const listResultSchema = z.object({ sessions: z.array(sessionSchema) })

const sessionRequestSchema = z.object({ sessionId: nonEmpty })

/** Archive additionally accepts the 0.2.x opt-in that stops running work. */
const archiveRequestSchema = z.object({
  sessionId: nonEmpty,
  stopActivity: z.boolean().optional(),
})

/** One activity family that refused an archive. */
const activitySchema = z.object({
  kind: z.string(),
  items: z.array(
    z.object({
      id: z.string(),
      label: z.string().optional(),
    }),
  ),
})

const archivedIdsResultSchema = z.object({ archivedSessionIds: z.array(z.string()) })

/**
 * `needsStop` is true when 0.2.x refused the archive because the session still
 * has running work; `activity` names the families so the page can explain it.
 */
const archiveResultSchema = z.object({
  archivedSessionIds: z.array(z.string()),
  needsStop: z.boolean(),
  activity: z.array(activitySchema),
})

const inspectDeleteResultSchema = z.object({
  deletable: z.boolean(),
  reason: z.union([z.string(), z.null()]),
  path: z.union([z.string(), z.null()]),
  dir: z.union([z.string(), z.null()]),
  /** Every canonical generation file a confirmed delete would remove. */
  files: z.array(z.string()),
})

const deleteResultSchema = z.object({
  path: z.string(),
  removed: z.number().int().nonnegative(),
  dirRemoved: z.boolean(),
})

/**
 * One strict codec in both harness spellings.
 * @param typeSymbol - stable type identity carried on the wire.
 * @param schema - the zod v4 schema validating the value.
 */
function codec(typeSymbol, schema) {
  return {
    mode: 'strict',
    typeSymbol,
    // 0.1.x reads `schema`; 0.2.x reads `create()`.
    schema,
    create: () => schema,
  }
}

const listRequest$codec = codec('dsh-delete-chat#ListRequest', listRequestSchema)
const list$codec = codec('dsh-delete-chat#ListResult', listResultSchema)
const sessionRequest$codec = codec('dsh-delete-chat#SessionRequest', sessionRequestSchema)
const archiveRequest$codec = codec('dsh-delete-chat#ArchiveRequest', archiveRequestSchema)
const archivedIds$codec = codec('dsh-delete-chat#ArchivedIdsResult', archivedIdsResultSchema)
const archive$codec = codec('dsh-delete-chat#ArchiveResult', archiveResultSchema)
const inspectDelete$codec = codec('dsh-delete-chat#InspectDeleteResult', inspectDeleteResultSchema)
const delete$codec = codec('dsh-delete-chat#DeleteResult', deleteResultSchema)

export const sessionSchemaExport = sessionSchema

export const TYPERT = {
  package: 'dsh-delete-chat',
  face: 'host',
  schemas: [],
  invocations: [
    {
      id: 'dsh-delete-chat#delChat/list',
      service: 'delChat',
      namespace: 'delChat',
      method: 'list',
      invocation: { kind: 'direct' },
      parameters: [{ name: 'request', wire: 'request', source: 'json', codec: listRequest$codec }],
      result: list$codec,
    },
    {
      id: 'dsh-delete-chat#delChat/archive',
      service: 'delChat',
      namespace: 'delChat',
      method: 'archive',
      invocation: { kind: 'direct' },
      parameters: [{ name: 'request', wire: 'request', source: 'json', codec: archiveRequest$codec }],
      result: archive$codec,
    },
    {
      id: 'dsh-delete-chat#delChat/unarchive',
      service: 'delChat',
      namespace: 'delChat',
      method: 'unarchive',
      invocation: { kind: 'direct' },
      parameters: [{ name: 'request', wire: 'request', source: 'json', codec: sessionRequest$codec }],
      result: archivedIds$codec,
    },
    {
      id: 'dsh-delete-chat#delChat/inspectDelete',
      service: 'delChat',
      namespace: 'delChat',
      method: 'inspectDelete',
      invocation: { kind: 'direct' },
      parameters: [{ name: 'request', wire: 'request', source: 'json', codec: sessionRequest$codec }],
      result: inspectDelete$codec,
    },
    {
      id: 'dsh-delete-chat#delChat/deleteSession',
      service: 'delChat',
      namespace: 'delChat',
      method: 'deleteSession',
      invocation: { kind: 'direct' },
      parameters: [{ name: 'request', wire: 'request', source: 'json', codec: sessionRequest$codec }],
      result: delete$codec,
    },
  ],
  model: {
    services: [],
    events: [],
    objects: [],
  },
}

export default TYPERT
