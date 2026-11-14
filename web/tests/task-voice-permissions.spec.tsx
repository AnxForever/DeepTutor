import React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";

import { GrantEditor } from "@/features/multi-user/components/GrantEditor";
import GuardianSettingsSection from "@/features/settings/sections/GuardianSettingsSection";
import type { GrantPayload, MultiUserResources } from "@/features/multi-user/types";
import type { GuardianRestrictions } from "@/lib/guardian-api";

const mock = vi.hoisted(() => ({
  resources: vi.fn(),
  grant: vi.fn(),
  save: vi.fn(),
  relationships: vi.fn(),
  restrictions: vi.fn(),
  t: (key: string) => key,
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: mock.t, i18n: { language: "en" } }),
}));
vi.mock("@/features/multi-user/api", () => ({
  fetchAdminResources: mock.resources,
  fetchUserGrant: mock.grant,
  saveUserGrant: mock.save,
}));
vi.mock("@/components/common/McpToolGroups", () => ({ default: () => null }));
vi.mock("@/lib/guardian-api", () => ({
  listGuardianRelationships: mock.relationships,
  getGuardianRestrictions: mock.restrictions,
  getGuardianReport: vi.fn(),
  getGuardianMaterials: vi.fn(),
  resetLearnerCredentials: vi.fn(),
  revokeMyGuardianRelationship: vi.fn(),
}));
// Exercise checkbox editing against the fetched baseline. Existing Settings
// tests cover the shared staging/save lifecycle; these tests cover optional
// permission fields and the absence of implicit task/voice coupling.
vi.mock("@/features/settings/store/useStagedSettings", () => ({
  useStagedSettings: (_key: string, value: unknown, setValue: unknown) => [value, setValue],
}));

function grant(): GrantPayload {
  return {
    version: 2,
    user_id: "u_synthetic_learner",
    models: { llm: [] },
    knowledge_bases: [{ resource_id: "admin:kb:synthetic" }],
    skills: [],
    partners: [],
    enabled_tools: [],
    mcp_tools: [],
    exec_enabled: false,
    learning_policy: {
      age_band: "9-12",
      locked_persona: "teacher",
      allowed_capabilities: ["chat", "immersive_reading"],
      default_capability: "immersive_reading",
      allowed_surfaces: ["reading", "tasks"],
      reading: { allow_upload: false, material_ids: [], extensions: [] },
    },
  };
}

const resources: MultiUserResources = {
  models: { llm: [] },
  knowledge_bases: [],
  skills: [],
  partners: [],
  reading_materials: [],
  reading_extensions: [],
  tools: [],
  mcp_tools: [],
};

beforeEach(() => {
  mock.resources.mockResolvedValue(resources);
  mock.grant.mockResolvedValue(grant());
  mock.save.mockImplementation(async (_uid, next: GrantPayload) => next);
  mock.relationships.mockResolvedValue([{
    id: "synthetic-relationship",
    guardian_user_id: "u_synthetic_guardian",
    guardian_username: "Adult",
    learner_user_id: "u_synthetic_learner",
    learner_username: "Learner",
    permissions: ["manage_restrictions"],
  }]);
  mock.restrictions.mockResolvedValue({
    restrictions: {
      age_band: "9-12",
      allow_upload: false,
      allowed_surfaces: ["reading", "tasks"],
      extensions: [],
    } satisfies GuardianRestrictions,
    available_extensions: [],
  });
});

it("admin opt-in stays independent of tasks and saves only explicit voice changes", async () => {
  render(<GrantEditor userId="u_synthetic_learner" />);
  const voice = await screen.findByRole("checkbox", { name: /studentTaskVoice.permissionLabel/ });
  expect(voice).not.toBeChecked();
  fireEvent.click(voice);
  fireEvent.click(screen.getByRole("checkbox", { name: "studentTasks.accessLabel" }));
  expect(voice).toBeChecked();
  fireEvent.click(screen.getByRole("button", { name: /Save/ }));
  await waitFor(() => expect(mock.save).toHaveBeenCalledOnce());
  const saved = mock.save.mock.calls[0][1] as GrantPayload;
  expect(saved.learning_policy?.task_voice_input).toBe(true);
  expect(saved.learning_policy?.allowed_surfaces).toEqual(["reading"]);
  expect(saved.knowledge_bases).toEqual(grant().knowledge_bases);
});

it("unrelated admin edits preserve a legacy absent voice permission", async () => {
  render(<GrantEditor userId="u_synthetic_learner" />);
  await screen.findByRole("checkbox", { name: /studentTaskVoice.permissionLabel/ });
  fireEvent.change(screen.getByRole("combobox", { name: "Age band" }), { target: { value: "13-15" } });
  fireEvent.click(screen.getByRole("button", { name: /Save/ }));
  await waitFor(() => expect(mock.save).toHaveBeenCalledOnce());
  const saved = mock.save.mock.calls[0][1] as GrantPayload;
  expect(saved.learning_policy).not.toHaveProperty("task_voice_input");
  expect(saved.learning_policy?.age_band).toBe("13-15");
});

it("guardian opt-in starts unchecked and is retained when task access is disabled", async () => {
  render(<GuardianSettingsSection />);
  fireEvent.click(await screen.findByRole("button", { name: /Learner/ }));
  const voice = await screen.findByRole("checkbox", { name: /studentTaskVoice.permissionLabel/ });
  expect(voice).not.toBeChecked();
  fireEvent.click(voice);
  fireEvent.click(screen.getByRole("checkbox", { name: "studentTasks.accessLabel" }));
  expect(voice).toBeChecked();
  expect(screen.getByRole("checkbox", { name: "studentTasks.accessLabel" })).not.toBeChecked();
  fireEvent.click(voice);
  expect(voice).not.toBeChecked();
});

it("guardian without restriction authority never receives a voice-permission editor", async () => {
  mock.relationships.mockResolvedValue([{
    id: "synthetic-viewer",
    guardian_user_id: "u_synthetic_viewer",
    guardian_username: "Viewer",
    learner_user_id: "u_synthetic_learner",
    learner_username: "Learner",
    permissions: [],
  }]);
  render(<GuardianSettingsSection />);
  fireEvent.click(await screen.findByRole("button", { name: /Learner/ }));
  await screen.findByRole("heading", { name: "Learner", level: 2 });
  expect(mock.restrictions).not.toHaveBeenCalled();
  expect(screen.queryByRole("checkbox", { name: /studentTaskVoice.permissionLabel/ })).toBeNull();
});
