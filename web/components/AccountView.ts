"use client";

import { useEffect, useState } from "react";
import { loadAccount, type Account } from "../lib/mera";
import { syncUsername } from "../lib/username";

/** Presentation subscriber only. Account creation, storage and signing remain in mera.ts. */
export function useAccountView() {
  const [account, setAccount] = useState<Account | null>(null);
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    let live = true;
    const read = () => {
      const a = loadAccount();
      setAccount(a);
      setLoaded(true);
      if (a && !a.username) void syncUsername(a).then((next) => {
        const latest = loadAccount();
        if (live && latest?.address === a.address) setAccount(latest.username ? latest : next);
      }).catch(() => {});
    };
    read();
    window.addEventListener("storage", read);
    window.addEventListener("focus", read);
    window.addEventListener("everpiece:account-view", read);
    return () => {
      live = false;
      window.removeEventListener("storage", read);
      window.removeEventListener("focus", read);
      window.removeEventListener("everpiece:account-view", read);
    };
  }, []);
  const onReady = (a: Account) => {
    setAccount(a);
    window.dispatchEvent(new Event("everpiece:account-view"));
  };
  return { account, loaded, onReady };
}
