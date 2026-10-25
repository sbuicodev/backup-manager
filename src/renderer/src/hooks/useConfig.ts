import { useCallback, useEffect, useState } from 'react'
import type { ConfigState } from '@shared/ipc'
import type { Config } from '@shared/schema'
import { api } from '@/lib/api'

export type UseConfig = {
  state: ConfigState | null
  /** Saves and returns validation errors, or null on success. */
  save(next: Config): Promise<string[] | null>
  reload(): Promise<void>
}

export function useConfig(): UseConfig {
  const [state, setState] = useState<ConfigState | null>(null)
  const reload = useCallback(async () => setState(await api.config.get()), [])
  useEffect(() => {
    void reload()
  }, [reload])
  const save = useCallback(
    async (next: Config) => {
      const r = await api.config.save(next)
      if (!r.ok) return r.errors
      await reload()
      return null
    },
    [reload]
  )
  return { state, save, reload }
}
