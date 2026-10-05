"use client";

import qrcode from "qrcode-generator";
import { useMemo } from "react";

/**
 * A QR code drawn as plain SVG cells from qrcode-generator's matrix (no innerHTML). It encodes only a link with an
 * opaque request id; the amount and recipient are fetched and verified when it's scanned, never trusted from the QR.
 */
export function QrCode({ value, label }: { value: string; label: string }) {
  const cells = useMemo(() => {
    const q = qrcode(0, "M");
    q.addData(value);
    q.make();
    const n = q.getModuleCount();
    const dark: [number, number][] = [];
    for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (q.isDark(r, c)) dark.push([r, c]);
    return { n, dark };
  }, [value]);
  const m = 4; // quiet zone
  const size = cells.n + m * 2;
  return (
    <svg className="qr" viewBox={`0 0 ${size} ${size}`} role="img" aria-label={label} shapeRendering="crispEdges">
      <rect width={size} height={size} fill="#fff" />
      {cells.dark.map(([r, c]) => (
        <rect key={`${r}-${c}`} x={c + m} y={r + m} width={1} height={1} fill="#111" />
      ))}
    </svg>
  );
}
