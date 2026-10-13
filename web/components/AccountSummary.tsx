"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { fromBaseUnits, payableTokens } from "@everpiece/shared";
import { type Account } from "../lib/mera";
import { config, isDevStack } from "../lib/config";
import { formatDollars } from "../lib/chain";
import { balanceOfToken } from "../lib/pay";
import { currentRate, earnAvailable, opportunity, readPosition } from "../lib/earn";
import { automateAvailable, listRules } from "../lib/automate";
import { Icon } from "./Icon";
import { LoadingSkeleton } from "./DashboardUI";

type Detail = { amount: bigint | null; note: string };
type Overview = { usdc: Detail; earn: Detail; rules: number | null; rulesNote: string; updated: number | null; stale: boolean; loading: boolean };
const initial: Overview = { usdc: { amount: null, note: "Sign in to see your balance" }, earn: { amount: null, note: "Sign in to see your position" }, rules: null, rulesNote: "Sign in to see your rules", updated: null, stale: false, loading: false };

/** Read-only summaries using the same registered assets and product clients as their existing screens. */
function useOverview(account: Account | null) {
  const [data, setData] = useState<Overview>(initial);
  useEffect(() => {
    if (!account) { setData(initial); return; }
    let live = true, running = false;
    const usdc = payableTokens(config.chainId).find((t) => t.symbol === "USDC");
    const o = opportunity();
    const read = async () => {
      if (running) return;
      running = true;
      const result = await Promise.allSettled([
        usdc ? balanceOfToken(usdc.address, account.address) : Promise.resolve(null),
        o ? Promise.all([readPosition(o, account.address), currentRate(o)]) : Promise.resolve(null),
        automateAvailable() ? listRules(account.address) : Promise.resolve(null),
      ]);
      running = false;
      if (!live) return;
      const [u, e, r] = result;
      setData((old) => ({
        usdc: u.status === "fulfilled" ? { amount: u.value, note: usdc ? "USDC · Circle" : "Not supported on this network" } : { amount: old.usdc.amount, note: old.usdc.amount !== null ? "Last known balance · refresh failed" : "Balance unavailable" },
        earn: e.status === "fulfilled" ? { amount: e.value?.[0].position.currentRedeemableValue ?? null, note: !o ? "Provider not connected" : o.simulated ? "Test vault · simulated yield" : e.value?.[1] ? `${(e.value[1].apyBps / 100).toFixed(2)}% APY · variable` : "Live APY unavailable" } : { amount: old.earn.amount, note: old.earn.amount !== null ? "Last known position · refresh failed" : "Position unavailable" },
        rules: r.status === "fulfilled" ? r.value?.filter((view) => view.state === "WAITING_TRIGGER" && view.rule.enabled === true).length ?? null : old.rules,
        rulesNote: r.status === "rejected" ? "Rules unavailable · try Automate" : !automateAvailable() ? "Provider not connected" : r.value?.length ? "View and manage your money rules" : "Create your first money rule",
        updated: Date.now(), stale: result.some((v) => v.status === "rejected"), loading: false,
      }));
    };
    setData({ ...initial, loading: true });
    void read();
    const timer = setInterval(() => { if (!document.hidden) void read(); }, 30_000);
    const show = () => { if (!document.hidden) void read(); };
    document.addEventListener("visibilitychange", show);
    return () => { live = false; clearInterval(timer); document.removeEventListener("visibilitychange", show); };
  }, [account?.address]);
  return data;
}

function AssetBalanceCard({ symbol, amount, note, hidden, loading }: { symbol: string; amount: string | null; note: string; hidden: boolean; loading: boolean }) {
  const showNote = /unavailable|failed|not supported/i.test(note);
  return <Link href="/receive" className="asset-balance-card" aria-label={`${symbol} balance and receive details`}>
    <img className={`token-logo ${symbol === "AUSD" ? "ausd-logo" : ""}`} src={`/tokens/${symbol.toLowerCase()}.svg`} alt="" width={34} height={34} />
    <span className="asset-card-copy"><span>{symbol}</span><strong>{loading ? <LoadingSkeleton label={`Loading ${symbol} balance`} /> : amount === null ? "—" : hidden ? "••••" : amount}</strong><small className={showNote ? "" : "sr-only"}>{note}</small></span>
    <Icon name="chevron" size={14} />
  </Link>;
}

function QuickAction({ href, icon, label }: { href: string; icon: string; label: string }) {
  return <Link href={href} className="quick-action" aria-label={label === "Send" ? "Send money" : label === "Add Money" && href === "/add" ? "Add money from another chain" : label}><span><Icon name={icon} size={21} /></span>{label}</Link>;
}

function FeatureSummaryCard({ href, title, value, note, icon, tone, loading }: { href: string; title: string; value: string; note: string; icon: string; tone: string; loading?: boolean }) {
  return <Link href={href} className={`feature-summary ${tone}`} aria-label={title === "Earn" ? "Earn on your Dollars" : "Invest in stocks"}><div className="feature-top"><span className="feature-icon"><Icon name={icon} size={20} /></span><strong>{title}</strong><Icon name="chevron" size={14} /></div><div className="feature-value">{loading ? <LoadingSkeleton label={`Loading ${title}`} /> : value}</div><p>{note}</p></Link>;
}

export function AccountSummary({ account, balance, assetRows = [], balanceLoading = false, balanceStale = false, hideBalance = false, toggleHide }: { account: Account | null; balance: bigint | null; assetRows?: { symbol: string; balance: bigint }[]; balanceLoading?: boolean; balanceStale?: boolean; hideBalance?: boolean; toggleHide?: () => void }) {
  const overview = useOverview(account);
  const [greeting, setGreeting] = useState("Hello");
  useEffect(() => { const hour = new Date().getHours(); setGreeting(hour < 12 ? "Good morning" : hour < 17 ? "Good afternoon" : "Good evening"); }, []);
  const usdc = payableTokens(config.chainId).find((t) => t.symbol === "USDC");
  const o = opportunity();
  // Mainnet can expose newer Earn providers through the production Earn screen even when this
  // dashboard build does not have that provider's vault metadata yet. Keep the dashboard honest:
  // the configured Earn contract means the product is available, while position details remain
  // on the production Earn route.
  const earnRouteAvailable = earnAvailable() || Boolean(config.earn) || Boolean(o);
  const rowOf = (s: string) => assetRows.find((r) => r.symbol === s)?.balance ?? null;
  return <>
    <div className="dashboard-greeting"><h1>{greeting}{account?.name ? `, ${account.name}` : ""}<span aria-hidden="true"> 👋</span></h1></div>
    <section className="account-summary" aria-label="Account balances">
      <div className="balance-heading"><span>Available Dollars</span>{account && toggleHide && <button className="eye" onClick={toggleHide} aria-label={hideBalance ? "Show balance" : "Hide balance"} aria-pressed={hideBalance}><Icon name={hideBalance ? "eyeOff" : "eye"} size={18} /></button>}{isDevStack && <span className="pill">Test money</span>}</div>
      <div className="dashboard-balance balance">{balanceLoading ? <LoadingSkeleton label="Loading AUSD balance" /> : !account ? <span className="balance-placeholder">$<span>—.——</span></span> : balance === null ? "Unavailable" : hideBalance ? "$••••" : <BalanceAmount value={formatDollars(balance)} />}</div>
      <p className="balance-context">{!account ? <Link href="/profile">Sign in to see your balances.</Link> : balanceStale ? "Last known balance · unable to refresh." : balance === null ? "Couldn’t load your balance. Try again shortly." : assetRows.length > 0 ? "USDC and AUSD available to spend" : "AUSD available to spend · other assets separate"}</p>
      <div className="asset-balance-grid">
        <AssetBalanceCard symbol="USDC" amount={rowOf("USDC") !== null ? formatDollars(rowOf("USDC")!) : overview.usdc.amount === null || !usdc ? null : fromBaseUnits(overview.usdc.amount, usdc.decimals, 2)} note={overview.usdc.note} hidden={hideBalance} loading={rowOf("USDC") !== null ? balanceLoading : overview.loading} />
        <AssetBalanceCard symbol="AUSD" amount={assetRows.length > 0 ? (rowOf("AUSD") === null ? null : formatDollars(rowOf("AUSD")!)) : balance === null ? null : formatDollars(balance)} note={account ? "AUSD · Agora" : "Sign in to see your balance"} hidden={hideBalance} loading={balanceLoading} />
      </div>
      <nav className="dashboard-quick-actions" aria-label="Pay and get paid"><QuickAction href="/send" icon="send" label="Send" /><QuickAction href="/receive" icon="request" label="Receive" /><QuickAction href="/request" icon="add" label="Request" /><QuickAction href="/scan" icon="scan" label="Scan" /></nav>
    </section>
    <div className="product-overview">
    <Link href="/automate" className="automation-summary" aria-label="Automate your money"><span className="automation-icon"><Icon name="automate" size={18} /></span><span><strong>{overview.loading ? "Loading automations…" : overview.rules !== null && !overview.stale ? overview.rules > 0 ? `${overview.rules} active ${overview.rules === 1 ? "rule" : "rules"}` : "No active automations" : "Automate your money"}</strong><small>{overview.rulesNote}</small></span><Icon name="chevron" size={15} /></Link>
    <div className="feature-grid">
      <FeatureSummaryCard href="/earn" title="Earn" icon="earn" tone="earn-summary" value={!account ? earnRouteAvailable ? "Available" : "Unavailable" : overview.earn.amount === null ? earnRouteAvailable ? "Available" : "Unavailable" : hideBalance ? "••••" : formatDollars(overview.earn.amount)} note={!account ? o ? o.simulated ? "Test vault · simulated yield" : o.name : earnRouteAvailable ? "View current opportunities" : "No provider connected" : overview.earn.amount === null && earnRouteAvailable ? "View your live Earn account" : overview.earn.note} loading={overview.loading} />
      <FeatureSummaryCard href="/invest" title="Invest" icon="invest" tone="invest-summary" value="Coming soon" note="Verified purchase routes pending" />
    </div>
    </div>
  </>;
}

function BalanceAmount({ value }: { value: string }) {
  const [whole, cents] = value.split(".");
  return <>{whole}<span className="balance-cents">.{cents}</span></>;
}
