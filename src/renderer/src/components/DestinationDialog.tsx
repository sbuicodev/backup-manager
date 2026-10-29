import { useState } from 'react'
import { FolderOpen } from 'lucide-react'
import { newDestination, type Destination } from '@shared/schema'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { SizeInput } from '@/components/SizeInput'
import { api } from '@/lib/api'

/** Add or edit a destination. A new one is created for `ownerSourceId` when given (exclusive). */
export function DestinationDialog({
  initial,
  ownerName,
  ownerSourceId = null,
  onSave,
  onClose
}: {
  initial: Destination | null
  /** Name of the source an exclusive destination belongs to, shown in the title. */
  ownerName?: string
  ownerSourceId?: string | null
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
      ...(initial ?? { ...newDestination(path, name.trim()), ownerSourceId }),
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
          {ownerName && (
            <DialogDescription>
              Only for “{ownerName}”: other sources never use it.
            </DialogDescription>
          )}
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
