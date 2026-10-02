"use client";

import { useEffect, useRef, useState } from "react";
import { MAX_ENVELOPE_BYTES, MAX_NOTE_CHARS, MAX_VOICE_MS, audioTypeOf, type AudioType } from "@everpiece/shared";
import { seconds } from "../lib/message";

export type Recording = { bytes: Uint8Array; type: AudioType; durationMs: number; url: string };
export type Draft = { note: string; voice: Recording | null };

/** Formats differ by browser (Chrome/Android: webm/opus; Safari: mp4/aac), so pick one at runtime (master §24.1). */
const CANDIDATES = ["audio/webm;codecs=opus", "audio/mp4", "audio/ogg;codecs=opus", "audio/webm"];
function recordingFormat(): string | null {
  if (typeof window === "undefined" || typeof MediaRecorder === "undefined" || !navigator.mediaDevices?.getUserMedia) return null;
  return CANDIDATES.find((m) => MediaRecorder.isTypeSupported(m) && audioTypeOf(m)) ?? null;
}

/** Optional message for a link payment: a written note and/or a voice note of up to 30 seconds. */
export function MessageComposer({ value, onChange, disabled, audience }: { value: Draft; onChange: (d: Draft) => void; disabled?: boolean; audience: string }) {
  const [format, setFormat] = useState<string | null>(null);
  const [recording, setRecording] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [problem, setProblem] = useState("");
  const rec = useRef<{ recorder: MediaRecorder; stream: MediaStream; started: number; timer: number; tick: number } | null>(null);
  const latest = useRef(value);
  latest.current = value;

  useEffect(() => setFormat(recordingFormat()), []);
  // Stop the microphone if the page goes away mid-recording.
  useEffect(() => () => {
    if (rec.current) {
      clearTimeout(rec.current.timer);
      clearInterval(rec.current.tick);
      rec.current.stream.getTracks().forEach((t) => t.stop());
    }
  }, []);

  async function start() {
    if (!format) return;
    setProblem("");
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      setProblem("Microphone access was blocked. You can still write a note.");
      return;
    }
    const recorder = new MediaRecorder(stream, { mimeType: format, audioBitsPerSecond: 32_000 });
    const chunks: Blob[] = [];
    recorder.ondataavailable = (e) => e.data.size > 0 && chunks.push(e.data);
    recorder.onstop = async () => {
      const r = rec.current;
      rec.current = null;
      stream.getTracks().forEach((t) => t.stop());
      setRecording(false);
      if (!r) return;
      clearTimeout(r.timer);
      clearInterval(r.tick);
      const type = audioTypeOf(recorder.mimeType || format);
      const blob = new Blob(chunks, { type: recorder.mimeType || format });
      const durationMs = Math.max(1, Math.min(MAX_VOICE_MS, Math.round(performance.now() - r.started)));
      if (!type || blob.size === 0) return setProblem("That recording didn't work. Please try again.");
      if (blob.size > MAX_ENVELOPE_BYTES - 4096) return setProblem("That recording is too large. Please record a shorter one.");
      if (latest.current.voice) URL.revokeObjectURL(latest.current.voice.url);
      onChange({ ...latest.current, voice: { bytes: new Uint8Array(await blob.arrayBuffer()), type, durationMs, url: URL.createObjectURL(blob) } });
    };
    const started = performance.now();
    rec.current = {
      recorder, stream, started,
      timer: window.setTimeout(() => recorder.state === "recording" && recorder.stop(), MAX_VOICE_MS),
      tick: window.setInterval(() => setElapsed(performance.now() - started), 250),
    };
    setElapsed(0);
    setRecording(true);
    recorder.start(1000);
  }

  function stop() {
    if (rec.current?.recorder.state === "recording") rec.current.recorder.stop();
  }

  function removeVoice() {
    if (value.voice) URL.revokeObjectURL(value.voice.url);
    onChange({ ...value, voice: null });
  }

  return (
    <div className="card stack">
      <div>
        <strong>Add a message</strong> <span className="muted small">(optional)</span>
      </div>
      <div>
        <label htmlFor="note">Written note</label>
        <input
          id="note" maxLength={MAX_NOTE_CHARS} placeholder="For October ❤️" value={value.note} disabled={disabled}
          onChange={(e) => onChange({ ...value, note: e.target.value })}
        />
      </div>
      {format && !value.voice && !recording && (
        <button className="secondary" disabled={disabled} onClick={start}>Record a voice note (up to 30 seconds)</button>
      )}
      {recording && (
        <>
          <div className="status" aria-live="polite">Recording… {seconds(elapsed)} / 0:30</div>
          <button onClick={stop}>Stop recording</button>
        </>
      )}
      {value.voice && !recording && (
        <div className="stack">
          <div className="muted small">Voice note, {seconds(value.voice.durationMs)}</div>
          <audio controls src={value.voice.url} aria-label="Your voice note" />
          <div className="row" role="group">
            <button className="secondary" disabled={disabled} onClick={() => { removeVoice(); start(); }}>Record again</button>
            <button className="ghost" disabled={disabled} onClick={removeVoice}>Remove</button>
          </div>
        </div>
      )}
      {problem && <div className="status warn">{problem}</div>}
      <p className="muted small">
        Voice notes are encrypted on this phone. {audience} Everpiece stores the encrypted message, never the recording or
        its key.
      </p>
    </div>
  );
}
