import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  poweredByHeader: false,
  // A self-contained server bundle: the VPS runs it without installing the workspace (its memory is shared).
  // @taceo/merces-client (Private Send) has a Node-only branch (fs/promises for file: URLs); the app never takes it.
  turbopack: { resolveAlias: { "fs/promises": "./lib/empty-fs.ts" } },
  reactStrictMode: true,
  // Last-mile payouts (docs/PAYOUT.md): the payout server is reached through the app's own origin on stacks that run
  // it next to the web (PAYOUT_INTERNAL_URL at build time), so no extra public route is needed on the host.
  // Automate (docs/AUTOMATE.md) the same way; only the owner-facing routes are proxied: trigger intake stays internal.
  async rewrites() {
    const payout = process.env.PAYOUT_INTERNAL_URL;
    const automate = process.env.AUTOMATE_INTERNAL_URL;
    return [
      ...(payout ? [{ source: "/payout-api/:path*", destination: `${payout}/:path*` }] : []),
      ...(automate ? [{ source: "/automate-api/v1/automate/:kind(rules|executions|legs)/:path*", destination: `${automate}/v1/automate/:kind/:path*` }, { source: "/automate-api/v1/automate/legs", destination: `${automate}/v1/automate/legs` }, { source: "/automate-api/v1/automate/rules", destination: `${automate}/v1/automate/rules` }] : []),
    ];
  },
  async headers() {
    return [
      {
        source: "/(.*)",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "DENY" },
          // HTTPS only from the first visit on (no includeSubDomains/preload on the test domain; decide for production)
          { key: "Strict-Transport-Security", value: "max-age=31536000" },
          // Claim links carry secrets in the #fragment; never leak the URL onward (THREAT_MODEL C6).
          { key: "Referrer-Policy", value: "no-referrer" },
          // Voice messages record on our own origin only.
          { key: "Permissions-Policy", value: "camera=(self), geolocation=(), payment=(), usb=(), microphone=(self)" }, // camera: QR scanning only
        ],
      },
      // Claim pages and anything secret-adjacent are never cached (master §2.6).
      { source: "/c/:path*", headers: [{ key: "Cache-Control", value: "no-store" }] },
      {
        // static owner-only page (scripts/styles are same-origin files; no network, no framing)
        source: "/owner-set-approver.:ext",
        headers: [{ key: "Content-Security-Policy", value: "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'none'; frame-ancestors 'none'; base-uri 'none'" }],
      },
      {
        source: "/sw.js",
        headers: [
          { key: "Content-Type", value: "application/javascript; charset=utf-8" },
          { key: "Cache-Control", value: "no-cache, no-store, must-revalidate" },
          { key: "Content-Security-Policy", value: "default-src 'self'; script-src 'self'" },
        ],
      },
    ];
  },
};

export default nextConfig;
