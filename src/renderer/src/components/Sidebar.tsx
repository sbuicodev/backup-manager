import type { LucideIcon } from 'lucide-react'
import type { Screen } from '@shared/ipc'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'

export type NavItem = { id: Screen; label: string; icon: LucideIcon }

/** Screen navigation: icon + label, or icons only (labels as tooltips) when collapsed. */
export function Sidebar({
  items,
  current,
  collapsed,
  onSelect
}: {
  items: NavItem[]
  current: Screen
  collapsed: boolean
  onSelect: (screen: Screen) => void
}): React.JSX.Element {
  return (
    <aside
      className={cn(
        'bg-sidebar text-sidebar-foreground flex shrink-0 flex-col overflow-hidden border-r p-3 transition-[width] duration-200',
        collapsed ? 'w-[60px]' : 'w-56'
      )}
    >
      {/* One column no wider than the sidebar: a hidden label must not widen the buttons, or
          tooltips would point at where the expanded sidebar ends. */}
      <nav className="grid grid-cols-[minmax(0,1fr)] gap-1">
        {items.map(({ id, label, icon: Icon }) => {
          const button = (
            <button
              key={id}
              aria-label={label}
              onClick={() => onSelect(id)}
              className={cn(
                'flex h-9 min-w-0 items-center gap-2.5 overflow-hidden rounded-md px-2.5 text-left text-sm whitespace-nowrap',
                current === id
                  ? 'bg-sidebar-accent text-sidebar-accent-foreground font-medium'
                  : 'text-muted-foreground hover:bg-sidebar-accent/60'
              )}
            >
              <Icon className="size-4 shrink-0" />
              <span className={cn('transition-opacity', collapsed && 'opacity-0')}>{label}</span>
            </button>
          )
          if (!collapsed) return button
          return (
            <Tooltip key={id}>
              <TooltipTrigger asChild>{button}</TooltipTrigger>
              <TooltipContent side="right">{label}</TooltipContent>
            </Tooltip>
          )
        })}
      </nav>
    </aside>
  )
}
