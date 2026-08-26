import { expect, test } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { apiContext, seedRepoProject } from "./helpers.js";

/**
 * Full vertical journey through the real UI against the real daemon
 * (spec §13 E2E flows 1–11). Single ordered flow; workers=1 in config.
 */

let projectId: string;
let agentProjectId: string;

async function answerAllQuestions(page: import("@playwright/test").Page, max = 10): Promise<void> {
  for (let i = 0; i < max; i++) {
    const questionCard = page.locator("text=Why this matters:");
    if ((await questionCard.count()) === 0) return;
    const optionButton = page.locator("button", { hasText: /recommended/ }).first();
    if ((await optionButton.count()) > 0) {
      await optionButton.click();
    } else {
      await page.locator('input[placeholder="Your answer…"]').fill("Deterministic e2e answer");
      await page.getByRole("button", { name: "Answer", exact: true }).click();
    }
    await page.waitForTimeout(600);
  }
}

test("1-2 · create project and submit a vague mission", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("h1", { hasText: "DEVFLOW OS" })).toBeVisible();
  await expect(page.locator('aside img[alt="DevFlow OS"]')).toBeVisible(); // sunshine logo

  await page.locator('input[placeholder="new project name…"]').fill("E2E Journey");
  await page.locator('input[placeholder="new project name…"]').press("Enter");
  await expect(page.locator("select")).toContainText("E2E Journey");

  await page.locator('input[placeholder^="Mission:"]').fill("Add Google login with OAuth");
  await page.getByRole("button", { name: "Submit Mission" }).click();

  // Intent Gate classified and discovery opened automatically.
  await expect(page.locator("text=Intent:")).toBeVisible({ timeout: 30_000 });
  await expect(page.locator("text=Discovery Interview").first()).toBeVisible();
  projectId = await page.locator("select").inputValue();
  expect(projectId).toBeTruthy();
});

test("3-4 · answering questions moves readiness to Definition of Ready", async ({ page }) => {
  await page.goto("/");
  await page.locator("select").selectOption(projectId);
  await page.getByRole("button", { name: "Discovery & Spec" }).click();

  await answerAllQuestions(page);
  await expect(page.locator("text=READY FOR PLANNING")).toBeVisible({ timeout: 30_000 });
  await expect(page.locator("text=Definition of Ready reached")).toBeVisible();
});

test("5 · planning generates the dependency-aware task DAG", async ({ page }) => {
  await page.goto("/");
  await page.locator("select").selectOption(projectId);
  await page.getByRole("button", { name: "Plan Delivery →" }).click();
  await expect(page.locator("text=Task DAG (")).toBeVisible({ timeout: 60_000 });
  await expect(page.locator(".mono", { hasText: /^TASK-001$/ })).toBeVisible();
});

test("6 · DevFlow graph renders persisted nodes", async ({ page }) => {
  await page.goto("/");
  await page.locator("select").selectOption(projectId);
  await page.getByRole("button", { name: "DevFlow Graph" }).click();
  await expect(page.locator(".react-flow__node").first()).toBeVisible({ timeout: 30_000 });
  const nodeCount = await page.locator(".react-flow__node").count();
  expect(nodeCount).toBeGreaterThanOrEqual(8); // 7 stages + tasks
});

test("7-9 · simulated agent executes, evidence is produced fresh", async ({ page }) => {
  // HIGH tasks execute only against a real git workspace (revision-bound evidence).
  const ctx = await apiContext("http://localhost:5288");
  const seeded = await seedRepoProject(ctx, "Agent Run UI", "Add Google login with OAuth");
  agentProjectId = seeded.projectId;

  await page.goto("/");
  await page.locator("select").selectOption(agentProjectId);
  await page.getByRole("button", { name: "Tasks", exact: true }).click();

  await page.locator("button", { hasText: /^TASK-001/ }).first().click();
  await page.getByRole("button", { name: "Execute with agent" }).click();
  // A successful engine run moves the task to VERIFYING (completion still needs evidence).
  await expect(page.locator("dd", { hasText: "VERIFYING" }).first()).toBeVisible({ timeout: 120_000 });

  await page.getByRole("button", { name: "Evidence", exact: true }).click();
  await expect(page.locator("table")).toContainText("UNIT_TEST");
  await expect(page.locator("table")).toContainText("PASS");
  await expect(page.locator("table")).toContainText("FRESH");
  await ctx.dispose();
});

test("10-11 · stale evidence blocks completion, fresh rerun completes (Scenario B)", async ({ page }) => {
  const ctx = await apiContext("http://localhost:5288");
  const seeded = await seedRepoProject(ctx, "Stale Repo UI", "Change button label text on settings page");
  const repo = seeded.repo;
  const git = (args: string[]) => execFileSync("git", args, { cwd: repo });

  const tasks = (await (await ctx.get(`/api/projects/${seeded.projectId}/tasks`)).json()).tasks;
  const run = await (await ctx.post(`/api/tasks/${tasks[0].id}/execute`, { data: {} })).json();
  expect(["SUCCEEDED", "WAITING_APPROVAL"]).toContain(run.run.status);
  if (run.run.status === "WAITING_APPROVAL") {
    const approvals = (await (await ctx.get(`/api/projects/${seeded.projectId}/approvals`)).json()).approvals;
    await ctx.post(`/api/approvals/${approvals[0].id}/resolve`, { data: { outcome: "ALLOW_ONCE" } });
  }

  // Code moves to a new revision → old evidence must go STALE and block completion.
  writeFileSync(join(repo, "src", "a.ts"), "export const a = 2;\n");
  git(["add", "."]);
  git(["commit", "-qm", "change behavior"]);
  const rerun = await (await ctx.post(`/api/tasks/${tasks[0].id}/rerun-verification`, { data: {} })).json();
  const freshness = rerun.evidence.map((e: { freshness: string }) => e.freshness);
  expect(freshness).toContain("STALE");
  expect(freshness).toContain("FRESH");

  // UI shows the stale chip and the computed completion explanation.
  await page.goto("/");
  await page.locator("select").selectOption(seeded.projectId);
  await page.getByRole("button", { name: "Evidence", exact: true }).click();
  await expect(page.locator("table")).toContainText("STALE");

  await page.getByRole("button", { name: "Tasks", exact: true }).click();
  await page.locator("button", { hasText: /^TASK-001/ }).first().click();
  await expect(page.locator("text=Proof of Done")).toBeVisible();

  await page.getByRole("button", { name: "Review → complete" }).click();
  await expect(page.locator("text=All conditions satisfied")).toBeVisible({ timeout: 120_000 });
  await ctx.dispose();
});
