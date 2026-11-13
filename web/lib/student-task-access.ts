import type { AuthStatus } from '@/lib/auth'
import type { AuthStatusState } from '@/hooks/useAuthStatus'
import { studentTasksRoute } from './student-tasks-api'

export function studentTaskAccess(auth: AuthStatusState): boolean {
  return auth.statusAvailable && auth.enabled && auth.authenticated && !auth.isAdmin && Boolean(auth.userId) && auth.preset === 'learner' && Boolean(auth.learningPolicy?.allowedSurfaces.includes('tasks'))
}

/** Explicit login return paths win; only a default landing uses the policy. */
export function defaultAccountHome(auth: AuthStatus | null): string {
  return auth?.enabled && auth.authenticated && auth.role !== 'admin' && auth.user_id && auth.preset === 'learner' && auth.learning_policy?.allowed_surfaces?.includes('tasks') ? studentTasksRoute() : '/chat'
}
