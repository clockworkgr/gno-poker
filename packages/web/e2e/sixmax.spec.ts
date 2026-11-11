// A full six-handed hand (largest table): 12 deck passes, 10-key hole deal, showdown of 6 hands.
import { expect, test } from "@playwright/test";
import { Bots, allShots, checkCall, createAndJoin, openApp, playHand, startHand } from "./helpers.ts";

let bots: Bots | null = null;
test.afterAll(async () => {
  await bots?.stop();
});

test("plays a six-handed hand to a verified showdown", async ({ page }) => {
  await openApp(page);
  const id = await createAndJoin(page, { seats: 6, timeout: 80, window: 20 });
  bots = new Bots(["--table", String(id), "--bots", "5", "--index", "50"]);
  await bots.seated(5);
  await startHand(page);
  await expect(page.getByTestId("my-cards").locator("[data-card]")).toHaveCount(2, { timeout: 180_000 });
  await allShots(page, "table-sixmax");
  await playHand(page, checkCall);
  await expect(page.getByTestId("verify-ok")).toContainText("All 12 deck passes");
  for (let s = 0; s < 6; s++) await expect(page.getByTestId(`seat-${s}`).locator("[data-card]")).toHaveCount(2);
  await page.getByTestId("leave").click();
  await expect(page.getByTestId("dock")).toContainText("watching", { timeout: 60_000 });
});
