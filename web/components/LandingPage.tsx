"use client";

import Image from "next/image";
import Link from "next/link";
import { useEffect, useState, type ReactNode } from "react";
import { Icon } from "./Icon";

const routeSteps = [
  ["David", "USDC on Base"],
  ["Supported route", "Aurora Intents"],
  ["Ada", "USDC on Monad"],
] as const;

const accountDestinations = [
  ["home", "Balance"],
  ["send", "Payments"],
  ["earn", "Earn"],
  ["invest", "Invest"],
  ["automate", "Automate"],
  ["activity", "Activity"],
] as const;

function SceneLabel({ number, children }: { number: string; children: ReactNode }) {
  return <span className="story-label"><b>{number}</b>{children}</span>;
}

function RouteVisual() {
  return (
    <div className="story-visual story-route" aria-label="Illustration of a supported payment route from David to Ada">
      <div className="story-request"><span>Payment request</span><strong>$50 for Ada</strong><small>Illustrative payment journey</small></div>
      <div className="story-route-line">
        {routeSteps.map(([name, detail], index) => <div key={name} className="story-route-step"><span>{index + 1}</span><strong>{name}</strong><small>{detail}</small></div>)}
      </div>
      <div className="story-status"><Icon name="check" size={17} />Route and fees reviewed before approval</div>
    </div>
  );
}

function QrVisual() {
  return (
    <div className="story-visual story-qr" aria-label="Illustration of an Everpiece QR payment">
      <div className="story-qr-request"><span>Request from Ada</span><strong>$25</strong><small>USDC · Monad</small></div>
      <div className="story-qr-code" aria-hidden="true">{Array.from({ length: 36 }, (_, index) => <i key={index} className={index % 3 === 0 || index % 7 === 0 || [1, 8, 22, 34].includes(index) ? "filled" : ""} />)}</div>
      <div className="story-scan-phone"><Icon name="scan" size={27} /><strong>Request recognized</strong><small>Recipient, amount, and route shown before payment</small></div>
    </div>
  );
}

function AssetVisual() {
  return (
    <div className="story-visual story-assets">
      <div className="story-assets-head"><span>Choose what arrives</span><small>Settlement stays visible</small></div>
      <div className="story-asset-card"><i className="token-usdc">U</i><span><strong>USDC</strong><small>Available balance</small></span><b>Keep</b></div>
      <div className="story-conversion"><span>Supported conversion</span><Icon name="send" size={17} /></div>
      <div className="story-asset-card"><i className="token-ausd">A</i><span><strong>AUSD</strong><small>Requested asset</small></span><b>Receive</b></div>
      <p>If a requested conversion cannot complete, the recoverable USDC state remains visible.</p>
    </div>
  );
}

function ProtectionVisual() {
  return (
    <div className="story-visual story-protection">
      <div className="story-send-choice"><span><Icon name="send" size={20} /></span><div><strong>Instant Send</strong><small>Final after verified onchain settlement</small></div></div>
      <div className="story-send-choice active"><span><Icon name="shield" size={20} /></span><div><strong>Protected Send</strong><small>Claim, cancel, or refund under the payment conditions</small></div><b>Selected</b></div>
      <div className="story-timeline"><span className="done">Protected</span><i /><span>Claimed</span><i /><span>Final</span></div>
      <small className="story-caption">The app explains pending, protected, claimed, refunded, and final states.</small>
    </div>
  );
}

function PrivacyVisual() {
  return (
    <div className="story-visual story-privacy">
      <div><span className="story-icon"><Icon name="eye" size={21} /></span><strong>Standard payment</strong><p>Public settlement details and a readable receipt.</p><small>Transparent onchain state</small></div>
      <div><span className="story-icon"><Icon name="lock" size={21} /></span><strong>Eligible private payment</strong><p>Supported confidential USDC balance and transfer options.</p><small>Boundaries remain explained</small></div>
      <p className="story-privacy-note"><Icon name="shield" size={17} />Privacy changes what is exposed; it does not make every system boundary invisible.</p>
    </div>
  );
}

function AllocationVisual() {
  return (
    <div className="story-visual story-allocation">
      <div className="story-arrival"><span>Payment received</span><strong>+$100 USDC</strong><small>Illustrative allocation</small></div>
      <div className="story-split-line" />
      <div className="story-allocation-grid">
        <div><span>50%</span><Icon name="home" size={21} /><strong>$50</strong><small>Available balance</small></div>
        <div><span>30%</span><Icon name="earn" size={21} /><strong>$30</strong><small>Earn</small></div>
        <div><span>20%</span><Icon name="invest" size={21} /><strong>$20</strong><small>Eligible investment</small></div>
      </div>
      <p>Every action is checked separately. Money stays available when an action cannot execute.</p>
    </div>
  );
}

function EarnVisual() {
  return (
    <div className="story-visual story-earn">
      <div className="story-product-head"><span><Icon name="earn" size={20} /></span><div><strong>Earn</strong><small>Supported strategies on Monad</small></div><b>Variable yield</b></div>
      <div className="story-chart" aria-label="Illustrative yield chart"><i /><i /><i /><i /><i /><i /><i /></div>
      <div className="story-rule"><span>Approved rule</span><strong>Keep $100 available. Earn on eligible excess.</strong></div>
      <small className="story-caption">Provider, withdrawal availability, estimate, and risk stay visible. Chart is illustrative.</small>
    </div>
  );
}

function InvestVisual() {
  const assets = [["NVIDIA", "40%"], ["Apple", "30%"], ["Microsoft", "30%"]] as const;
  return (
    <div className="story-visual story-invest">
      <div className="story-product-head"><span><Icon name="invest" size={20} /></span><div><strong>Invest with eligible earnings</strong><small>Illustrative proposal</small></div><b>Review required</b></div>
      <div className="story-threshold"><span>Harvestable yield threshold</span><strong>$10 example</strong></div>
      {assets.map(([name, share]) => <div className="story-invest-row" key={name}><span>{name.slice(0, 1)}</span><strong>{name}</strong><i><em style={{ width: share }} /></i><b>{share}</b></div>)}
      <small className="story-caption">Availability depends on issuer terms, eligibility, price quality, liquidity, and simulation.</small>
    </div>
  );
}

function AutomateVisual() {
  return (
    <div className="story-visual story-automate">
      <div className="story-prompt"><span><Icon name="spark" size={18} />Describe your intention</span><p>“Whenever I get paid, keep half, earn on 30%, and invest the remaining 20%.”</p></div>
      <div className="story-rule-preview"><span>Rule proposal</span><div><b>50%</b> Balance</div><div><b>30%</b> Earn</div><div><b>20%</b> Invest</div><small>Limits, providers, duration, and risks are reviewed first.</small></div>
      <div className="story-approval"><Icon name="lock" size={17} />AI proposes. You approve. Deterministic rules execute.</div>
    </div>
  );
}

function ConnectedVisual() {
  return (
    <div className="story-visual story-connected">
      <div className="story-dashboard-preview">
        <div className="story-dashboard-nav"><span className="landing-mini-mark" /><b>Everpiece</b><i /><span className="story-avatar"><Icon name="user" size={14} /></span></div>
        <div className="story-dashboard-balance"><small>Total balance</small><strong>$—.——</strong><span>USDC + AUSD</span></div>
        <div className="story-destination-grid">{accountDestinations.map(([icon, label]) => <div key={label}><Icon name={icon} size={18} /><span>{label}</span></div>)}</div>
        <div className="story-dashboard-activity"><span>Recent activity</span><small>Clear status and finalized receipts</small></div>
      </div>
      <div className="story-profile-card"><Icon name="user" size={22} /><strong>One account</strong><span>Passkey security</span><span>Encrypted app backup</span><span>Limits and preferences</span></div>
    </div>
  );
}

export function LandingPage() {
  const [navShrunk, setNavShrunk] = useState(false);

  useEffect(() => {
    const updateNav = () => setNavShrunk(window.scrollY > 24);
    updateNav();
    window.addEventListener("scroll", updateNav, { passive: true });
    return () => window.removeEventListener("scroll", updateNav);
  }, []);

  return (
    <div className="landing-page">
      <header className={`landing-nav${navShrunk ? " is-scrolled" : ""}`}>
        <div className="landing-nav-inner">
          <Link href="/" className="brand landing-brand"><Image className="landing-logo-mark" src="/brand/everpiece-mark.png" alt="" width={1254} height={1254} priority />Everpiece<span className="brand-dot">.</span></Link>
          <nav className="landing-links" aria-label="Landing navigation">
            <a href="#story">The story</a>
            <a href="#payments">Payments</a>
            <a href="#possibilities">What happens next</a>
            <a href="#security">Security</a>
          </nav>
          <div className="landing-nav-actions">
            <Link href="/profile" className="landing-login">Sign in</Link>
            <Link href="/profile" className="landing-pill landing-pill-primary">Open Everpiece</Link>
          </div>
        </div>
      </header>

      <main>
        <section className="landing-hero" id="story">
          <div className="landing-container landing-hero-grid">
            <div className="landing-hero-copy">
              <span className="landing-kicker">Programmable money on Monad</span>
              <h1>Pay with what you have.<br />Receive what you need.</h1>
              <p>Money should move around your life, not the other way around. Send, receive, earn, invest, and automate from one account.</p>
              <div className="landing-hero-actions">
                <Link href="/profile" className="landing-pill landing-pill-primary">Open Everpiece <Icon name="send" size={18} /></Link>
                <a href="#payments" className="landing-pill landing-pill-ghost">See how it works</a>
              </div>
              <div className="landing-assurance"><Icon name="shield" size={17} /><span>Passkey protected. Every financial action stays within your approval and limits.</span></div>
            </div>
            <div className="landing-product-art">
              <Image className="landing-device-render" src="/landing/everpiece-devices.png" alt="Everpiece wallet displayed on two phones with a violet payment card" width={1536} height={1024} priority />
            </div>
          </div>
        </section>

        <section className="landing-facts" aria-label="Everpiece product facts">
          <div className="landing-container landing-facts-grid">
            <div className="landing-fact"><span><Icon name="send" size={20} /></span><div><strong>Different wallets</strong><small>One supported payment route</small></div></div>
            <div className="landing-fact"><span><b>U</b></span><div><strong>USDC + AUSD</strong><small>Choose what fits the payment</small></div></div>
            <div className="landing-fact"><span><Icon name="shield" size={20} /></span><div><strong>Protection by choice</strong><small>Instant, protected, or eligible private</small></div></div>
            <div className="landing-fact"><span><Icon name="automate" size={20} /></span><div><strong>Money with instructions</strong><small>Keep, earn, invest, or automate</small></div></div>
          </div>
        </section>

        <section className="landing-problem">
          <div className="landing-container landing-problem-grid">
            <div><SceneLabel number="01">The problem</SceneLabel><h2>Money is global.<br />Using it is still complicated.</h2></div>
            <div><p>A sender may already have USDC on Base or another supported asset. The recipient may want digital dollars on Monad. Today, that can mean addresses, bridges, swaps, gas, and several applications.</p><p>People do not think in infrastructure. They think: <strong>“I want to send $50 to someone.”</strong> Everpiece starts with that intention.</p></div>
          </div>
        </section>

        <div className="landing-story">
          <section className="story-scene" id="payments">
            <div className="landing-container story-grid">
              <div className="story-copy"><SceneLabel number="02">Cross-chain payments</SceneLabel><h2>Different wallets.<br />One simple payment.</h2><p>Ada creates a $50 request in Lagos and shares it with David in London. David can review a supported route from his existing wallet. Ada receives the result on Monad without either person manually operating a bridge.</p><strong>Two people. Different wallets. One payment.</strong></div>
              <RouteVisual />
            </div>
          </section>

          <section className="story-scene story-tinted">
            <div className="landing-container story-grid story-reverse">
              <QrVisual />
              <div className="story-copy"><SceneLabel number="03">Requests and QR</SceneLabel><h2>Your next payment starts with a scan.</h2><p>Create a request, share a link, or show a QR code. The payer sees the recipient, amount, requested asset, and supported ways to pay before confirming.</p><strong>One request. Different supported ways to pay.</strong></div>
            </div>
          </section>

          <section className="story-scene">
            <div className="landing-container story-grid">
              <div className="story-copy"><SceneLabel number="04">Asset choice</SceneLabel><h2>Your balance.<br />Your choice.</h2><p>Hold USDC and AUSD in one account and choose the asset that fits the payment. Everpiece coordinates an authorized supported conversion when available and keeps incomplete or recoverable outcomes visible.</p><strong>A payment should deliver what was agreed—or explain clearly why it could not.</strong></div>
              <AssetVisual />
            </div>
          </section>

          <section className="story-scene story-tinted">
            <div className="landing-container story-grid story-reverse">
              <ProtectionVisual />
              <div className="story-copy"><SceneLabel number="05">Payment protection</SceneLabel><h2>Pay with the right kind of confidence.</h2><p>Use Instant Send for a straightforward transfer. Choose Protected Send when the intended recipient should claim the money, with cancellation or refund paths available under the payment conditions.</p><strong>Protection is a payment choice, not hidden infrastructure.</strong></div>
            </div>
          </section>

          <section className="story-scene" id="security">
            <div className="landing-container story-grid">
              <div className="story-copy"><SceneLabel number="06">Privacy</SceneLabel><h2>Some payments deserve more privacy.</h2><p>Standard payments, protected payments, confidential routing, and private balances solve different problems. Everpiece explains what each supported option protects and what remains visible.</p><strong>Discretion without impossible promises.</strong></div>
              <PrivacyVisual />
            </div>
          </section>
        </div>

        <section className="landing-pivot" id="possibilities">
          <div className="landing-container"><SceneLabel number="07">The Everpiece moment</SceneLabel><h2>Getting paid is just the beginning.</h2><p>Keep some. Earn on some. Invest the rest. Let your money follow rules you reviewed and approved.</p><AllocationVisual /></div>
        </section>

        <section className="story-scene">
          <div className="landing-container story-grid">
            <div className="story-copy"><SceneLabel number="08">Earn</SceneLabel><h2>Your money does not need to sit still.</h2><p>Put eligible stablecoins to work through supported onchain strategies. See the provider, variable estimate, withdrawal availability, and relevant risks in one understandable view.</p><strong>Your principal and actual harvestable yield stay distinct.</strong></div>
            <EarnVisual />
          </div>
        </section>

        <section className="story-scene story-tinted">
          <div className="landing-container story-grid story-reverse">
            <InvestVisual />
            <div className="story-copy"><SceneLabel number="09">Invest</SceneLabel><h2>Let your earnings build something bigger.</h2><p>Use eligible harvestable yield to gradually build exposure to supported tokenized assets. Every proposal must show issuer information, actual rights, eligibility, price quality, liquidity, and restrictions.</p><strong>A deployed token is not automatically an available investment.</strong></div>
          </div>
        </section>

        <section className="story-scene">
          <div className="landing-container story-grid">
            <div className="story-copy"><SceneLabel number="10">Automate</SceneLabel><h2>Just tell your money what to do.</h2><p>Describe an intention in plain language. Everpiece Copilot turns it into a structured proposal with providers, limits, duration, and risks for you to review.</p><strong>The AI helps express the intention. You control the permission.</strong></div>
            <AutomateVisual />
          </div>
        </section>

        <section className="story-scene story-connected-section">
          <div className="landing-container story-grid story-reverse">
            <ConnectedVisual />
            <div className="story-copy"><SceneLabel number="11">One coherent account</SceneLabel><h2>Everything in one place.</h2><p>Your balance, USDC and AUSD, payments, activity, Earn, Invest, Automate, profile, passkey security, backup, limits, and preferences—connected through one Everpiece experience.</p><strong>A financial product for people, not a trading terminal.</strong></div>
          </div>
        </section>

        <section className="landing-future">
          <div className="landing-container landing-future-card">
            <div><SceneLabel number="12">Coming soon</SceneLabel><h2>More useful ways to move money.</h2><p>We are working toward local payment options for Nigeria, including Naira funding, Naira off-ramp, and Nigerian bank payouts.</p><span className="landing-coming-soon">Provider verification and production testing required</span></div>
            <div className="landing-naira-preview"><span>Future product preview</span><strong>Digital dollars → Naira</strong><div><Icon name="bank" size={24} /><p><b>Nigerian bank payout</b><small>Coming Soon</small></p></div><small>No exchange rate or completed payout is implied.</small></div>
          </div>
        </section>

        <section className="landing-final">
          <div className="landing-container landing-final-grid">
            <div><SceneLabel number="13">Your money. Your rules.</SceneLabel><h2>Pay anyone through supported routes. Decide what happens next.</h2><p>Receive digital dollars. Keep them available, earn on them, invest them, or automate eligible actions—all from Everpiece.</p><div className="landing-hero-actions"><Link href="/profile" className="landing-pill landing-pill-primary">Open Everpiece <Icon name="send" size={18} /></Link><a href="#payments" className="landing-pill landing-pill-ghost">Explore how it works</a></div></div>
            <Image className="landing-final-device" src="/landing/everpiece-devices.png" alt="The complete Everpiece account experience" width={1536} height={1024} />
          </div>
        </section>
      </main>

      <footer className="landing-footer"><div className="landing-container"><Link href="/" className="brand landing-brand"><Image className="landing-logo-mark" src="/brand/everpiece-mark.png" alt="" width={1254} height={1254} />Everpiece<span className="brand-dot">.</span></Link><span>Pay with what you have. Receive what you need.</span><div><Link href="/proof">On-chain proof</Link><Link href="/profile">Sign in</Link></div></div></footer>
    </div>
  );
}
