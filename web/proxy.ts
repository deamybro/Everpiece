import { NextResponse, type NextRequest } from "next/server";

/**
 * Per-request nonce CSP (Next.js 16 `proxy`, docs: 02-guides/content-security-policy.md).
 * The page holds passkey-derived signing keys in memory for a moment, so XSS must be as hard as possible
 * (THREAT_MODEL F1): no inline scripts without the nonce, and the network is limited to our own services.
 */
function origin(u: string | undefined): string {
  if (!u) return "";
  try {
    return new URL(u).origin;
  } catch {
    return "";
  }
}

export function proxy(request: NextRequest) {
  const nonce = Buffer.from(crypto.randomUUID()).toString("base64");
  const isDev = process.env.NODE_ENV === "development";
  const connect = [
    "'self'",
    origin(process.env.NEXT_PUBLIC_MONAD_RPC),
    origin(process.env.NEXT_PUBLIC_RELAYER_URL),
    origin(process.env.NEXT_PUBLIC_CLAIMS_URL),
    origin(process.env.NEXT_PUBLIC_DIRECTORY_URL),
    origin(process.env.NEXT_PUBLIC_INDEXER_URL),
    origin(process.env.NEXT_PUBLIC_DEV_FAUCET_URL),
  ]
    .filter(Boolean)
    .join(" ");
  const csp = `
    default-src 'self';
    script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${isDev ? " 'unsafe-eval'" : ""};
    style-src 'self' ${isDev ? "'unsafe-inline'" : `'nonce-${nonce}'`};
    img-src 'self' blob: data:;
    font-src 'self';
    connect-src ${connect};
    worker-src 'self';
    manifest-src 'self';
    object-src 'none';
    base-uri 'self';
    form-action 'self';
    frame-ancestors 'none';
    ${isDev ? "" : "upgrade-insecure-requests;"}
  `
    .replace(/\s{2,}/g, " ")
    .trim();

  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-nonce", nonce);
  requestHeaders.set("Content-Security-Policy", csp);
  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set("Content-Security-Policy", csp);
  return response;
}

export const config = {
  matcher: [
    {
      source: "/((?!api|_next/static|_next/image|favicon.ico|sw.js|icon-).*)",
      missing: [
        { type: "header", key: "next-router-prefetch" },
        { type: "header", key: "purpose", value: "prefetch" },
      ],
    },
  ],
};
