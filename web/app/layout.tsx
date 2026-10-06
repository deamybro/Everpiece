import type { Metadata, Viewport } from "next";
import { headers } from "next/headers";
import { Plus_Jakarta_Sans } from "next/font/google";
import "./globals.css";
import { ServiceWorker } from "../components/ServiceWorker";

// Self-hosted at build time by next/font (no runtime request to Google; the CSP stays font-src 'self').
const font = Plus_Jakarta_Sans({ subsets: ["latin"], weight: ["400", "500", "600", "700", "800"], display: "swap", variable: "--font" });

export const metadata: Metadata = {
  title: "Everpiece",
  description: "Send money to the right person, and let them choose what it becomes.",
  applicationName: "Everpiece",
};

export const viewport: Viewport = { themeColor: "#f5f5f7", width: "device-width", initialScale: 1 };

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  // Reading request headers makes every page dynamic, which the per-request CSP nonce requires (proxy.ts).
  await headers();
  return (
    <html lang="en" className={font.variable}>
      <body>
        <main className="app">{children}</main>
        <ServiceWorker />
      </body>
    </html>
  );
}
