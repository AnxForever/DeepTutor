import { useEffect } from 'react'
import i18n from 'i18next'
import { act, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, expect, it, vi } from 'vitest'
import enApp from '@/locales/en/app.json'
import zhApp from '@/locales/zh/app.json'
import { initI18n } from '@/i18n/init'
import { TaskTranslations } from '@/components/learning/TaskTranslations'
import { ensureTaskResources, taskResourcesReady } from '@/i18n/task-resources'

vi.mock('@/i18n/task-resources', () => ({ ensureTaskResources: vi.fn(), taskResourcesReady: vi.fn() }))
function deferred() {
  let resolve!: () => void
  let reject!: (reason: Error) => void
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
beforeEach(async () => {
  vi.mocked(ensureTaskResources).mockReset()
  vi.mocked(taskResourcesReady).mockReturnValue(false)
  initI18n()
  i18n.addResourceBundle('en', 'app', enApp, true, true)
  i18n.addResourceBundle('zh', 'app', zhApp, true, true)
  await i18n.changeLanguage('en')
})

it('mounts the task only after the first resource is available and retries failure', async () => {
  const ready = deferred()
  vi.mocked(ensureTaskResources).mockRejectedValueOnce(new Error('Unavailable')).mockReturnValueOnce(ready.promise)
  render(<TaskTranslations><input aria-label="student answer" /></TaskTranslations>)
  expect(screen.queryByLabelText('student answer')).not.toBeInTheDocument()
  await userEvent.click(await screen.findByRole('button', { name: enApp['taskResources.retry'] }))
  expect(screen.queryByLabelText('student answer')).not.toBeInTheDocument()
  await act(async () => ready.resolve())
  expect(await screen.findByLabelText('student answer')).toBeVisible()
})

it('retains the same editor and unsaved answer through a language-resource failure', async () => {
  const changed = deferred()
  const retried = deferred()
  const mounted = vi.fn()
  const unmounted = vi.fn()
  function Editor() {
    useEffect(() => { mounted(); return unmounted }, [])
    return <input aria-label="student answer" defaultValue="my last step" />
  }
  vi.mocked(taskResourcesReady).mockReturnValue(true)
  vi.mocked(ensureTaskResources).mockResolvedValueOnce().mockReturnValueOnce(changed.promise).mockReturnValueOnce(retried.promise)
  render(<TaskTranslations><Editor /></TaskTranslations>)
  await screen.findByLabelText('student answer')
  await act(async () => { await i18n.changeLanguage('zh') })
  expect(screen.getByLabelText('student answer')).toHaveValue('my last step')
  expect(screen.getByLabelText('student answer')).not.toBeVisible()
  await act(async () => changed.reject(new Error('Unavailable')))
  await userEvent.click(await screen.findByRole('button', { name: zhApp['taskResources.retry'] }))
  await act(async () => retried.resolve())
  expect(screen.getByLabelText('student answer')).toBeVisible()
  expect(screen.getByLabelText('student answer')).toHaveValue('my last step')
  expect(mounted).toHaveBeenCalledTimes(1)
  expect(unmounted).not.toHaveBeenCalled()
})
