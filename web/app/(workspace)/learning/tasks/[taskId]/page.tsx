import StudentTaskPlayerPage from '@/components/learning/student-tasks/StudentTaskPlayerPage'

export default async function Page({ params }: { params: Promise<{ taskId: string }> }) {
  const { taskId } = await params
  return <StudentTaskPlayerPage taskId={taskId} />
}
