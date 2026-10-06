// Phone-size screenshots of the naira flow for a UX review (runs only with E2E_SHOTS=1; writes ./shots/*.png).
import { expect, test, type Page } from "@playwright/test";

const FAUCET = process.env.E2E_FAUCET_URL ?? "http://127.0.0.1:8790";
test.skip(process.env.E2E_SHOTS !== "1", "screenshots only on request");
test.use({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, colorScheme: "dark" }); // like the owner's phone

const shot = (page: Page, name: string) => page.screenshot({ path: `shots/${name}.png`, fullPage: true });

test("naira flow screenshots", async ({ page, context }) => {
  test.setTimeout(300_000);
  const cdp = await context.newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: { protocol: "ctap2", ctap2Version: "ctap2_1", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true, hasPrf: true, automaticPresenceSimulation: true },
  });
  await page.goto("/");
  await expect(page.getByLabel("Your first name")).toBeVisible();
  await shot(page, "00-welcome");
  await page.getByLabel("Your first name").fill("Ada");
  await page.getByRole("button", { name: "Create my account with fingerprint or screen lock" }).click();
  await expect(page.getByText("Hi Ada, your Dollars")).toBeVisible();
  const address = await page.evaluate(() => JSON.parse(localStorage.getItem("everpiece.account.v1")!).address as string);
  await fetch(`${FAUCET}/faucet`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ address }) });
  await page.goto("/");
  await expect(page.locator(".balance")).toHaveText("$100.00");
  await shot(page, "01-home");

  await page.getByRole("link", { name: "How you receive money" }).click();
  await page.getByText("Nigerian bank account", { exact: true }).click();
  await shot(page, "02-receive-empty");
  await page.getByLabel("Bank", { exact: true }).selectOption({ label: "Guaranty Trust Bank" });
  await page.getByLabel("Account number").fill("0123456789");
  await expect(page.getByLabel("Account check")).toBeVisible();
  await shot(page, "03-receive-checked");
  await page.getByLabel("Account check").getByRole("button", { name: /save with fingerprint/ }).click();
  await expect(page.getByLabel("Your bank account")).toBeVisible();
  await shot(page, "04-receive-saved");

  await page.goto("/bank");
  await shot(page, "05-bank-who");
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByRole("button", { name: "₦10,000" }).click();
  await expect(page.getByText(/≈ \$/)).toBeVisible();
  await shot(page, "06-bank-amount");
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.getByLabel("Payment summary")).toContainText("/ $1");
  await shot(page, "07-bank-review");
  await page.getByRole("button", { name: "Pay with fingerprint or screen lock" }).click();
  await expect(page.getByLabel("Payout progress")).toBeVisible({ timeout: 120_000 });
  await shot(page, "08-bank-progress");
  await expect(page.locator(".timeline li.done").filter({ hasText: "Delivered" })).toBeVisible({ timeout: 120_000 });
  await shot(page, "09-bank-delivered");
  await page.goto("/");
  await expect(page.getByLabel("Bank payouts")).toContainText("Delivered");
  await shot(page, "10-home-after");

  await page.goto("/send");
  await shot(page, "12-send");
  await page.goto("/request");
  await page.getByRole("button", { name: "Naira to my bank" }).click();
  await page.getByRole("button", { name: "₦20,000" }).click();
  await expect(page.getByText(/They'll pay about/)).toBeVisible();
  await shot(page, "11-request-naira");
  await page.getByRole("button", { name: "Create request with fingerprint or screen lock" }).click();
  await expect(page.getByRole("img", { name: "Payment request QR code" })).toBeVisible();
  await shot(page, "13-request-qr");
});

test("other screens after the redesign", async ({ page, context }) => {
  test.setTimeout(240_000);
  const cdp = await context.newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: { protocol: "ctap2", ctap2Version: "ctap2_1", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true, hasPrf: true, automaticPresenceSimulation: true },
  });
  await page.goto("/");
  await page.getByLabel("Your first name").fill("Bo");
  await page.getByRole("button", { name: "Create my account with fingerprint or screen lock" }).click();
  await expect(page.getByText("Hi Bo, your Dollars")).toBeVisible();
  const address = await page.evaluate(() => JSON.parse(localStorage.getItem("everpiece.account.v1")!).address as string);
  await fetch(`${FAUCET}/faucet`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ address }) });
  await page.goto("/send");
  await page.getByLabel("Amount in Dollars").fill("12.50");
  await shot(page, "20-send-amount");
  await page.getByRole("button", { name: "Continue" }).click();
  await shot(page, "21-send-who");
  await page.getByRole("button", { name: "Email" }).click().catch(() => {});
  await shot(page, "22-send-email");
  await page.goto("/request");
  await page.getByLabel("Amount to request").fill("25");
  await shot(page, "23-request-dollars");
  await page.goto("/add");
  await page.getByLabel("Dollars to add").fill("20");
  await shot(page, "24-add");
  await page.goto("/scan");
  await shot(page, "25-scan");
  await page.goto("/proof");
  await page.waitForTimeout(3000);
  await shot(page, "26-proof");
});
