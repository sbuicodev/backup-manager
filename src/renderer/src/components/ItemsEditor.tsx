import { useState } from 'react'
import {
  ArrowUpToLine,
  File as FileIcon,
  FilePlus,
  Folder,
  FolderInput,
  FolderPlus,
  Plus,
  X
} from 'lucide-react'
import { fileName, type SourceItem } from '@shared/schema'
import { Button } from '@/components/ui/button'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger
} from '@/components/ui/context-menu'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { t } from '@/i18n'
import { api } from '@/lib/api'
import { shortPath } from '@/lib/summary'
import { cn } from '@/lib/utils'

/** Drag payload for items moved inside the list (their paths, as JSON). */
const ITEM_DRAG = 'application/x-backup-items'

/** A subfolder name nobody uses yet: "New Folder", "New Folder 2", … */
function freshName(taken: string[]): string {
  const base = t('items.newFolderName')
  let name = base
  for (let n = 2; taken.includes(name); n++) name = `${base} ${n}`
  return name
}

/** Cleans a typed subfolder: "/" separators, no empty or dot-led parts. */
function cleanFolder(raw: string): string {
  return raw
    .split(/[\\/]+/)
    .map((s) => s.trim())
    .filter((s) => s && !s.startsWith('.'))
    .join('/')
}

/** `item` placed in `folder` ('' = top level), keeping its alias. */
const placed = (item: SourceItem, folder: string): SourceItem => {
  const { folder: _old, ...rest } = item
  void _old
  return folder ? { ...rest, folder } : rest
}

/** Asks for the name an item gets at the destination; empty means its own name. */
function AliasDialog({
  item,
  onSave,
  onClose
}: {
  item: SourceItem
  onSave: (alias: string | undefined) => void
  onClose: () => void
}): React.JSX.Element {
  const [value, setValue] = useState(item.alias ?? '')
  const own = fileName(item.path)
  const bad = value.trim() !== '' && (/[\\/]/.test(value) || value.trim().startsWith('.'))
  const save = (): void => {
    if (bad) return
    onSave(value.trim() && value.trim() !== own ? value.trim() : undefined)
    onClose()
  }
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t('items.aliasTitle')}</DialogTitle>
          <DialogDescription>{t('items.aliasHint', { name: own })}</DialogDescription>
        </DialogHeader>
        <Input
          autoFocus
          placeholder={own}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && save()}
        />
        {bad && <p className="text-destructive text-xs">{t('items.aliasInvalid')}</p>}
        <DialogFooter>
          {item.alias && (
            <Button
              variant="ghost"
              className="mr-auto"
              onClick={() => (onSave(undefined), onClose())}
            >
              {t('items.useOwnName')}
            </Button>
          )}
          <Button variant="outline" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button onClick={save}>{t('common.save')}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/**
 * The files and folders of a backup, Finder style: items at the top level, then one group per
 * subfolder. Click, ⌘-click and ⇧-click select items; drag them, or use the right-click menu, to
 * move them between subfolders or give one an alias (its name at the destination).
 */
export function ItemsEditor({
  items,
  onChange
}: {
  items: SourceItem[]
  onChange: (items: SourceItem[]) => void
}): React.JSX.Element {
  // Subfolders made with New Subfolder that hold nothing yet (not saved until they do).
  const [empty, setEmpty] = useState<string[]>([])
  const [renaming, setRenaming] = useState<string | null>(null)
  const [over, setOver] = useState<string | null>(null)
  // True while some subfolder items are being dragged: shows the Top level target.
  const [draggingOut, setDraggingOut] = useState(false)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [anchor, setAnchor] = useState<string | null>(null)
  const [aliasing, setAliasing] = useState<SourceItem | null>(null)
  // macOS can pick files and folders in one dialog; Windows and Linux need one for each.
  const mixedPicker = api.app.platform === 'darwin'

  const used = [...new Set(items.flatMap((i) => (i.folder ? [i.folder] : [])))]
  const folders = [...new Set([...used, ...empty])].sort((a, b) => a.localeCompare(b))
  // Display order, for ⇧-click ranges.
  const ordered = [
    ...items.filter((i) => !i.folder),
    ...folders.flatMap((f) => items.filter((i) => i.folder === f))
  ]

  const add = (picked: SourceItem[], folder: string): void => {
    const fresh = picked.filter((p) => !items.some((i) => i.path === p.path))
    if (fresh.length === 0) return
    onChange([...items, ...fresh.map((p) => placed(p, folder))])
    setEmpty(empty.filter((f) => f !== folder))
  }
  const pick = async (mode: 'any' | 'files' | 'folders'): Promise<void> =>
    add(await api.dialog.pickItems(mode, items.at(-1)?.path), '')
  const moveTo = (paths: string[], folder: string): void => {
    const moving = new Set(paths)
    const next = items.map((i) => (moving.has(i.path) ? placed(i, folder) : i))
    onChange(next)
    // Subfolders emptied by the move stay in the list until removed.
    const emptied = used.filter((f) => f !== folder && !next.some((i) => i.folder === f))
    setEmpty([...new Set([...empty, ...emptied])].filter((f) => f !== folder))
  }
  const rename = (from: string, raw: string): void => {
    setRenaming(null)
    const to = cleanFolder(raw)
    if (!to || to === from) return
    onChange(items.map((i) => (i.folder === from ? { ...i, folder: to } : i)))
    setEmpty(empty.map((f) => (f === from ? to : f)))
  }
  const removeFolder = (folder: string): void => {
    onChange(items.map((i) => (i.folder === folder ? placed(i, '') : i)))
    setEmpty(empty.filter((f) => f !== folder))
  }
  /** A new subfolder, holding `paths` when given, ready to be named. */
  const newFolder = (paths: string[] = []): void => {
    const name = freshName(folders)
    if (paths.length > 0) moveTo(paths, name)
    else setEmpty([...empty, name])
    setRenaming(name)
  }
  const remove = (paths: string[]): void => {
    const gone = new Set(paths)
    onChange(items.filter((i) => !gone.has(i.path)))
    setSelected(new Set())
  }

  const click = (e: React.MouseEvent, path: string): void => {
    if (e.shiftKey && anchor) {
      const a = ordered.findIndex((i) => i.path === anchor)
      const b = ordered.findIndex((i) => i.path === path)
      const range = ordered.slice(Math.min(a, b), Math.max(a, b) + 1).map((i) => i.path)
      setSelected(new Set(e.metaKey || e.ctrlKey ? [...selected, ...range] : range))
      return
    }
    if (e.metaKey || e.ctrlKey) {
      const next = new Set(selected)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      setSelected(next)
    } else setSelected(new Set([path]))
    setAnchor(path)
  }
  /** What a right-click or drag acts on: the selection when the item is in it, else the item. */
  const targetsOf = (path: string): string[] => (selected.has(path) ? [...selected] : [path])

  // Each group accepts items dragged inside the list and files dropped from outside.
  const dropZone = (folder: string): React.HTMLAttributes<HTMLDivElement> => ({
    onDragOver: (e) => {
      e.preventDefault()
      setOver(folder)
    },
    onDragLeave: (e) => {
      if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOver(null)
    },
    onDrop: (e) => {
      e.preventDefault()
      e.stopPropagation()
      setOver(null)
      setDraggingOut(false)
      const moved = e.dataTransfer.getData(ITEM_DRAG)
      if (moved) return moveTo(JSON.parse(moved) as string[], folder)
      const paths = [...e.dataTransfer.files].map((f) => api.files.pathOf(f)).filter(Boolean)
      if (paths.length > 0) void api.dialog.statItems(paths).then((p) => add(p, folder))
    }
  })

  const row = (it: SourceItem, nested: boolean): React.JSX.Element => {
    const Icon = it.kind === 'folder' ? Folder : FileIcon
    const own = fileName(it.path)
    const isSelected = selected.has(it.path)
    const targets = targetsOf(it.path)
    return (
      <ContextMenu
        key={it.path}
        onOpenChange={(open) => {
          if (open && !isSelected) {
            setSelected(new Set([it.path]))
            setAnchor(it.path)
          }
        }}
      >
        <ContextMenuTrigger asChild>
          <div
            draggable
            onClick={(e) => click(e, it.path)}
            onDragEnd={() => {
              setDraggingOut(false)
              setOver(null)
            }}
            onDragStart={(e) => {
              e.dataTransfer.setData(ITEM_DRAG, JSON.stringify(targets))
              e.dataTransfer.effectAllowed = 'move'
              // Shown a tick later: changing the page during dragstart can cancel the drag.
              const out = items.some((i) => targets.includes(i.path) && i.folder)
              setTimeout(() => setDraggingOut(out))
            }}
            className={cn(
              'flex min-w-0 cursor-default items-center gap-2 border-b px-3 py-2 text-sm select-none',
              nested && 'pl-9',
              isSelected && 'bg-primary/10'
            )}
          >
            <Icon className="text-muted-foreground size-4 shrink-0" />
            <span className="max-w-[60%] shrink-0 truncate font-medium">
              {it.alias ? <em>{it.alias}</em> : own}
            </span>
            {it.alias && <span className="text-muted-foreground shrink-0 text-xs">{own}</span>}
            <span
              className="text-muted-foreground min-w-0 flex-1 truncate text-right font-mono text-xs"
              title={it.path}
            >
              {shortPath(it.path)}
            </span>
            <Button
              variant="ghost"
              size="icon"
              className="size-7"
              aria-label={t('form.remove', { name: own })}
              onClick={(e) => {
                e.stopPropagation()
                remove([it.path])
              }}
            >
              <X />
            </Button>
          </div>
        </ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuItem disabled={targets.length > 1} onSelect={() => setAliasing(it)}>
            {t('items.setAlias')}
          </ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuSub>
            <ContextMenuSubTrigger>{t('items.moveTo')}</ContextMenuSubTrigger>
            <ContextMenuSubContent>
              <ContextMenuItem onSelect={() => moveTo(targets, '')}>
                {t('items.topLevel')}
              </ContextMenuItem>
              {folders.map((f) => (
                <ContextMenuItem key={f} onSelect={() => moveTo(targets, f)}>
                  {f}
                </ContextMenuItem>
              ))}
            </ContextMenuSubContent>
          </ContextMenuSub>
          <ContextMenuItem onSelect={() => newFolder(targets)}>
            {t('items.newFolderWith', { count: targets.length })}
          </ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem variant="destructive" onSelect={() => remove(targets)}>
            {t('items.remove', { count: targets.length })}
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
    )
  }

  return (
    <div className="grid min-w-0">
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <div
            {...dropZone('')}
            onClick={(e) => e.target === e.currentTarget && setSelected(new Set())}
            className={cn('grid min-h-2 min-w-0', over === '' && 'bg-accent/40')}
          >
            {draggingOut && (
              <div
                className={cn(
                  'text-muted-foreground m-2 flex items-center justify-center gap-2 rounded-md border border-dashed py-2.5 text-xs',
                  over === '' && 'border-primary text-foreground'
                )}
              >
                <ArrowUpToLine className="size-4" /> {t('items.toTopLevel')}
              </div>
            )}
            {items.filter((i) => !i.folder).map((i) => row(i, false))}
          </div>
        </ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuItem onSelect={() => newFolder()}>{t('items.newFolder')}</ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
      {folders.map((folder) => (
        <div
          key={folder}
          {...dropZone(folder)}
          className={cn('grid min-w-0', over === folder && 'bg-accent/40')}
        >
          <ContextMenu>
            <ContextMenuTrigger asChild>
              <div className="bg-muted/30 flex min-w-0 items-center gap-2 border-b px-3 py-1.5 text-sm">
                <FolderInput className="size-4 shrink-0 text-sky-500" />
                {renaming === folder ? (
                  <Input
                    autoFocus
                    defaultValue={folder}
                    className="h-7 w-64"
                    onFocus={(e) => e.currentTarget.select()}
                    onBlur={(e) => rename(folder, e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') rename(folder, e.currentTarget.value)
                      if (e.key === 'Escape') setRenaming(null)
                    }}
                  />
                ) : (
                  <button
                    type="button"
                    className="min-w-0 truncate text-left font-medium"
                    title={t('items.renameHint')}
                    onDoubleClick={() => setRenaming(folder)}
                  >
                    {folder}
                  </button>
                )}
                <span className="text-muted-foreground ml-auto text-xs">
                  {items.some((i) => i.folder === folder) ? '' : t('items.dropHere')}
                </span>
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-7"
                  aria-label={t('items.removeFolder', { name: folder })}
                  onClick={() => removeFolder(folder)}
                >
                  <X />
                </Button>
              </div>
            </ContextMenuTrigger>
            <ContextMenuContent>
              <ContextMenuItem onSelect={() => setRenaming(folder)}>
                {t('items.rename')}
              </ContextMenuItem>
              <ContextMenuItem onSelect={() => newFolder()}>{t('items.newFolder')}</ContextMenuItem>
              <ContextMenuSeparator />
              <ContextMenuItem variant="destructive" onSelect={() => removeFolder(folder)}>
                {t('items.removeFolderAction')}
              </ContextMenuItem>
            </ContextMenuContent>
          </ContextMenu>
          {items.filter((i) => i.folder === folder).map((i) => row(i, true))}
        </div>
      ))}
      <div
        {...dropZone('')}
        className={cn('flex flex-wrap items-center gap-2 px-3 py-2', over === '' && 'bg-accent/40')}
      >
        {mixedPicker ? (
          <Button variant="outline" size="sm" onClick={() => void pick('any')}>
            <Plus /> {t('form.add')}
          </Button>
        ) : (
          <>
            <Button variant="outline" size="sm" onClick={() => void pick('folders')}>
              <FolderPlus /> {t('form.addFolder')}
            </Button>
            <Button variant="outline" size="sm" onClick={() => void pick('files')}>
              <FilePlus /> {t('form.addFiles')}
            </Button>
          </>
        )}
        <span className="text-muted-foreground text-xs">{t('items.hint')}</span>
      </div>
      {aliasing && (
        <AliasDialog
          item={aliasing}
          onSave={(alias) =>
            onChange(
              items.map((i) => {
                if (i.path !== aliasing.path) return i
                const { alias: _old, ...rest } = i
                void _old
                return alias ? { ...rest, alias } : rest
              })
            )
          }
          onClose={() => setAliasing(null)}
        />
      )}
    </div>
  )
}
