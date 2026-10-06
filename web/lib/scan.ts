import { PAYOUT_REQUEST_LINK, REQUEST_LINK } from "@everpiece/shared";

/** Only our own origin's /pay/<id> links are followed; everything else (other sites, odd schemes, huge payloads) is refused. */
export function requestIdFromScan(text: string, origin: string): `0x${string}` | null {
  if (text.length > 512) return null;
  let u: URL;
  try {
    u = new URL(text.trim());
  } catch {
    return null;
  }
  if (u.origin !== origin || u.search || u.hash) return null;
  const m = REQUEST_LINK.exec(u.pathname.toLowerCase());
  return m ? (m[1] as `0x${string}`) : null;
}

/** The in-app path a scanned request opens: a Dollar request (/pay/<id>) or a bank-payout request (/payout/<id>). */
export function requestPathFromScan(text: string, origin: string): string | null {
  if (text.length > 512) return null;
  let u: URL;
  try {
    u = new URL(text.trim());
  } catch {
    return null;
  }
  if (u.origin !== origin || u.search || u.hash) return null;
  const path = u.pathname.toLowerCase();
  const m = REQUEST_LINK.exec(path) ?? PAYOUT_REQUEST_LINK.exec(path);
  return m ? path : null;
}
