// Browser failure cases: native controls lose styles across shadow roots,
// map or modifier clicks submit the lobby, polling resets a draft, busy controls
// remain active, mobile layouts overflow, and UI values differ from the request.
// OPENFRONT_URL selects Vite. PLAYWRIGHT_PACKAGE can select bundled Playwright.
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_PACKAGE ?? "playwright");
const baseUrl = process.env.OPENFRONT_URL ?? "http://localhost:9000";
const output = path.resolve(".agent-arena", "verification", "lobby-options");
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
let captured;
let submissions = 0;
const idle = {
  phase: "idle",
  gameId: null,
  players: [],
  totalTokens: 0,
  runtime: { authenticated: true, models: ["gpt-6-luna"] },
  settings: {
    agentCount: 4,
    mediumAgentCount: 0,
    tribeCount: 100,
    nationCount: 52,
    mode: "codex",
    gameMap: "Europe",
    gameMapSize: "Compact",
    useRandomMap: false,
    difficulty: "Easy",
    gameMode: "Free For All",
    playerTeams: 2,
    randomSpawn: false,
    infiniteGold: false,
    infiniteTroops: false,
    instantBuild: false,
    disabledUnits: [],
    waterNukes: false,
  },
};
await page.route("**/api/agents**", async (route) => {
  if (route.request().method() === "POST") {
    assert.ok(route.request().url().endsWith("/create"));
    submissions++;
    captured = route.request().postDataJSON();
    await new Promise((resolve) => setTimeout(resolve, 500));
    await route.fulfill({
      status: 409,
      contentType: "application/json",
      body: JSON.stringify({ error: "Captured test request" }),
    });
  } else {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify(idle),
    });
  }
});
try {
  await page.goto(baseUrl);
  await page.waitForFunction(() => customElements.get("agent-panel"));
  const panel = page.locator("agent-panel");
  await panel.getByRole("button", { name: "Agent lobby", exact: true }).click();
  const form = panel.locator("agent-lobby-form");
  await form.waitFor();
  await form.locator('input[name="agentCount"]').fill("6");
  await form.locator('input[name="mediumAgentCount"]').fill("2");
  await form.getByPlaceholder(/search maps/i).fill("Africa");
  await form.getByRole("button", { name: "Africa", exact: true }).click();
  await form.getByRole("button", { name: "Hard", exact: true }).click();
  await form.getByRole("button", { name: "Teams", exact: true }).click();
  await form
    .getByRole("button", { name: "Infinite gold", exact: true })
    .click();
  await form.getByRole("button", { name: "Compact Map", exact: true }).click();
  await form
    .getByRole("button", { name: "Instant build", exact: true })
    .click();
  await form
    .getByRole("button", { name: "Starting Gold (Millions)", exact: true })
    .click();
  await form
    .getByRole("spinbutton", { name: "Starting Gold (Millions)", exact: true })
    .fill("7.5");
  await form.getByRole("button", { name: "City", exact: true }).click();
  assert.equal(
    submissions,
    0,
    "configuration buttons must not submit the lobby",
  );
  await page.waitForTimeout(2300);
  assert.equal(
    await form.locator('input[name="agentCount"]').inputValue(),
    "6",
  );
  assert.equal(
    await form
      .getByRole("button", { name: "City", exact: true })
      .getAttribute("aria-pressed"),
    "false",
  );
  await panel.locator(".body").evaluate((element) => {
    element.scrollTop = 0;
  });
  await panel
    .locator(".panel")
    .screenshot({ path: path.join(output, "desktop.png") });
  await page.setViewportSize({ width: 380, height: 820 });
  await page.waitForTimeout(100);
  const layout = await form.evaluate((element) => ({
    width: element.getBoundingClientRect().width,
    contentWidth: element.shadowRoot.querySelector("fieldset").scrollWidth,
    styledGrid: getComputedStyle(
      element.shadowRoot.querySelector("map-picker .grid"),
    ).display,
  }));
  assert.ok(layout.width <= 356);
  assert.equal(layout.styledGrid, "grid");
  assert.ok(layout.contentWidth <= layout.width + 1, JSON.stringify(layout));
  await panel
    .locator(".panel")
    .screenshot({ path: path.join(output, "mobile.png") });
  await form.getByRole("button", { name: "Spectate", exact: true }).click();
  await page.waitForFunction(
    () =>
      document
        .querySelector("agent-panel")
        .shadowRoot.querySelector("agent-lobby-form").busy,
  );
  assert.equal(
    await form
      .getByRole("button", { name: "Spectate", exact: true })
      .isDisabled(),
    true,
  );
  await page.waitForFunction(
    () =>
      !document
        .querySelector("agent-panel")
        .shadowRoot.querySelector("agent-lobby-form").busy,
  );
  assert.equal(submissions, 1);
  assert.equal(captured.gameMap, "Africa");
  assert.equal(captured.gameMapSize, "Normal");
  assert.equal(captured.gameMode, "Team");
  assert.equal(captured.difficulty, "Hard");
  assert.equal(captured.agentCount, 6);
  assert.equal(captured.mediumAgentCount, 2);
  assert.equal(captured.infiniteGold, true);
  assert.equal(captured.instantBuild, true);
  assert.equal(captured.startingGold, 7_500_000);
  assert.deepEqual(captured.disabledUnits, ["City"]);
  assert.deepEqual(errors, []);
  await writeFile(
    path.join(output, "checks.json"),
    JSON.stringify({ captured, layout, errors }, null, 2),
  );
  console.log(
    "Native map UI, modifier request, draft persistence, busy controls, and mobile layout passed.",
  );
} finally {
  await browser.close();
}
