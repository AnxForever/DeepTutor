import { beforeEach, expect, it, vi } from 'vitest'
import { getStudentTaskHints, revealStudentTaskHint, validStudentTaskHints, type StudentTaskHintsState } from '@/lib/student-task-hints-api'
import { requestJson } from '@/shared/api/client'

vi.mock('@/shared/api/client', () => ({ requestJson: vi.fn(async () => ({})) }))
const TASK = '11111111-1111-4111-8111-111111111111'
const REQUEST = '22222222-2222-4222-8222-222222222222'
beforeEach(() => { vi.clearAllMocks(); window.history.replaceState({}, '', '/learning/tasks?dt_workspace=teacher-private') })
it('keeps hint reads and reveals account-global and submits only the explicit sequential request', async () => {
  const signal = new AbortController().signal
  await getStudentTaskHints(TASK, signal)
  await revealStudentTaskHint(TASK, { question_id: 'Q1', request_id: REQUEST, expected_hint_revision: 2 }, signal)
  const calls = vi.mocked(requestJson).mock.calls
  for (const [input] of calls) expect(new URL(String(input), window.location.origin).searchParams.get('dt_workspace')).toBe('')
  expect(calls[0][1]).toMatchObject({ cache: 'no-store', signal })
  expect(JSON.parse(String(calls[1][1]?.body))).toEqual({ question_id: 'Q1', request_id: REQUEST, expected_hint_revision: 2 })
  expect(calls[1][1]).toMatchObject({ method: 'POST', signal })
})
it('accepts only the current task and complete question set with a contiguous bounded revealed prefix', () => {
  const valid: StudentTaskHintsState = { task_id: TASK, hint_revision: 1, questions: [{ question_id: 'Q1', total: 3, revealed: [{ level: 1, text: 'A small clue.', revealed_at: 1 }] }, { question_id: 'Q2', total: 0, revealed: [] }] }
  expect(validStudentTaskHints(valid, TASK, ['Q1', 'Q2'])).toBe(true)
  expect(validStudentTaskHints({ ...valid, task_id: REQUEST }, TASK, ['Q1', 'Q2'])).toBe(false)
  expect(validStudentTaskHints({ ...valid, hint_revision: 10 }, TASK, ['Q1', 'Q2'])).toBe(false)
  expect(validStudentTaskHints({ ...valid, questions: [valid.questions[0], valid.questions[0]] }, TASK, ['Q1', 'Q2'])).toBe(false)
  for (const hint of [{ level: 2, text: 'Skipped a level', revealed_at: 1 }, { level: 1, text: 'X'.repeat(601), revealed_at: 1 }, { level: 1, text: 'A clue', revealed_at: Number.NaN }]) expect(validStudentTaskHints({ ...valid, questions: [{ question_id: 'Q1', total: 3, revealed: [hint] }, valid.questions[1]] }, TASK, ['Q1', 'Q2'])).toBe(false)
})
