import i18n from 'i18next'
import { beforeEach, expect, it, vi } from 'vitest'
import enApp from '@/locales/en/app.json'
import zhApp from '@/locales/zh/app.json'
import enTasks from '@/locales/en/tasks.json'
import zhTasks from '@/locales/zh/tasks.json'
import { initI18n } from '@/i18n/init'
import { ensureTaskResources, taskResourcesReady } from '@/i18n/task-resources'

beforeEach(async () => {
  vi.restoreAllMocks()
  initI18n()
  i18n.removeResourceBundle('en', 'app')
  i18n.removeResourceBundle('zh', 'app')
  i18n.addResourceBundle('en', 'app', enApp)
  i18n.addResourceBundle('zh', 'app', zhApp)
  await i18n.changeLanguage('en')
})

it('loads task copy on demand and preserves existing global labels', async () => {
  expect(taskResourcesReady('en')).toBe(false)
  await ensureTaskResources('en')
  expect(taskResourcesReady('en')).toBe(true)
  expect(i18n.t('studentTasks.subtitle')).toBe(enTasks['studentTasks.subtitle'])
  expect(i18n.t('studentTasks.title')).toBe(enApp['studentTasks.title'])
})

it('coalesces concurrent requests and supplies the English fallback', async () => {
  const add = vi.spyOn(i18n, 'addResourceBundle')
  await Promise.all([ensureTaskResources('en'), ensureTaskResources('de'), ensureTaskResources('ja')])
  expect(add).toHaveBeenCalledTimes(1)
  expect(i18n.t('teacherTasks.hint', { lng: 'ja' })).toBe(enTasks['teacherTasks.hint'])
})

it('loads both fallback and Chinese copy before declaring Chinese ready', async () => {
  await ensureTaskResources('en')
  expect(taskResourcesReady('zh')).toBe(false)
  await ensureTaskResources('zh')
  expect(taskResourcesReady('zh')).toBe(true)
  expect(i18n.t('studentTasks.subtitle', { lng: 'zh' })).toBe(zhTasks['studentTasks.subtitle'])
  expect(i18n.t('studentTasks.title', { lng: 'zh' })).toBe(zhApp['studentTasks.title'])
})

it('does not permanently cache a failed resource application', async () => {
  const add = i18n.addResourceBundle.bind(i18n)
  vi.spyOn(i18n, 'addResourceBundle').mockImplementationOnce(() => { throw new Error('Unavailable resource') }).mockImplementation(add)
  await expect(ensureTaskResources('en')).rejects.toThrow('Unavailable resource')
  expect(taskResourcesReady('en')).toBe(false)
  await ensureTaskResources('en')
  expect(taskResourcesReady('en')).toBe(true)
})

it('keeps task keys and interpolation parameters in parity', () => {
  expect(Object.keys(zhTasks).sort()).toEqual(Object.keys(enTasks).sort())
  const params = (text: string) => [...text.matchAll(/{{\s*([\w]+)\s*}}/g)].map(match => match[1]).sort()
  for (const key of Object.keys(enTasks) as (keyof typeof enTasks)[]) {
    expect(params(zhTasks[key]), key).toEqual(params(enTasks[key]))
    expect(Object.hasOwn(enApp, key), key).toBe(false)
  }
})
