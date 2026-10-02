// End-to-end on the LOCAL TEST STACK: both people pick @usernames → Stella sends to @mama (USERNAME mode, no link or
// code) → Mama sees it on Home and claims with her fingerprint → second send shows the pinned recipient → a changed
// directory answer is blocked (TOFU pinning, master §10.2) → unknown usernames are refused.
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

async function toUsername(page: Page, amount: string, username: string) {
  await page.getByRole("link", { name: "Send money" }).click();
  await page.getByLabel("Amount in Dollars").fill(amount);
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByRole("button", { name: "@username" }).click();
  await page.getByLabel("Their Everpiece username").fill(username);
  await page.getByRole("button", { name: "Find" }).click();
}


// Close every browser this test opened: open pages keep polling Home (directory/indexer) and would eat the next
// test's per-IP rate limits, since all test traffic comes from one IP.
test.afterEach(async ({ browser }) => {
  for (const c of browser.contexts()) await c.close();
});

test("send to @username → recipient claims from Home; pinned recipient; changed recipient blocked", async ({ browser }) => {
  const stella = await withPasskeys(await browser.newContext());
  const mama = await withPasskeys(await browser.newContext());
  const csp: string[] = [];
  for (const p of [stella, mama]) p.on("console", (m) => m.type() === "error" && /Content Security Policy/.test(m.text()) && csp.push(m.text()));
  const suffix = Date.now().toString(36).slice(-5);
  const S = `stella_${suffix}`, M = `mama_${suffix}`;

  await onboard(stella, "Stella", S);
  await stella.getByRole("button", { name: "Get 100 test Dollars" }).click();
  await expect(stella.locator(".balance")).toHaveText("$100.00");
  await onboard(mama, "Mama", M);

  // --- first payment: new recipient → must confirm who it is
  await toUsername(stella, "20", `@${M.toUpperCase()}`);
  await expect(stella.getByText(`@${M}`, { exact: true })).toBeVisible();
  const cont = stella.getByRole("button", { name: "Continue" });
  await expect(cont).toBeDisabled();
  await stella.getByLabel(/This is the person I mean/).check();
  await cont.click();
  await expect(stella.getByText(`@${M} (Mama)`)).toBeVisible();
  await stella.getByRole("button", { name: "Confirm with fingerprint or screen lock" }).click();
  await expect(stella.getByText(`Sent to @${M} ✓`)).toBeVisible();
  await stella.getByRole("link", { name: "Done" }).click();
  await expect(stella.locator(".balance")).toHaveText("$80.00");

  // --- Mama claims from Home
  await expect(mama.getByText("Money for you")).toBeVisible();
  await expect(mama.getByText(`from @${S}`)).toBeVisible();
  await mama.getByRole("button", { name: "Claim with fingerprint or screen lock" }).click();
  await expect(mama.getByText(`You received $20.00 from @${S} ✓`)).toBeVisible();
  await expect(mama.locator(".balance")).toHaveText("$20.00");
  await expect(mama.getByText("Money for you")).toBeHidden();
  await expect(stella.getByText("Claimed")).toBeVisible();

  // --- second payment: pinned, no confirmation needed; then cancelled by Stella
  await toUsername(stella, "5", M);
  await expect(stella.getByText("You've paid them before ✓")).toBeVisible();
  await stella.getByRole("button", { name: "Continue" }).click();
  await stella.getByRole("button", { name: "Confirm with fingerprint or screen lock" }).click();
  await expect(stella.getByText(`Sent to @${M} ✓`)).toBeVisible();
  await stella.getByRole("link", { name: "Done" }).click();
  await expect(stella.locator(".balance")).toHaveText("$75.00");
  await stella.getByRole("button", { name: "Cancel and get my money back" }).click();
  await expect(stella.getByText("Money returned: $5.00.")).toBeVisible();
  await expect(stella.locator(".balance")).toHaveText("$80.00");

  // --- the directory "changes" @mama's account (simulated by a different local pin) → sending is blocked
  await stella.evaluate((m) => {
    const pins = JSON.parse(localStorage.getItem("everpiece.pins.v1") ?? "{}");
    pins[m] = "0x000000000000000000000000000000000000dEaD";
    localStorage.setItem("everpiece.pins.v1", JSON.stringify(pins));
  }, M);
  await toUsername(stella, "5", M);
  await expect(stella.getByText("This recipient's security details changed. Verify them before sending.")).toBeVisible();
  await expect(stella.getByRole("button", { name: "Continue" })).toBeDisabled();

  // --- unknown username
  await stella.getByLabel("Their Everpiece username").fill(`nobody_${suffix}`);
  await stella.getByRole("button", { name: "Find" }).click();
  await expect(stella.getByText("No one on Everpiece has that username.", { exact: false })).toBeVisible();

  // --- one username = one person: a newcomer can't take @mama_… or a lookalike of it
  const copycat = await withPasskeys(await browser.newContext());
  await copycat.goto("/");
  await copycat.getByLabel("Your first name").fill("Copy");
  await copycat.getByRole("button", { name: "Create my account with fingerprint or screen lock" }).click();
  await expect(copycat.getByText("Hi Copy, your Dollars")).toBeVisible();
  await copycat.getByLabel("Username", { exact: true }).fill(M);
  await expect(copycat.getByText("That username is taken. Try another one.")).toBeVisible();
  await copycat.getByLabel("Username", { exact: true }).fill(M.replace("_", ""));
  await expect(copycat.getByText("That's too close to someone else's username. Try a different one.")).toBeVisible();
  await expect(copycat.getByRole("button", { name: /with fingerprint/ })).toBeDisabled();

  expect(csp).toEqual([]);
});
