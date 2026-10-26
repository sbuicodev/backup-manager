import { useEffect, useState } from 'react'
import { FolderOpen, HardDrive, Pencil, Plus, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { newDestination, type Config, type Destination } from '@shared/schema'
import { PageHeader } from '@/components/PageHeader'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle
} from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow
} from '@/components/ui/table'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { SizeInput } from '@/components/SizeInput'
import { api } from '@/lib/api'
import type { UseConfig } from '@/hooks/useConfig'

function useAvailability(): Record<string, boolean> {
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

function DestinationDialog({
  initial,
  onSave,
  onClose
}: {
  initial: Destination | null
  onSave: (d: Destination) => Promise<boolean>
  onClose: () => void
}): React.JSX.Element {
  const [name, setName] = useState(initial?.name ?? '')
  const [path, setPath] = useState(initial?.path ?? '')
  const [zipLimit, setZipLimit] = useState(initial?.zipPartLimitBytes ?? null)
  const [forceChunk, setForceChunk] = useState(initial?.forceChunkOversized ?? false)
  const browse = async (): Promise<void> => {
    const p = await api.dialog.pickFolder()
    if (p) {
      setPath(p)
      if (!name) setName(p.split(/[\\/]/).filter(Boolean).pop() ?? '')
    }
  }
  const submit = async (): Promise<void> => {
    const d = {
      ...(initial ?? newDestination(path, name.trim())),
      name: name.trim(),
      path,
      zipPartLimitBytes: zipLimit,
      forceChunkOversized: forceChunk
    }
    if (await onSave(d)) onClose()
  }
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{initial ? 'Edit destination' : 'Add destination'}</DialogTitle>
        </DialogHeader>
        <div className="grid gap-4">
          <div className="grid gap-2">
            <Label htmlFor="dest-path">Folder</Label>
            <div className="flex gap-2">
              <Input id="dest-path" value={path} onChange={(e) => setPath(e.target.value)} />
              <Button variant="outline" onClick={browse}>
                <FolderOpen /> Browse…
              </Button>
            </div>
            <p className="text-muted-foreground text-xs">
              External drives, network shares and synced folders (e.g. OneDrive) all work. The
              folder must exist when a backup runs; it is never created automatically.
            </p>
          </div>
          <div className="grid gap-2">
            <Label htmlFor="dest-name">Name</Label>
            <Input id="dest-name" value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <div className="grid gap-2">
            <Label>Limit zip parts to</Label>
            <SizeInput
              value={zipLimit}
              onChange={setZipLimit}
              offLabel="No limit (use each source's setting)"
              defaultBytes={4095 * 1024 ** 2}
            />
            <p className="text-muted-foreground text-xs">
              FAT32 drives can&apos;t store files of 4 GB or more — use 4095 MB.
            </p>
          </div>
          <label className="flex items-center gap-2 text-sm">
            <Switch checked={forceChunk} onCheckedChange={setForceChunk} />
            Always split files larger than the limit into chunks
          </label>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={!name.trim() || !path}>
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export function Destinations({
  cfg,
  config
}: {
  cfg: UseConfig
  config: Config
}): React.JSX.Element {
  const avail = useAvailability()
  const [editing, setEditing] = useState<Destination | 'new' | null>(null)
  const [deleting, setDeleting] = useState<Destination | null>(null)

  const save = async (next: Config): Promise<boolean> => {
    const errors = await cfg.save(next)
    if (errors) {
      toast.error('Could not save', { description: errors.join('\n') })
      return false
    }
    return true
  }
  const upsert = (d: Destination): Promise<boolean> => {
    const exists = config.destinations.some((x) => x.id === d.id)
    return save({
      ...config,
      destinations: exists
        ? config.destinations.map((x) => (x.id === d.id ? d : x))
        : [...config.destinations, d]
    })
  }
  const affected = deleting
    ? config.sources.filter(
        (s) => s.destinationIds !== 'all' && s.destinationIds.includes(deleting.id)
      )
    : []
  const remove = async (d: Destination): Promise<void> => {
    await save({
      ...config,
      destinations: config.destinations.filter((x) => x.id !== d.id),
      sources: config.sources.map((s) =>
        s.destinationIds === 'all'
          ? s
          : { ...s, destinationIds: s.destinationIds.filter((id) => id !== d.id) }
      )
    })
    setDeleting(null)
  }

  return (
    <div>
      <PageHeader
        title="Destinations"
        description="Where backups are written. Every source goes to all destinations unless you pick specific ones."
        actions={
          <Button onClick={() => setEditing('new')}>
            <Plus /> Add destination
          </Button>
        }
      />
      {config.destinations.length === 0 ? (
        <div className="text-muted-foreground flex flex-col items-center gap-2 rounded-lg border border-dashed p-10 text-sm">
          <HardDrive className="size-8" />
          No destinations yet. Add a folder on an external drive, NAS or synced cloud folder.
        </div>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-8" />
              <TableHead>Name</TableHead>
              <TableHead>Folder</TableHead>
              <TableHead className="w-20">Enabled</TableHead>
              <TableHead className="w-24" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {config.destinations.map((d) => (
              <TableRow key={d.id}>
                <TableCell>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <span
                        className={`inline-block size-2.5 rounded-full ${
                          avail[d.id] === undefined
                            ? 'bg-muted-foreground/40'
                            : avail[d.id]
                              ? 'bg-emerald-500'
                              : 'bg-red-500'
                        }`}
                      />
                    </TooltipTrigger>
                    <TooltipContent>
                      {avail[d.id] ? 'Available' : 'Not available (drive unplugged?)'}
                    </TooltipContent>
                  </Tooltip>
                </TableCell>
                <TableCell className="font-medium">{d.name}</TableCell>
                <TableCell className="text-muted-foreground max-w-0 truncate font-mono text-xs">
                  {d.path}
                </TableCell>
                <TableCell>
                  <Switch
                    checked={d.enabled}
                    onCheckedChange={(enabled) => void upsert({ ...d, enabled })}
                  />
                </TableCell>
                <TableCell className="text-right">
                  <Button variant="ghost" size="icon" onClick={() => setEditing(d)}>
                    <Pencil />
                  </Button>
                  <Button variant="ghost" size="icon" onClick={() => setDeleting(d)}>
                    <Trash2 />
                  </Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
      {editing && (
        <DestinationDialog
          initial={editing === 'new' ? null : editing}
          onSave={upsert}
          onClose={() => setEditing(null)}
        />
      )}
      <AlertDialog open={deleting !== null} onOpenChange={(o) => !o && setDeleting(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove “{deleting?.name}”?</AlertDialogTitle>
            <AlertDialogDescription>
              Existing backups in the folder are not deleted.
              {affected.length > 0 &&
                ` It will also be removed from: ${affected.map((s) => s.name).join(', ')}.`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => deleting && void remove(deleting)}>
              Remove
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
