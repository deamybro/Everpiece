import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  poweredByHeader: false,
  reactStrictMode: true,
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
