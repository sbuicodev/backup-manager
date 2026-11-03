import { useEffect, useRef, useState } from 'react'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { cn } from '@/lib/utils'

type Tab = { id: string; title: string }

/** Where `el` sits inside the scrolling `root`, in its scroll coordinates. */
const sectionTop = (root: HTMLElement, el: HTMLElement): number =>
  el.getBoundingClientRect().top - root.getBoundingClientRect().top + root.scrollTop

/** The form's sections as they are rendered now (some only show for some settings). */
function sectionsIn(root: HTMLElement): Tab[] {
  return [...root.querySelectorAll<HTMLElement>('section[id]')].map((el) => ({
    id: el.id,
    title: el.querySelector('h2')?.textContent ?? el.id
  }))
}

/**
 * A sheet whose content is one scrolling page of sections (`<section id>` with an `<h2>`), with
 * tabs on top that follow the scroll and jump to their section. Used for a backup's
 * configuration and for the app's settings, so both look and behave the same.
 */
export function SectionSheet({
  title,
  badge,
  description,
  section,
  errors = {},
  footer,
  onClose,
  children
}: {
  title: string
  /** Shown beside the title, like "Unsaved changes". */
  badge?: React.ReactNode
  /** For screen readers. */
  description: string
  /** The section to show first. */
  section?: string
  /** Sections with a problem; their tabs turn red. */
  errors?: Record<string, string>
  footer: React.ReactNode
  /** Esc or the close button. */
  onClose: () => void
  children: React.ReactNode
}): React.JSX.Element {
  // The dialog mounts its content later than this component, so the node is state.
  const [node, setNode] = useState<HTMLDivElement | null>(null)
  const [tabs, setTabs] = useState<Tab[]>([])
  const [active, setActive] = useState(section ?? '')
  // While a tab click scrolls smoothly, the clicked tab stays lit.
  const jumping = useRef<number | null>(null)

  // Sections come and go with the settings (Deletions only for a mirror, …): follow the DOM.
  useEffect(() => {
    if (!node) return
    const update = (): void => {
      const next = sectionsIn(node)
      setTabs((t) => (t.map((x) => x.id).join() === next.map((x) => x.id).join() ? t : next))
    }
    update()
    const obs = new MutationObserver(update)
    obs.observe(node, { childList: true, subtree: true })
    return () => obs.disconnect()
  }, [node])

  useEffect(() => {
    const el = section && node?.querySelector<HTMLElement>(`#${section}`)
    if (!node || !el) return
    jumping.current = window.setTimeout(() => (jumping.current = null), 300)
    node.scrollTop = sectionTop(node, el) - 16
    // Only when the dialog opens on a section.
  }, [node, section])

  const onScroll = (): void => {
    const root = node
    if (!root || jumping.current !== null) return
    const els = [...root.querySelectorAll<HTMLElement>('section[id]')]
    const atEnd = root.scrollTop + root.clientHeight >= root.scrollHeight - 2
    const current = atEnd
      ? els.at(-1)
      : (els
          .filter((el) => sectionTop(root, el) - root.scrollTop <= root.clientHeight / 3)
          .at(-1) ?? els[0])
    if (current) setActive(current.id)
  }

  const jump = (id: string): void => {
    const root = node
    const el = root?.querySelector<HTMLElement>(`#${id}`)
    if (!root || !el) return
    setActive(id)
    if (jumping.current !== null) window.clearTimeout(jumping.current)
    jumping.current = window.setTimeout(() => (jumping.current = null), 600)
    root.scrollTo({ top: sectionTop(root, el) - 16, behavior: 'smooth' })
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="flex h-[min(85vh,760px)] flex-col gap-0 p-0 sm:max-w-3xl">
        <div className="grid gap-3 border-b px-6 pt-5 pb-3">
          <div className="flex items-baseline gap-3 pr-8">
            <DialogTitle className="truncate">{title}</DialogTitle>
            {badge}
          </div>
          <DialogDescription className="sr-only">{description}</DialogDescription>
          <nav className="bg-muted/60 flex gap-0.5 self-start overflow-x-auto rounded-lg p-0.5">
            {tabs.map((tab) => (
              <button
                key={tab.id}
                type="button"
                onClick={() => jump(tab.id)}
                className={cn(
                  'rounded-md px-2.5 py-1 text-xs font-medium whitespace-nowrap transition-colors',
                  (active || tabs[0]?.id) === tab.id
                    ? 'bg-background text-foreground shadow-sm'
                    : 'text-muted-foreground hover:text-foreground',
                  errors[tab.id] && 'text-destructive'
                )}
              >
                {tab.title}
              </button>
            ))}
          </nav>
        </div>
        <div ref={setNode} onScroll={onScroll} className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
          {children}
        </div>
        <div className="flex justify-end gap-2 border-t px-6 py-3">{footer}</div>
      </DialogContent>
    </Dialog>
  )
}
