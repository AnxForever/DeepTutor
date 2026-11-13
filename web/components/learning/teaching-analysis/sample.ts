import type { AssignmentInput, AssignmentItem } from '@/lib/teaching-analysis-api'

/** Header-only UTF-8 BOM CSV opens correctly in Excel without invented submissions. */
export function assignmentCsvTemplate(language: 'zh' | 'en'): string {
  const headers = language === 'zh'
    ? ['学生代号', '作业代号', '学科', '题号', '题干', '学生作答', '解题过程', '参考答案', '评分标准']
    : ['student_ref', 'assignment_ref', 'subject', 'question_id', 'question', 'student_answer', 'student_work', 'reference_answer', 'rubric']
  return `\uFEFF${headers.join(',')}\r\n`
}

export function emptyAssignmentItem(index: number): AssignmentItem {
  return {
    question_id: `Q${index}`,
    question: '',
    student_answer: null,
    student_work: null,
    reference_answer: null,
    rubric: null,
    knowledge_points: [],
    source_locator: '',
    answer_status: 'unknown',
    transcription_status: 'not_applicable',
    assistance: 'unknown',
  }
}

export function emptyAssignment(): AssignmentInput {
  return { student_ref: '', assignment_ref: '', subject: '', grade: '', teacher_context: '', rubric_template: null, document_provenance: null, items: [emptyAssignmentItem(1)] }
}

/** Public synthetic worksheet; deliberately contains no evaluator answers or instructions. */
export function exampleAssignment(language: 'zh' | 'en'): AssignmentInput {
  const zh = language === 'zh'
  return {
    student_ref: 'example-student-A',
    assignment_ref: 'example-fractions-01',
    subject: zh ? '数学' : 'Mathematics',
    grade: zh ? '小学五年级' : 'Grade 5',
    teacher_context: zh ? '合成示例：分数加法练习，非真实学生资料。' : 'Synthetic example: a fraction addition worksheet, with no real student records.',
    rubric_template: null,
    document_provenance: null,
    items: [
      { question: '1/5 + 2/5 = ?', answer: '3/5', work: '(1+2)/5 = 3/5', reference: '3/5' },
      { question: '1/2 + 1/3 = ?', answer: '2/5', work: '(1+1)/(2+3) = 2/5', reference: '5/6' },
      { question: '2/3 + 1/4 = ?', answer: '3/7', work: '(2+1)/(3+4) = 3/7', reference: '11/12' },
    ].map((item, index) => ({
      ...emptyAssignmentItem(index + 1),
      question: item.question,
      student_answer: item.answer,
      student_work: item.work,
      reference_answer: item.reference,
      rubric: zh ? '检查结果与解题过程。' : 'Check the result and the working.',
      source_locator: zh ? `合成作业第1页第${index + 1}题` : `Synthetic worksheet, page 1, item ${index + 1}`,
      knowledge_points: [zh ? '分数加法' : 'Fraction addition'],
      answer_status: 'present',
      transcription_status: 'confirmed',
      assistance: 'independent',
    })),
  }
}
