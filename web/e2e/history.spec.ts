// Payment history from the INDEXER (source of truth), not this browser's storage. Needs a stack with the indexer
// (the public test site: E2E_BASE_URL=https://test.everpiece.xyz …). Checks sent + received, refresh, a wiped local
// cache (new device), sign-out/sign-in, a second browser, and a cancel reflected everywhere.
import { expect, test, type Browser, type BrowserContext, type Page } from "@playwright/test";

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

const activity = (page: Page) => page.getByRole("list", { name: "Activity" });
const row = (page: Page, text: string) => activity(page).locator("li", { hasText: text });

/** A second browser where the same account is signed in, but which never sent anything (no local cache). */
async function secondBrowser(browser: Browser, from: Page): Promise<Page> {
  const account = await from.evaluate(() => localStorage.getItem("everpiece.account.v1"));
  const ctx = await browser.newContext();
  await ctx.addInitScript((a) => { if (a && !localStorage.getItem("everpiece.account.v1")) localStorage.setItem("everpiece.account.v1", a); }, account);
  const page = await ctx.newPage();
  await page.goto("/");
  expect(await page.evaluate(() => localStorage.getItem("everpiece.sent.v1"))).toBeNull();
  return page;
}


// Close every browser this test opened: open pages keep polling Home (directory/indexer) and would eat the next
// test's per-IP rate limits, since all test traffic comes from one IP.
test.afterEach(async ({ browser }) => {
  for (const c of browser.contexts()) await c.close();
});

test("history comes from the indexer: sent + received, refresh, new device, sign-out/in, second browser, cancel", async ({ browser }) => {
  const stella = await withPasskeys(await browser.newContext());
  const mama = await withPasskeys(await browser.newContext());
  const suffix = Date.now().toString(36).slice(-5);
  const S = `hist_s_${suffix}`, M = `hist_m_${suffix}`;

  await onboard(stella, "Stella", S);
  await stella.getByRole("button", { name: "Get 100 test Dollars" }).click();
  await expect(stella.locator(".balance")).toHaveText("$100.00");
  await onboard(mama, "Mama", M);

  // $6 to @mama → claimed by Mama (sent for Stella, received for Mama)
  await stella.getByRole("link", { name: "Send money" }).click();
  await stella.getByLabel("Amount in Dollars").fill("6");
  await stella.getByRole("button", { name: "Continue" }).click();
  await stella.getByRole("button", { name: "@username" }).click();
  await stella.getByLabel("Their Everpiece username").fill(M);
  await stella.getByRole("button", { name: "Find" }).click();
  await stella.getByLabel(/This is the person I mean/).check();
  await stella.getByRole("button", { name: "Continue" }).click();
  await stella.getByRole("button", { name: "Protected", exact: true }).click(); // @username sends are instant by default
  await stella.getByRole("button", { name: "Confirm with fingerprint or screen lock" }).click();
  await expect(stella.getByText(`Sent to @${M} ✓`)).toBeVisible();
  await stella.getByRole("link", { name: "Done" }).click();
  await mama.reload();
  await mama.getByRole("button", { name: "Claim with fingerprint or screen lock" }).click();
  await expect(mama.getByText(`You received $6.00 from @${S} ✓`)).toBeVisible();

  // $4 by link, left unclaimed (protected)
  await stella.getByRole("link", { name: "Send money" }).click();
  await stella.getByLabel("Amount in Dollars").fill("4");
  await stella.getByRole("button", { name: "Continue" }).click();
  await stella.getByLabel("Their phone number (with country code)").fill("+447700900123");
  await stella.getByRole("button", { name: "Continue" }).click();
  await stella.getByRole("button", { name: "Confirm with fingerprint or screen lock" }).click();
  await expect(stella.getByText("Payment protected ✓")).toBeVisible();
  await stella.getByRole("link", { name: "Done" }).click();

  // Indexed history on the sending device (labels from this device's cache)
  await expect(row(stella, "$6.00").getByText("Claimed")).toBeVisible();
  await expect(row(stella, "$6.00")).toContainText(`to @${M}`);
  await expect(row(stella, "$4.00").getByText("Waiting to be claimed")).toBeVisible();
  await expect(row(stella, "$4.00")).toContainText("to +447700900123");
  await expect(row(mama, "+$6.00").getByText("Received")).toBeVisible();
  await expect(row(mama, "+$6.00")).toContainText(`from @${S}`);

  // 1. refresh
  await stella.reload();
  await expect(row(stella, "$6.00").getByText("Claimed")).toBeVisible();

  // 2. wiped local cache (= a device that never sent these): still there, labelled from chain + directory
  await stella.evaluate(() => localStorage.removeItem("everpiece.sent.v1"));
  await stella.reload();
  await expect(row(stella, "$6.00")).toContainText(`to @${M}`); // claimer's verified username
  await expect(row(stella, "$4.00")).toContainText("to a payment link"); // unclaimed: the recipient is private
  await expect(row(stella, "$4.00").getByText("Waiting to be claimed")).toBeVisible();

  // 3. sign out, sign back in with the same passkey
  await stella.getByRole("button", { name: "Sign out" }).click();
  await expect(activity(stella)).toHaveCount(0);
  await stella.getByRole("button", { name: "I already have an account" }).click();
  await expect(row(stella, "$6.00").getByText("Claimed")).toBeVisible();
  await expect(row(stella, "$4.00").getByText("Waiting to be claimed")).toBeVisible();

  // 4. a second browser for each account
  const stella2 = await secondBrowser(browser, stella);
  const mama2 = await secondBrowser(browser, mama);
  await expect(row(stella2, "$6.00").getByText("Claimed")).toBeVisible();
  await expect(row(stella2, "$4.00").getByText("Waiting to be claimed")).toBeVisible();
  await expect(row(mama2, "+$6.00").getByText("Received")).toBeVisible();

  // 5. cancel (unchanged flow) → reflected on both browsers from the indexer
  await row(stella, "$4.00").getByRole("button", { name: "Cancel and get my money back" }).click();
  await expect(stella.getByText("Money returned: $4.00.")).toBeVisible();
  await expect(row(stella, "$4.00").getByText("Cancelled")).toBeVisible();
  await stella2.reload();
  await expect(row(stella2, "$4.00").getByText("Cancelled")).toBeVisible();
  await expect(stella.locator(".balance")).toHaveText("$94.00"); // 100 − 6 (claimed) − 4 + 4 (cancelled, returned)

  // 6. on-chain proof: each payment links to its latest transaction; the public numbers page reads the indexer
  await expect(row(stella, "$6.00").getByRole("link", { name: "See it on Monad" })).toHaveAttribute("href", /\/tx\/0x[0-9a-f]{64}$/);
  await expect(row(mama, "+$6.00").getByRole("link", { name: "See it on Monad" })).toHaveAttribute("href", /\/tx\/0x[0-9a-f]{64}$/);
  await stella.getByRole("link", { name: "Everpiece in numbers" }).click();
  const numbers = stella.getByLabel("Everpiece numbers");
  await expect(numbers).toContainText("People");
  await expect(numbers).toContainText("Median time to claim");
  await expect(stella.getByRole("list", { name: "Latest transactions" }).getByRole("link", { name: "See it on Monad" }).first())
    .toHaveAttribute("href", /\/tx\/0x[0-9a-f]{64}$/);

  // 7. receipts: rebuilt from the chain + indexer, each step with its transaction; nothing private before a claim
  await stella.goto("/");
  await row(stella, "$6.00").getByRole("link", { name: "Receipt" }).click();
  await expect(stella.getByLabel("Receipt status")).toContainText(`Claimed by @${M}`);
  const details = stella.getByLabel("Receipt details");
  await expect(details).toContainText(`@${S}`);
  await expect(details).toContainText(`@${M}`);
  await expect(details).toContainText("$0.00 (paid by Everpiece)");
  const timeline = stella.getByRole("list", { name: "Timeline" });
  await expect(timeline.getByRole("listitem")).toHaveCount(2);
  await expect(timeline).toContainText("Sent and protected");
  await expect(timeline).toContainText("Claimed by the recipient");
  for (const a of await timeline.getByRole("link", { name: "Proof on Monad" }).all()) await expect(a).toHaveAttribute("href", /\/tx\/0x[0-9a-f]{64}$/);
  await expect(stella.getByRole("button", { name: "Save as PDF / Print" })).toBeVisible();

  await stella.goto("/");
  await row(stella, "$4.00").getByRole("link", { name: "Receipt" }).click();
  await expect(stella.getByLabel("Receipt status")).toContainText("Cancelled");
  await expect(stella.getByRole("list", { name: "Timeline" })).toContainText("Cancelled, money returned to the sender");

  // the recipient's receipt for the same $6 payment, in her own browser
  await mama.goto("/");
  await row(mama, "+$6.00").getByRole("link", { name: "Receipt" }).click();
  await expect(mama.getByLabel("Receipt status")).toContainText(`Claimed by @${M}`);
  await expect(mama.getByLabel("Receipt details")).toContainText(`@${S}`);
});
