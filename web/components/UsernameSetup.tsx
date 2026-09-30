"use client";

import { useEffect, useState } from "react";
import { cleanDisplayName, normalizeUsername, usernameProblem } from "@everpiece/shared";
import { friendlyError } from "../lib/api";
import { friendlyPasskeyError, type Account } from "../lib/mera";
import { UsernameError, checkAvailable, registerUsername } from "../lib/username";

/** Lets people receive money by @username. One fingerprint prompt; the username can't be changed later in V1. */
export function UsernameSetup({ account, onDone }: { account: Account; onDone: (a: Account) => void }) {
  const [input, setInput] = useState("");
  const [displayName, setDisplayName] = useState(account.name);
  // undefined = not checked yet, null = available, string = why not
  const [taken, setTaken] = useState<string | null | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const username = normalizeUsername(input);
  const problem = username ? usernameProblem(username) : input.trim() ? "Invalid" : null;
  const name = cleanDisplayName(displayName);

  useEffect(() => {
    setTaken(undefined);
    if (!username || problem) return;
    const t = setTimeout(() => checkAvailable(username).then(setTaken).catch(() => setTaken(undefined)), 400);
    return () => clearTimeout(t);
  }, [username, problem]);

  async function save() {
    if (!username || !name) return;
    setBusy(true);
    setError("");
    try {
      onDone(await registerUsername(account, username, name));
    } catch (e) {
      setError(e instanceof UsernameError ? friendlyError(e.code) : friendlyPasskeyError(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card stack">
      <strong>Get paid by username</strong>
      <p className="muted small">Pick a username so people can send you money without a link or code.</p>
      <div>
        <label htmlFor="username">Username</label>
        <input id="username" autoCapitalize="none" autoCorrect="off" spellCheck={false} placeholder="e.g. mama_ngozi" value={input} onChange={(e) => setInput(e.target.value)} />
      </div>
      {problem === "Invalid" && <p className="muted small">3–20 lowercase letters, numbers or _, starting with a letter.</p>}
      {problem === "Reserved" && <p className="muted small">That username isn&apos;t available.</p>}
      {!problem && taken === null && <p className="muted small">@{username} is available ✓</p>}
      {!problem && typeof taken === "string" && <p className="muted small">{friendlyError(taken)}</p>}
      <div>
        <label htmlFor="displayName">Name people will see</label>
        <input id="displayName" autoComplete="name" value={displayName} onChange={(e) => setDisplayName(e.target.value)} />
      </div>
      <button disabled={busy || !username || problem !== null || taken !== null || !name} onClick={save}>
        Save @{username ?? "username"} with fingerprint
      </button>
      <p className="muted small">Your username can&apos;t be changed later.</p>
      {error && <div className="status bad">{error}</div>}
    </div>
  );
}
