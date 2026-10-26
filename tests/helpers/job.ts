import { effectiveZipSettings, newDestination, type Source } from '@shared/schema'
import type { ChangeEntry, ProgressEvent } from '@shared/types'
import { FsDestination } from '../../src/main/engine/destination'
import type { ExecContext, JobContext } from '../../src/main/engine/job'
import { walkTree } from '../../src/main/engine/walk'

export async function ctxFor(source: Source, dest: FsDestination, now: Date): Promise<JobContext> {
  const { files, skipped } = await walkTree(source.path, { excludes: source.excludes })
  return {
    source,
    destId: 'd1',
    dest,
    globalExcludes: [],
    srcFiles: files,
    srcSkipped: skipped,
    now,
    zip: effectiveZipSettings(source, newDestination('/d', 'D'))
  }
}

export function exec(
  events: ProgressEvent[] = [],
  signal = new AbortController().signal,
  changes: ChangeEntry[] = []
): ExecContext {
  return {
    runId: 'r1',
    signal,
    emit: (e) => events.push(e),
    record: (c) => (changes.push(c), true),
    drain: async () => {}
  }
}

/** FsDestination whose Nth copyFileIn (or zip stream open) throws an errno error. */
export class FailingDest extends FsDestination {
  calls = 0
  constructor(
    root: string,
    private failOn: number,
    private code: string
  ) {
    super(root)
  }
  override async copyFileIn(
    ...args: Parameters<FsDestination['copyFileIn']>
  ): Promise<{ bytes: number }> {
    if (++this.calls === this.failOn) throw Object.assign(new Error(this.code), { code: this.code })
    return super.copyFileIn(...args)
  }
}
