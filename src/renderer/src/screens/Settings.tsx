import { useState } from 'react'
import { Download, Upload } from 'lucide-react'
import { toast } from 'sonner'
import type { Config, Settings as SettingsT } from '@shared/schema'
import { PageHeader } from '@/components/PageHeader'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import { api } from '@/lib/api'
import type { UseConfig } from '@/hooks/useConfig'

function Row({
  label,
  hint,
  children
}: {
  label: string
  hint?: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <div className="flex items-center justify-between gap-6 py-3">
      <div>
        <Label>{label}</Label>
        {hint && <p className="text-muted-foreground mt-1 text-xs">{hint}</p>}
      </div>
      {children}
    </div>
  )
}

export function Settings({
  cfg,
  config,
  path
}: {
  cfg: UseConfig
  config: Config
  path: string
}): React.JSX.Element {
  const [excludes, setExcludes] = useState(config.globalExcludes.join('\n'))
  const save = async (next: Config): Promise<void> => {
    const errors = await cfg.save(next)
    if (errors) toast.error('Could not save', { description: errors.join('\n') })
  }
  const setSetting = <K extends keyof SettingsT>(key: K, value: SettingsT[K]): Promise<void> =>
    save({ ...config, settings: { ...config.settings, [key]: value } })
  const saveExcludes = (): Promise<void> =>
    save({
      ...config,
      globalExcludes: excludes
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean)
    })
  const doImport = async (): Promise<void> => {
    const r = await api.config.import()
    if (!r) return
    if (r.ok) {
      toast.success('Configuration imported')
      await cfg.reload()
    } else {
      toast.error('Import failed', { description: r.errors.join('\n') })
    }
  }

  return (
    <div>
      <PageHeader title="Settings" />
      <div className="grid gap-6">
        <Card>
          <CardHeader>
            <CardTitle>Background</CardTitle>
            <CardDescription>How the app runs scheduled backups.</CardDescription>
          </CardHeader>
          <CardContent className="divide-y">
            <Row label="Launch at login" hint="Starts hidden in the menu bar / system tray.">
              <Switch
                checked={config.settings.launchAtLogin}
                onCheckedChange={(v) => void setSetting('launchAtLogin', v)}
              />
            </Row>
            <Row
              label="Skip scheduled runs on battery"
              hint="Due backups wait until the computer is plugged in."
            >
              <Switch
                checked={config.settings.skipScheduledOnBattery}
                onCheckedChange={(v) => void setSetting('skipScheduledOnBattery', v)}
              />
            </Row>
            <Row label="Notifications">
              <Select
                value={config.settings.notifications}
                onValueChange={(v) =>
                  void setSetting('notifications', v as SettingsT['notifications'])
                }
              >
                <SelectTrigger className="w-56">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="problems">Only failures and warnings</SelectItem>
                  <SelectItem value="always">After every run</SelectItem>
                  <SelectItem value="never">Never</SelectItem>
                </SelectContent>
              </Select>
            </Row>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Global exclusions</CardTitle>
            <CardDescription>
              Glob patterns skipped in every source (unless a source turns them off). One per line;
              a pattern without “/” matches at any depth, a trailing “/” matches folders only.
            </CardDescription>
          </CardHeader>
          <CardContent className="grid gap-3">
            <Textarea
              rows={5}
              className="font-mono text-xs"
              value={excludes}
              onChange={(e) => setExcludes(e.target.value)}
            />
            <div>
              <Button
                variant="outline"
                onClick={saveExcludes}
                disabled={excludes === config.globalExcludes.join('\n')}
              >
                Save exclusions
              </Button>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Configuration file</CardTitle>
            <CardDescription className="font-mono text-xs break-all">{path}</CardDescription>
          </CardHeader>
          <CardContent className="flex gap-2">
            <Button variant="outline" onClick={() => void api.config.export()}>
              <Download /> Export…
            </Button>
            <Button variant="outline" onClick={doImport}>
              <Upload /> Import…
            </Button>
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
