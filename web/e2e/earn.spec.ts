// Earn on the TESTNET stack (docs/EARN.md): real EverpieceEarn + the SIMULATED-yield test vault over real Agora
// testnet AUSD, gasless through the relayer. Put in → nothing harvestable right away (principal is protected on-chain,
// not by the lagging indexer) → simulated earnings → take only the earnings (deposit untouched) → take out the rest.
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

const dollars = (s: string) => Number(s.replace(/[^0-9.]/g, ""));

test("Earn: put $50 in, earnings only come out, the deposit stays whole, then take it all back", async ({ browser }) => {
  test.setTimeout(420_000);
  const page = await withPasskeys(await browser.newContext());
  const csp: string[] = [];
  page.on("console", (m) => m.type() === "error" && /Content Security Policy/.test(m.text()) && csp.push(m.text()));

  await page.goto("/");
  await page.getByLabel("Your first name").fill("Ada");
  await page.getByRole("button", { name: "Create my account with fingerprint or screen lock" }).click();
  await page.getByRole("button", { name: "Get 100 test Dollars" }).click();
  await expect(page.locator(".balance")).toHaveText("$100.00");

  await page.getByRole("link", { name: "Earn on your Dollars" }).click();
  await expect(page.getByText("Simulated yield: this test vault", { exact: false })).toBeVisible();
  await expect(page.getByLabel("Current rate")).toContainText("simulated");
  await expect(page.getByText("In your balance: $100.00")).toBeVisible();

  // put in
  await page.getByLabel("Dollars to put in").fill("50");
  await page.getByRole("button", { name: "Put $50.00 in with fingerprint or screen lock" }).click();
  await expect(page.getByText("$50.00 is now earning ✓")).toBeVisible({ timeout: 120_000 });
  const position = page.getByLabel("Your Earn position");
  await expect(position).toContainText("Deposited$50.00"); // from the contract's principalOf, not the indexer
  await expect(page.getByLabel("Harvestable earnings")).toHaveText("$0.00"); // nothing is "earnings" yet
  await expect(page.getByRole("button", { name: /Take my earnings/ })).toHaveCount(0);

  // simulated earnings arrive (test only), then take just the earnings
  await page.getByRole("button", { name: "Add simulated earnings (test only)" }).click();
  await expect(page.getByText("Simulated earnings added to the test vault.")).toBeVisible({ timeout: 120_000 });
  await expect.poll(async () => dollars((await page.getByLabel("Harvestable earnings").textContent()) ?? "0"), { timeout: 60_000 }).toBeGreaterThan(0);
  await page.getByRole("button", { name: /Take my earnings/ }).click();
  await expect(page.getByText("Your deposit is untouched.", { exact: false })).toBeVisible({ timeout: 120_000 });
  await expect(position).toContainText("Deposited$50.00");
  await expect(page.getByLabel("Harvestable earnings")).toHaveText("$0.00");

  // take out everything that's left
  await page.getByRole("button", { name: "Take out", exact: true }).click();
  const max = dollars((await page.getByText("You can take out up to", { exact: false }).textContent()) ?? "0");
  expect(max).toBeGreaterThanOrEqual(50);
  await page.getByLabel("Dollars to take out").fill("50");
  await page.getByRole("button", { name: "Take out $50.00 with fingerprint or screen lock" }).click();
  await expect(page.getByText("$50.00 is back in your balance ✓")).toBeVisible({ timeout: 120_000 });
  await expect(position).toContainText("Deposited$0.00");
  await page.getByRole("link", { name: "Done" }).click();
  await expect.poll(async () => dollars((await page.locator(".balance").textContent()) ?? "0"), { timeout: 60_000 }).toBeGreaterThan(100); // $100 + earnings

  expect(csp).toEqual([]);
});
