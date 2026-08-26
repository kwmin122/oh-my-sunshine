import { expect, test } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { APIRequestContext } from "@playwright/test";

/**
 * Shared E2E seams. HIGH-risk tasks demand a real git workspace for
 * revision-bound evidence (spec §4 Step 17), so seeded projects always
 * get a throwaway repository.
 */
export function makeTmpRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), "devflow-ui-repo-"));
  const git = (args: string[]) => execFileSync("git", args, { cwd: repo });
  git(["init", "-q"]);
  git(["config", "user.email", "e2e@devflow.local"]);
  git(["config", "user.name", "e2e"]);
  mkdirSync(join(repo, "src"), { recursive: true });
  writeFileSync(join(repo, "src", "a.ts"), "export const a = 1;\n");
  git(["add", "."]);
  git(["commit", "-qm", "init"]);
  return repo;
}

/** Answers/skips every open discovery question, finalizes the spec and runs planning. */
export async function driveToReadyAndPlan(ctx: APIRequestContext, projectId: string): Promise<void> {
  const post = async (path: string, data: unknown): Promise<void> => {
    const r = await ctx.post(path, { data });
    if (!r.ok()) throw new Error(`POST ${path} -> ${r.status()} ${await r.text()}`);
  };
  for (let i = 0; i < 16; i++) {
    const d = await (await ctx.get(`/api/projects/${projectId}/discovery`)).json();
    if (!d.openQuestion) break;
    const q = d.openQuestion;
    await post(`/api/projects/${projectId}/questions/${q.id}/answer`, {
      answer: "Deterministic e2e answer",
      optionKey: q.recommendedOption ?? q.options?.[0]?.key ?? undefined,
    });
  }
  for (let i = 0; i < 10; i++) {
    const d = await (await ctx.get(`/api/projects/${projectId}/discovery`)).json();
    if (!d.openQuestion) break;
    await post(`/api/projects/${projectId}/questions/${d.openQuestion.id}/skip`, {});
  }
  await post(`/api/projects/${projectId}/finalize-spec`, {});
  const planned = await ctx.post(`/api/projects/${projectId}/plan`, { data: {} });
  if (!planned.ok()) throw new Error(`plan failed: ${planned.status()} ${await planned.text()}`);
}

/** Creates a repo-backed project and drives it through mission → spec → plan via API. */
export async function seedRepoProject(
  ctx: APIRequestContext,
  name: string,
  rawRequest: string,
): Promise<{ projectId: string; repo: string }> {
  const repo = makeTmpRepo();
  const created = await ctx.post("/api/projects", { data: { name, repositoryPath: repo } });
  expect(created.ok()).toBe(true);
  const pid = (await created.json()).project.id;
  await ctx.post(`/api/projects/${pid}/mission`, { data: { rawRequest } });
  await driveToReadyAndPlan(ctx, pid);
  return { projectId: pid, repo };
}

export function apiContext(baseURL: string): Promise<APIRequestContext> {
  return import("@playwright/test").then((m) => m.request.newContext({ baseURL }));
}
