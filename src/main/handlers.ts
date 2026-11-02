import { readFile, writeFile } from 'node:fs/promises'
import { z } from 'zod'
import { CH } from '@shared/ipc'
import { validateConfig } from '@shared/schema'
import type { Services } from './services'

export type Dialogs = {
  pickFolder(): Promise<string | null>
  pickFiles(): Promise<string[]>
  saveFile(defaultName: string): Promise<string | null>
  openFile(): Promise<string | null>
}

export type Handler = (...args: unknown[]) => Promise<unknown>

const SourceIds = z.array(z.string()).optional()
const Id = z.string()
const ChangeQuerySchema = z.object({
  sourceId: z.string(),
  destId: z.string(),
  actions: z
    .array(z.enum(['added', 'updated', 'removed', 'trashed', 'deleted', 'skipped']))
    .optional(),
  search: z.string().max(500).optional(),
  offset: z.number().int().min(0).optional(),
  limit: z.number().int().min(1).max(1000).optional()
})
const PauseUntil = z.union([z.literal('forever'), z.iso.datetime()])

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const r = schema.safeParse(value)
  if (!r.success) throw new Error('invalid arguments')
  return r.data
}

/** Plain-function IPC handlers keyed by channel; every argument is validated. */
export function createHandlers(services: Services, dialogs: Dialogs): Record<string, Handler> {
  const { scheduler } = services
  return {
    [CH.configGet]: async () => services.configState(),
    [CH.configSave]: async (c) => services.saveConfig(c),
    [CH.configExport]: async () => {
      const file = await dialogs.saveFile('backup-manager-config.json')
      if (!file) return false
      await writeFile(file, JSON.stringify(services.config(), null, 2))
      return true
    },
    [CH.configImport]: async () => {
      const file = await dialogs.openFile()
      if (!file) return null
      let json: unknown
      try {
        json = JSON.parse(await readFile(file, 'utf8'))
      } catch (err) {
        return { ok: false, errors: [`(root): ${(err as Error).message}`] }
      }
      const r = validateConfig(json)
      return r.ok ? services.saveConfig(r.config) : r
    },
    [CH.configReset]: async () => services.resetConfig(),
    [CH.pickFolder]: async () => dialogs.pickFolder(),
    [CH.pickFiles]: async () => dialogs.pickFiles(),
    [CH.availability]: async () => services.availability(),
    [CH.runPlan]: async (ids) => services.plan(parse(SourceIds, ids)),
    [CH.runStart]: async (ids) => scheduler.runNow(parse(SourceIds, ids))?.id ?? null,
    [CH.runCancel]: async () => scheduler.cancel(),
    [CH.schedulerStatus]: async () => scheduler.status(),
    [CH.schedulerPause]: async (until) => {
      const u = parse(PauseUntil, until)
      await scheduler.pause(u === 'forever' ? 'forever' : new Date(u))
    },
    [CH.schedulerResume]: async () => scheduler.resume(),
    [CH.historyList]: async () => services.listRuns(),
    [CH.historyGet]: async (id) => services.getRun(parse(Id, id)),
    [CH.historyChanges]: async (runId, q) =>
      services.readChanges(parse(Id, runId), parse(ChangeQuerySchema, q))
  }
}
