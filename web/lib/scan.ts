import { REQUEST_LINK } from "@everpiece/shared";

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
