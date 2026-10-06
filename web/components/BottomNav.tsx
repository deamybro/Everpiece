"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Icon } from "./Icon";

/** Slush-style bottom tab bar. Hidden on pages a recipient opens from a link (claim, pay-a-request, receipts). */
const TABS = [
  { href: "/", label: "Home", icon: "home" },
  { href: "/bank", label: "Bank", icon: "bank" },
  { href: "/scan", label: "Scan", icon: "scan", primary: true },
  { href: "/#activity", label: "Activity", icon: "activity" },
  { href: "/receive", label: "Receive", icon: "user" },
] as const;

export function BottomNav() {
  const path = usePathname() ?? "/";
  // only on the app's "places" (like Slush): never over a flow, a claim link, a receipt or a payment screen
  if (path !== "/" && path !== "/receive" && path !== "/scan") return null;
  return (
    <nav className="tabbar" aria-label="Main">
      {TABS.map((t) => {
        const active = t.href === "/" ? path === "/" : t.href !== "/#activity" && path.startsWith(t.href);
        return (
          <Link key={t.label} href={t.href} className={`tab${active ? " active" : ""}${"primary" in t ? " primary" : ""}`} aria-current={active ? "page" : undefined}>
            <span className="tab-icon"><Icon name={t.icon} size={22} /></span>
            <span className="tab-label">{t.label}</span>
          </Link>
        );
      })}
    </nav>
  );
}
