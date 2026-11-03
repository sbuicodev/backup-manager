import { t } from '@/i18n'
import { useState } from 'react'
import { Download, Upload } from 'lucide-react'
import { toast } from 'sonner'
import type { Config, Settings as SettingsT } from '@shared/schema'
import { Group, Row } from '@/components/BackupForm'
import { SectionSheet } from '@/components/SectionSheet'
import { Button } from '@/components/ui/button'
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

/** The app's settings, in a sheet laid out like a backup's configuration. Changes save at once. */
export function Settings({
  cfg,
  config,
  path,
  onClose
}: {
  cfg: UseConfig
  config: Config
  path: string
  onClose: () => void
}): React.JSX.Element {
  const [excludes, setExcludes] = useState(config.globalExcludes.join('\n'))
  const save = async (next: Config): Promise<void> => {
    const errors = await cfg.save(next)
    if (errors) toast.error(t('settings.couldNotSave'), { description: errors.join('\n') })
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
      toast.success(t('settings.imported'))
      await cfg.reload()
    } else {
      toast.error(t('settings.importFailed'), { description: r.errors.join('\n') })
    }
  }

  return (
    <SectionSheet
      title={t('settings.title')}
      description={t('settings.title')}
      onClose={onClose}
      footer={<Button onClick={onClose}>{t('settings.done')}</Button>}
    >
      <div className="grid gap-6">
        <Group title={t('settings.appearance')} id="appearance">
          <Row label={t('settings.glass')} hint={t('settings.glassHint')}>
            <Switch
              checked={config.settings.glass}
              onCheckedChange={(v) => void setSetting('glass', v)}
            />
          </Row>
        </Group>
        <Group title={t('settings.background')} id="background">
          <Row label={t('settings.login')} hint={t('settings.loginHint')}>
            <Switch
              checked={config.settings.launchAtLogin}
              onCheckedChange={(v) => void setSetting('launchAtLogin', v)}
            />
          </Row>
          <Row label={t('settings.battery')} hint={t('settings.batteryHint')}>
            <Switch
              checked={config.settings.skipScheduledOnBattery}
              onCheckedChange={(v) => void setSetting('skipScheduledOnBattery', v)}
            />
          </Row>
          <Row label={t('settings.notifications')}>
            <Select
              value={config.settings.notifications}
              onValueChange={(v) =>
                void setSetting('notifications', v as SettingsT['notifications'])
              }
            >
              <SelectTrigger className="w-64">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="problems">{t('settings.problems')}</SelectItem>
                <SelectItem value="always">{t('settings.always')}</SelectItem>
                <SelectItem value="never">{t('settings.never')}</SelectItem>
              </SelectContent>
            </Select>
          </Row>
        </Group>
        <Group title={t('settings.excludes')} id="exclusions">
          <Row label={t('settings.excludesLabel')} hint={t('settings.excludesHint')} stack>
            <Textarea
              rows={5}
              className="font-mono text-xs"
              value={excludes}
              onChange={(e) => setExcludes(e.target.value)}
            />
            <Button
              variant="outline"
              size="sm"
              className="mt-2"
              onClick={saveExcludes}
              disabled={excludes === config.globalExcludes.join('\n')}
            >
              {t('settings.saveExcludes')}
            </Button>
          </Row>
        </Group>
        <Group title={t('settings.file')} id="file">
          <Row label={t('settings.location')} hint={path} stack>
            <div className="flex gap-2">
              <Button variant="outline" size="sm" onClick={() => void api.config.export()}>
                <Download /> {t('settings.export')}
              </Button>
              <Button variant="outline" size="sm" onClick={doImport}>
                <Upload /> {t('settings.import')}
              </Button>
            </div>
          </Row>
        </Group>
      </div>
    </SectionSheet>
  )
}
