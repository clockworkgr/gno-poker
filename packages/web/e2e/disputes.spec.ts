// Dispute paths against a live gnodev: a cheating last shuffler is detected after the hand, the
// mismatch is shown and (after the player confirms) challenged and convicted; a player who refuses
// to reveal is timed out and forfeits.

import { mkdirSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { Bots, allShots, checkCall, createAndJoin, openApp, playHand, shots, startHand } from "./helpers.ts";

let bots: Bots | null = null;
test.afterEach(async () => {
  await bots?.stop();
  bots = null;
});

test("detects a cheating shuffler and convicts it after confirmation", async ({ page }) => {
  mkdirSync(shots, { recursive: true });
  await openApp(page, { confirmChallenge: true });
  const tableId = await createAndJoin(page, { seats: 2, timeout: 60, window: 40 });
  bots = new Bots(["--table", String(tableId), "--bots", "1", "--index", "40", "--cheat"]);
  await bots.seated(1);

  const challenge = page.getByTestId("send-challenge");
  let found = false;
  // Heads-up the bot is the last shuffler every other hand.
  for (let hand = 0; hand < 3 && !found; hand++) {
    await startHand(page);
    await playHand(page, checkCall, page.getByTestId("start-hand").or(challenge));
    found = await challenge.isVisible();
  }
  expect(found).toBe(true);
  await expect(page.getByTestId("verify-bad")).toContainText("does not follow from their revealed seed");
  await allShots(page, "table-challenge");
  await challenge.click();
  await expect(page.getByTestId("dock-head")).toContainText("convicted", { timeout: 60_000 });
  await expect(page.locator(".seat-plate-open")).toHaveCount(1, { timeout: 30_000 }); // the cheater was removed
  await expect(page.getByTestId("log")).toContainText("GUILTY");
  console.log("--- bot log (tail) ---\n" + bots.tail());
  await page.getByTestId("leave").click();
  await expect(page.getByTestId("dock")).toContainText("watching", { timeout: 60_000 });
});

test("times out a player who will not reveal", async ({ page }) => {
  await openApp(page);
  const tableId = await createAndJoin(page, { seats: 2, timeout: 6, window: 10 });
  bots = new Bots(["--table", String(tableId), "--bots", "1", "--index", "41", "--stall", "reveal"]);
  await bots.seated(1);
  await startHand(page);
  await playHand(page, checkCall, page.getByTestId("timeout"));
  await page.getByTestId("timeout").click();
  await expect(page.getByTestId("dock-head")).toContainText("aborted", { timeout: 60_000 });
  await expect(page.getByTestId("dock-head")).toContainText("forfeited");
  await expect(page.locator(".seat-plate-open")).toHaveCount(1, { timeout: 30_000 });
  await page.getByTestId("leave").click();
  await expect(page.getByTestId("dock")).toContainText("watching", { timeout: 60_000 });
});
