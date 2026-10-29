import { useState } from 'react'
import { HardDrive, Pencil, Plus, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import type { Config, Destination } from '@shared/schema'
import { DestinationDialog } from '@/components/DestinationDialog'
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
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
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
import { useAvailability } from '@/hooks/useAvailability'
import type { UseConfig } from '@/hooks/useConfig'

/** Which destinations the list shows: shared ones, all, or those exclusive to one source. */
type Filter = 'shared' | 'all' | `source:${string}`

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
  const [filter, setFilter] = useState<Filter>('shared')
  const sourceName = (id: string): string =>
    config.sources.find((s) => s.id === id)?.name ?? 'removed source'
  const owners = [
    ...new Set(config.destinations.flatMap((d) => (d.ownerSourceId ? [d.ownerSourceId] : [])))
  ]
  const shown = config.destinations.filter((d) =>
    filter === 'all'
      ? true
      : filter === 'shared'
        ? d.ownerSourceId === null
        : d.ownerSourceId === filter.slice('source:'.length)
  )

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
        description="Where backups are written. Every source goes to all shared destinations unless you pick specific ones; a source can also have destinations of its own."
        actions={
          <Button onClick={() => setEditing('new')}>
            <Plus /> Add destination
          </Button>
        }
      />
      {owners.length > 0 && (
        <div className="mb-3 flex items-center gap-2 text-sm">
          <span className="text-muted-foreground">Show</span>
          <Select value={filter} onValueChange={(v) => setFilter(v as Filter)}>
            <SelectTrigger className="w-64">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="shared">Shared destinations</SelectItem>
              <SelectItem value="all">All destinations</SelectItem>
              {owners.map((id) => (
                <SelectItem key={id} value={`source:${id}`}>
                  Only for {sourceName(id)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {filter === 'shared' && (
            <span className="text-muted-foreground text-xs">
              {config.destinations.length - shown.length} source-only hidden
            </span>
          )}
        </div>
      )}
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
            {shown.map((d) => (
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
                <TableCell className="font-medium">
                  {d.name}
                  {d.ownerSourceId && (
                    <Badge variant="secondary" className="ml-2">
                      Only for {sourceName(d.ownerSourceId)}
                    </Badge>
                  )}
                </TableCell>
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
          ownerName={
            editing !== 'new' && editing.ownerSourceId
              ? sourceName(editing.ownerSourceId)
              : undefined
          }
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
