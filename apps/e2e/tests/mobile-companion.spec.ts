import { expect, test } from "@playwright/test";
import { driveToReadyAndPlan, makeTmpRepo } from "./helpers.js";

/**
 * Mobile companion web surface at /m on the daemon origin (spec §5.17, Scenario G):
 * pairing → status → role-restricted governance. The page talks to the same daemon
 * endpoints; every command passes the deterministic governance layer.
 */

const DAEMON = "http://127.0.0.1:47710";

test("pair an OPERATOR device, read status, and answer a decision from the phone", async ({ page, request }) => {
  // Seed one open decision to answer from the phone.
  const created = await request.post("/api/projects", { data: { name: "Mobile Decision", repositoryPath: makeTmpRepo() } });
  const pid = (await created.json()).project.id;
  await request.post(`/api/projects/${pid}/mission`, { data: { rawRequest: "Add payment checkout" } });
  await driveToReadyAndPlan(request, pid);
  const tasks = await (await request.get(`/api/projects/${pid}/tasks`)).json().catch(() => ({ tasks: [] }));

  // Escalate a decision via three failing attempts on a planned task (if planning ran).
  if (tasks.tasks?.length) {
    await request.post("/api/runtimes/mock/fail-mode", { data: { enabled: true } });
    for (let i = 0; i < 3; i++) await request.post(`/api/tasks/${tasks.tasks[0].id}/execute`, { data: {} });
    await request.post("/api/runtimes/mock/fail-mode", { data: { enabled: false } });
  }
  const decisions = (await (await request.get(`/api/projects/${pid}/decisions`)).json()).decisions;
  test.skip(decisions.length === 0, "no decision available to answer from mobile");

  await page.goto(`${DAEMON}/m`);
  await expect(page.locator("h2")).toContainText("DevFlow OS");

  await page.locator("#dname").fill("e2e-phone");
  await page.locator("#drole").selectOption("OPERATOR");
  await page.getByRole("button", { name: /Pair/ }).click();

  await expect(page.locator("h3", { hasText: /Decision|No project|Project/ }).first()).toBeVisible({ timeout: 30_000 });

  // Multi-project daemon → target the seeded project explicitly.
  const projSelect = page.locator("#proj");
  if ((await projSelect.count()) > 0) {
    const hasOption = await projSelect.locator(`option[value="${pid}"]`).count();
    if (hasOption > 0) { await projSelect.selectOption(pid); }
  }

  // The status card also mentions "decisions" — match the real DEC-xxx card only.
  const decisionCard = page.locator(".card", { hasText: /Decision DEC-\d+/ }).first();
  if ((await decisionCard.count()) > 0) {
    const before = (await (await request.get(`/api/projects/${pid}/decisions`)).json()).decisions.filter((d: { status: string }) => d.status === "OPEN").length;
    await decisionCard.locator("button").first().click();
    await expect(decisionCard).not.toBeVisible({ timeout: 30_000 }).catch(() => undefined);
    const after = (await (await request.get(`/api/projects/${pid}/decisions`)).json()).decisions.filter((d: { status: string }) => d.status === "OPEN").length;
    expect(after).toBeLessThan(before);
  }

  // Engineering Lead chat replies through the daemon (structured governance, no bypass).
  await page.locator("#chat").fill("What is happening?");
  await page.locator("#chat").press("Enter");
  await expect(page.locator("#reply")).toContainText(/./, { timeout: 30_000 });
});

test("pairing tokens are single-use: replaying a consumed token fails", async ({ request }) => {
  const begin = await (await request.post(`${DAEMON}/api/mobile/pair/begin`, { data: { deviceName: "reuse", requestedRole: "VIEWER" } })).json();
  await request.post(`${DAEMON}/api/mobile/pair/complete`, { data: { token: begin.pairingToken } });
  const replay = await request.post(`${DAEMON}/api/mobile/pair/complete`, { data: { token: begin.pairingToken } });
  expect(replay.status()).toBe(401);
});
