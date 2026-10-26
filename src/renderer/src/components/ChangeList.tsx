import { useEffect, useState } from 'react'
import { Loader2 } from 'lucide-react'
import type { ChangeAction, ChangeEntry, ChangePage } from '@shared/types'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { api } from '@/lib/api'
import { formatBytes } from '@/lib/format'
import { cn } from '@/lib/utils'

const ACTIONS: { id: ChangeAction; label: string; className: string }[] = [
  {
    id: 'added',
    label: 'Added',
    className: 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400'
  },
  { id: 'updated', label: 'Updated', className: 'bg-sky-500/15 text-sky-600 dark:text-sky-400' },
  { id: 'removed', label: 'Removed', className: 'bg-red-500/15 text-red-600 dark:text-red-400' },
  {
    id: 'trashed',
    label: 'Trashed',
    className: 'bg-amber-500/15 text-amber-600 dark:text-amber-400'
  },
  { id: 'deleted', label: 'Deleted', className: 'bg-red-500/15 text-red-600 dark:text-red-400' },
  { id: 'skipped', label: 'Skipped', className: 'bg-muted text-muted-foreground' }
]
const STYLE = Object.fromEntries(ACTIONS.map((a) => [a.id, a])) as Record<
  ChangeAction,
  (typeof ACTIONS)[number]
>
const PAGE = 200

/** Per-file changes of one job in one run, with action filters, path search and paging. */
export function ChangeList({
  runId,
  sourceId,
  destId
}: {
  runId: string
  sourceId: string
  destId: string
}): React.JSX.Element {
  const [hidden, setHidden] = useState<Set<ChangeAction>>(new Set())
  const [search, setSearch] = useState('')
  const [query, setQuery] = useState('')
  const [page, setPage] = useState<ChangePage | null>(null)
  const [items, setItems] = useState<ChangeEntry[]>([])
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    const h = setTimeout(() => setQuery(search.trim()), 250)
    return () => clearTimeout(h)
  }, [search])

  const shown = ACTIONS.map((a) => a.id).filter((a) => !hidden.has(a))
  const load = async (offset: number): Promise<void> => {
    setLoading(true)
    try {
      const p = await api.history.changes(runId, {
        sourceId,
        destId,
        actions: hidden.size > 0 ? shown : undefined,
        search: query || undefined,
        offset,
        limit: PAGE
      })
      setPage(p)
      setItems((prev) => (offset === 0 ? p.items : [...prev, ...p.items]))
    } finally {
      setLoading(false)
    }
  }
  const filterKey = `${[...hidden].sort().join(',')}|${query}`
  useEffect(() => {
    void load(0)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runId, sourceId, destId, filterKey])

  const toggle = (a: ChangeAction): void => {
    const next = new Set(hidden)
    if (next.has(a)) next.delete(a)
    else next.add(a)
    setHidden(next)
  }

  return (
    <div className="grid gap-3 py-2">
      <div className="flex flex-wrap items-center gap-2">
        {ACTIONS.filter((a) => (page?.counts[a.id] ?? 0) > 0).map((a) => (
          <button
            key={a.id}
            type="button"
            onClick={() => toggle(a.id)}
            className={cn(
              'rounded-full border px-2.5 py-0.5 text-xs transition-opacity',
              a.className,
              hidden.has(a.id) && 'opacity-40'
            )}
          >
            {a.label} {page?.counts[a.id]}
          </button>
        ))}
        <Input
          className="ml-auto h-8 w-60"
          placeholder="Search paths…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>
      <div className="max-h-96 overflow-auto rounded-md border">
        <table className="w-full text-xs">
          <tbody>
            {items.map((c, i) => (
              <tr key={`${c.path}:${i}`} className="border-b last:border-0">
                <td className="w-24 px-2 py-1.5">
                  <Badge className={cn('border-transparent', STYLE[c.action].className)}>
                    {STYLE[c.action].label}
                  </Badge>
                </td>
                <td className="max-w-0 truncate px-2 py-1.5 font-mono" title={c.path}>
                  {c.path}
                  {c.code && <span className="text-muted-foreground"> ({c.code})</span>}
                </td>
                <td className="w-20 px-2 py-1.5 text-right tabular-nums">
                  {c.size !== undefined ? formatBytes(c.size) : ''}
                </td>
                <td
                  className="text-muted-foreground w-44 max-w-44 truncate px-2 py-1.5 font-mono"
                  title={c.archive}
                >
                  {c.archive ?? ''}
                </td>
              </tr>
            ))}
            {items.length === 0 && !loading && (
              <tr>
                <td className="text-muted-foreground px-2 py-3 text-center">No matching changes</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      <div className="text-muted-foreground flex items-center gap-3 text-xs">
        {page && `${items.length} of ${page.total}`}
        {loading && <Loader2 className="size-3 animate-spin" />}
        {page && items.length < page.total && (
          <Button variant="outline" size="sm" onClick={() => void load(items.length)}>
            Load more
          </Button>
        )}
      </div>
    </div>
  )
}
