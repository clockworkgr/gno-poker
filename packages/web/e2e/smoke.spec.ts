// End-to-end smoke test against a live gnodev: create a table, join with a session key, play
// several hands against dev auto-players (fold, raise, showdown, reload mid-hand), then leave and
// cash out. Takes screenshots of the lobby and the table in both themes at desktop and phone width.

import { mkdirSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { Bots, allShots, checkCall, createAndJoin, openApp, playHand, shots, startHand } from "./helpers.ts";

let bots: Bots | null = null;
test.afterAll(async () => {
  await bots?.stop();
});

test("create, join, play hands, reload mid-hand, leave", async ({ page }) => {
  mkdirSync(shots, { recursive: true });
  await openApp(page);
  const tableId = await createAndJoin(page, { seats: 3, timeout: 80, window: 20 });
  await page.getByTestId("tab-seat").click();
  await expect(page.getByTestId("session-address")).toHaveText(/^g1/);
  await page.getByTestId("tab-log").click();

  bots = new Bots(["--table", String(tableId), "--bots", "2", "--index", "30"]);
  await bots.seated(2);
  await expect(page.locator(".seat-plate-open")).toHaveCount(0, { timeout: 30_000 });

  await page.goto("/#/");
  await expect(page.getByTestId(`table-row-${tableId}`)).toBeVisible();
  await allShots(page, "lobby");
  await page.goto(`/#/table/${tableId}`);

  // Hand 1: fold at the first decision
  await startHand(page);
  expect(await playHand(page, () => "fold")).toEqual(["fold"]);
  await expect(page.getByTestId("log")).toContainText("You fold");

  // Hand 2: raise pre-flop, then check/call to showdown
  await startHand(page);
  const h2 = await playHand(page, (street, canCheck) => (street === 0 ? "raise" : canCheck ? "check" : "call"));
  expect(h2[0]).toBe("raise");
  await expect(page.getByTestId("log")).toContainText(/You (raise to|bet)/);
  await expect(page.getByTestId("verify-ok")).toBeVisible({ timeout: 60_000 });
  for (let s = 0; s < 3; s++) await expect(page.getByTestId(`seat-${s}`).locator("[data-card]")).toHaveCount(2);
  await allShots(page, "table-showdown");

  // Hand 3: reload as soon as our hole cards are open, then finish the hand
  await startHand(page);
  const mine = page.getByTestId("my-cards").locator("[data-card]");
  await expect(mine).toHaveCount(2, { timeout: 120_000 });
  const before = await mine.evaluateAll((els) => els.map((e) => e.getAttribute("data-card")));
  await allShots(page, "table-inhand");
  await page.reload();
  await expect(mine).toHaveCount(2, { timeout: 60_000 });
  expect(await mine.evaluateAll((els) => els.map((e) => e.getAttribute("data-card")))).toEqual(before);
  await expect(page.getByTestId("log")).toContainText("Hand #3 started"); // the log survived the reload
  await playHand(page, checkCall);
  await expect(page.getByTestId("verify-ok")).toBeVisible({ timeout: 60_000 });

  // Leave and cash out
  await page.getByTestId("tab-seat").click();
  const balText = async () => (await page.locator(".kv dd").first().innerText()).split("\n").pop() ?? "";
  const beforeLeave = await balText();
  await page.getByTestId("leave").click();
  await expect(page.getByTestId("dock")).toContainText("watching", { timeout: 60_000 });
  await expect.poll(balText, { timeout: 30_000 }).not.toBe(beforeLeave);
  console.log("wallet before leave:", beforeLeave, "after:", await balText());
  await page.getByTestId("sweep").click();
  await page.getByTestId("tab-log").click();
  await expect(page.getByTestId("log")).toContainText("Returned the session key's unused gas", { timeout: 30_000 });
  console.log("--- bot log (tail) ---\n" + bots.tail());
});
