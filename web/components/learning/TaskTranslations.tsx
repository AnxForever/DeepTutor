'use client'

import { useEffect, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { Button, InlineAlert } from '@/shared/ui'
import { ensureTaskResources, taskResourcesReady } from '@/i18n/task-resources'

/** Keeps first-time task loading and retries separate from student answer state. */
export function TaskTranslations({ children, compact = false }: { children: ReactNode; compact?: boolean }) {
  const { t, i18n } = useTranslation()
  const language = i18n.resolvedLanguage || i18n.language || 'en'
  const [readyLanguage, setReadyLanguage] = useState<string | null>(() => taskResourcesReady(language) ? language : null)
  const [hasLoaded, setHasLoaded] = useState(() => taskResourcesReady(language))
  const [failure, setFailure] = useState<{ language: string; attempt: number } | null>(null)
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    let active = true
    void ensureTaskResources(language).then(() => {
      if (active) { setReadyLanguage(language); setHasLoaded(true) }
    }).catch(() => { if (active) setFailure({ language, attempt }) })
    return () => { active = false }
  }, [language, attempt])
  const blocked = readyLanguage !== language
  return <>
    {blocked && <div className={compact ? 'py-3' : 'p-6 sm:p-8'}>
      {failure?.language === language && failure.attempt === attempt ? <InlineAlert tone="warning" action={<Button size="sm" variant="secondary" onClick={() => setAttempt(value => value + 1)}>{t('taskResources.retry')}</Button>}>{t('taskResources.failed')}</InlineAlert>
        : <p role="status" className="text-sm text-muted-foreground">{t('taskResources.loading')}</p>}
    </div>}
    <div className={blocked ? 'hidden' : 'contents'} hidden={blocked} inert={blocked}>{hasLoaded ? children : null}</div>
  </>
}
