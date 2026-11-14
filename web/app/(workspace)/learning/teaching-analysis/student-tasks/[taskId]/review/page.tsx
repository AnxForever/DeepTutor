import TaskReviewPage from '@/components/learning/teaching-analysis/TaskReviewPage'

export default async function Page({ params }: { params: Promise<{ taskId: string }> }) { const { taskId } = await params; return <TaskReviewPage taskId={taskId} /> }
