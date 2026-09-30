// Browser failure cases: incoming dumps hide decisions, polls move the reader,
// new events fail to follow at the bottom, retained rows lose expanded details,
// and the panel changes height as its history grows.
// Run against Vite: OPENFRONT_URL=http://localhost:9000 node tests/agents/transcript-ui-e2e.mjs
// PLAYWRIGHT_PACKAGE can point to a bundled Playwright package without repo installation.
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_PACKAGE ?? "playwright");
const baseUrl = process.env.OPENFRONT_URL ?? "http://localhost:9000";
const output = path.resolve(".agent-arena", "verification", "transcript-ui");
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
const player = {
  id: "reader",
  clientId: "reader01",
  name: "Reader",
  threadId: "thread-reader",
  status: "ready",
  alive: true,
  tokens: 1200,
  decisions: 30,
};
const events = Array.from({ length: 35 }, (_, index) => ({
  time: 1_800_000_000_000 + index,
  type: "think",
  text: `Decision note ${index}: advance along the coast.`,
}));
events.push({
  time: 1_800_000_000_050,
  type: "observation",
  text: "incoming-observation-dump",
});
events.push({
  time: 1_800_000_000_051,
  type: "item/completed",
  text: JSON.stringify({
    method: "item/completed",
    params: {
      item: { type: "agentMessage", text: "I attacked the coastal rival." },
    },
  }),
});
events.push({
  time: 1_800_000_000_052,
  type: "action",
  text: 'Submitted {"type":"upgrade_structure","unit":"Port","unitId":42,"amount":5}',
});
events.push({
  time: 1_800_000_000_053,
  type: "action",
  text: 'Submitted {"type":"boat","dst":4567,"troops":1000}',
});
const lobby = {
  phase: "running",
  gameId: "reader-game",
  players: [player],
  settings: { agentCount: 1, tribeCount: 0, nationCount: 0, mode: "codex" },
  runtime: { authenticated: true, models: [] },
  totalTokens: 1200,
};
await page.route("**/api/agents**", (route) =>
  route.fulfill({
    json: route.request().url().includes("/players/")
      ? { player, events }
      : lobby,
  }),
);
await page.route("**/transcript-ui-test", (route) =>
  route.fulfill({
    contentType: "text/html",
    body: `<html><body style="background:#111820"><lang-selector hidden></lang-selector>
    <script type="module">
      import en from '/resources/lang/en.json';
      const language = document.querySelector('lang-selector');
      language.currentLang = 'en';
      language.translations = Object.fromEntries(['agents', 'unit_type'].flatMap(group => Object.entries(en[group]).map(([key, text]) => [group + '.' + key, text])));
      sessionStorage.setItem('openfront.agentPanelOpen', 'true');
      await import('/src/client/agents/AgentPanel.ts');
      const panel = document.createElement('agent-panel');
      panel.focusPlayer = () => {};
      panel.joinLobby = () => {};
      document.body.append(panel);
    </script></body></html>`,
  }),
);
try {
  await page.goto(`${baseUrl}/transcript-ui-test`);
  await page.locator("agent-panel .player").click();
  await page.locator("agent-panel .transcript-event").first().waitFor();
  const body = page.locator("agent-panel .body");
  const snapshot = () =>
    body.evaluate((element) => ({
      top: element.scrollTop,
      height: element.scrollHeight,
      viewport: element.clientHeight,
      text: element.textContent,
      panelHeight: element.parentElement.getBoundingClientRect().height,
    }));
  const first = await snapshot();
  assert.ok(
    !first.text.includes("incoming-observation-dump"),
    "Default view hides incoming data",
  );
  assert.ok(
    first.text.includes("I attacked the coastal rival."),
    "Final messages show readable text",
  );
  assert.ok(
    first.text.includes("Upgrade Port #42 ×5"),
    "Upgrade summary includes structure and amount",
  );
  assert.ok(
    first.text.includes("Send boat to tile 4567"),
    "Boat summary includes destination",
  );
  assert.ok(
    first.height - first.viewport - first.top < 3,
    "Opening an agent follows the latest event",
  );
  const append = async (number) => {
    events.push({
      time: 1_800_000_000_100 + number,
      type: "think",
      text: `New decision ${number}`,
    });
    await page.evaluate(async () => {
      await document.querySelector("agent-panel").refresh();
    });
  };
  await append(1);
  const followed = await snapshot();
  assert.ok(
    followed.height - followed.viewport - followed.top < 3,
    "New events follow at the bottom",
  );
  assert.equal(
    followed.panelHeight,
    first.panelHeight,
    "Panel height stays fixed",
  );
  await body.evaluate((element) => {
    element.scrollTop = 700;
    element.dispatchEvent(new Event("scroll"));
  });
  const detail = page
    .locator("agent-panel .transcript-event")
    .nth(6)
    .locator("details");
  await detail.evaluate((element) => {
    element.open = true;
  });
  const reading = await snapshot();
  await append(2);
  const retained = await snapshot();
  assert.ok(
    Math.abs(retained.top - reading.top) < 2,
    "New events preserve the reading position",
  );
  assert.equal(
    await detail.evaluate((element) => element.open),
    true,
    "Polling keeps event details open",
  );
  // Simulate the backend's retained history window, then verify the same visible note stays put.
  const beforeTrim = await page
    .locator("agent-panel .transcript-event")
    .evaluateAll((rows) => {
      const bounds = rows[0].closest(".body").getBoundingClientRect();
      const row = rows.find(
        (entry) => entry.getBoundingClientRect().bottom > bounds.top,
      );
      return {
        text: row.querySelector(".event-preview").textContent,
        y: row.getBoundingClientRect().top,
      };
    });
  events.splice(0, 2);
  await append(3);
  const afterTrim = await page
    .locator("agent-panel .transcript-event")
    .evaluateAll((rows) => {
      const bounds = rows[0].closest(".body").getBoundingClientRect();
      const row = rows.find(
        (entry) => entry.getBoundingClientRect().bottom > bounds.top,
      );
      return {
        text: row.querySelector(".event-preview").textContent,
        y: row.getBoundingClientRect().top,
      };
    });
  assert.deepEqual(
    afterTrim,
    beforeTrim,
    "Retained history trimming preserves the visible row",
  );
  await page.getByRole("button", { name: "Latest", exact: true }).click();
  const latest = await snapshot();
  assert.ok(
    latest.height - latest.viewport - latest.top < 3,
    "Latest resumes following",
  );
  await page.getByRole("checkbox", { name: "Show diagnostics" }).check();
  assert.ok(
    (await snapshot()).text.includes("incoming-observation-dump"),
    "Diagnostics retain incoming data",
  );
  await page.getByRole("checkbox", { name: "Show diagnostics" }).uncheck();
  assert.deepEqual(errors, [], "No browser errors");
  await page.screenshot({ path: path.join(output, "transcript.png") });
  await writeFile(
    path.join(output, "result.json"),
    JSON.stringify(
      {
        passed: true,
        checks: 13,
        first,
        followed,
        reading,
        retained,
        beforeTrim,
        afterTrim,
        latest,
      },
      null,
      2,
    ),
  );
  console.log(`Transcript UI passed. Artifacts: ${output}`);
} finally {
  await browser.close();
}
