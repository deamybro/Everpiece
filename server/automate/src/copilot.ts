import { COPILOT_MAX_INPUT_CHARS, COPILOT_SYSTEM_PROMPT, parseCopilotProposal } from "@everpiece/shared";
import type { Result } from "./service.ts";

/**
 * Copilot gateway: one sentence in, one PROPOSAL out (docs/AUTOMATE.md). It calls a small local model (Ollama) and
 * returns only what `parseCopilotProposal` accepts. It holds no keys and cannot create, sign or run a rule; the app turns
 * the proposal into a draft the owner reads and signs. Built for a shared, small server: one request at a time, a hard
 * timeout, the model unloaded after use, and a per-IP rate limit.
 */
export type CopilotConfig = { url: string; model: string; timeoutMs: number; perIpPerMinute: number };

export function copilotConfigFromEnv(env: NodeJS.ProcessEnv): CopilotConfig | null {
  if (!env.COPILOT_URL) return null;
  return { url: env.COPILOT_URL.replace(/\/$/, ""), model: env.COPILOT_MODEL || "qwen2.5:3b", timeoutMs: Number(env.COPILOT_TIMEOUT_MS || 60_000), perIpPerMinute: Number(env.COPILOT_PER_IP_PER_MINUTE || 4) };
}

export class Copilot {
  private busy = false;
  private hits = new Map<string, number[]>();
  readonly cfg: CopilotConfig;
  private readonly fetchImpl: typeof fetch;
  constructor(cfg: CopilotConfig, fetchImpl: typeof fetch = fetch) {
    this.cfg = cfg;
    this.fetchImpl = fetchImpl;
  }

  private limited(ip: string): boolean {
    const now = Date.now();
    const recent = (this.hits.get(ip) ?? []).filter((t) => now - t < 60_000);
    recent.push(now);
    this.hits.set(ip, recent);
    if (this.hits.size > 5_000) this.hits.clear();
    return recent.length > this.cfg.perIpPerMinute;
  }

  async propose(body: unknown, ip: string): Promise<Result> {
    const text = (body as { text?: unknown } | null)?.text;
    if (typeof text !== "string" || text.trim().length < 4 || text.length > COPILOT_MAX_INPUT_CHARS || /[\u0000-\u0008\u000b-\u001f]/.test(text)) {
      return { httpStatus: 400, body: { error: "InvalidText" } };
    }
    if (this.limited(ip)) return { httpStatus: 429, body: { error: "RATE_LIMITED" } };
    if (this.busy) return { httpStatus: 429, body: { error: "COPILOT_BUSY" } };
    this.busy = true;
    try {
      const res = await this.fetchImpl(`${this.cfg.url}/api/chat`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        signal: AbortSignal.timeout(this.cfg.timeoutMs),
        body: JSON.stringify({
          model: this.cfg.model, stream: false, format: "json", keep_alive: "20s",
          options: { temperature: 0, num_predict: 350, num_ctx: 2048 },
          messages: [{ role: "system", content: COPILOT_SYSTEM_PROMPT }, { role: "user", content: text.trim() }],
        }),
      });
      if (!res.ok) return { httpStatus: 502, body: { error: "COPILOT_UNAVAILABLE" } };
      const out = (await res.json()) as { message?: { content?: unknown } };
      const r = parseCopilotProposal(typeof out.message?.content === "string" ? out.message.content : "");
      return { httpStatus: 200, body: r.ok ? { proposal: r.proposal } : { refusal: r.reason } };
    } catch {
      return { httpStatus: 502, body: { error: "COPILOT_UNAVAILABLE" } };
    } finally {
      this.busy = false;
    }
  }
}
