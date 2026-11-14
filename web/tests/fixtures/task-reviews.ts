import type { TeacherStudentTask } from '@/lib/teacher-student-tasks-api'
import type { SavedTaskReview } from '@/lib/task-reviews-api'
import { editorForTaskReview, type TaskReviewDraft } from '@/lib/task-review-drafts'

export const REVIEW_TASK = '11111111-1111-4111-8111-111111111111'
export const REVIEW_SUBMISSION = '22222222-2222-4222-8222-222222222222'
export const REVIEW_REPORT = '33333333-3333-4333-8333-333333333333'
export const REVIEW_FOLLOWUP = '44444444-4444-4444-8444-444444444444'
export const REVIEW_REQUEST = '55555555-5555-4555-8555-555555555555'
export function reviewTask(patch: Partial<TeacherStudentTask> = {}): TeacherStudentTask {
  return {
    task_id: REVIEW_TASK, task_revision: 3, title: 'A short fraction task', instructions: 'Explain your method.', recipient_user_id: 'learner-real-id', followup_id: REVIEW_FOLLOWUP, followup_revision: 1, status: 'submitted', issued_at: 1, updated_at: 3, submitted_at: 3, progress: { revision: 2, current_question_index: 1, saved_at: 3 },
    source_snapshot: { followup_id: REVIEW_FOLLOWUP, revision: 1, report_id: REVIEW_REPORT, report_revision: 1, priority_index: 0, title: 'Fractions', student_ref: 'Anonymous source label', assignment_ref: 'Synthetic worksheet', subject: 'Mathematics', grade: 'Grade 5', knowledge_point: 'Adding fractions', source_fingerprint: 'a'.repeat(64), created_at: 1, updated_at: 1, questions: [{ question_id: 'F1', question: 'Explain 1/2 + 1/3.', reference_answer: '5/6', rubric: 'Use common denominators.' }, { question_id: 'F2', question: 'Explain 1/4 + 1/2.', reference_answer: '3/4', rubric: null }] },
    submission: { task_id: REVIEW_TASK, submission_id: REVIEW_SUBMISSION, submitted_at: 3, responses: [{ question_id: 'F1', response_status: 'needs_help', answer: '1/2 = 3/6, then I got stuck.', assistance: 'assisted' }, { question_id: 'F2', response_status: 'needs_help', answer: null, assistance: 'unknown' }], hint_usage: [{ question_id: 'F1', revealed: [{ level: 1, revealed_at: 2 }] }] },
    question_hints: [{ question_id: 'F1', hints: ['Look at the denominators.'] }], hint_usage: [{ question_id: 'F1', revealed: [{ level: 1, revealed_at: 2 }] }], started_at: 2, revoked_at: null, revoke_reason: null, issued_by_user_id: 'teacher-a', ...patch,
  }
}
export function savedTaskReview(task = reviewTask(), patch: Partial<SavedTaskReview> = {}): SavedTaskReview {
  return { task_id: task.task_id, submission_id: task.submission!.submission_id, request_id: REVIEW_REQUEST, revision: 1, status: 'confirmed', items: task.source_snapshot.questions.map(question => ({ question_id: question.question_id, result: 'ungraded', feedback: '' })), summary: '', change_reason: '', recipient_user_id: task.recipient_user_id, report_id: task.source_snapshot.report_id, report_revision: task.source_snapshot.report_revision, followup_id: task.followup_id, followup_revision: task.followup_revision, subject: task.source_snapshot.subject, knowledge_point: task.source_snapshot.knowledge_point, submission_receipt_hash: 'b'.repeat(64), reviewer_user_id: 'teacher-a', recorded_at: 10, ...patch }
}
export function taskReviewDraft(task = reviewTask(), review: SavedTaskReview | null = null): TaskReviewDraft {
  return { kind: 'task-review-editor', version: 1, task_id: task.task_id, submission_id: task.submission!.submission_id, editor: editorForTaskReview(task, review), editing: true, withdrawing: false, withdraw_reason: '', pending: null, acknowledged: null }
}
