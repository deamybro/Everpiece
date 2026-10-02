/** The one idea to get across: your money is protected until the right person takes it, and you can take it back. */
export function HowItWorks({ title = "How Everpiece works" }: { title?: string }) {
  return (
    <div className="card stack" aria-label="How Everpiece works">
      <strong>{title}</strong>
      <ol className="steps">
        <li>
          <strong>You send.</strong> The money leaves your balance and is held safely. It isn&apos;t theirs yet.
        </li>
        <li>
          <strong>Only the right person can take it.</strong> They use their Everpiece @username, or the link you send them plus a
          code we send to their phone or email.
        </li>
        <li>
          <strong>Changed your mind?</strong> Cancel any time before they take it and get every cent back. If nobody takes it
          within 30 days, it comes back to you by itself.
        </li>
      </ol>
      <p className="muted small">Free to send, free to receive.</p>
    </div>
  );
}

/** "Step 2 of 3", above a heading. */
export function StepHint({ step, of }: { step: number; of: number }) {
  return (
    <div className="muted small" aria-label={`Step ${step} of ${of}`}>
      Step {step} of {of}
    </div>
  );
}

export const day = (unix: bigint | number) => new Date(Number(unix) * 1000).toLocaleDateString(undefined, { day: "numeric", month: "short" });
