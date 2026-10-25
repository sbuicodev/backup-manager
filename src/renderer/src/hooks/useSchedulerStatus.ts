import { useEffect, useState } from 'react'
import type { SchedulerStatus } from '@shared/types'
import { api } from '@/lib/api'

export function useSchedulerStatus(): SchedulerStatus | null {
  const [status, setStatus] = useState<SchedulerStatus | null>(null)
  useEffect(() => {
    let alive = true
    void api.scheduler.status().then((s) => alive && setStatus(s))
    const off = api.scheduler.onStatus(setStatus)
    return () => {
      alive = false
      off()
    }
  }, [])
  return status
}

/** Re-renders every `ms` so relative times stay fresh. */
export function useNow(ms = 30_000): Date {
  const [now, setNow] = useState(() => new Date())
  useEffect(() => {
    const h = setInterval(() => setNow(new Date()), ms)
    return () => clearInterval(h)
  }, [ms])
  return now
}
