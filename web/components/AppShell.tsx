"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef } from "react";
import { forgetAccount } from "../lib/mera";
import { useAccountView } from "./AccountView";
import { Icon } from "./Icon";
import { BottomNav } from "./BottomNav";

const destinations = [
  ["/dashboard", "Home", "home"], ["/send", "Send", "send"], ["/request", "Request", "request"],
  ["/earn", "Earn", "earn"], ["/invest", "Invest", "invest"], ["/automate", "Automate", "automate"],
  ["/activity", "Activity", "activity"], ["/profile", "Profile", "user"], ["/settings", "Settings", "settings"],
] as const;

export function signOut() {
  forgetAccount();
  window.location.assign("/");
}

function TopHeader({ path }: { path: string }) {
  const { account } = useAccountView();
  const menu = useRef<HTMLDetailsElement>(null);
  useEffect(() => { if (menu.current) menu.current.open = false; window.dispatchEvent(new Event("everpiece:account-view")); }, [path]);
  useEffect(() => {
    const close = (e: PointerEvent) => { if (menu.current && !menu.current.contains(e.target as Node)) menu.current.open = false; };
    const escape = (e: KeyboardEvent) => { if (e.key === "Escape" && menu.current?.open) { menu.current.open = false; menu.current.querySelector("summary")?.focus(); } };
    window.addEventListener("pointerdown", close);
    window.addEventListener("keydown", escape);
    return () => { window.removeEventListener("pointerdown", close); window.removeEventListener("keydown", escape); };
  }, []);
  const title = destinations.find(([href]) => href === path)?.[1] ?? "Everpiece";
  return <header className="app-header">
    <Link href="/dashboard" className="brand mobile-brand">Everpiece<span className="brand-dot">.</span></Link>
    <span className="desktop-page-name">{title}</span>
    <div className="header-end">
      {!account && <Link href="/profile" className="signin-link">Sign in</Link>}
      <details className="account-menu" ref={menu}>
        <summary aria-label="Open account menu"><span className="avatar">{account ? (account.name || account.username || "E").slice(0, 1).toUpperCase() : <Icon name="user" size={18} />}</span><Icon name="chevron" size={13} /></summary>
        <div className="account-popover">
          <div className="menu-identity"><strong>{account?.name || (account?.username ? `@${account.username}` : "Your account")}</strong><span>{account ? "Passkey account" : "Not signed in"}</span></div>
          <Link href="/profile"><Icon name="user" size={17} />Profile</Link>
          <Link href="/settings"><Icon name="settings" size={17} />Settings</Link>
          {account && <button className="ghost" onClick={signOut}>Sign out</button>}
        </div>
      </details>
    </div>
  </header>;
}

export function AppShell({ children }: { children: React.ReactNode }) {
  const path = usePathname() ?? "/";
  // Public payment links and receipts retain their existing self-contained experience.
  if (/^\/(c|r|pay|payout)\//.test(path)) return <main className="app">{children}</main>;
  const places = ["/", "/dashboard", "/send", "/scan", "/request", "/receive", "/earn", "/invest", "/automate", "/activity", "/profile", "/settings"].includes(path);
  return <div className={`app-shell${places ? " with-mobile-nav" : ""}${path === "/dashboard" ? " shell-home" : ""}`}>
    <a className="skip-link" href="#main-content">Skip to content</a>
    <aside className="desktop-sidebar">
      <Link href="/dashboard" className="brand">Everpiece<span className="brand-dot">.</span></Link>
      <nav aria-label="Desktop navigation">{destinations.map(([href, label, icon]) => <Link key={href} href={href} aria-label={`${label} navigation`} aria-current={path === href ? "page" : undefined} className={path === href ? "selected" : ""}><Icon name={icon} size={19} />{label}</Link>)}</nav>
      <div className="sidebar-foot"><Icon name="shield" size={17} /><span>Made for peace of mind.</span></div>
    </aside>
    <div className="workspace">
      <TopHeader path={path} />
      <main id="main-content" className={`workspace-main ${places ? "place-page" : "flow-page"}`}>{children}</main>
    </div>
    <BottomNav />
  </div>;
}
