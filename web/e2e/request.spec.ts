// End-to-end on the TESTNET stack (real Agora AUSD + EverpiecePay): Maris requests money → the payer opens the link
// (as a scanned QR would) → pays in Dollars (instant, final) and in test CTK through Agora (protected) → Maris's
// request page flips to Paid only once the directory has checked the payment on-chain → paid/unknown/foreign links
// are refused. Test money only.
import { expect, test, type BrowserContext, type Page } from "@playwright/test";

const FAUCET = process.env.E2E_FAUCET_URL ?? "http://127.0.0.1:8790";

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

async function onboard(page: Page, first: string, username: string) {
  await page.goto("/");
  await page.getByLabel("Your first name").fill(first);
  await page.getByRole("button", { name: "Create my account with fingerprint or screen lock" }).click();
  await expect(page.getByText(`Hi ${first}, your Dollars`)).toBeVisible();
  await page.getByLabel("Username", { exact: true }).fill(username);
  await expect(page.getByText(`@${username} is available ✓`)).toBeVisible();
  await page.getByRole("button", { name: `Save @${username} with fingerprint or screen lock` }).click();
  await expect(page.getByText(`Your username: @${username}`)).toBeVisible();
}

/** Create a request from Home and return its /pay link (read from the signed request the page sends). */
async function requestMoney(page: Page, amount: string, mode: "Instant" | "Protected"): Promise<string> {
  await page.goto("/");
  await page.getByRole("link", { name: "Request", exact: true }).click();
  await page.getByLabel("Amount to request").fill(amount);
  await page.getByRole("button", { name: mode, exact: true }).click();
  const sent = page.waitForRequest((r) => r.url().includes("/v1/requests/create"));
  await page.getByRole("button", { name: "Create request with fingerprint or screen lock" }).click();
  const requestId = (await sent).postDataJSON().request.requestId as string;
  await expect(page.getByRole("img", { name: "Payment request QR code" })).toBeVisible();
  return `/pay/${requestId}`;
}

test.afterEach(async ({ browser }) => {
  for (const c of browser.contexts()) await c.close();
});

test("request → pay in Dollars (instant) and in CTK via Agora (protected); paid, unknown and foreign links refused", async ({ browser }) => {
  test.setTimeout(480_000);
  const maris = await withPasskeys(await browser.newContext());
  const payer = await withPasskeys(await browser.newContext());
  const csp: string[] = [];
  for (const p of [maris, payer]) p.on("console", (m) => m.type() === "error" && /Content Security Policy/.test(m.text()) && csp.push(m.text()));
  const suffix = Date.now().toString(36).slice(-5);
  const M = `maris_${suffix}`, P = `payer_${suffix}`;

  await onboard(maris, "Maris", M);
  await onboard(payer, "Payer", P);
  await payer.getByRole("button", { name: "Get 100 test Dollars" }).click();
  await expect(payer.locator(".balance")).toHaveText("$100.00");

  // --- instant request, paid in Dollars: final, exact amount, Maris's page flips to Paid
  const instant = await requestMoney(maris, "3", "Instant");
  await payer.goto(instant);
  await expect(payer.getByText(`Pay @${M}`)).toBeVisible();
  await payer.getByText("Dollars (AUSD)").click();
  await expect(payer.getByText("Instant · final")).toBeVisible();
  await payer.getByRole("button", { name: "Pay $3.00 with fingerprint or screen lock" }).click();
  await expect(payer.getByText("Paid ✓", { exact: false })).toBeVisible();
  await expect(payer.getByText("received exactly $3.00", { exact: false })).toBeVisible();
  await expect(maris.getByText("Paid ✓ You received $3.00", { exact: false })).toBeVisible();

  // a paid request can't be paid twice
  await payer.goto(instant);
  await expect(payer.getByText("This request has already been paid.")).toBeVisible();
  await expect(payer.getByRole("link", { name: "View receipt" })).toBeVisible();

  // --- protected request, paid in test CTK: converted through Agora, then held for Maris
  const address = await payer.evaluate(() => JSON.parse(localStorage.getItem("everpiece.account.v1")!).address as string);
  const fund = await fetch(`${FAUCET}/faucet`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ address, token: "CTK" }) });
  expect(fund.ok).toBe(true);
  const protectedLink = await requestMoney(maris, "2", "Protected");
  await payer.goto(protectedLink);
  await payer.getByText("Test CTK").click();
  await expect(payer.getByText("Agora Instant Settlement")).toBeVisible();
  await expect(payer.getByText("Price valid for")).toBeVisible(); // a real quote arrived
  await payer.getByRole("button", { name: "Pay $2.00 with fingerprint or screen lock" }).click();
  await expect(payer.getByText(`Sent ✓ $2.00 is protected for @${M}`, { exact: false })).toBeVisible();
  await expect(maris.getByText("(protected: claim it on Home)", { exact: false })).toBeVisible();

  // --- links that must never lead to a payment
  await payer.goto(`/pay/0x${"00".repeat(31)}01`);
  await expect(payer.getByText("We couldn't find this payment request.", { exact: false })).toBeVisible();
  expect((await payer.goto("/pay/0x1234"))?.status()).toBe(404);
  await payer.goto("/scan");
  await payer.getByLabel("Or paste a payment link").fill(`https://evil.example${instant}`);
  await payer.getByRole("button", { name: "Open payment request" }).click();
  await expect(payer.getByText("That isn't an Everpiece payment link.")).toBeVisible();
  await payer.getByLabel("Or paste a payment link").fill(new URL(instant, payer.url()).href);
  await payer.getByRole("button", { name: "Open payment request" }).click();
  await expect(payer).toHaveURL(new RegExp(`${instant}$`));

  expect(csp).toEqual([]);
});
