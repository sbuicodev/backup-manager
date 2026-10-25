import type { Config, Destination as DestinationConfig, Source } from '@shared/schema'
import type { FileEntry, JobKind, JobPlan, JobRequest, Plan, SkippedEntry } from '@shared/types'
import { FsDestination, type Destination } from './destination'
import { effectiveExcludes, type JobContext, type PreparedJob } from './job'
import { prepareMirrorCopy, prepareMirrorZip } from './mirror'
import { prepareSnapshot } from './snapshot'
import { walkTree } from './walk'

export type RunRequest = { sourceIds?: string[] } | { jobs: JobRequest[] }

export type PlanDeps = {
  now?: () => Date
  makeDestination?: (root: string) => Destination
  signal?: AbortSignal
}

export type PreparedEntry = { plan: JobPlan; execute?: PreparedJob['execute'] }

export function jobKind(source: Source): JobKind {
  return `${source.mode}-${source.packaging === 'copy' ? 'copy' : 'zip'}`
}

/** Enabled destinations a source targets, in config order. */
export function destinationsFor(config: Config, source: Source): DestinationConfig[] {
  return config.destinations.filter(
    (d) => d.enabled && (source.destinationIds === 'all' || source.destinationIds.includes(d.id))
  )
}

function selectPairs(config: Config, request: RunRequest): [Source, DestinationConfig][] {
  const pairs: [Source, DestinationConfig][] = []
  if ('jobs' in request) {
    const wanted = new Set(request.jobs.map((j) => `${j.sourceId}:${j.destId}`))
    for (const s of config.sources) {
      if (!s.enabled) continue
      for (const d of config.destinations) {
        if (d.enabled && wanted.has(`${s.id}:${d.id}`)) pairs.push([s, d])
      }
    }
    return pairs
  }
  for (const s of config.sources) {
    if (!s.enabled || (request.sourceIds && !request.sourceIds.includes(s.id))) continue
    for (const d of destinationsFor(config, s)) pairs.push([s, d])
  }
  return pairs
}

function skippedPlan(
  source: Source,
  destId: string,
  reason: 'source-missing' | 'destination-missing'
): JobPlan {
  return {
    sourceId: source.id,
    destId,
    kind: jobKind(source),
    status: 'skipped',
    reason,
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
  const walks = new Map<string, Promise<{ files: FileEntry[]; skipped: SkippedEntry[] } | null>>()
  const walkSource = (
    s: Source
  ): Promise<{ files: FileEntry[]; skipped: SkippedEntry[] } | null> => {
    let w = walks.get(s.id)
    if (!w) {
      w = walkTree(s.path, {
        excludes: effectiveExcludes(s, config.globalExcludes),
        signal: deps.signal
      }).catch(() => null)
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
      now
    }
    const job =
      source.mode === 'snapshot'
        ? await prepareSnapshot(ctx)
        : source.packaging === 'copy'
          ? await prepareMirrorCopy(ctx)
          : await prepareMirrorZip(ctx)
    prepared.push(job)
  }
  return { plan: { createdAt: now.toISOString(), jobs: prepared.map((p) => p.plan) }, prepared }
}
