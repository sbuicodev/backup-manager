import { t } from '@/i18n'
import { PanelLeftClose, PanelLeftOpen } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'

/**
 * The app's own title bar. It is a window drag region; on macOS it leaves room for the traffic
 * lights on the left, elsewhere for the native window controls on the right (titleBarOverlay).
 */
export function TopBar({
  sidebar,
  children
}: {
  /** The sidebar toggle: its icon shows whether clicking opens or closes the sidebar. */
  sidebar?: { collapsed: boolean; onToggle: () => void }
  children?: React.ReactNode
}): React.JSX.Element {
  const mac = api.app.platform === 'darwin'
  return (
    <header
      className={cn(
        'app-drag bg-sidebar text-sidebar-foreground flex h-11 shrink-0 items-center gap-2 border-b pr-3 pl-3 text-sm',
        mac ? 'pl-[84px]' : 'pr-[calc(100vw-env(titlebar-area-width,100vw)+12px)]'
      )}
    >
      {sidebar && (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="app-no-drag size-8"
              aria-label={sidebar.collapsed ? t('topbar.expand') : t('topbar.collapse')}
              onClick={sidebar.onToggle}
            >
              {sidebar.collapsed ? <PanelLeftOpen /> : <PanelLeftClose />}
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom">
            {sidebar.collapsed ? t('topbar.expand') : t('topbar.collapse')}
          </TooltipContent>
        </Tooltip>
      )}
      <span className="font-semibold select-none">Backup Manager</span>
      <div className="flex min-w-0 flex-1 items-center justify-end gap-3">{children}</div>
    </header>
  )
}
