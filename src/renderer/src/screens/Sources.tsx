import { useState } from 'react'
import { FolderInput, Pencil, Play, Plus, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import type { Config, Source } from '@shared/schema'
import type { SchedulerStatus } from '@shared/types'
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
import { Switch } from '@/components/ui/switch'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow
} from '@/components/ui/table'
import type { UseConfig } from '@/hooks/useConfig'
import { useNow } from '@/hooks/useSchedulerStatus'
import { api } from '@/lib/api'
import { describeSchedule, formatRelativeTime } from '@/lib/format'
import { SourceEditor } from './SourceEditor'

const PACKAGING: Record<Source['packaging'], string> = {
  copy: 'Copy',
  'zip-whole': 'One zip',
  'zip-children': 'Zip each item'
}

export function Sources({
  cfg,
  config,
  status
}: {
  cfg: UseConfig
  config: Config
  status: SchedulerStatus | null
}): React.JSX.Element {
  const now = useNow()
  const [editing, setEditing] = useState<Source | 'new' | null>(null)
  const [deleting, setDeleting] = useState<Source | null>(null)

  const save = async (next: Config): Promise<void> => {
    const errors = await cfg.save(next)
    if (errors) toast.error('Could not save', { description: errors.join('\n') })
  }
  const runNow = async (s: Source): Promise<void> => {
    const id = await api.run.start([s.id])
    if (id) toast.success(`“${s.name}” queued`)
    else toast.info(`“${s.name}” is already queued or has no destinations`)
  }
  const nextRun = (id: string): string | null => {
    const at = status?.nextRuns.find((n) => n.sourceId === id)?.at
    return at ? formatRelativeTime(new Date(at), now) : null
  }

  return (
    <div>
      <PageHeader
        title="Sources"
        description="Folders to back up. Each one has its own packaging, mode and schedule."
        actions={
          <Button onClick={() => setEditing('new')}>
            <Plus /> Add source
          </Button>
        }
      />
      {config.sources.length === 0 ? (
        <div className="text-muted-foreground flex flex-col items-center gap-2 rounded-lg border border-dashed p-10 text-sm">
          <FolderInput className="size-8" />
          No sources yet. Add a folder you want to back up.
        </div>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-[38%]">Source</TableHead>
              <TableHead>Backup</TableHead>
              <TableHead>Schedule</TableHead>
              <TableHead className="w-20">Enabled</TableHead>
              <TableHead className="w-32" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {config.sources.map((s) => (
              <TableRow key={s.id}>
                <TableCell className="max-w-0">
                  <div className="font-medium">{s.name}</div>
                  <div className="text-muted-foreground truncate font-mono text-xs">{s.path}</div>
                </TableCell>
                <TableCell>
                  <div className="flex gap-1">
                    <Badge variant="secondary">
                      {s.mode === 'mirror' ? 'Mirror' : 'Snapshots'}
                    </Badge>
                    <Badge variant="outline">{PACKAGING[s.packaging]}</Badge>
                  </div>
                </TableCell>
                <TableCell>
                  <div className="text-sm">{describeSchedule(s.schedule)}</div>
                  {s.enabled && nextRun(s.id) && (
                    <div className="text-muted-foreground text-xs">next {nextRun(s.id)}</div>
                  )}
                </TableCell>
                <TableCell>
                  <Switch
                    checked={s.enabled}
                    onCheckedChange={(enabled) =>
                      void save({
                        ...config,
                        sources: config.sources.map((x) => (x.id === s.id ? { ...x, enabled } : x))
                      })
                    }
                  />
                </TableCell>
                <TableCell className="text-right whitespace-nowrap">
                  <Button
                    variant="ghost"
                    size="icon"
                    title="Run now"
                    disabled={!s.enabled}
                    onClick={() => void runNow(s)}
                  >
                    <Play />
                  </Button>
                  <Button variant="ghost" size="icon" title="Edit" onClick={() => setEditing(s)}>
                    <Pencil />
                  </Button>
                  <Button variant="ghost" size="icon" title="Remove" onClick={() => setDeleting(s)}>
                    <Trash2 />
                  </Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
      {editing && (
        <SourceEditor
          config={config}
          initial={editing === 'new' ? null : editing}
          onSave={cfg.save}
          onClose={() => setEditing(null)}
        />
      )}
      <AlertDialog open={deleting !== null} onOpenChange={(o) => !o && setDeleting(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove “{deleting?.name}”?</AlertDialogTitle>
            <AlertDialogDescription>
              It will no longer be backed up. Existing backups are not deleted.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() =>
                deleting &&
                void save({
                  ...config,
                  sources: config.sources.filter((x) => x.id !== deleting.id)
                }).then(() => setDeleting(null))
              }
            >
              Remove
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
