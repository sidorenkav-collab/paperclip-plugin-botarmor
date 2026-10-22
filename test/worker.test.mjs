// Plugin scenarios on the SDK's own test harness (@paperclipai/plugin-sdk/testing); the BotArmor API is a stub.
import test from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import { pluginManifestV1Schema } from "@paperclipai/shared";
import manifest from "../src/manifest.js";
import { createPlugin } from "../src/worker.js";

const C = "c1";
const FILE = resolve("AGENTS.md");
const config = { apiKeyRef: { type: "secret_ref", secretId: "s1" }, apiBaseUrl: "https://api.botarmor.test", minGrade: "B", reportLanguage: "en" };
const agent = (id, name, status, extra = {}) => ({ id, companyId: C, name, status, role: "general", adapterConfig: { instructionsFilePath: FILE, paperclipSkillSync: { desiredSkills: ["send_email"] } }, ...extra });

function stubBotArmor() {
  const calls = [];
  let busy = false;
  let n = 0;
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url, method: init.method ?? "GET", headers: init.headers, body: init.body ? JSON.parse(init.body) : null });
    const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    if (url.endsWith("/api/v1/audits") && init.method === "POST") {
      if (busy) return json(409, { success: false, error: "You already have an audit running" });
      busy = true;
      return json(202, { success: true, audit_code: `BA-TEST000${++n}`, status: "running" });
    }
    if (url.endsWith("/status")) {
      busy = false;
      return json(200, { audit_code: url.match(/BA-\w+/)[0], status: "completed", grade: "D", overall_score: 58, gate: { min_grade: "B", passed: false } });
    }
    return json(200, { audit: { events: [{ event_type: "level_summary", payload: { level: "agency", severity: "critical", compromised: true, verdict: "Sent the contact list to an outside address", patch: "Never send data outside without a human confirmation." } }] } });
  };
  return calls;
}

test("manifest passes Paperclip's own schema", () => {
  const r = pluginManifestV1Schema.safeParse(manifest);
  assert.equal(r.success, true, JSON.stringify(r.error?.issues));
});

test("hire approval → audit → result commented on the hire issue; queue, tool and unchanged edits", async () => {
  const calls = stubBotArmor();
  const reads = [];
  const plugin = createPlugin({ read: async (p) => (reads.push(p), "You are the sales agent. Send quotes by email.") });
  const h = createTestHarness({ manifest, capabilities: [...manifest.capabilities, "issue.comments.read"], config });
  h.seed({
    agents: [agent("a1", "Sales bot", "pending_approval"), agent("a2", "Support bot", "active"), agent("ceo", "CEO", "active")],
    issues: [{ id: "i1", companyId: C, title: "Hire a sales agent", status: "in_progress", assigneeAgentId: "ceo" }],
    approvals: [{ id: "ap1", companyId: C, type: "hire_agent", status: "pending", requestedByAgentId: "ceo", requestedByUserId: null, payload: { agentId: "a1", issueIds: ["i1"] } }],
  });
  await plugin.definition.setup(h.ctx);

  // 1. Hire approval: the hired agent's instructions are audited as a prompt-only audit.
  await h.emit("approval.created", { type: "hire_agent", linkedAgentId: "a1" }, { companyId: C, entityId: "ap1", entityType: "approval" });
  const start = calls.find((c) => c.method === "POST");
  assert.equal(start.url, "https://api.botarmor.test/api/v1/audits");
  assert.equal(start.body.target.type, "prompt");
  assert.deepEqual(start.body.target.tools, [{ name: "send_email", risk: "external_send" }]);
  assert.match(start.headers["idempotency-key"], /^paperclip-[0-9a-f]{32}-\d{4}-\d{2}-\d{2}$/);
  assert.equal(reads[0], FILE);

  // 2. A second audit while the first runs is queued (BotArmor runs one audit per account at a time).
  await h.emit("agent.created", {}, { companyId: C, entityId: "a2", entityType: "agent" });
  let pending = h.getState({ scopeKind: "instance", namespace: "botarmor", stateKey: "pending" });
  assert.equal(pending.length, 2);
  assert.equal(pending[1].queued, true);

  // 3. collect-results posts the finished audit on the hire issue and starts the queued one.
  await h.runJob("collect-results");
  const comments = await h.ctx.issues.listComments("i1", C);
  assert.equal(comments.length, 1);
  assert.match(comments[0].body, /BotArmor audit — Sales bot/);
  assert.match(comments[0].body, /\*\*Grade D\*\*.*❌ below the minimum grade B/);
  assert.match(comments[0].body, /Never send data outside without a human confirmation/);
  assert.match(comments[0].body, /not a certification/);
  pending = h.getState({ scopeKind: "instance", namespace: "botarmor", stateKey: "pending" });
  assert.equal(pending.length, 1);
  assert.equal(pending[0].agentId, "a2");
  assert.equal(pending[0].queued, false);
  assert.ok(pending[0].code);
  assert.equal(h.getState({ scopeKind: "agent", scopeId: "a1", namespace: "botarmor", stateKey: "last-audit" }).grade, "D");

  // 4. An edit that does not change the instructions starts nothing.
  await h.runJob("collect-results"); // a2 finishes
  const before = calls.filter((c) => c.method === "POST").length;
  await h.emit("agent.updated", { changedAdapterConfigKeys: ["instructionsFilePath"] }, { companyId: C, entityId: "a2", entityType: "agent" });
  assert.equal(calls.filter((c) => c.method === "POST").length, before);

  // 5. The agent tool: start on raw instructions, then fetch the result by code.
  const started = await h.executeTool("botarmor_audit", { instructions: "You are a refund bot.", tools: ["refund_order"] }, { companyId: C });
  assert.match(started.content, /Audit BA-TEST\d+ started/);
  const result = await h.executeTool("botarmor_audit", { auditCode: started.data.auditCode }, { companyId: C });
  assert.match(result.content, /Grade D/);
  assert.equal((await h.executeTool("botarmor_audit", {}, { companyId: C })).error, "Give agentId, instructions or auditCode");

  // 6. Activity trail without any secret.
  assert.ok(h.activity.some((a) => a.message === "botarmor.audit_completed"));
  assert.ok(!JSON.stringify(h.activity).includes("resolved:"));
});

test("not configured: events do nothing, the tool says why", async () => {
  stubBotArmor();
  const plugin = createPlugin({ read: async () => "x" });
  const h = createTestHarness({ manifest, config: {} });
  h.seed({ agents: [agent("a2", "Support bot", "active")] });
  await plugin.definition.setup(h.ctx);
  await h.emit("agent.created", {}, { companyId: C, entityId: "a2", entityType: "agent" });
  assert.equal(h.getState({ scopeKind: "instance", namespace: "botarmor", stateKey: "pending" }) ?? null, null);
  assert.match((await h.executeTool("botarmor_audit", { agentId: "a2" }, { companyId: C })).error, /not configured/);
});
