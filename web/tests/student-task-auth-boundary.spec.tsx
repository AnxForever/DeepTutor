import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, expect, it, vi } from 'vitest'
import { useAuthStatus } from '@/hooks/useAuthStatus'
import { fetchAuthStatus, invalidateAuthStatusCache, type AuthStatus } from '@/lib/auth'
import { updateRecoveryPrincipal } from '@/lib/recovery-principal'

let status: AuthStatus
function AccountScreen() {
  const auth = useAuthStatus()
  if (auth.loading) return <p>Checking account</p>
  return <section key={auth.userId}><p>{auth.userId}</p><input aria-label="Writing" defaultValue="" /></section>
}
beforeEach(() => {
  invalidateAuthStatusCache(); updateRecoveryPrincipal(null)
  status = { enabled: true, authenticated: true, user_id: 'learner-a', role: 'student', preset: 'learner', learning_policy: { age_band: '6-8', locked_persona: '', allowed_capabilities: [], default_capability: 'chat', allowed_surfaces: ['tasks'] } }
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(status), { headers: { 'Content-Type': 'application/json' } })))
})
it('coalesces the initial principal notification and keeps children mounted for ordinary cached reads', async () => {
  render(<AccountScreen />)
  await screen.findByText('learner-a')
  expect(fetch).toHaveBeenCalledOnce()
  fireEvent.change(screen.getByLabelText('Writing'), { target: { value: 'Keep this input' } })
  await act(async () => { await fetchAuthStatus(); updateRecoveryPrincipal(status) })
  expect(fetch).toHaveBeenCalledOnce()
  expect(screen.getByLabelText('Writing')).toHaveValue('Keep this input')
})
it('drops the previous account subtree on a real boundary and resolves the new verified UID without a refetch loop', async () => {
  render(<AccountScreen />); await screen.findByText('learner-a')
  fireEvent.change(screen.getByLabelText('Writing'), { target: { value: 'Account A local input' } })
  status = { ...status, user_id: 'learner-b' }
  act(() => invalidateAuthStatusCache())
  await screen.findByText('learner-b')
  expect(screen.getByLabelText('Writing')).toHaveValue('')
  await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2))
})
it('ignores an older status response after a newer account boundary', async () => {
  let release!: (response: Response) => void
  const old = { ...status }
  vi.mocked(fetch).mockImplementationOnce(() => new Promise(resolve => { release = resolve }))
  render(<AccountScreen />)
  await waitFor(() => expect(fetch).toHaveBeenCalledOnce())
  status = { ...status, user_id: 'learner-b' }
  act(() => { invalidateAuthStatusCache(); updateRecoveryPrincipal(status) })
  await screen.findByText('learner-b')
  await act(async () => release(new Response(JSON.stringify(old))))
  expect(screen.queryByText('learner-a')).toBeNull()
  expect(fetch).toHaveBeenCalledTimes(2)
})
