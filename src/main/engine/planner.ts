import {
  effectiveZipSettings,
  type Config,
  type Destination as DestinationConfig,
  type Source
} from '@shared/schema'
import type { JobKind, JobPlan, JobRequest, Plan } from '@shared/types'
import { FsDestination, type Destination } from './destination'
import { effectiveExcludes, type JobContext, type PreparedJob } from './job'
import { prepareMirrorCopy, prepareMirrorZip } from './mirror'
import { prepareSnapshot } from './snapshot'
import { readSourceItems, type SourceFiles } from './source-items'

export type RunRequest = { sourceIds?: string[] } | { jobs: JobRequest[] }

export type PlanDeps = {
  now?: () => Date
  makeDestination?: (root: string) => Destination
  signal?: AbortSignal
  /** Snapshot file-list index folder (enables snapshot change diffs). */
  indexDir?: string
}

export type PreparedEntry = { plan: JobPlan; execute?: PreparedJob['execute'] }

export function jobKind(source: Source): JobKind {
  return `${source.mode}-${source.packaging === 'copy' ? 'copy' : 'zip'}`
}

/** Whether a backup may run at all: switched on and set up. */
export function isRunnable(source: Source): boolean {
  return source.enabled && source.setupComplete
}

/** Whether a source targets a destination (enabled or not): its own ones always, shared ones as chosen. */
export function targets(source: Source, d: DestinationConfig): boolean {
  if (d.ownerSourceId !== null) return d.ownerSourceId === source.id
  return source.destinationIds === 'all' || source.destinationIds.includes(d.id)
}

/** Enabled destinations a source targets, in config order. */
export function destinationsFor(config: Config, source: Source): DestinationConfig[] {
  return config.destinations.filter((d) => d.enabled && targets(source, d))
}

function selectPairs(config: Config, request: RunRequest): [Source, DestinationConfig][] {
  const pairs: [Source, DestinationConfig][] = []
  if ('jobs' in request) {
    const wanted = new Set(request.jobs.map((j) => `${j.sourceId}:${j.destId}`))
    for (const s of config.sources) {
      if (!isRunnable(s)) continue
      for (const d of config.destinations) {
        if (d.enabled && wanted.has(`${s.id}:${d.id}`)) pairs.push([s, d])
      }
    }
    return pairs
  }
  for (const s of config.sources) {
    if (!isRunnable(s) || (request.sourceIds && !request.sourceIds.includes(s.id))) continue
    for (const d of destinationsFor(config, s)) pairs.push([s, d])
  }
  return pairs
}

function skippedPlan(
  source: Source,
  destId: string,
  reason: NonNullable<JobPlan['reason']>,
  error?: string
): JobPlan {
  return {
    sourceId: source.id,
    destId,
    kind: jobKind(source),
    status: 'skipped',
    reason,
    ...(error ? { error } : {}),
    counts: { copy: 0, update: 0, zip: 0, trash: 0, delete: 0, unchanged: 0 },
    bytes: 0,
    skippedEntries: []
  }
}

export async function planRun(
  config: Config,
  request: RunRequest,
  deps: PlanDeps = {}
): Promise<{ plan: Plan; prepared: PreparedEntry[] }> {
  const now = (deps.now ?? (() => new Date()))()
  const makeDestination = deps.makeDestination ?? ((root: string) => new FsDestination(root))
  const walks = new Map<string, Promise<SourceFiles | null>>()
  const walkSource = (s: Source): Promise<SourceFiles | null> => {
    let w = walks.get(s.id)
    if (!w) {
      w = readSourceItems(s, effectiveExcludes(s, config.globalExcludes), deps.signal)
      walks.set(s.id, w)
    }
    return w
  }

  const prepared: PreparedEntry[] = []
  for (const [source, d] of selectPairs(config, request)) {
    deps.signal?.throwIfAborted()
    const dest = makeDestination(d.path)
    if (!(await dest.isAvailable())) {
      prepared.push({ plan: skippedPlan(source, d.id, 'destination-missing') })
      continue
    }
    const walked = await walkSource(source)
    if (!walked) {
      prepared.push({ plan: skippedPlan(source, d.id, 'source-missing') })
      continue
    }
    const ctx: JobContext = {
      source,
      destId: d.id,
      dest,
      globalExcludes: config.globalExcludes,
      srcFiles: walked.files,
      srcSkipped: walked.skipped,
      now,
      zip: effectiveZipSettings(source, d),
      indexDir: deps.indexDir,
      absOf: walked.absOf,
      itemized: true
    }
    try {
      const job =
        source.mode === 'snapshot'
          ? await prepareSnapshot(ctx)
          : source.packaging === 'copy'
            ? await prepareMirrorCopy(ctx)
            : await prepareMirrorZip(ctx)
      prepared.push(job)
    } catch (err) {
      // e.g. the existing backup folder is unreadable: fail this job, not the whole run.
      prepared.push({ plan: skippedPlan(source, d.id, 'error', (err as Error).message) })
    }
  }
  return { plan: { createdAt: now.toISOString(), jobs: prepared.map((p) => p.plan) }, prepared }
}
