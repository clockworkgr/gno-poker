import { mkdirSync } from "node:fs";
import path from "node:path";
import { type Locator, type Page, expect, test } from "@playwright/test";
import { Bots, checkCall, createAndJoin, openApp, playHand, shots, startHand } from "./helpers.ts";

const directory = path.join(shots, "compact");
const viewports = [
  { width: 1440, height: 800 },
  { width: 1366, height: 668 },
  { width: 1280, height: 620 },
  { width: 390, height: 844 },
];
const themes = ["light", "dark"] as const;
type Viewport = (typeof viewports)[number];

async function layout(page: Page, viewport: Viewport, theme: (typeof themes)[number]) {
  await page.setViewportSize(viewport);
  await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
  await page.evaluate((theme) => {
    document.documentElement.setAttribute("data-theme", theme);
    window.scrollTo(0, 0);
  }, theme);
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
}

async function screenshot(page: Page, name: string, viewport: Viewport, theme: string) {
  await page.screenshot({
    path: path.join(directory, `${name}-${viewport.width}x${viewport.height}-${theme}.png`),
    fullPage: true,
    animations: "disabled",
  });
}

async function insideViewport(locator: Locator, viewport: Viewport) {
  const box = await locator.boundingBox();
  expect(box, `${locator} has a box`).not.toBeNull();
  expect(box!.x, `${locator} left`).toBeGreaterThanOrEqual(0);
  expect(box!.y, `${locator} top`).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width, `${locator} right`).toBeLessThanOrEqual(viewport.width + 0.5);
  expect(box!.y + box!.height, `${locator} bottom`).toBeLessThanOrEqual(viewport.height + 0.5);
  return box!;
}

async function fullActionDock(page: Page) {
  await expect(page.getByTestId("dock-head")).toHaveText("Your turn");
  await expect(page.getByTestId("my-cards").locator("[data-card]")).toHaveCount(2);
  for (const id of ["bet-controls", "act-fold", "act-raise", "raise-slider", "raise-input", "preset-allin"]) {
    await expect(page.getByTestId(id)).toBeVisible();
  }
  await expect(page.getByTestId("act-check").or(page.getByTestId("act-call"))).toBeVisible();
  await expect(page.locator(".presets button")).toHaveCount(4);
}

async function desktopFit(page: Page, viewport: Viewport) {
  const dimensions = await page.evaluate(() => ({
    height: document.documentElement.scrollHeight,
    width: document.documentElement.scrollWidth,
    viewportHeight: window.innerHeight,
    viewportWidth: window.innerWidth,
    scrollY: window.scrollY,
  }));
  expect(dimensions.height, "no vertical page scrolling").toBeLessThanOrEqual(dimensions.viewportHeight);
  expect(dimensions.width, "no horizontal page scrolling").toBeLessThanOrEqual(dimensions.viewportWidth);
  expect(dimensions.scrollY).toBe(0);

  await insideViewport(page.locator(".header"), viewport);
  const felt = await insideViewport(page.locator(".felt-wrap"), viewport);
  const dock = await insideViewport(page.getByTestId("dock"), viewport);
  await insideViewport(page.locator(".side"), viewport);
  expect(felt.y + felt.height, "felt and dock do not overlap").toBeLessThanOrEqual(dock.y);

  // Absolute seats and rotated cards can protrude beyond the felt's layout box.
  for (const element of await page.locator(".felt-wrap .felt, .felt-wrap .seat, .felt-wrap .card, .board, .pots, .status-pill").all()) {
    const box = await insideViewport(element, viewport);
    expect(box.y + box.height, `${element} is above the dock`).toBeLessThanOrEqual(dock.y);
  }
  for (const control of await page.locator(".bet-controls button, .bet-controls input").all()) {
    await insideViewport(control, viewport);
  }
}

test("lobby and dialogs retain the compact scale in both themes", async ({ page }) => {
  mkdirSync(directory, { recursive: true });
  await openApp(page);
  await expect(page.getByText("Loading tables…", { exact: true })).toBeHidden();
  await expect(page.locator(".lobby .error-text")).toHaveCount(0);
  for (const theme of themes) {
    for (const viewport of viewports) {
      await test.step(`lobby ${viewport.width}x${viewport.height} ${theme}`, async () => {
        await layout(page, viewport, theme);
        await screenshot(page, "lobby", viewport, theme);
        expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(viewport.width);
        await expect(page.getByTestId("create-table")).toBeVisible();
        await page.getByTestId("create-table").scrollIntoViewIfNeeded();
        await insideViewport(page.getByTestId("create-table"), viewport);

        await page.getByRole("button", { name: "Settings", exact: true }).click();
        const dialog = page.getByRole("dialog");
        await expect(dialog).toBeVisible();
        await insideViewport(dialog, viewport);
        await screenshot(page, "settings", viewport, theme);
        await dialog.getByRole("button", { name: "Close", exact: true }).click();
      });
    }
  }
});

test("six-max table and full betting dock fit the laptop viewport", async ({ page }) => {
  mkdirSync(directory, { recursive: true });
  await openApp(page);
  const id = await createAndJoin(page, { seats: 6, timeout: 120, window: 20 });
  const bots = new Bots(["--table", String(id), "--bots", "5", "--index", "60"]);
  try {
    await bots.seated(5);
    await expect(page.locator(".seat-plate-open")).toHaveCount(0);
    await startHand(page);
    await expect(page.getByTestId("bet-controls")).toBeVisible({ timeout: 180_000 });

    for (const theme of themes) {
      for (const viewport of viewports) {
        await test.step(`table ${viewport.width}x${viewport.height} ${theme}`, async () => {
          await layout(page, viewport, theme);
          await fullActionDock(page);
          await screenshot(page, "table-sixmax-turn", viewport, theme);
          if (viewport.width > 1000) {
            // Each side panel must stay within the same desktop height budget.
            for (const tab of ["fair", "seat", "log"]) {
              await page.getByTestId(`tab-${tab}`).click();
              await desktopFit(page, viewport);
            }
          } else {
            await page.getByTestId("bet-controls").scrollIntoViewIfNeeded();
            await insideViewport(page.getByTestId("bet-controls"), viewport);
            expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(viewport.width);
            for (const control of await page.locator(".bet-controls button, .bet-controls input, .seat-buttons button").all()) {
              expect((await control.boundingBox())!.height, "phone touch target").toBeGreaterThanOrEqual(40);
            }
            await screenshot(page, "table-sixmax-actions", viewport, theme);
          }
        });
      }
    }

    // Also guard the narrow and wide ends of the supported phone range.
    for (const width of [360, 430]) {
      await layout(page, { width, height: 844 }, "light");
      await fullActionDock(page);
      await page.getByTestId("bet-controls").scrollIntoViewIfNeeded();
      await insideViewport(page.getByTestId("bet-controls"), { width, height: 844 });
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    }

    await page.setViewportSize({ width: 1280, height: 620 });
    await playHand(page, checkCall);
    await expect(page.getByTestId("verify-ok")).toContainText("All 12 deck passes");
    await page.getByTestId("leave").click();
    await expect(page.getByTestId("dock")).toContainText("watching");
  } finally {
    await bots.stop();
  }
});
