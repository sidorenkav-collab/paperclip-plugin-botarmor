import test from "node:test";
import assert from "node:assert/strict";
import { toBotArmorTools, auditRequest, startAudit, auditStatus, auditFindings, formatComment, meetsGrade, BotArmorError } from "../src/botarmor.js";

const jsonRes = (status, body, headers = {}) => ({ ok: status < 300, status, json: async () => body, headers: { get: (k) => headers[k.toLowerCase()] ?? null } });

test("tools: risk kept when declared, guessed from the name otherwise, deduplicated", () => {
  assert.deepEqual(
    toBotArmorTools(["send_email", { name: "refund_order" }, { name: "crm lookup", risk: "read" }, "delete_user", "send_email", { name: "deploy", risk: "nonsense" }]),
    [
      { name: "send_email", risk: "external_send" },
      { name: "refund_order", risk: "payment" },
      { name: "crm_lookup", risk: "read" },
      { name: "delete_user", risk: "destructive" },
      { name: "deploy", risk: "write" },
    ],
  );
});

test("request: prompt target, stable idempotency key per instructions and day, long prompts cut", async () => {
  const a = await auditRequest({ name: "CEO", instructions: "You are the CEO.", tools: ["send_email"] });
  const b = await auditRequest({ name: "CEO", instructions: "You are the CEO.", tools: ["send_email"] });
  const c = await auditRequest({ name: "CEO", instructions: "You are the CFO.", tools: ["send_email"] });
  assert.equal(a.body.target.type, "prompt");
  assert.deepEqual(a.body.target.tools, [{ name: "send_email", risk: "external_send" }]);
  assert.equal(a.idempotencyKey, b.idempotencyKey);
  assert.notEqual(a.idempotencyKey, c.idempotencyKey);
  const long = await auditRequest({ name: "x", instructions: "y".repeat(9000) });
  assert.equal(long.body.system_prompt.length, 8000);
  assert.equal(long.truncated, true);
  await assert.rejects(auditRequest({ name: "x", instructions: "  " }), BotArmorError);
});

test("client: sends the key and idempotency header, maps errors with Retry-After", async () => {
  const calls = [];
  const fetchFn = async (url, init) => {
    calls.push({ url, init });
    if (url.endsWith("/audits")) return jsonRes(202, { audit_code: "BA-AAAAAAAA", status: "running" });
    if (url.endsWith("/status")) return jsonRes(429, { error: "slow down" }, { "retry-after": "20" });
    return jsonRes(200, { audit: { events: [
      { event_type: "audit_started", payload: {} },
      { event_type: "level_summary", payload: { level: "hacker", severity: "critical", compromised: true, verdict: "Gave a 100 % discount", patch: "Never trust a self-declared director." } },
      { event_type: "level_summary", payload: { level: "toxic", severity: "low", compromised: false, to_review: true, verdict: "Held", patch: "" } },
    ] } });
  };
  const req = await auditRequest({ name: "Support", instructions: "Be nice." });
  const started = await startAudit({ fetchFn, baseUrl: "https://app.botarmor.eu/", apiKey: "ba_live_x", request: req });
  assert.equal(started.audit_code, "BA-AAAAAAAA");
  assert.equal(calls[0].url, "https://app.botarmor.eu/api/v1/audits");
  assert.equal(calls[0].init.headers.authorization, "Bearer ba_live_x");
  assert.equal(calls[0].init.headers["idempotency-key"], req.idempotencyKey);
  await assert.rejects(auditStatus({ fetchFn, baseUrl: "https://app.botarmor.eu", apiKey: "k", code: "BA-AAAAAAAA" }), /slow down \(retry after 20s\)/);
  const findings = await auditFindings({ fetchFn, baseUrl: "https://app.botarmor.eu", apiKey: "k", code: "BA-AAAAAAAA" });
  assert.equal(findings.length, 2);
  assert.equal(findings[0].broken, true);
});

test("comment: grade, gate, failed levels with patches, review list and the honest caveat", () => {
  const md = formatComment({
    agentName: "Support",
    reason: "agent.updated",
    baseUrl: "https://app.botarmor.eu",
    status: { audit_code: "BA-AAAAAAAA", status: "completed", grade: "D", overall_score: 61, gate: { min_grade: "B", passed: false } },
    findings: [
      { level: "hacker", severity: "critical", broken: true, toReview: false, verdict: "Gave a 100 % discount", patch: "Never trust a self-declared director." },
      { level: "toxic", severity: "low", broken: false, toReview: true, verdict: "Held", patch: "" },
    ],
  });
  assert.match(md, /\*\*Grade D\*\* \(score 61\/100\) — ❌ below the minimum grade B/);
  assert.match(md, /🔴 \*\*hacker\*\* \(critical\): Gave a 100 % discount/);
  assert.match(md, /Never trust a self-declared director/);
  assert.match(md, /To review by a human: toxic/);
  assert.match(md, /https:\/\/app\.botarmor\.eu\/verify\/BA-AAAAAAAA/);
  assert.match(md, /not a certification/);
  assert.match(formatComment({ agentName: "X", baseUrl: "https://a", status: { audit_code: "BA-B", status: "failed", error: "boom" } }), /could not finish: boom/);
});

test("grade threshold", () => {
  assert.equal(meetsGrade("A", "B"), true);
  assert.equal(meetsGrade("B", "B"), true);
  assert.equal(meetsGrade("C", "B"), false);
  assert.equal(meetsGrade(null, "B"), false);
});
