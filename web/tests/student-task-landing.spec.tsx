import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, expect, it, vi } from 'vitest'
import LoginPage from '@/app/(auth)/login/page'
import ProfilePage from '@/app/(utility)/profile/page'
import HomePage from '@/app/(workspace)/page'
import { initI18n } from '@/i18n/init'
import * as auth from '@/lib/auth'
import * as profile from '@/lib/profile-api'

const navigation = vi.hoisted(() => ({ search: new URLSearchParams(), router: { replace: vi.fn(), push: vi.fn() } }))
vi.mock('next/navigation', () => ({ useRouter: () => navigation.router, useSearchParams: () => navigation.search }))
vi.mock('next/link', () => ({ default: ({ href, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }) => <a href={href} {...props} /> }))
vi.mock('@/lib/auth', () => ({ login: vi.fn(), fetchAuthStatus: vi.fn(), checkIsFirstUser: vi.fn(), logout: vi.fn() }))
vi.mock('@/lib/profile-api', async original => ({ ...(await original<typeof profile>()), getProfile: vi.fn(), changeOwnPassword: vi.fn() }))
initI18n('en')
const learner: auth.AuthStatus = { enabled: true, authenticated: true, user_id: 'learner-a', role: 'student', preset: 'learner', learning_policy: { age_band: '6-8', locked_persona: '', allowed_capabilities: [], default_capability: 'chat', allowed_surfaces: ['tasks'] } }
beforeEach(() => {
  vi.clearAllMocks(); navigation.search = new URLSearchParams(); window.history.replaceState({}, '', '/')
  vi.mocked(auth.fetchAuthStatus).mockResolvedValue(learner)
  vi.mocked(auth.checkIsFirstUser).mockResolvedValue(false)
  vi.mocked(auth.login).mockResolvedValue({ ok: true })
  vi.mocked(profile.getProfile).mockResolvedValue({ id: 'learner-a', username: 'Synthetic learner', role: 'student', created_at: '2026-01-01T00:00:00Z', can_change_password: true, must_change_password: true })
  vi.mocked(profile.changeOwnPassword).mockResolvedValue(undefined)
})
it('lands a tasks-only learner on Today and keeps the adult default chat landing', async () => {
  const view = render(<HomePage />)
  await waitFor(() => expect(navigation.router.replace).toHaveBeenCalledWith('/learning/tasks?dt_workspace='))
  view.unmount(); navigation.router.replace.mockReset(); vi.mocked(auth.fetchAuthStatus).mockResolvedValue({ enabled: false, authenticated: true, role: 'admin', user_id: 'local-admin', preset: 'standard' })
  render(<HomePage />)
  await waitFor(() => expect(navigation.router.replace).toHaveBeenCalledWith('/chat'))
})
it('preserves an explicit safe login deep link ahead of a learner default', async () => {
  navigation.search = new URLSearchParams({ next: '/learning/tasks/specific-task?dt_workspace=#answer' })
  render(<LoginPage />)
  await waitFor(() => expect(navigation.router.replace).toHaveBeenCalledWith('/learning/tasks/specific-task?dt_workspace=#answer'))
})
it('requires the first password change before returning to the policy default task inbox', async () => {
  vi.mocked(auth.fetchAuthStatus).mockResolvedValueOnce({ enabled: true, authenticated: false }).mockResolvedValue(learner)
  vi.mocked(auth.login).mockResolvedValue({ ok: true, mustChangePassword: true })
  render(<LoginPage />)
  fireEvent.change(screen.getByLabelText('Email or username'), { target: { value: 'synthetic-learner' } })
  fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'synthetic-login-only' } })
  fireEvent.click(screen.getByRole('button', { name: 'Sign in' }))
  await waitFor(() => expect(navigation.router.replace).toHaveBeenCalledWith('/profile?change=1&next=%2Flearning%2Ftasks%3Fdt_workspace%3D'))
  expect(navigation.router.replace).not.toHaveBeenCalledWith('/learning/tasks?dt_workspace=')
})
it.each([null, '/learning/tasks/exact-task?dt_workspace='])('returns from a successful first password change to the learner inbox or explicit next %j', async next => {
  const search = new URLSearchParams({ change: '1' }); if (next) search.set('next', next)
  window.history.replaceState({}, '', `/profile?${search}`)
  render(<ProfilePage />)
  fireEvent.change(await screen.findByLabelText('Current password'), { target: { value: 'synthetic-old' } })
  fireEvent.change(screen.getByLabelText('New password', { exact: true }), { target: { value: 'synthetic-new' } })
  fireEvent.change(screen.getByLabelText('Confirm new password'), { target: { value: 'synthetic-new' } })
  fireEvent.click(screen.getByRole('button', { name: 'Update password' }))
  await waitFor(() => expect(navigation.router.replace).toHaveBeenCalledWith(next ?? '/learning/tasks?dt_workspace='))
  expect(profile.changeOwnPassword).toHaveBeenCalledOnce()
})
