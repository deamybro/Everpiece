"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import {
  ANCHORED_STOCK_ORACLE, INVEST_ASSETS, INVEST_AVAILABILITY, INVEST_PROVIDERS, priceIdOf, referenceFromOracle, stockOracleAbi,
  type AssetStatus, type InvestAsset, type ReferencePrice,
} from "@everpiece/shared";
import { client, formatDollars } from "../../lib/chain";
import { config } from "../../lib/config";

const SESSION_TEXT: Record<string, string> = {
  REGULAR: "market open", PRE_MARKET: "pre-market", POST_MARKET: "after hours", OVERNIGHT: "overnight", CLOSED: "market closed", UNKNOWN: "session unknown",
};

/** The issuer's on-chain reference price (Anchored StockOracle), read live; null = unavailable on this network. */
async function referencePrice(ticker: string): Promise<ReferencePrice | null> {
  if (config.chainId !== 143) return null;
  try {
    const p = await client.readContract({ address: ANCHORED_STOCK_ORACLE, abi: stockOracleAbi, functionName: "latestPrice", args: [priceIdOf(ticker)] });
    return referenceFromOracle(ticker, { ...p, price: BigInt(p.price), bestBid: BigInt(p.bestBid), bestAsk: BigInt(p.bestAsk), feedUpdateTimestamp: BigInt(p.feedUpdateTimestamp) }, BigInt(Math.floor(Date.now() / 1000)));
  } catch {
    return null;
  }
}

const BADGE: Record<AssetStatus, string> = {
  AVAILABLE: "Available", LOW_LIQUIDITY: "Low liquidity", UNAVAILABLE: "Unavailable", COMING_SOON: "Coming soon", RESTRICTED: "Restricted",
};

/**
 * Invest (docs/INVEST.md): tokenized US stocks as part of a money account, not a trading terminal. An asset is only
 * "Available" when a real route passes Everpiece's price-quality rules and simulates; nothing here invents a price.
 */
export default function InvestPage() {
  const [open, setOpen] = useState<InvestAsset | null>(null);
  const [ref, setRef] = useState<ReferencePrice | null | "loading">(null);
  useEffect(() => {
    if (!open) return;
    setRef("loading");
    referencePrice(open.referenceTicker).then(setRef);
  }, [open]);
  const status = (id: string) => INVEST_AVAILABILITY.assets.find((a) => a.assetId === id) ?? { assetId: id, status: "UNAVAILABLE" as AssetStatus, reason: "Not checked yet" };
  const anyAvailable = INVEST_ASSETS.some((a) => status(a.id).status === "AVAILABLE");

  return (
    <div className="stack">
      <div className="row">
        <Link href="/" className="brand">Everpiece</Link>
        <Link href="/" className="muted small">Done</Link>
      </div>
      <h1>Invest</h1>
      <p className="muted">Own a piece of companies you know, with tokenized US stocks issued by Anchored. Everpiece only offers a stock when it can buy it at a fair price.</p>
      {!anyAvailable && (
        <div className="status warn" aria-label="Investing status">
          No stock can be bought through Everpiece yet: no route meets Everpiece&apos;s price-quality rules. Nothing is bought, and your money stays in your balance.
        </div>
      )}
      <p className="muted small">Availability last checked {INVEST_AVAILABILITY.checkedAt} (read-only check on Monad mainnet).</p>

      {!open && (
        <ul className="assets" aria-label="Stocks">
          {INVEST_ASSETS.map((a) => {
            const s = status(a.id);
            return (
              <li key={a.id}>
                <button className="card settings-row" aria-label={`${a.company} ${BADGE[s.status]}`} onClick={() => setOpen(a)}>
                  <span className="grow"><strong>{a.company}</strong><span className="muted small">{a.symbol} · tracks {a.referenceTicker}</span></span>
                  <span className={`small ${s.status === "AVAILABLE" ? "" : "muted"}`}>{BADGE[s.status]}</span>
                </button>
              </li>
            );
          })}
        </ul>
      )}

      {open && (() => {
        const s = status(open.id);
        return (
          <section className="card stack" aria-label={`${open.company} details`}>
            <div className="row"><strong>{open.company}</strong><span className="small">{BADGE[s.status]}</span></div>
            <dl>
              <dt>Token</dt><dd>{open.symbol}</dd>
              <dt>Issuer</dt><dd>{open.issuer}</dd>
              <dt>Tracks</dt><dd>{open.referenceTicker} (US-listed share)</dd>
              <dt>Price</dt><dd>Shown only with a live, verified quote</dd>
              <dt>Reference price (not a buy price)</dt>
              <dd aria-label="Reference price">
                {ref === "loading" ? "…" : ref && !ref.stale
                  ? `${formatDollars(ref.priceMicroUsd)} per ${open.referenceTicker} share · ${SESSION_TEXT[ref.session]} · ${Math.round(Number(ref.ageSec) / 60)} min old (Anchored oracle)`
                  : "Unavailable right now"}
              </dd>
              <dt>Why</dt><dd>{s.reason}</dd>
            </dl>
            <details>
              <summary className="small">Routes Everpiece checked</summary>
              <ul className="small muted">
                {INVEST_PROVIDERS.map((p) => <li key={p.id}><strong>{p.name}</strong>: {p.enabled ? "enabled" : `not enabled — ${p.missing.join("; ")}`}</li>)}
              </ul>
            </details>
            <p className="muted small">
              Eligibility: Anchored tokenized stocks are for eligible, qualified investors and are not available to US persons and some other
              jurisdictions. They track a share&apos;s price; they are not the share itself. Markets have trading hours; settlement can take time.
            </p>
            <button className="ghost" onClick={() => setOpen(null)}>Back to stocks</button>
          </section>
        );
      })()}
    </div>
  );
}
