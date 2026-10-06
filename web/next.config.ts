import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  poweredByHeader: false,
  reactStrictMode: true,
  // Last-mile payouts (docs/PAYOUT.md): the payout server is reached through the app's own origin on stacks that run
  // it next to the web (PAYOUT_INTERNAL_URL at build time), so no extra public route is needed on the host.
  async rewrites() {
    const target = process.env.PAYOUT_INTERNAL_URL;
    return target ? [{ source: "/payout-api/:path*", destination: `${target}/:path*` }] : [];
  },
  async headers() {
    return [
      {
        source: "/(.*)",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "DENY" },
          // Claim links carry secrets in the #fragment; never leak the URL onward (THREAT_MODEL C6).
          { key: "Referrer-Policy", value: "no-referrer" },
          // Voice messages record on our own origin only.
          { key: "Permissions-Policy", value: "camera=(self), geolocation=(), payment=(), usb=(), microphone=(self)" }, // camera: QR scanning only
        ],
      },
      // Claim pages and anything secret-adjacent are never cached (master §2.6).
      { source: "/c/:path*", headers: [{ key: "Cache-Control", value: "no-store" }] },
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
