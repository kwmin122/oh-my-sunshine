import { expect, test } from "@playwright/test";
import { apiContext, seedRepoProject } from "./helpers.js";

/**
 * AI Team Composer (spec §31): Auto/Recommended/Manual composition, presets,
 * capability-mismatch warnings, task-level overrides, and fallback execution.
 */

let projectId: string;

test.beforeAll(async ({ request }) => {
  const seeded = await seedRepoProject(request, "Composer UI", "Add Google login with OAuth");
  projectId = seeded.projectId;
});

test("compose the team, hit a mismatch warning, clear it, and run with a task override", async ({ page, request }) => {
  const ctx = await apiContext("http://localhost:5288");

  await page.goto("/");
  await page.locator("select").selectOption(projectId);
  await page.getByRole("button", { name: "AI Team Composer" }).click();

  // ---- Mode 1: AUTO — deterministic team with human-readable reasons ----
  await page.getByRole("button", { name: /Auto — compose for me/ }).click();
  await expect(page.locator("table").first()).toContainText("CEO / Orchestrator");
  const rowCount = await page.locator("table").first().locator("tbody tr").count();
  expect(rowCount).toBeGreaterThanOrEqual(8); // CEO…QA all present
  await page.locator("details", { hasText: "Selection rationale" }).locator("summary").click();
  await expect(page.locator("li", { hasText: /best .*score .*across/i }).first()).toBeVisible();

  // Composition persists across reloads.
  await page.reload();
  await page.locator("select").first().selectOption(projectId);
  await page.getByRole("button", { name: "AI Team Composer" }).click();
  await expect(page.locator("text=CEO / Orchestrator").first()).toBeVisible();

  // ---- Manual edit creates a capability mismatch the system must surface ----
  const backendRow = page.locator("tr", { hasText: "Backend Engineer" });
  await backendRow.locator("select").first().selectOption("model-api-only");
  await expect(page.locator("text=INCOMPATIBLE RUNTIME")).toBeVisible({ timeout: 15_000 });
  await expect(page.locator("text=/missing: filesystem, shell, git, tests/")).toBeVisible();
  await expect(page.locator("text=/recommended: .*(claude-code|codex-cli)/")).toBeVisible();

  // ---- Fix it manually (Mode 3): pick a capable runtime; warning clears ----
  await backendRow.locator("select").first().selectOption("codex-cli");
  await expect(page.locator("text=INCOMPATIBLE RUNTIME")).not.toBeVisible({ timeout: 15_000 });

  // ---- Org presets apply instantly and are labeled ----
  await page.getByRole("button", { name: "Balanced" }).click();
  await expect(page.locator("text=Preset \"balanced\" applied.")).toBeVisible();

  // ---- Task-level override + fallback execution through the real engine ----
  const catalog = (await (await ctx.get("/api/team/catalog")).json()).catalog;
  test.skip(!catalog.some((c: { id: string }) => c.id === "model-api-only"), "catalog missing");

  await page.getByRole("button", { name: "Tasks", exact: true }).click();
  await page.locator("button", { hasText: /^TASK-001/ }).first().click();
  // Override TASK-001 onto a runtime with no registered adapter → engine must fall back, not fail.
  await page.locator("select", { hasText: "switch runtime for next run…" }).last().selectOption("model-api-only");
  await page.getByRole("button", { name: "Execute with agent" }).click();
  await expect(page.locator("dd", { hasText: "VERIFYING" }).first()).toBeVisible({ timeout: 120_000 });

  // The event chain proves the composer resolved an override and degraded gracefully.
  const events = (await (await ctx.get(`/api/projects/${projectId}/events`)).json()).events;
  const types = events.map((e: { type: string }) => e.type);
  expect(types).toContain("team.task_override_set");
  expect(types).toContain("agent.fallback_used");
  expect(types).toContain("agent.run_started");

  await ctx.dispose();
});
