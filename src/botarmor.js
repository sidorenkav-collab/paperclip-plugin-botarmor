// BotArmor API v1 client for the Paperclip plugin. Plain functions over an injected `fetch`, so the same code runs
// with the plugin's ctx.http.fetch in Paperclip and with a stub in tests. Docs: https://app.botarmor.eu/api/v1/openapi.yaml

const RISKS = new Set(["read", "write", "destructive", "external_send", "payment"]);
export const GRADE_ORDER = ["A", "B", "C", "D", "F"];
const MAX_PROMPT = 8000;

export class BotArmorError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

// Paperclip agents describe their tools in different shapes; BotArmor wants { name, risk }. Unknown risk = "read"
// unless the name says otherwise, so a "send_email" or "delete_*" tool is never under-declared.
export function toBotArmorTools(tools = []) {
  const seen = new Set();
  const out = [];
  for (const t of tools) {
    const name = String(typeof t === "string" ? t : t?.name ?? "").trim().replace(/[^\w.:-]/g, "_").slice(0, 64);
    if (!name || seen.has(name)) continue;
    seen.add(name);
    const declared = typeof t === "object" && RISKS.has(t?.risk) ? t.risk : null;
    out.push({ name, risk: declared ?? guessRisk(name) });
  }
  return out;
}

function guessRisk(name) {
  const n = name.toLowerCase();
  if (/(pay|refund|charge|invoice|transfer|stripe)/.test(n)) return "payment";
  if (/(delete|remove|drop|purge|destroy|revoke)/.test(n)) return "destructive";
  if (/(send|email|mail|post|publish|tweet|message|notify|slack|sms|webhook)/.test(n)) return "external_send";
  if (/(write|create|update|set|edit|insert|upsert|patch|commit|push|deploy|merge|run|exec|shell|bash)/.test(n)) return "write";
  return "read";
}

// The request for a prompt-only audit. The idempotency key ties one audit to one version of the instructions per day,
// so a retried event (or two events for the same change) never pays twice.
export async function auditRequest({ name, instructions, tools = [], lang = "en", minGrade = "B", callbackUrl = null }) {
  const text = String(instructions ?? "").trim();
  if (!text) throw new BotArmorError("The agent has no instructions to audit", 400);
  const system_prompt = text.length > MAX_PROMPT ? text.slice(0, MAX_PROMPT) : text;
  const digest = await sha256Hex(system_prompt + JSON.stringify(tools));
  return {
    body: {
      target: { type: "prompt", name: String(name || "Paperclip agent").slice(0, 120), tools: toBotArmorTools(tools) },
      system_prompt,
      lang,
      min_grade: minGrade,
      ...(callbackUrl ? { callback_url: callbackUrl } : {}),
    },
    idempotencyKey: `paperclip-${digest.slice(0, 32)}-${new Date().toISOString().slice(0, 10)}`,
    truncated: text.length > MAX_PROMPT,
  };
}

async function sha256Hex(s) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function call(fetchFn, baseUrl, apiKey, path, { method = "GET", body, headers = {} } = {}) {
  const res = await fetchFn(`${baseUrl.replace(/\/+$/, "")}/api/v1${path}`, {
    method,
    headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json", "user-agent": "paperclip-plugin-botarmor", ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => null);
  if (!res.ok) {
    const retry = res.headers?.get?.("retry-after");
    throw new BotArmorError(`${json?.error || `HTTP ${res.status}`}${retry ? ` (retry after ${retry}s)` : ""}`, res.status);
  }
  return json;
}

export async function startAudit({ fetchFn, baseUrl, apiKey, request }) {
  return call(fetchFn, baseUrl, apiKey, "/audits", { method: "POST", body: request.body, headers: { "idempotency-key": request.idempotencyKey } });
}

export async function auditStatus({ fetchFn, baseUrl, apiKey, code }) {
  return call(fetchFn, baseUrl, apiKey, `/audits/${encodeURIComponent(code)}/status`);
}

// Failing and disputed levels with their verdict and the patch to paste into the instructions.
export async function auditFindings({ fetchFn, baseUrl, apiKey, code }) {
  const json = await call(fetchFn, baseUrl, apiKey, `/audits/${encodeURIComponent(code)}`);
  return (json?.audit?.events ?? [])
    .filter((e) => e.event_type === "level_summary")
    .map((e) => e.payload)
    .map((p) => ({ level: p.level, severity: p.severity, broken: Boolean(p.compromised), toReview: Boolean(p.to_review), verdict: p.verdict ?? "", patch: p.patch ?? "" }));
}

const SEV_ICON = { critical: "🔴", high: "🟠", medium: "🟡", low: "🟢", none: "🟢" };

// Markdown for an issue comment. Honest about what a prompt-only audit is.
export function formatComment({ agentName, status, findings = [], baseUrl, reason }) {
  const base = baseUrl.replace(/\/+$/, "");
  const failed = findings.filter((f) => f.severity === "critical" || f.severity === "high");
  const review = findings.filter((f) => f.toReview && !failed.includes(f));
  const gate = status.gate?.passed === true ? "✅ meets" : status.gate?.passed === false ? "❌ below" : "—";
  const lines = [
    `### BotArmor audit — ${agentName}`,
    reason ? `_Trigger: ${reason}_` : null,
    "",
    status.status === "failed"
      ? `The audit could not finish: ${status.error || "unknown error"}. No credit is used for a failed audit.`
      : `**Grade ${status.grade ?? "?"}** (score ${status.overall_score ?? "?"}/100) — ${gate} the minimum grade ${status.gate?.min_grade ?? "B"}.`,
  ];
  if (failed.length) {
    lines.push("", `**${failed.length} failed level(s):**`);
    for (const f of failed) {
      lines.push(`- ${SEV_ICON[f.severity] ?? ""} **${f.level}** (${f.severity}): ${oneLine(f.verdict, 300)}`);
      if (f.patch) lines.push(`  <details><summary>Patch to add to the instructions</summary>\n\n  ${oneLine(f.patch, 1200)}\n\n  </details>`);
    }
  }
  if (review.length) lines.push("", `To review by a human: ${review.map((f) => f.level).join(", ")}.`);
  lines.push(
    "",
    `Report: ${base}/verify/${status.audit_code} · full report (owner): ${base}/api/v1/audits/${status.audit_code}/report`,
    "",
    "_Prompt-only audit: BotArmor's simulated bot played these instructions. An estimate, not a test of the live agent and not a certification. The decision stays with the board._",
  );
  return lines.filter((l) => l !== null).join("\n");
}

const oneLine = (s, max) => String(s ?? "").replace(/\s+/g, " ").trim().slice(0, max);

export function meetsGrade(grade, minGrade) {
  return grade != null && GRADE_ORDER.indexOf(grade) <= GRADE_ORDER.indexOf(minGrade);
}
