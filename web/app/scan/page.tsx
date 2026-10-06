"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { requestPathFromScan } from "../../lib/scan";

type Detector = { detect(source: HTMLVideoElement): Promise<{ rawValue: string }[]> };

/**
 * The browser's own QR detector where there is one (Android Chrome); otherwise jsQR on camera frames (iPhone Safari
 * has no BarcodeDetector). jsQR is only downloaded when it's needed.
 */
async function qrDetector(): Promise<Detector> {
  const W = window as unknown as { BarcodeDetector?: new (o: { formats: string[] }) => Detector };
  if (W.BarcodeDetector) return new W.BarcodeDetector({ formats: ["qr_code"] });
  const { default: jsQR } = await import("jsqr");
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
  return {
    async detect(video) {
      const w = video.videoWidth, h = video.videoHeight;
      if (!w || !h) return [];
      const scale = Math.min(1, 640 / Math.max(w, h)); // smaller frames decode fast enough on phones
      canvas.width = Math.round(w * scale);
      canvas.height = Math.round(h * scale);
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      const code = jsQR(ctx.getImageData(0, 0, canvas.width, canvas.height).data, canvas.width, canvas.height, { inversionAttempts: "dontInvert" });
      return code ? [{ rawValue: code.data }] : [];
    },
  };
}

export default function ScanPage() {
  const router = useRouter();
  const video = useRef<HTMLVideoElement>(null);
  const [supported, setSupported] = useState<boolean | null>(null);
  const [problem, setProblem] = useState("");
  const [pasted, setPasted] = useState("");

  useEffect(() => {
    if (!navigator.mediaDevices?.getUserMedia) return setSupported(false);
    setSupported(true);
    let stream: MediaStream | null = null;
    let stopped = false;
    (async () => {
      let detector: Detector;
      try {
        detector = await qrDetector();
      } catch {
        setSupported(false);
        return;
      }
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } });
      } catch {
        setProblem("Camera access was blocked. You can paste the payment link instead.");
        return;
      }
      // the page may have closed while the camera prompt was open: release it, or the camera light stays on
      if (!video.current || stopped) return stream.getTracks().forEach((t) => t.stop());
      video.current.srcObject = stream;
      await video.current.play().catch(() => {});
      while (!stopped) {
        const codes = await detector.detect(video.current).catch(() => []);
        for (const c of codes) {
          const id = requestPathFromScan(c.rawValue, window.location.origin);
          if (id) {
            stopped = true;
            router.push(id);
            return;
          }
          setProblem("That QR code isn't an Everpiece payment request.");
        }
        await new Promise((r) => setTimeout(r, 300));
      }
    })();
    return () => {
      stopped = true;
      stream?.getTracks().forEach((t) => t.stop());
    };
  }, [router]);

  function openPasted() {
    const id = requestPathFromScan(pasted, window.location.origin);
    if (id) router.push(id);
    else setProblem("That isn't an Everpiece payment link.");
  }

  return (
    <div className="stack">
      <div className="row">
        <Link href="/" className="brand">Everpiece</Link>
        <Link href="/" className="muted small">Cancel</Link>
      </div>
      <h1>Scan to pay</h1>
      {supported && <video ref={video} className="scanner" playsInline muted aria-label="Camera" />}
      {supported === false && <p className="muted">This browser can&apos;t use the camera here. Paste the payment link instead.</p>}
      {problem && <div className="status warn">{problem}</div>}
      <div>
        <label htmlFor="link">Or paste a payment link</label>
        <input id="link" autoCapitalize="none" spellCheck={false} placeholder="https://…/pay/0x…" value={pasted} onChange={(e) => setPasted(e.target.value)} />
      </div>
      <button className="secondary" disabled={!pasted} onClick={openPasted}>Open payment request</button>
    </div>
  );
}
