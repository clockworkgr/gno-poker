import { type ChildProcess, spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { type Page, expect } from "@playwright/test";

const here = path.dirname(fileURLToPath(import.meta.url));
export const shots = path.join(here, "screenshots");
export const rpc = process.env.E2E_RPC_URL ?? "http://127.0.0.1:46657";
export const chain = process.env.E2E_CHAIN_ID ?? "dev";

export class Bots {
  proc: ChildProcess;
  log = "";
  constructor(args: string[]) {
    this.proc = spawn(process.execPath, ["dev/autoplayer.ts", ...args, "--rpc", rpc, "--chain", chain], {
      cwd: path.join(here, ".."),
      stdio: ["ignore", "pipe", "pipe"],
    });
    this.proc.stdout!.on("data", (d) => (this.log += d.toString()));
    this.proc.stderr!.on("data", (d) => (this.log += d.toString()));
  }
  async seated(n: number) {
    await expect.poll(() => (this.log.match(/joined table|already seated/g) ?? []).length, { timeout: 60_000 }).toBe(n);
  }
  async stop() {
    if (this.proc.exitCode !== null) return;
    this.proc.kill("SIGTERM");
    for (let i = 0; i < 40 && this.proc.exitCode === null; i++) await new Promise((r) => setTimeout(r, 250));
    if (this.proc.exitCode === null) this.proc.kill("SIGKILL");
  }
  tail(n = 15) {
    return this.log.split("\n").slice(-n).join("\n");
  }
}

/** Fresh browser state with the given settings, development wallet (test1) connected. */
export async function openApp(page: Page, settings: Record<string, unknown> = {}) {
  page.on("pageerror", (e) => console.log("pageerror:", e.message));
  await page.goto("/");
  await page.evaluate(({ rpc, chain, settings }) => {
    localStorage.clear();
    sessionStorage.clear();
    localStorage.setItem("gno-poker:settings", JSON.stringify({ rpcUrl: rpc, chainId: chain, theme: "light", ...settings }));
  }, { rpc, chain, settings });
  await page.reload();
  await page.getByTestId("wallet-button").click();
  await page.getByTestId("use-dev-wallet").click();
  await expect(page.getByTestId("wallet-button")).toContainText("Dev key");
}

/** Creates a table from the lobby form and takes a seat; returns the table id. */
export async function createAndJoin(page: Page, o: { seats: number; timeout: number; window: number; buyIn?: number }) {
  await page.getByTestId("create-players").selectOption(String(o.seats));
  await page.getByTestId("create-timeout").fill(String(o.timeout));
  await page.getByTestId("create-window").fill(String(o.window));
  await page.getByTestId("create-table").click();
  await page.waitForURL(/#\/table\/\d+/);
  const tableId = Number(/table\/(\d+)/.exec(page.url())![1]);
  await page.getByTestId("join-here").click();
  await page.getByTestId("buyin").fill(String((o.buyIn ?? 100000) / 1_000_000)); // the form takes GNOT
  await page.getByTestId("confirm-join").click();
  await expect(page.getByTestId("gas-chip")).toContainText("GNOT", { timeout: 30_000 });
  return tableId;
}

export async function startHand(page: Page) {
  await page.getByTestId("start-hand").click();
  await expect(page.getByTestId("start-hand")).toBeHidden({ timeout: 30_000 });
}

export type Policy = (street: number, canCheck: boolean) => "fold" | "check" | "call" | "raise";
export const checkCall: Policy = (_s, canCheck) => (canCheck ? "check" : "call");

/**
 * Plays the current hand with a policy until `done` appears (default: the Deal button).
 * Returns the actions taken.
 */
export async function playHand(page: Page, policy: Policy, done = page.getByTestId("start-hand")): Promise<string[]> {
  const taken: string[] = [];
  let street = 0;
  const controls = page.getByTestId("bet-controls");
  for (let guard = 0; guard < 40; guard++) {
    await expect(done.or(controls).first()).toBeVisible({ timeout: 180_000 });
    if (await done.first().isVisible()) return taken;
    const canCheck = await page.getByTestId("act-check").isVisible();
    const act = policy(street++, canCheck);
    const id = act === "check" && !canCheck ? "act-call" : act === "call" && canCheck ? "act-check" : `act-${act}`;
    taken.push(id.replace("act-", ""));
    await page.getByTestId(id).click();
    await expect(controls).toBeHidden({ timeout: 60_000 });
  }
  throw new Error("hand did not finish");
}

export async function shot(page: Page, name: string, opts: { theme: "light" | "dark"; width: number; height: number }) {
  await page.evaluate((t) => {
    const s = JSON.parse(localStorage.getItem("gno-poker:settings") ?? "{}");
    localStorage.setItem("gno-poker:settings", JSON.stringify({ ...s, theme: t }));
    document.documentElement.setAttribute("data-theme", t);
  }, opts.theme);
  await page.setViewportSize({ width: opts.width, height: opts.height });
  await page.waitForTimeout(400);
  await page.screenshot({ path: path.join(shots, `${name}-${opts.width < 700 ? "phone" : "desktop"}-${opts.theme}.png`), fullPage: true });
}

export async function allShots(page: Page, name: string) {
  for (const theme of ["light", "dark"] as const) {
    await shot(page, name, { theme, width: 1440, height: 960 });
    await shot(page, name, { theme, width: 390, height: 844 });
  }
  await page.setViewportSize({ width: 1440, height: 960 });
}
