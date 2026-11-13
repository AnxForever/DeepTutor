"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";

import type { Capability } from "@/lib/capability-routes";
import { fetchAuthStatus } from '@/lib/auth';
import { RECOVERY_PRINCIPAL_CHANGED } from '@/lib/recovery-principal';
import { listLLMOptions } from "@/lib/llm-options";

type CapabilityAccessValue = {
  /** True until the first access probe resolves. */
  loading: boolean;
  /** Admins manage the catalog directly and are never gated. */
  isAdmin: boolean;
  /** Whether the current user has at least one usable LLM model. */
  hasLlm: boolean;
  /** Whether the current user may use a gated capability. */
  has: (capability: Capability) => boolean;
  /** Re-probe access (used on tab focus to pick up mid-session grant changes). */
  refresh: () => Promise<void>;
};

// Default value keeps the hook safe outside a provider (e.g. shared components
// rendered in the admin tree): everything reads as available, and the backend
// remains the real enforcement boundary.
const DEFAULT_VALUE: CapabilityAccessValue = {
  loading: false,
  isAdmin: true,
  hasLlm: true,
  has: () => true,
  refresh: async () => {},
};

const CapabilityAccessContext =
  createContext<CapabilityAccessValue>(DEFAULT_VALUE);

export function useCapabilityAccess(): CapabilityAccessValue {
  return useContext(CapabilityAccessContext);
}

export function CapabilityAccessProvider({
  children,
}: {
  children: ReactNode;
}) {
  // Optimistic until the first probe resolves so we never flash a locked UI
  // (admins and users-with-access stay unlocked; the backend enforces anyway).
  const [isAdmin, setIsAdmin] = useState(true);
  const [hasLlm, setHasLlm] = useState(true);
  const [loading, setLoading] = useState(true);
  const probe = useRef(0);

  const refresh = useCallback(async () => {
    const current = ++probe.current;
    try {
      // Auth status is the identity authority. Restricted learners cannot
      // read the runtime settings catalog just to discover their own role.
      const auth = await fetchAuthStatus();
      if (current !== probe.current) return;
      const admin = Boolean(auth && (!auth.enabled || auth.role === 'admin'));
      setIsAdmin(admin);
      if (admin) {
        setHasLlm(true);
        return;
      }
      setHasLlm(false);
      if (!auth?.authenticated || (auth.learning_policy && !(auth.learning_policy.allowed_surfaces ?? ['chat', 'reading']).includes('chat'))) return;
      // Non-admins: their grant-filtered LLM options decide access.
      const { options } = await listLLMOptions();
      if (current === probe.current) setHasLlm(options.length > 0);
    } catch {
      if (current === probe.current) { setIsAdmin(false); setHasLlm(false); }
    } finally {
      if (current === probe.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    return () => { probe.current += 1; };
  }, [refresh]);

  // Re-check when the user returns to the tab. This is what surfaces a
  // mid-session revocation (admin removed the grant while the tab was open)
  // without any polling — the next focus re-reads access and locks the UI.
  useEffect(() => {
    const onFocus = () => void refresh();
    const onVisible = () => {
      if (document.visibilityState === "visible") void refresh();
    };
    window.addEventListener("focus", onFocus);
    window.addEventListener(RECOVERY_PRINCIPAL_CHANGED, onFocus);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.removeEventListener("focus", onFocus);
      window.removeEventListener(RECOVERY_PRINCIPAL_CHANGED, onFocus);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [refresh]);

  const has = useCallback(
    (_capability: Capability): boolean => {
      // Only LLM is gated today. Admins and the pre-load window are never gated.
      if (isAdmin || loading) return true;
      return hasLlm;
    },
    [isAdmin, loading, hasLlm],
  );

  return (
    <CapabilityAccessContext.Provider
      value={{ loading, isAdmin, hasLlm, has, refresh }}
    >
      {children}
    </CapabilityAccessContext.Provider>
  );
}
