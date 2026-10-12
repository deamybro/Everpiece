"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { describeRule, parseCopilotProposal, proposalToRuleSpec, ruleFromJson, ruleSpecProblem, COPILOT_MAX_INPUT_CHARS, type Action, type RuleSpec } from "@everpiece/shared";
import { Welcome } from "../../components/Welcome";
import { Progress, progressText } from "../../components/status";
import { friendlyError } from "../../lib/api";
import { formatDollars, parseDollars, chainTime } from "../../lib/chain";
import { askCopilot, copilotAvailable, authorizeRule, boundedAvailable, createRule, listExecutions, listRules, runExecution, setEnabled, targetStatus, automateAvailable, type ExecutionView, type RuleView } from "../../lib/automate";
import { opportunities, opportunity } from "../../lib/earn";
import { friendlyPasskeyError, loadAccount, type Account } from "../../lib/mera";
import { PayError } from "../../lib/pay";

const errText = (e: unknown) => (e instanceof PayError ? friendlyError(e.code) : friendlyPasskeyError(e));
type Template = "split" | "keep" | "earn-invest";
const STOCKS = [{ id: "aNVDA", name: "NVIDIA" }, { id: "aAAPL", name: "Apple" }, { id: "aMSFT", name: "Microsoft" }];
const names = {
  opportunity: () => opportunity()?.name ?? "Earn",
  asset: (id: string) => STOCKS.find((s) => s.id === id)?.name ?? id,
  position: () => opportunity()?.name ?? "Earn",
};
const LEG_TEXT: Record<string, string> = {
  KEPT: "Stays in your balance", PENDING: "Waiting for you", LIMITED: "Limited by your rule", UNAVAILABLE: "Skipped",
  EXECUTING: "In progress", DONE: "Done ✓", FAILED: "Didn't happen",
};
const RUN_TEXT: Record<string, string> = {
  READY: "Waiting for your fingerprint", EXECUTING: "Running", COMPLETED: "Completed ✓", PARTIALLY_COMPLETED: "Partly done", FAILED: "Nothing moved",
};

/** Automate (docs/AUTOMATE.md): deterministic rules, signed by you, within limits you set. */
export default function AutomatePage() {
  const [account, setAccount] = useState<Account | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [rules, setRules] = useState<RuleView[]>([]);
  const [runs, setRuns] = useState<ExecutionView[]>([]);
  const [template, setTemplate] = useState<Template | null>(null);
  const [keepPct, setKeepPct] = useState("50");
  const [earnPct, setEarnPct] = useState("30");
  const [stockPct, setStockPct] = useState("20");
  const [keepAmount, setKeepAmount] = useState("100");
  const [threshold, setThreshold] = useState("10");
  const [stocks, setStocks] = useState<Record<string, string>>({ aNVDA: "40", aAAPL: "30", aMSFT: "30" });
  const [perRun, setPerRun] = useState("50");
  const [perDay, setPerDay] = useState("200");
  const [perMonth, setPerMonth] = useState("1000");
  const [days, setDays] = useState("30");
  const [spec, setSpec] = useState<RuleSpec | null>(null);
  const [copilotOn, setCopilotOn] = useState(false);
  const [ask, setAsk] = useState("");
  const [asking, setAsking] = useState(false);
  const [assumed, setAssumed] = useState<string[]>([]);
  const [fromCopilot, setFromCopilot] = useState(false);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState("");
  const [error, setError] = useState("");
  const [done, setDone] = useState("");
  /** "Runs within these limits without asking" (EverpieceAutomate grant) vs. confirm each run with a fingerprint. */
  const [unattended, setUnattended] = useState(false);

  const refresh = useCallback(async (a: Account) => {
    const [r, x] = await Promise.all([listRules(a.address), listExecutions(a.address)]);
    setRules(r);
    setRuns(x);
  }, []);
  useEffect(() => {
    const a = loadAccount();
    setAccount(a);
    setLoaded(true);
    if (a && automateAvailable()) refresh(a).catch((e) => setError(errText(e)));
    copilotAvailable().then(setCopilotOn).catch(() => {});
  }, [refresh]);

  if (!loaded) return null;
  if (!account) return <Welcome onReady={setAccount} title="Create your account first." />;
  const opp = opportunity();

  const bps = (s: string) => Math.round(Number(s) * 100);
  async function preview() {
    setError("");
    setDone("");
    const max = (s: string) => parseDollars(s) ?? 0n;
    const now = await chainTime();
    const limits = { maxPerExecution: max(perRun), maxPerDay: max(perDay), maxPerMonth: max(perMonth), expiresAt: now + BigInt(Math.max(1, Number(days) || 0)) * 86_400n };
    let s: RuleSpec;
    if (template === "split") {
      const actions: Action[] = [];
      if (bps(keepPct) > 0) actions.push({ kind: "KEEP_BALANCE", bps: bps(keepPct) });
      if (bps(earnPct) > 0) actions.push({ kind: "DEPOSIT_YIELD", bps: bps(earnPct), opportunityId: opp?.id ?? "earn" });
      if (bps(stockPct) > 0) actions.push({ kind: "BUY_STOCK", bps: bps(stockPct), assetId: "aNVDA" });
      s = { name: "Split my income", trigger: { kind: "PAYMENT_RECEIVED", minAmount: 0n }, actions, limits, authorization: "CONFIRM_EACH" };
    } else if (template === "keep") {
      s = { name: `Keep ${formatDollars(max(keepAmount))}, earn the rest`, trigger: { kind: "BALANCE_ABOVE", keep: max(keepAmount) }, actions: [{ kind: "DEPOSIT_YIELD", bps: 10_000, opportunityId: opp?.id ?? "earn" }], limits, authorization: "CONFIRM_EACH" };
    } else {
      const actions: Action[] = STOCKS.filter((x) => bps(stocks[x.id] ?? "0") > 0).map((x) => ({ kind: "BUY_STOCK", bps: bps(stocks[x.id]), assetId: x.id }));
      s = { name: "Earn → Invest", trigger: { kind: "YIELD_THRESHOLD", positionId: opp?.id ?? "earn", threshold: max(threshold) }, actions, limits, authorization: "CONFIRM_EACH" };
    }
    // unattended runs are possible only for Earn deposits (the module can't do anything else)
    if (unattended && boundedAvailable() && s.actions.every((a) => a.kind !== "BUY_STOCK")) s = { ...s, authorization: "BOUNDED_MODULE" };
    const problem = ruleSpecProblem(s, now);
    if (problem) return setError(PROBLEM[problem] ?? problem);
    setSpec(s);
  }

  /** Copilot only drafts: the draft goes through the same checks, preview and signature as a template. */
  async function suggest() {
    setError("");
    setDone("");
    setAsking(true);
    try {
      const r = await askCopilot(ask.trim());
      if ("refusal" in r) return setError(r.refusal);
      // the app re-validates whatever the server returned; nothing from the model is trusted as-is
      const parsed = parseCopilotProposal(JSON.stringify({
        understood: true, name: (r.proposal as any)?.name,
        trigger: (() => { const t = (r.proposal as any)?.trigger ?? {}; return { type: t.type, min_dollars: t.minDollars, keep_dollars: t.keepDollars, threshold_dollars: t.thresholdDollars }; })(),
        split: ((r.proposal as any)?.split ?? []).map((s: any) => ({ to: s.to, percent: s.percent })),
        limits: (() => { const l = (r.proposal as any)?.limits ?? {}; return { per_run_dollars: l.perRunDollars, per_day_dollars: l.perDayDollars, per_month_dollars: l.perMonthDollars, days: l.days }; })(),
      }));
      if (!parsed.ok) return setError(parsed.reason);
      const now = await chainTime();
      const draft = proposalToRuleSpec(parsed.proposal, { nowSec: now, earnOpportunityId: opp?.id, stocksAvailable: false });
      if (!draft.ok) return setError(draft.reason);
      setAssumed(draft.assumed);
      setFromCopilot(true);
      setTemplate(null);
      setSpec(draft.spec);
    } catch (e) {
      setError(errText(e));
    } finally {
      setAsking(false);
    }
  }

  async function save() {
    if (!account || !spec) return;
    setBusy(true);
    setError("");
    try {
      const saved = await createRule(account, spec);
      if (spec.authorization === "BOUNDED_MODULE") {
        // second prompt: the on-chain permission itself, bounded to this rule's caps, vault and expiry
        const rule = ruleFromJson(saved.rule);
        const earnAction = rule.actions.find((a) => a.kind === "DEPOSIT_YIELD");
        const o = opportunities().find((x) => earnAction?.kind === "DEPOSIT_YIELD" && x.id === earnAction.opportunityId);
        if (!o) throw new PayError("EarnUnavailable");
        await authorizeRule(account, rule, o, (st) => setProgress(progressText(st, "Setting up the permission")));
      }
      setSpec(null);
      setTemplate(null);
      setFromCopilot(false);
      setDone(spec.authorization === "BOUNDED_MODULE"
        ? "Rule saved ✓ It runs by itself within your limits. You can stop it any time."
        : "Rule saved ✓ It runs when its trigger happens; you confirm each run.");
      await refresh(account);
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  }
  async function toggle(r: RuleView) {
    if (!account) return;
    setBusy(true);
    setError("");
    try {
      await setEnabled(account, ruleFromJson(r.rule), r.state === "PAUSED");
      await refresh(account);
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  }
  async function run(x: ExecutionView) {
    if (!account) return;
    setBusy(true);
    setError("");
    try {
      const v = await runExecution(account, x, (s) => setProgress(progressText(s, "Running your rule")));
      setDone(v.state === "COMPLETED" ? "Run completed ✓" : `Run finished: ${RUN_TEXT[v.state] ?? v.state}. Anything that didn't move is still in your balance.`);
      await refresh(account);
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
      setProgress("");
    }
  }

  const unavailable = spec ? spec.actions.filter((a) => a.kind !== "KEEP_BALANCE" && targetStatus(a).status !== "AVAILABLE") : [];
  const ruleName = (id: string) => rules.find((r) => String(r.rule.id).toLowerCase() === id.toLowerCase())?.rule.name ?? "Rule";

  return (
    <div className="stack">
      <div className="row">
        <Link href="/" className="brand">Everpiece</Link>
        <Link href="/" className="muted small">Done</Link>
      </div>
      <h1>Automate</h1>
      <p className="muted">Money comes in. Your rule decides what it does next, only within the limits you sign. You confirm each run with your fingerprint.</p>
      {!automateAvailable() && <div className="status warn">Automate isn&apos;t available here yet.</div>}
      {automateAvailable() && (
        <>
          {!template && !spec && copilotOn && (
            <section className="card stack" aria-label="Describe your rule">
              <strong>Describe what you want</strong>
              <textarea rows={3} maxLength={COPILOT_MAX_INPUT_CHARS} placeholder="e.g. When I get paid, keep half and put half into Earn" value={ask} onChange={(e) => setAsk(e.target.value)} />
              <button disabled={asking || ask.trim().length < 4} onClick={suggest}>{asking ? "Thinking… this can take up to a minute" : "Suggest a rule"}</button>
              <p className="muted small">An AI draft, not advice. It only proposes: you read every limit on the next screen and nothing happens unless you sign.</p>
            </section>
          )}
          {!template && !spec && (
            <section className="stack" aria-label="Templates">
              <h2>Templates</h2>
              <button className="card settings-row" onClick={() => setTemplate("split")}><span className="grow"><strong>Split my income</strong><span className="muted small">keep some, earn on some, invest the rest</span></span></button>
              <button className="card settings-row" onClick={() => setTemplate("keep")}><span className="grow"><strong>Keep $X available, earn the rest</strong><span className="muted small">the extra goes into Earn</span></span></button>
              <button className="card settings-row" onClick={() => setTemplate("earn-invest")}><span className="grow"><strong>Earn → Invest</strong><span className="muted small">earnings buy stocks; your deposit is never touched</span></span></button>
              <div className="card settings-row" aria-disabled="true"><span className="grow"><strong>Recurring investment</strong><span className="muted small">coming soon</span></span></div>
            </section>
          )}

          {template && !spec && (
            <section className="card stack" aria-label="Rule settings">
              {template === "split" && (<>
                <strong>When money arrives</strong>
                <label>Keep in my balance (%)<input inputMode="numeric" value={keepPct} onChange={(e) => setKeepPct(e.target.value)} /></label>
                <label>Put into Earn (%)<input inputMode="numeric" value={earnPct} onChange={(e) => setEarnPct(e.target.value)} /></label>
                <label>Buy NVIDIA (%)<input inputMode="numeric" value={stockPct} onChange={(e) => setStockPct(e.target.value)} /></label>
              </>)}
              {template === "keep" && (<label>Keep this much available ($)<input inputMode="decimal" value={keepAmount} onChange={(e) => setKeepAmount(e.target.value)} /></label>)}
              {template === "earn-invest" && (<>
                <label>When earnings reach ($)<input inputMode="decimal" value={threshold} onChange={(e) => setThreshold(e.target.value)} /></label>
                {STOCKS.map((s) => (
                  <label key={s.id}>{s.name} (%)<input inputMode="numeric" value={stocks[s.id]} onChange={(e) => setStocks({ ...stocks, [s.id]: e.target.value })} /></label>
                ))}
              </>)}
              <strong>Limits</strong>
              <label>At most per run ($)<input inputMode="decimal" value={perRun} onChange={(e) => setPerRun(e.target.value)} /></label>
              <label>At most per day ($)<input inputMode="decimal" value={perDay} onChange={(e) => setPerDay(e.target.value)} /></label>
              <label>At most per month ($)<input inputMode="decimal" value={perMonth} onChange={(e) => setPerMonth(e.target.value)} /></label>
              <label>Ends after (days)<input inputMode="numeric" value={days} onChange={(e) => setDays(e.target.value)} /></label>
              <button onClick={preview}>Preview</button>
              <button className="ghost" onClick={() => setTemplate(null)}>Back</button>
            </section>
          )}

          {!spec && template && boundedAvailable() && template !== "earn-invest" && (
            <label className="small">
              <input type="checkbox" checked={unattended} onChange={(e) => setUnattended(e.target.checked)} /> Run by itself within these limits (no fingerprint each time)
            </label>
          )}
          {spec && (() => {
            const d = describeRule(spec, names);
            return (
              <section className="card stack" aria-label="Rule preview">
                {fromCopilot && (
                  <div className="status warn small">
                    Draft from Copilot. Check every line before you save.
                    {assumed.length > 0 && <> Not stated in your request, so assumed: {assumed.join("; ")}.</>}
                  </div>
                )}
                <strong>{spec.name}</strong>
                <span>{d.when}:</span>
                <ul>{d.then.map((t, i) => <li key={t + i}>{t}</li>)}</ul>
                <ul className="muted small">{d.limits.map((l) => <li key={l}>{l}</li>)}</ul>
                {unavailable.length > 0 && (
                  <div className="status warn" aria-label="Unavailable now">
                    {unavailable.map((a) => <div key={JSON.stringify(a)}>{a.kind === "BUY_STOCK" ? names.asset(a.assetId) : "Earn"}: unavailable now ({targetStatus(a as Exclude<Action, { kind: "KEEP_BALANCE" }>).reason}). Its share stays in your balance; it is never moved elsewhere.</div>)}
                  </div>
                )}
                {opp?.simulated && <div className="dev">Earn on this test site has simulated yield.</div>}
                <div className="small">
                  {spec.authorization === "BOUNDED_MODULE"
                    ? "Runs by itself: Everpiece can only move money from your balance into Earn in your own name, within the limits above, until the rule expires. Nothing else is possible, and you can stop it any time."
                    : "You confirm each run with your fingerprint."}
                </div>
                <Progress text={progress} />
                <button disabled={busy} onClick={save}>Save rule with fingerprint or screen lock</button>
                <button className="ghost" onClick={() => { setSpec(null); setFromCopilot(false); }}>Change it</button>
              </section>
            );
          })()}

          {runs.some((x) => x.state === "READY") && (
            <section className="stack" aria-label="Runs waiting for you">
              <h2>Waiting for you</h2>
              {runs.filter((x) => x.state === "READY").map((x) => (
                <div key={x.executionId} className="card stack">
                  <strong>{ruleName(x.ruleId)}: {formatDollars(BigInt(x.base))}</strong>
                  <ul className="small">{x.legs.map((l) => <li key={l.index}>{legLine(l)}</li>)}</ul>
                  <button disabled={busy} onClick={() => run(x)}>Confirm with fingerprint or screen lock</button>
                </div>
              ))}
            </section>
          )}

          <section className="stack" aria-label="My rules">
            <h2>My rules</h2>
            {rules.length === 0 && <p className="muted small">No rules yet.</p>}
            {rules.map((r) => {
              const rule = ruleFromJson(r.rule);
              const d = describeRule(rule, names);
              return (
                <div key={rule.id} className="card stack" aria-label={`Rule ${rule.name}`}>
                  <div className="row"><strong>{rule.name}</strong><span className="muted small">{r.state === "WAITING_TRIGGER" ? "On" : r.state === "PAUSED" ? "Paused" : "Ended"}</span></div>
                  <span className="small">{d.when}: {d.then.join(", ")}</span>
                  <span className="muted small">{d.limits[0]}. {d.limits[1]}.</span>
                  {r.targets.filter((t) => t.status !== "AVAILABLE").map((t) => (
                    <span key={JSON.stringify(t.action)} className="small muted">⚠ {t.action.kind === "BUY_STOCK" ? names.asset(t.action.assetId) : "Earn"} unavailable now: that share stays in your balance.</span>
                  ))}
                  {r.lastExecution && <span className="small muted">Last run: {RUN_TEXT[r.lastExecution.state] ?? r.lastExecution.state}</span>}
                  {r.state !== "EXPIRED" && <button className="ghost" disabled={busy} onClick={() => toggle(r)}>{r.state === "PAUSED" ? "Resume" : "Pause"}</button>}
                </div>
              );
            })}
          </section>

          {runs.some((x) => x.state !== "READY") && (
            <section className="stack" aria-label="Past runs">
              <h2>Past runs</h2>
              {runs.filter((x) => x.state !== "READY").map((x) => (
                <div key={x.executionId} className="card stack small">
                  <div className="row"><strong>{ruleName(x.ruleId)}: {formatDollars(BigInt(x.base))}</strong><span>{RUN_TEXT[x.state] ?? x.state}</span></div>
                  <ul>{x.legs.map((l) => <li key={l.index}>{legLine(l)}</li>)}</ul>
                </div>
              ))}
            </section>
          )}
          <Progress text={progress} />
          {done && <div className="status ok">{done}</div>}
          {error && <div className="status bad">{error}</div>}
        </>
      )}
    </div>
  );
}

function legLine(l: ExecutionView["legs"][number]) {
  const what = l.action.kind === "KEEP_BALANCE" ? "Keep" : l.action.kind === "DEPOSIT_YIELD" ? "Earn" : names.asset(l.action.assetId);
  const amount = l.action.kind === "KEEP_BALANCE" ? BigInt(l.leftInBalance) : BigInt(l.amount);
  const left = BigInt(l.leftInBalance);
  const why = l.status === "UNAVAILABLE" && l.action.kind !== "KEEP_BALANCE" ? ` — ${formatDollars(left)} stays in your balance because ${l.action.kind === "BUY_STOCK" ? "no stock route meets Everpiece's price-quality rules" : "Earn is unavailable"}` : l.status === "LIMITED" || (l.status === "DONE" && left > 0n) ? ` — ${formatDollars(left)} stays in your balance (your limit)` : l.reason === "NOT_CONFIRMED" ? " — not confirmed in time; nothing moved" : "";
  return `${what}: ${formatDollars(amount)} · ${LEG_TEXT[l.status] ?? l.status}${why}`;
}

const PROBLEM: Record<string, string> = {
  ALLOCATION_NOT_100: "The percentages must add up to exactly 100%.",
  NOTHING_MOVES: "This rule would keep everything; choose something to move.",
  INVALID_LIMITS: "Limits must be above $0, with per run ≤ per day ≤ per month.",
  EXPIRY_TOO_FAR: "A rule can last at most a year.",
  INVALID_TRIGGER: "Check the amount in the trigger.",
  INVALID_ALLOCATION: "Each percentage must be between 0 and 100.",
  NO_ACTIONS: "Choose at least one thing for the money to do.",
};
