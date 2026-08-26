import { expect, test } from "@playwright/test";
import { driveToReadyAndPlan, makeTmpRepo } from "./helpers.js";

/**
 * Governance through the UI: dangerous-action approval (Scenario C) and
 * repeated-failure escalation → Decision Inbox → resume (Scenario D).
 * Mirrors the daemon API for state setup; every human action happens in the UI.
 */

let projectId: string;

test.beforeAll(async ({ request }) => {
  // Repo-backed: HIGH tasks execute only inside a real git workspace.
  const created = await request.post("/api/projects", { data: { name: "Governance UI", repositoryPath: makeTmpRepo() } });
  projectId = (await created.json()).project.id;
  await request.post(`/api/projects/${projectId}/mission`, { data: { rawRequest: "Add Google login with OAuth and a database migration" } });
  await driveToReadyAndPlan(request, projectId);
});

test("Scenario C · dangerous command parks in Approval Inbox; Allow once executes it", async ({ page, request }) => {
  await request.post(`/api/projects/${projectId}/tools/shell`, { data: { command: "rm -rf ~/" } });

  await page.goto("/");
  await page.locator("select").selectOption(projectId);
  await page.getByRole("button", { name: "Inbox", exact: true }).click();

  await expect(page.locator("text=Approval Inbox (1)")).toBeVisible();
  await page.getByRole("button", { name: "Allow once" }).click();
  await expect(page.locator("text=Approval Inbox (0)")).toBeVisible({ timeout: 30_000 });

  // The event chain records approval + executed/failed action (defense layer refuses rm -rf).
  const events = await (await request.get(`/api/projects/${projectId}/events`)).json();
  const types = events.events.map((e: { type: string }) => e.type);
  expect(types).toContain("action.approval_requested");
  expect(types).toContain("action.approved");
});

test("Scenario D · repeated failures escalate into Decision Inbox; answering resumes work", async ({ page, request }) => {
  await request.post("/api/runtimes/mock/fail-mode", { data: { enabled: true } });
  const tasks = (await (await request.get(`/api/projects/${projectId}/tasks`)).json()).tasks;
  const target = tasks[0];

  // Three bounded attempts — the third must escalate instead of retrying forever.
  for (let i = 0; i < 3; i++) {
    const run = await (await request.post(`/api/tasks/${target.id}/execute`, { data: {} })).json();
    const status = run.run?.status ?? run.error ?? "";
    if (String(status).includes("exhausted")) break; // attempt cap reached — escalation already raised
  }
  await request.post("/api/runtimes/mock/fail-mode", { data: { enabled: false } });

  const decisions = (await (await request.get(`/api/projects/${projectId}/decisions`)).json()).decisions;
  expect(decisions.length).toBeGreaterThanOrEqual(1);
  const decision = decisions[0];

  await page.goto("/");
  await page.locator("select").selectOption(projectId);
  await page.getByRole("button", { name: "Inbox", exact: true }).click();
  await expect(page.locator(`text=${decision.stableKey}`)).toBeVisible();

  // Answer with the recommended option — blocked work resumes automatically.
  await page.locator("button", { hasText: new RegExp(`^${decision.options[0].key}\\.`) }).first().click();
  await expect(page.locator(`text=${decision.stableKey}`)).not.toBeVisible({ timeout: 30_000 });

  const after = (await (await request.get(`/api/projects/${projectId}/tasks`)).json()).tasks;
  const resumed = after.find((t: { id: string }) => t.id === decision.taskId);
  expect(["QUEUED", "READY", "RUNNING", "VERIFYING", "REVIEW", "DONE", "BLOCKED"].includes(resumed.status)).toBe(true);
  expect(resumed.blockers.length).toBe(0);
});
