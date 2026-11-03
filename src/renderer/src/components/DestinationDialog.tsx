import { t } from '@/i18n'
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

/**
 * The one sheet for creating or editing a destination, wherever it's opened from. Opened from a
 * backup (`owner`), a new destination can be made for that backup only.
 */
export function DestinationDialog({
  initial,
  owner,
  onSave,
  onClose
}: {
  initial: Destination | null
  /** The backup it's opened from; its id becomes `ownerSourceId` when "Only this backup" is on. */
  owner?: { id: string; name: string }
  onSave: (d: Destination) => Promise<boolean>
  onClose: () => void
}): React.JSX.Element {
  const [onlyThis, setOnlyThis] = useState(false)
  const [name, setName] = useState(initial?.name ?? '')
  const [path, setPath] = useState(initial?.path ?? '')
  const [zipLimit, setZipLimit] = useState(initial?.zipPartLimitBytes ?? null)
  const [forceChunk, setForceChunk] = useState(initial?.forceChunkOversized ?? false)
  const browse = async (): Promise<void> => {
    const p = await api.dialog.pickFolder(path.trim() || undefined)
    if (p) {
      setPath(p)
      if (!name) setName(p.split(/[\\/]/).filter(Boolean).pop() ?? '')
    }
  }
  const submit = async (): Promise<void> => {
    const d = {
      ...(initial ?? {
        ...newDestination(path, name.trim()),
        ownerSourceId: owner && onlyThis ? owner.id : null
      }),
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
          <DialogTitle>{initial ? t('destination.edit') : t('destination.add')}</DialogTitle>
          {initial?.ownerSourceId && owner && (
            <DialogDescription>{t('destination.onlyFor', { name: owner.name })}</DialogDescription>
          )}
        </DialogHeader>
        <div className="grid gap-4">
          {!initial && owner && (
            <label className="flex items-start gap-3 text-sm">
              <Switch checked={onlyThis} onCheckedChange={setOnlyThis} />
              <span>
                {t('destination.onlyThis')}
                <span className="text-muted-foreground block text-xs">
                  {t('destination.onlyThisHint')}
                </span>
              </span>
            </label>
          )}
          <div className="grid gap-2">
            <Label htmlFor="dest-path">{t('destination.folder')}</Label>
            <div className="flex gap-2">
              <Input id="dest-path" value={path} onChange={(e) => setPath(e.target.value)} />
              <Button variant="outline" onClick={browse}>
                <FolderOpen /> {t('destination.browse')}
              </Button>
            </div>
            <p className="text-muted-foreground text-xs">{t('destination.folderHint')}</p>
          </div>
          <div className="grid gap-2">
            <Label htmlFor="dest-name">{t('destination.name')}</Label>
            <Input id="dest-name" value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <div className="grid gap-2">
            <Label>{t('destination.limit')}</Label>
            <SizeInput
              value={zipLimit}
              onChange={setZipLimit}
              offLabel={t('destination.noLimit')}
              defaultBytes={4095 * 1024 ** 2}
            />
            <p className="text-muted-foreground text-xs">{t('destination.fat32')}</p>
          </div>
          <label className="flex items-center gap-2 text-sm">
            <Switch checked={forceChunk} onCheckedChange={setForceChunk} />
            {t('destination.forceChunk')}
          </label>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button onClick={submit} disabled={!name.trim() || !path}>
            {t('common.save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
