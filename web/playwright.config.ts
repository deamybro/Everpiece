import { defineConfig } from "@playwright/test";

// Expects the local stack to be running: `npm run dev:stack` (repo root). Test Dollars only.
export default defineConfig({
  testDir: "./e2e",
  timeout: 180_000,
  expect: { timeout: 60_000 },
  workers: 1,
  reporter: [["list"]],
  // E2E_BASE_URL: the test stack on a server through its SSH tunnel (deploy/test-stack/README.md).
  use: { baseURL: process.env.E2E_BASE_URL ?? "http://localhost:3000", trace: "retain-on-failure" },
});
