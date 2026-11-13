import { beforeEach, expect, it, vi } from 'vitest'
import { capabilityForPath } from '@/lib/capability-routes'
import { defaultAccountHome, studentTaskAccess } from '@/lib/student-task-access'
import { requestJson } from '@/shared/api/client'
import { getStudentTask, listStudentTasks, saveStudentTaskProgress, studentTasksRoute, submitStudentTask } from '@/lib/student-tasks-api'
import { navVisibleUnderPolicy } from '@/components/sidebar/nav-entries'

vi.mock('@/shared/api/client', () => ({ requestJson: vi.fn(async () => ({})) }))
const TASK = '11111111-1111-4111-8111-111111111111'
beforeEach(() => { vi.clearAllMocks(); window.history.replaceState({}, '', '/learning/tasks?dt_workspace=teacher-private') })
it('sends every inbox API request to explicit General regardless of the content workspace URL', async () => {
  await listStudentTasks({ state: 'active', limit: 30, offset: 0 })
  await getStudentTask(TASK)
  await saveStudentTaskProgress(TASK, { request_id: TASK, expected_revision: 0, current_question_index: 0, responses: [] })
  await submitStudentTask(TASK, { submission_id: TASK, expected_revision: 1, responses: [] })
  for (const [url] of vi.mocked(requestJson).mock.calls) expect(new URL(String(url), window.location.origin).searchParams.get('dt_workspace')).toBe('')
  expect(studentTasksRoute(TASK)).toBe(`/learning/tasks/${TASK}?dt_workspace=`)
})
it('only bypasses the LLM gate for the exact tasks route and descendants', () => {
  expect(capabilityForPath('/learning/tasks')).toBeNull()
  expect(capabilityForPath(`/learning/tasks/${TASK}`)).toBeNull()
  expect(capabilityForPath('/learning/tasks-other')).toBe('llm')
  expect(capabilityForPath('/learning')).toBe('llm')
  expect(capabilityForPath('/learning/teaching-analysis')).toBe('llm')
  expect(navVisibleUnderPolicy('/learning/tasks', ['tasks'])).toBe(true)
  expect(navVisibleUnderPolicy('/chat', ['tasks'])).toBe(false)
})
it('uses the verified learner preset and explicit tasks policy for default landing', () => {
  const account = { enabled: true, authenticated: true, role: 'student', user_id: 'real-account', preset: 'learner' as const, learning_policy: { age_band: '6-8', locked_persona: '', allowed_capabilities: [], default_capability: 'chat', allowed_surfaces: ['tasks'] } }
  expect(defaultAccountHome(account)).toBe('/learning/tasks?dt_workspace=')
  expect(defaultAccountHome({ ...account, preset: 'standard' })).toBe('/chat')
  expect(defaultAccountHome({ ...account, role: 'admin' })).toBe('/chat')
  expect(defaultAccountHome({ ...account, enabled: false })).toBe('/chat')
  expect(defaultAccountHome({ ...account, learning_policy: { ...account.learning_policy, allowed_surfaces: ['reading'] } })).toBe('/chat')
  expect(studentTaskAccess({ loading: false, enabled: true, authenticated: true, isAdmin: false, statusAvailable: true, userId: null, preset: 'learner', learningPolicy: { allowedSurfaces: ['tasks'] } })).toBe(false)
})
