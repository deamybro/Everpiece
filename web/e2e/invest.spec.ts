// Invest (docs/INVEST.md): the screen tells the truth about availability. No aStock route passes the quality rules
// (2026-10-08 mainnet scan), so nothing is offered for purchase and no price is invented.
import { expect, test } from "@playwright/test";

test("Invest: no stock is offered, NVIDIA shows low liquidity with its reason, no price is shown", async ({ page }) => {
  await page.goto("/invest");
  await expect(page.getByRole("heading", { name: "Invest" })).toBeVisible();
  await expect(page.getByLabel("Investing status")).toContainText("No stock can be bought through Everpiece yet");
  await expect(page.getByRole("button", { name: "NVIDIA Low liquidity" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Apple Unavailable" })).toBeVisible();
  await expect(page.getByRole("button", { name: /Available$/ }).filter({ hasNotText: /Unavailable/ })).toHaveCount(0);

  await page.getByRole("button", { name: "NVIDIA Low liquidity" }).click();
  const details = page.getByLabel("NVIDIA details");
  await expect(details).toContainText("above Everpiece's 2% limit");
  await expect(details).toContainText("Shown only with a live, verified quote");
  await expect(details).not.toContainText("$");
  await expect(page.getByRole("button", { name: /buy/i })).toHaveCount(0);
  await details.getByRole("button", { name: "Back to stocks" }).click();
  await expect(page.getByLabel("Stocks")).toBeVisible();
});
