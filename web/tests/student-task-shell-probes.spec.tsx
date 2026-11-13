import { act, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, expect, it, vi } from 'vitest'
import { CapabilityAccessProvider, useCapabilityAccess } from '@/components/access/CapabilityAccessContext'
import { WorkspaceNavigation } from '@/components/workspaces/WorkspaceNavigation'
import { fetchCapabilityCatalog } from '@/features/capabilities/api'
import { listWorkspaces } from '@/lib/workspaces-api'
import { fetchAuthStatus, type AuthStatus } from '@/lib/auth'
import { apiFetch } from '@/lib/api'
import { listLLMOptions, type LLMOptionsResponse } from '@/lib/llm-options'
import { invalidateClientCache } from '@/lib/client-cache'
import { RECOVERY_PRINCIPAL_CHANGED } from '@/lib/recovery-principal'
import { rememberWorkspaceId } from '@/lib/workspace-scope'

const navigation = vi.hoisted(() => ({ router: { push: vi.fn(), replace: vi.fn() } }))
vi.mock('next/navigation', () => ({ useRouter: () => navigation.router, usePathname: () => window.location.pathname, useSearchParams: () => new URLSearchParams(window.location.search) }))
vi.mock('@/lib/auth', () => ({ fetchAuthStatus: vi.fn() }))
vi.mock('@/lib/api', () => ({ apiFetch: vi.fn(), apiUrl: (path: string) => path }))
vi.mock('@/lib/llm-options', () => ({ listLLMOptions: vi.fn() }))
const learner: AuthStatus = { enabled: true, authenticated: true, role: 'student', preset: 'learner', user_id: 'learner-a', learning_policy: { age_band: '9-12', locked_persona: '', allowed_capabilities: ['chat'], default_capability: 'chat', allowed_surfaces: ['chat', 'reading', 'tasks'] } }
function AccessState() { const access = useCapabilityAccess(); return <output>{access.loading ? 'checking' : `${access.isAdmin ? 'admin' : 'learner'}:${access.has('llm') ? 'models' : 'no-models'}`}</output> }
beforeEach(() => {
  vi.clearAllMocks(); invalidateClientCache('workspaces:'); invalidateClientCache('capabilities:'); rememberWorkspaceId(''); window.history.replaceState({}, '', '/learning/tasks?dt_workspace=')
  vi.mocked(fetchAuthStatus).mockResolvedValue(learner)
  vi.mocked(listLLMOptions).mockResolvedValue({ active: null, options: [] })
  vi.mocked(apiFetch).mockImplementation(async input => new Response(JSON.stringify(String(input).includes('/capabilities/') ? { capabilities: ['chat', 'deep_solve'] } : { workspaces: [{ workspace_id: 'adult-workspace', kind: 'workspace' }] }), { headers: { 'Content-Type': 'application/json' } }))
})
it('skips private settings, workspace registry and capability manifests for the real default learner policy', async () => {
  render(<CapabilityAccessProvider><AccessState /></CapabilityAccessProvider>)
  await screen.findByText('learner:no-models')
  expect(await fetchCapabilityCatalog()).toEqual([])
  expect(await listWorkspaces()).toEqual([])
  expect(apiFetch).not.toHaveBeenCalled()
  expect(listLLMOptions).toHaveBeenCalledOnce()
})
it('does not even probe model options for a tasks-only learning policy', async () => {
  vi.mocked(fetchAuthStatus).mockResolvedValue({ ...learner, learning_policy: { ...learner.learning_policy!, allowed_surfaces: ['tasks'] } })
  render(<CapabilityAccessProvider><AccessState /></CapabilityAccessProvider>)
  await screen.findByText('learner:no-models')
  expect(listLLMOptions).not.toHaveBeenCalled()
  expect(apiFetch).not.toHaveBeenCalled()
})
it.each([true, false])('preserves adult capability metadata and registered workspace access with auth enabled %j', async enabled => {
  vi.mocked(fetchAuthStatus).mockResolvedValue({ enabled, authenticated: true, role: 'admin', user_id: 'adult', preset: 'standard' })
  render(<CapabilityAccessProvider><AccessState /></CapabilityAccessProvider>)
  await screen.findByText('admin:models')
  expect((await fetchCapabilityCatalog()).map(row => row.id)).toEqual(['chat', 'deep_solve'])
  expect((await listWorkspaces())[0].workspace_id).toBe('adult-workspace')
  expect(vi.mocked(apiFetch).mock.calls.map(([url]) => url)).toEqual(['/api/capabilities/registered', '/api/settings/workspace/registrations'])
  expect(listLLMOptions).not.toHaveBeenCalled()
})
it('does not treat a hidden private registry as a missing learner workspace and redirect away from the task', async () => {
  window.history.replaceState({}, '', '/learning/tasks?dt_workspace=learner-owned')
  render(<WorkspaceNavigation />)
  await waitFor(() => expect(fetchAuthStatus).toHaveBeenCalled())
  await act(async () => { await Promise.resolve() })
  expect(apiFetch).not.toHaveBeenCalled()
  expect(navigation.router.push).not.toHaveBeenCalled()
  expect(window.location.search).toBe('?dt_workspace=learner-owned')
})
it('does not let an old account model probe unlock a newer tasks-only account', async () => {
  let resolveOld!: (value: LLMOptionsResponse) => void
  vi.mocked(listLLMOptions).mockImplementationOnce(() => new Promise(resolve => { resolveOld = resolve }))
  render(<CapabilityAccessProvider><AccessState /></CapabilityAccessProvider>)
  await waitFor(() => expect(listLLMOptions).toHaveBeenCalledOnce())
  vi.mocked(fetchAuthStatus).mockResolvedValue({ ...learner, user_id: 'learner-b', learning_policy: { ...learner.learning_policy!, allowed_surfaces: ['tasks'] } })
  act(() => window.dispatchEvent(new Event(RECOVERY_PRINCIPAL_CHANGED)))
  await screen.findByText('learner:no-models')
  await act(async () => resolveOld({ active: null, options: [{ profile_id: 'old-account', model_id: 'old-model', profile_name: '', model_name: '', model: '', provider: '', is_active_default: false }] }))
  expect(screen.getByText('learner:no-models')).toBeVisible()
  expect(apiFetch).not.toHaveBeenCalled()
})
