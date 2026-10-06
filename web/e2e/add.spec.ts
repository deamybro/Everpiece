// "Add Dollars from another chain" on the TESTNET stack, whose Aurora is SIMULATED (scripts/aurora-sim.mjs: nothing
// crosses a chain; test CTK is delivered). Exercises the real relayer adapter, the real Agora conversion and the app.
import { expect, test, type BrowserContext, type Page } from "@playwright/test";

async function withPasskeys(context: BrowserContext): Promise<Page> {
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: {
      protocol: "ctap2", ctap2Version: "ctap2_1", transport: "internal", hasResidentKey: true,
      hasUserVerification: true, isUserVerified: true, hasPrf: true, automaticPresenceSimulation: true,
    },
  });
  return page;
}

test.afterEach(async ({ browser }) => {
  for (const c of browser.contexts()) await c.close();
});

test("add $5 from Base (simulated): price → deposit → arrives → one prompt → exactly $5.00 in Dollars", async ({ browser }) => {
  test.setTimeout(300_000);
  const page = await withPasskeys(await browser.newContext());
  const csp: string[] = [];
  page.on("console", (m) => m.type() === "error" && /Content Security Policy/.test(m.text()) && csp.push(m.text()));

  await page.goto("/");
  await page.getByLabel("Your first name").fill("Ada");
  await page.getByRole("button", { name: "Create my account with fingerprint or screen lock" }).click();
  await expect(page.locator(".balance")).toHaveText("$0.00");

  await page.getByRole("link", { name: "Add money from another chain" }).click();
  await expect(page.getByText("Simulated cross-chain transfer", { exact: false })).toBeVisible();
  await page.getByLabel("Dollars to add").fill("5");
  await expect(page.getByText("USDC on Base (simulated)")).toBeVisible();

  // a refund address is required and must be an address
  await page.getByLabel(/Your wallet address on/).fill("not-an-address");
  await page.getByRole("button", { name: "See the price" }).click();
  await expect(page.getByText("(it starts with 0x)", { exact: false })).toBeVisible();
  await page.getByLabel(/Your wallet address on/).fill("0x2222222222222222222222222222222222222222");
  await page.getByRole("button", { name: "See the price" }).click();

  const summary = page.getByLabel("Top-up summary");
  await expect(summary).toContainText("$5.00 in Dollars");
  await expect(summary).toContainText("USDC on Base (simulated)");
  await expect(summary).toContainText("0x2222222222222222222222222222222222222222");
  await page.getByRole("button", { name: "Show me where to send it" }).click();

  await expect(page.getByLabel("Deposit address")).toHaveText(/^0x[0-9a-fA-F]{40}$/);
  await expect(page.getByText("Waiting for your deposit…")).toBeVisible();
  // the top-up survives a reload
  await page.reload();
  await expect(page.getByText("Waiting for your deposit…")).toBeVisible();
  await page.getByRole("button", { name: "Simulate the deposit (test only)" }).click();

  await expect(page.getByRole("heading", { name: "Turn it into Dollars" })).toBeVisible({ timeout: 120_000 });
  await page.getByRole("button", { name: "Convert to $5.00 with fingerprint or screen lock" }).click();
  await expect(page.getByText("Added $5.00 ✓", { exact: false })).toBeVisible({ timeout: 120_000 });
  await page.getByRole("link", { name: "Back to Everpiece" }).click();
  await expect(page.locator(".balance")).toHaveText("$5.00");
  await expect(page.getByLabel("Top-up in progress")).toHaveCount(0);

  expect(csp).toEqual([]);
});
