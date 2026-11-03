import { t } from '@/i18n'
import type { Config, Destination } from '@shared/schema'
import { BackupForm } from '@/components/BackupForm'
import { SectionSheet } from '@/components/SectionSheet'
import { Button } from '@/components/ui/button'
import type { Draft } from '@/lib/backup-draft'

/**
 * A backup's whole configuration as one scrolling page, with tabs on top that follow the scroll
 * and jump to their section. Nothing is saved until Save.
 */
export function BackupConfigDialog({
  config,
  draft,
  onChange,
  dirty,
  errors,
  section,
  onSave,
  onClose,
  addShared
}: {
  config: Config
  /** Saves a new shared destination to the configuration. */
  addShared: (d: Destination) => Promise<boolean>
  draft: Draft
  onChange: (d: Draft) => void
  dirty: boolean
  errors: Record<string, string>
  /** The section to show first. */
  section?: string
  onSave: () => void
  /** Cancel, Esc or the close button; the caller asks first when there are unsaved changes. */
  onClose: () => void
}): React.JSX.Element {
  return (
    <SectionSheet
      title={draft.source.name.trim() || t('common.newBackup')}
      badge={
        dirty && (
          <span className="text-muted-foreground flex shrink-0 items-center gap-1.5 text-xs">
            <span className="size-1.5 rounded-full bg-amber-500" /> {t('common.unsaved')}
          </span>
        )
      }
      description={t('config.description')}
      section={section}
      errors={errors}
      onClose={onClose}
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button onClick={onSave}>{t('common.save')}</Button>
        </>
      }
    >
      <BackupForm
        config={config}
        draft={draft}
        onChange={onChange}
        errors={errors}
        addShared={addShared}
      />
    </SectionSheet>
  )
}
