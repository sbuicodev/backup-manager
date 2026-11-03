import { fileName, newSource, type Config, type Destination, type SourceItem } from '@shared/schema'

/** What the three assistant steps collected. */
export type AssistantState = {
  items: SourceItem[]
  /** Shared drives picked in step 2. */
  driveIds: string[]
  /** Folders added with "Other folder…": drives for this backup only. */
  newDrives: Destination[]
  mode: 'mirror' | 'snapshot'
  run: 'daily' | 'interval' | 'manual'
}

/** The configuration with the new backup added. */
export function assistantConfig(
  config: Config,
  st: AssistantState
): { next: Config; sourceId: string } {
  const name = st.items[0] ? fileName(st.items[0].path) : 'New backup'
  const source = {
    ...newSource(
      '',
      name,
      config.sources.map((s) => s.slug)
    ),
    items: st.items,
    destinationIds: st.driveIds,
    mode: st.mode,
    schedule:
      st.run === 'daily'
        ? ({ kind: 'daily', time: '22:00' } as const)
        : st.run === 'interval'
          ? ({ kind: 'interval', everyHours: 4 } as const)
          : null,
    setupComplete: true
  }
  return {
    sourceId: source.id,
    next: {
      ...config,
      destinations: [
        ...config.destinations,
        ...st.newDrives.map((d) => ({ ...d, ownerSourceId: source.id }))
      ],
      sources: [...config.sources, source]
    }
  }
}
