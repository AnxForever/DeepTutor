import { apiFetch, apiUrl } from "@/lib/api";
import { withClientCache } from "@/lib/client-cache";
import { fetchAuthStatus } from '@/lib/auth';

import {
  parseCapabilityCatalogPayload,
  type CapabilityDescriptor,
} from "./model";

export async function fetchCapabilityCatalog(options?: {
  force?: boolean;
}): Promise<CapabilityDescriptor[]> {
  const auth = await fetchAuthStatus();
  // Restricted learning accounts use their policy, not private deployment
  // manifests. Empty metadata keeps the existing core-chat fallback.
  if (!auth || (auth.enabled && (!auth.authenticated || auth.learning_policy))) return [];
  return withClientCache(
    "capabilities:catalog",
    async () => {
      const response = await apiFetch(apiUrl("/api/capabilities/registered"));
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return parseCapabilityCatalogPayload(await response.json());
    },
    { force: options?.force, ttlMs: 300_000 },
  );
}
