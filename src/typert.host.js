/**
 * dsh-del-chat — Host-face Typert manifest.
 *
 * Structurally identical to a `@deepseek-ai/dsh-typert-generator` artifact:
 * `dsh-typert-loader` imports this module through the package's `./typert`
 * export, validates it, and registers every invocation with the Typert
 * gateway, which is what makes `remote.delChat.*` callable from the browser.
 *
 * Every codec must be `{ mode: 'strict', typeSymbol, schema }` with a zod v4
 * schema — a bare zod schema is rejected at registration.
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
})

const listRequestSchema = z.object({}).strict()
const listResultSchema = z.object({ sessions: z.array(sessionSchema) })

const sessionRequestSchema = z.object({ sessionId: nonEmpty })

const archivedIdsResultSchema = z.object({ archivedSessionIds: z.array(z.string()) })

const inspectDeleteResultSchema = z.object({
  deletable: z.boolean(),
  reason: z.union([z.string(), z.null()]),
  path: z.union([z.string(), z.null()]),
  dir: z.union([z.string(), z.null()]),
})

const deleteResultSchema = z.object({ path: z.string() })

const listRequest$codec = {
  mode: 'strict',
  typeSymbol: 'dsh-del-chat#ListRequest',
  schema: listRequestSchema,
}
const list$codec = {
  mode: 'strict',
  typeSymbol: 'dsh-del-chat#ListResult',
  schema: listResultSchema,
}
const sessionRequest$codec = {
  mode: 'strict',
  typeSymbol: 'dsh-del-chat#SessionRequest',
  schema: sessionRequestSchema,
}
const archivedIds$codec = {
  mode: 'strict',
  typeSymbol: 'dsh-del-chat#ArchivedIdsResult',
  schema: archivedIdsResultSchema,
}
const inspectDelete$codec = {
  mode: 'strict',
  typeSymbol: 'dsh-del-chat#InspectDeleteResult',
  schema: inspectDeleteResultSchema,
}
const delete$codec = {
  mode: 'strict',
  typeSymbol: 'dsh-del-chat#DeleteResult',
  schema: deleteResultSchema,
}

export const sessionSchemaExport = sessionSchema

export const TYPERT = {
  package: 'dsh-del-chat',
  face: 'host',
  schemas: [],
  invocations: [
    {
      id: 'dsh-del-chat#delChat/list',
      service: 'delChat',
      namespace: 'delChat',
      method: 'list',
      invocation: { kind: 'direct' },
      parameters: [{ name: 'request', wire: 'request', source: 'json', codec: listRequest$codec }],
      result: list$codec,
    },
    {
      id: 'dsh-del-chat#delChat/archive',
      service: 'delChat',
      namespace: 'delChat',
      method: 'archive',
      invocation: { kind: 'direct' },
      parameters: [{ name: 'request', wire: 'request', source: 'json', codec: sessionRequest$codec }],
      result: archivedIds$codec,
    },
    {
      id: 'dsh-del-chat#delChat/unarchive',
      service: 'delChat',
      namespace: 'delChat',
      method: 'unarchive',
      invocation: { kind: 'direct' },
      parameters: [{ name: 'request', wire: 'request', source: 'json', codec: sessionRequest$codec }],
      result: archivedIds$codec,
    },
    {
      id: 'dsh-del-chat#delChat/inspectDelete',
      service: 'delChat',
      namespace: 'delChat',
      method: 'inspectDelete',
      invocation: { kind: 'direct' },
      parameters: [{ name: 'request', wire: 'request', source: 'json', codec: sessionRequest$codec }],
      result: inspectDelete$codec,
    },
    {
      id: 'dsh-del-chat#delChat/deleteSession',
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
