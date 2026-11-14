import i18n from 'i18next'
import { initI18n, normalizeLanguage } from './init'

const pending = new Map<string, Promise<void>>()

function hasLanguage(language: string) {
  return typeof i18n.getResource(language, 'app', 'studentTasks.subtitle') === 'string' &&
    typeof i18n.getResource(language, 'app', 'teacherTasks.hint') === 'string' &&
    typeof i18n.getResource(language, 'app', 'studentTaskVoice.listen') === 'string' &&
    typeof i18n.getResource(language, 'app', 'studentTaskHints.first') === 'string' &&
    typeof i18n.getResource(language, 'app', 'teacherTaskHints.editorTitle') === 'string'
}

/** Task copy is loaded with the task feature, outside the shared application bundle. */
export function taskResourcesReady(language: string) {
  return hasLanguage('en') && (normalizeLanguage(language) !== 'zh' || hasLanguage('zh'))
}

function loadLanguage(language: 'en' | 'zh'): Promise<void> {
  if (hasLanguage(language)) return Promise.resolve()
  const current = pending.get(language)
  if (current) return current
  const operation = (language === 'zh'
    ? import('@/locales/zh/tasks.json')
    : import('@/locales/en/tasks.json'))
    .then(resource => { i18n.addResourceBundle(language, 'app', resource.default, true, true) })
    .finally(() => { pending.delete(language) })
  pending.set(language, operation)
  return operation
}

export async function ensureTaskResources(language: string) {
  initI18n()
  await loadLanguage('en')
  if (normalizeLanguage(language) === 'zh') await loadLanguage('zh')
}
