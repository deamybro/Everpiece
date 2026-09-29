import type { Metadata, Viewport } from "next";
import { headers } from "next/headers";
import "./globals.css";
import { ServiceWorker } from "../components/ServiceWorker";

export const metadata: Metadata = {
  title: "Everpiece",
  description: "Send money to the right person, and let them choose what it becomes.",
  applicationName: "Everpiece",
};

export const viewport: Viewport = { themeColor: "#5b3df5", width: "device-width", initialScale: 1 };

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  // Reading request headers makes every page dynamic, which the per-request CSP nonce requires (proxy.ts).
  await headers();
  return (
    <html lang="en">
      <body>
        <main className="app">{children}</main>
        <ServiceWorker />
      </body>
    </html>
  );
}
