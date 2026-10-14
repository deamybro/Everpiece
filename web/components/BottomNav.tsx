"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Icon } from "./Icon";

/** Main places only: financial forms and public receipts keep their full viewport. */
const TABS = [
  { href: "/dashboard", label: "Home", icon: "home" },
  { href: "/earn", label: "Earn", icon: "earn" },
  { href: "/invest", label: "Invest", icon: "invest" },
  { href: "/automate", label: "Automate", icon: "automate" },
  { href: "/profile", label: "Profile", icon: "user" },
] as const;

export function BottomNav() {
  const path = usePathname() ?? "/";
  // Keep primary mobile navigation in its own row across the main app screens.
  if (!["/", "/dashboard", "/send", "/scan", "/request", "/receive", "/earn", "/invest", "/automate", "/activity", "/profile", "/settings", "/get-paid", "/private"].includes(path)) return null;
  return (
    <nav className="tabbar" aria-label="Main">
      {TABS.map((t) => {
        const active = path.startsWith(t.href);
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
