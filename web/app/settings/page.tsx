"use client";

import { useEffect, useState } from "react";
import { PageHeader, ProfileSection } from "../../components/DashboardUI";

export default function SettingsPage() {
  const [hidden, setHidden] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => { try { setHidden(localStorage.getItem("everpiece.hideBalance.v1") === "1"); } catch {} }, []);
  function toggle() {
    try { localStorage.setItem("everpiece.hideBalance.v1", hidden ? "0" : "1"); setHidden(!hidden); setError(""); }
    catch { setError("This browser couldn’t save your preference."); }
  }
  return <div className="stack settings-page"><PageHeader title="Settings" description="Make Everpiece feel like home." /><ProfileSection title="Display"><div className="detail-row"><div><strong>Hide balances</strong><p className="muted small">Keep amounts private on your Home screen.</p></div><button className="preference-toggle" role="switch" aria-label="Hide balances" aria-checked={hidden} onClick={toggle}><span /></button></div><p className="muted small" role="status">{error}</p><div className="detail-row"><span>Appearance</span><strong>Light</strong></div></ProfileSection><ProfileSection title="Notifications"><p className="muted small">Notification preferences are not available here. Your payments are available on the Activity screen.</p></ProfileSection></div>;
}
