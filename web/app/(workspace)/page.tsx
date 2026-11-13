'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { useTranslation } from 'react-i18next'
import { fetchAuthStatus } from '@/lib/auth'
import { defaultAccountHome } from '@/lib/student-task-access'
import { Button, InlineAlert } from '@/shared/ui'

export default function HomePage() {
  const router = useRouter()
  const { t } = useTranslation()
  const [failed, setFailed] = useState(false)
  const [retry, setRetry] = useState(0)
  useEffect(() => {
    let alive = true
    void fetchAuthStatus().then(status => {
      if (!alive) return
      if (!status) { setFailed(true); return }
      router.replace(status.enabled && !status.authenticated ? '/login' : defaultAccountHome(status))
    })
    return () => { alive = false }
  }, [router, retry])
  return <div className="p-6">{failed ? <InlineAlert tone="warning" action={<Button onClick={() => { setFailed(false); setRetry(value => value + 1) }}>{t('Retry')}</Button>}>{t('Could not reach the server')}</InlineAlert> : <p role="status">{t('Loading…')}</p>}</div>
}
