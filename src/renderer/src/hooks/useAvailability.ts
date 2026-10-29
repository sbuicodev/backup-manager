import { useEffect, useState } from 'react'
import { api } from '@/lib/api'

/** Whether each destination is reachable, refreshed every 10 s. */
export function useAvailability(): Record<string, boolean> {
  const [avail, setAvail] = useState<Record<string, boolean>>({})
  useEffect(() => {
    let alive = true
    const load = (): void => {
      void api.destinations.availability().then((a) => alive && setAvail(a))
    }
    load()
    const h = setInterval(load, 10_000)
    return () => {
      alive = false
      clearInterval(h)
    }
  }, [])
  return avail
}
