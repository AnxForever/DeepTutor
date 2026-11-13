import StudentCaseDetailPage from '@/components/learning/teaching-analysis/StudentCaseDetailPage'

export default async function StudentCaseRoute({ params }: { params: Promise<{ caseId: string }> }) {
  const { caseId } = await params
  return <StudentCaseDetailPage caseId={caseId} />
}
