import { useEffect, useState } from 'react'
import type { PairResult } from '@shared/types'
import { api } from '@/lib/api'

/** The newest result of each backup × drive pair; refreshed whenever a run ends. */
export function useLatestResults(): PairResult[] {
  const [results, setResults] = useState<PairResult[]>([])
  useEffect(() => {
    let alive = true
    const load = (): void => {
      void api.history.latest().then((r) => alive && setResults(r))
    }
    load()
    const off = api.run.onProgress((e) => {
      if (e.type === 'run-end') load()
    })
    return () => {
      alive = false
      off()
    }
  }, [])
  return results
}
