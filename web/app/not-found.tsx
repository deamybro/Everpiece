import Link from "next/link";

// Our own 404: Next's built-in one uses inline styles, which the CSP (style-src with a nonce) blocks.
export default function NotFound() {
  return (
    <div className="stack">
      <div className="row">
        <Link href="/" className="brand">Everpiece</Link>
      </div>
      <h1>Page not found</h1>
      <p className="muted">This link isn&apos;t right. If someone sent it to you, ask them to send it again.</p>
      <Link className="button" href="/">Back to Everpiece</Link>
    </div>
  );
}
