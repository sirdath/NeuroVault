import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("nv.onboarding.done", "true");
    localStorage.setItem("nv.splash.seen", "true");
  });

  await page.route("http://127.0.0.1:8765/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/health") {
      await route.fulfill({ json: { status: "ok" } });
    } else if (path === "/api/status") {
      await route.fulfill({ json: { memories: 0, chunks: 0, entities: 0, connections: 0, indexing: [] } });
    } else if (path === "/api/brains") {
      await route.fulfill({ json: [{ id: "sample", name: "Sample Vault", description: "", created_at: "", is_active: true }] });
    } else if (path === "/api/brains/active") {
      await route.fulfill({ json: { id: "sample", name: "Sample Vault" } });
    } else if (path === "/api/notes") {
      await route.fulfill({ json: [] });
    } else if (path === "/api/home_brief") {
      await route.fulfill({ json: { needs_review: 0, sessions_today: 0, continue: null, since: [] } });
    } else if (path === "/api/proposals") {
      await route.fulfill({ json: { proposals: [] } });
    } else if (path === "/api/activity/context_receipts") {
      await route.fulfill({ json: { receipts: [] } });
    } else {
      await route.fulfill({ status: 503, json: { error: "not available in smoke fixture" } });
    }
  });
});

test("the consumer shell boots, navigates, and has no serious structural accessibility violations", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("button", { name: "Today", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Search", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Memories", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Graph", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Privacy & Trust", exact: true })).toBeVisible();
  await expect(page.getByText("Something crashed while rendering")).toHaveCount(0);

  await page.getByRole("button", { name: "Open settings" }).click();
  await expect(page.getByRole("heading", { name: "Settings", level: 1 })).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Main navigation" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Open settings" })).toHaveAttribute("aria-current", "page");

  const audit = await new AxeBuilder({ page }).analyze();
  const blocking = audit.violations.filter(
    (violation) => violation.impact === "critical" || violation.impact === "serious",
  );
  expect(blocking).toEqual([]);
});
