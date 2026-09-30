// End-to-end on the LOCAL TEST STACK: a link payment whose claim code goes by (simulated) EMAIL instead of SMS.
// The sender is told not to email the link (link + code must travel separately); the recipient claims with the emailed code.
import { expect, test, type BrowserContext, type Page } from "@playwright/test";

const FAUCET = process.env.E2E_FAUCET_URL ?? "http://127.0.0.1:8790";
const BASE = process.env.E2E_BASE_URL ?? "http://localhost:3000";
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\/]/g, "\$&");

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

async function latestSimulatedCode(page: Page): Promise<string> {
  const html = await (await page.request.get(`${FAUCET}/sms`)).text();
  const m = /<li><b>([0-9]{6})<\/b> → m•••@example\.com <small>\(email\)/.exec(html);
  if (!m) throw new Error("no simulated email yet");
  return m[1];
}

test("send by link with an EMAIL code → recipient gets the code by email → claims", async ({ browser }) => {
  const stella = await withPasskeys(await browser.newContext());
  const mama = await withPasskeys(await browser.newContext());
  const csp: string[] = [];
  for (const p of [stella, mama]) p.on("console", (m) => m.type() === "error" && /Content Security Policy/.test(m.text()) && csp.push(m.text()));

  await stella.goto("/");
  await stella.getByLabel("Your first name").fill("Stella");
  await stella.getByRole("button", { name: "Create my account with fingerprint or screen lock" }).click();
  await stella.getByRole("button", { name: "Get 100 test Dollars" }).click();
  await expect(stella.locator(".balance")).toHaveText("$100.00");

  await stella.getByRole("link", { name: "Send money" }).click();
  await stella.getByLabel("Amount in Dollars").fill("15");
  await stella.getByRole("button", { name: "Continue" }).click();
  await stella.getByRole("button", { name: "Email", exact: true }).click();
  const cont = stella.getByRole("button", { name: "Continue" });
  await stella.getByLabel("Their email address").fill("not-an-email");
  await expect(cont).toBeDisabled();
  await stella.getByLabel("Their email address").fill("  Mama.Ngozi@Example.com ");
  await cont.click();
  await expect(stella.getByText("mama.ngozi@example.com")).toBeVisible(); // normalized on the review screen
  await stella.getByRole("button", { name: "Confirm with fingerprint or screen lock" }).click();
  await expect(stella.getByText("Payment protected ✓")).toBeVisible();
  await expect(stella.getByText("Don't email this link.", { exact: false })).toBeVisible();
  const wa = await stella.getByRole("link", { name: "Send on WhatsApp" }).getAttribute("href");
  expect(wa).toMatch(/^https:\/\/wa\.me\/\?text=/); // no phone number: WhatsApp's contact picker
  const link = new RegExp(`(${escapeRe(BASE)}/c/0x[0-9a-f]{64}#[A-Za-z0-9_-]+)`).exec(decodeURIComponent(wa!.split("?text=")[1]))![1];

  await mama.goto(link);
  await expect(mama.getByText("$15.00")).toBeVisible();
  await mama.getByLabel("Your first name").fill("Mama");
  await mama.getByRole("button", { name: "Create my account with fingerprint or screen lock" }).click();
  await mama.getByRole("button", { name: "Send me the code" }).click();
  await expect(mama.getByText(/We emailed a 6-digit code to m•••@example\.com/)).toBeVisible();
  await mama.getByLabel("Code").fill(await latestSimulatedCode(mama));
  await mama.getByRole("button", { name: "Claim $15.00" }).click();
  await expect(mama.getByText("You received $15.00 ✓")).toBeVisible();
  await mama.getByRole("link", { name: "Go to my Everpiece" }).click();
  await expect(mama.locator(".balance")).toHaveText("$15.00");

  expect(csp).toEqual([]);
});
