// BotArmor Gate: audits Paperclip agents' instructions with BotArmor and reports to the board. It informs and never
// blocks: Paperclip gives plugins no veto, and the hire decision stays with a human.
//
// Triggers (Paperclip 2026.1012.0):
//   approval.created (type hire_agent) — the agent being hired; result commented on the issue that asked for the hire
//   agent.created — an agent created directly, without approval
//   agent.updated — its instructions path, template or skills changed
//   job weekly-recheck — instruction file edits fire no event, so a weekly fingerprint check catches them
//   tool botarmor_audit — agents can audit an agent or raw instructions themselves
// An audit takes 5-15 minutes while host calls time out after 30 s: events only start audits, and the job
// collect-results (every 5 minutes) posts each result when it is ready.
import { readFile } from "node:fs/promises";
import { definePlugin, runWorker } from "@paperclipai/plugin-sdk";
import { auditRequest, startAudit, auditStatus, auditFindings, formatComment, BotArmorError } from "./botarmor.js";
import { agentInstructions, fingerprint } from "./instructions.js";

const NS = "botarmor";
const PENDING = { scopeKind: "instance", namespace: NS, stateKey: "pending" };
const lastAuditKey = (agentId) => ({ scopeKind: "agent", scopeId: agentId, namespace: NS, stateKey: "last-audit" });
const INSTRUCTION_KEYS = ["instructionsFilePath", "instructionsRootPath", "instructionsEntryFile", "instructionsBundleMode", "promptTemplate", "bootstrapPromptTemplate", "paperclipSkillSync"];
const GIVE_UP_MS = 2 * 3600 * 1000;

export function createPlugin({ read = readFile, now = () => Date.now() } = {}) {
  let ctx;

  async function settings(companyId) {
    const cfg = await ctx.config.get(companyId);
    if (!cfg?.apiKeyRef) throw new BotArmorError("BotArmor Gate is not configured for this company (API key missing)", 412);
    return {
      baseUrl: String(cfg.apiBaseUrl || "https://app.botarmor.eu"),
      apiKey: await ctx.secrets.resolve(cfg.apiKeyRef, { companyId, configPath: "apiKeyRef" }),
      minGrade: cfg.minGrade || "B",
      lang: cfg.reportLanguage || "en",
      auditOnHire: cfg.auditOnHire !== false,
      auditOnNewAgent: cfg.auditOnNewAgent !== false,
      weeklyRecheck: cfg.weeklyRecheck !== false,
      reportIssueId: cfg.reportIssueId || null,
    };
  }

  const fetchFn = (url, init) => ctx.http.fetch(url, init);
  const api = (s) => ({ fetchFn, baseUrl: s.baseUrl, apiKey: s.apiKey });

  async function pending() {
    return (await ctx.state.get(PENDING)) ?? [];
  }
  async function savePending(list) {
    await ctx.state.set(PENDING, list);
  }

  // Starts an audit of one agent, or queues it when BotArmor is busy with another audit of the account (HTTP 409).
  async function auditAgent({ companyId, agent, reason, issueId, force = false }) {
    const s = await settings(companyId);
    const instr = await agentInstructions(agent, { read });
    if (!instr.text) {
      await note(companyId, issueId, `### BotArmor audit — ${agent.name}\n\nNo instructions could be read for this agent (no instructions file or prompt template on this host), so nothing was audited.`, agent.id, "botarmor.audit_skipped");
      return { skipped: "no instructions" };
    }
    const fp = await fingerprint(instr);
    const last = await ctx.state.get(lastAuditKey(agent.id));
    if (!force && last?.fingerprint === fp && last.status !== "failed") return { skipped: "unchanged", auditCode: last.code };

    const list = await pending();
    if (list.some((p) => p.agentId === agent.id && p.fingerprint === fp)) return { skipped: "already pending" };
    const entry = { companyId, agentId: agent.id, agentName: agent.name, issueId: issueId ?? s.reportIssueId, reason, fingerprint: fp, at: now() };
    try {
      const req = await auditRequest({ name: agent.name, instructions: instr.text, tools: instr.skills, lang: s.lang, minGrade: s.minGrade });
      const started = await startAudit({ ...api(s), request: req });
      entry.code = started.audit_code;
    } catch (err) {
      if (err.status !== 409) throw err;
      entry.queued = true; // started by collect-results once the running audit ends
    }
    await savePending([...list, entry]);
    await ctx.state.set(lastAuditKey(agent.id), { code: entry.code ?? null, fingerprint: fp, status: entry.queued ? "queued" : "running", at: entry.at });
    await ctx.activity.log({ companyId, message: entry.queued ? "botarmor.audit_queued" : "botarmor.audit_started", entityType: "agent", entityId: agent.id, metadata: { auditCode: entry.code ?? null, reason } });
    return { auditCode: entry.code ?? null, queued: Boolean(entry.queued) };
  }

  async function note(companyId, issueId, body, agentId, action) {
    if (issueId) {
      try {
        await ctx.issues.createComment(issueId, body, companyId);
      } catch (err) {
        ctx.logger.warn("Could not comment on the issue", { issueId, error: err.message });
      }
    }
    await ctx.activity.log({ companyId, message: action, entityType: "agent", entityId: agentId, metadata: { issueId: issueId ?? null } });
  }

  // The issue that asked for a hire: Paperclip links approvals to issues but gives plugins no direct lookup, so the
  // requesting agent's issues are checked for one carrying this approval.
  async function issueForApproval(companyId, approval) {
    const ids = approval.payload?.issueIds;
    if (Array.isArray(ids) && ids.length) return ids[0];
    // A hire made by an agent: its own issues; a hire made by the board: the company's most recent issues.
    const issues = await ctx.issues.list(approval.requestedByAgentId ? { companyId, assigneeAgentId: approval.requestedByAgentId, limit: 50 } : { companyId, limit: 50 });
    for (const issue of issues) {
      const summary = await ctx.issues.summaries.getOrchestration({ issueId: issue.id, companyId }).catch(() => null);
      if (summary?.approvals?.some((a) => a.id === approval.id)) return issue.id;
    }
    return null;
  }

  // One pass over started and queued audits: posts finished results, starts the next queued one, drops stale ones.
  async function collectResults() {
    const list = await pending();
    const keep = [];
    let startedOne = false;
    for (const p of list) {
      try {
        const s = await settings(p.companyId);
        if (p.queued) {
          if (startedOne) { keep.push(p); continue; }
          const agent = await ctx.agents.get(p.agentId, p.companyId);
          if (!agent) continue;
          const instr = await agentInstructions(agent, { read });
          const req = await auditRequest({ name: agent.name, instructions: instr.text, tools: instr.skills, lang: s.lang, minGrade: s.minGrade });
          try {
            const started = await startAudit({ ...api(s), request: req });
            keep.push({ ...p, queued: false, code: started.audit_code, at: now() });
            startedOne = true;
            await ctx.state.set(lastAuditKey(p.agentId), { code: started.audit_code, fingerprint: p.fingerprint, status: "running", at: now() });
          } catch (err) {
            if (err.status !== 409) throw err;
            keep.push(p);
            startedOne = true; // the account is busy: try the queue again next run
          }
          continue;
        }
        const status = await auditStatus({ ...api(s), code: p.code });
        if (status.status === "running") {
          if (now() - p.at < GIVE_UP_MS) keep.push(p);
          continue;
        }
        const findings = status.status === "completed" ? await auditFindings({ ...api(s), code: p.code }) : [];
        const body = formatComment({ agentName: p.agentName, status, findings, baseUrl: s.baseUrl, reason: p.reason });
        await note(p.companyId, p.issueId, body, p.agentId, status.status === "completed" ? "botarmor.audit_completed" : "botarmor.audit_failed");
        await ctx.state.set(lastAuditKey(p.agentId), { code: p.code, fingerprint: p.fingerprint, status: status.status, grade: status.grade ?? null, passed: status.gate?.passed ?? null, at: now() });
      } catch (err) {
        ctx.logger.error("BotArmor result collection failed", { auditCode: p.code ?? null, agentId: p.agentId, error: err.message });
        if (now() - p.at < GIVE_UP_MS) keep.push(p);
      }
    }
    await savePending(keep);
  }

  async function weeklyRecheck() {
    const companies = await ctx.companies.list();
    for (const company of companies) {
      try {
        const s = await settings(company.id);
        if (!s.weeklyRecheck) continue;
        const agents = await ctx.agents.list({ companyId: company.id, limit: 200 });
        for (const agent of agents) {
          if (["terminated", "pending_approval"].includes(agent.status)) continue;
          await auditAgent({ companyId: company.id, agent, reason: "weekly re-check (instructions changed since the last audit)" });
        }
      } catch (err) {
        if (err.status !== 412) ctx.logger.warn("Weekly re-check skipped a company", { companyId: company.id, error: err.message });
      }
    }
  }

  return definePlugin({
    multiCompanyConfig: true,

    async setup(c) {
      ctx = c;

      ctx.events.on("approval.created", async (event) => {
        const companyId = event.companyId;
        const s = await settings(companyId).catch(() => null);
        if (!s?.auditOnHire) return;
        const approval = await ctx.approvals.get(event.entityId, companyId);
        if (approval?.type !== "hire_agent") return;
        const agentId = approval.payload?.agentId ?? event.payload?.linkedAgentId;
        const agent = agentId ? await ctx.agents.get(agentId, companyId) : null;
        if (!agent) return;
        const issueId = await issueForApproval(companyId, approval);
        await auditAgent({ companyId, agent, reason: "hire approval", issueId, force: true });
      });

      ctx.events.on("agent.created", async (event) => {
        const companyId = event.companyId;
        const s = await settings(companyId).catch(() => null);
        if (!s?.auditOnNewAgent) return;
        const agent = await ctx.agents.get(event.entityId, companyId);
        if (!agent || agent.status === "pending_approval") return; // the hire approval audits it
        await auditAgent({ companyId, agent, reason: "new agent" });
      });

      ctx.events.on("agent.updated", async (event) => {
        const changed = [...(event.payload?.changedAdapterConfigKeys ?? []), ...(event.payload?.changedTopLevelKeys ?? [])];
        if (!changed.some((k) => INSTRUCTION_KEYS.includes(k))) return;
        const companyId = event.companyId;
        const s = await settings(companyId).catch(() => null);
        if (!s) return;
        const agent = await ctx.agents.get(event.entityId, companyId);
        if (agent) await auditAgent({ companyId, agent, reason: "instructions or skills changed" });
      });

      ctx.jobs.register("collect-results", collectResults);
      ctx.jobs.register("weekly-recheck", weeklyRecheck);

      ctx.tools.register(
        "botarmor_audit",
        {
          displayName: "BotArmor audit",
          description: "Start a BotArmor audit of an agent (agentId) or of instructions text; call again with auditCode for the result.",
          parametersSchema: { type: "object" },
        },
        async (params = {}, runCtx) => {
          const companyId = runCtx.companyId;
          try {
            const s = await settings(companyId);
            if (params.auditCode) {
              const status = await auditStatus({ ...api(s), code: params.auditCode });
              if (status.status === "running") return { content: `Audit ${params.auditCode} is still running (audits take 5-15 minutes). Call again later.`, data: status };
              const findings = status.status === "completed" ? await auditFindings({ ...api(s), code: params.auditCode }) : [];
              return { content: formatComment({ agentName: status.audit_code, status, findings, baseUrl: s.baseUrl }), data: { ...status, findings } };
            }
            if (params.agentId) {
              const agent = await ctx.agents.get(params.agentId, companyId);
              if (!agent) return { error: "Agent not found in this company" };
              const r = await auditAgent({ companyId, agent, reason: `requested by an agent (run ${runCtx.runId})`, force: true });
              if (r.skipped) return { content: `Not audited: ${r.skipped}.`, data: r };
              return { content: r.queued ? "Another audit is running for this BotArmor account; this one is queued and its result will be posted when ready." : `Audit ${r.auditCode} started. Call botarmor_audit again with auditCode "${r.auditCode}" in about 10 minutes.`, data: r };
            }
            if (params.instructions) {
              const req = await auditRequest({ name: params.name || "Instructions", instructions: params.instructions, tools: params.tools ?? [], lang: s.lang, minGrade: s.minGrade });
              const started = await startAudit({ ...api(s), request: req });
              return { content: `Audit ${started.audit_code} started${req.truncated ? " (instructions cut to 8000 characters)" : ""}. Call botarmor_audit again with auditCode "${started.audit_code}" in about 10 minutes.`, data: { auditCode: started.audit_code } };
            }
            return { error: "Give agentId, instructions or auditCode" };
          } catch (err) {
            return { error: err.message };
          }
        },
      );
    },

    async onValidateConfig(config) {
      const errors = [];
      if (config.apiBaseUrl && !/^https:\/\/[^\s/]+/.test(String(config.apiBaseUrl))) errors.push("The BotArmor API base URL must start with https://");
      if (!config.apiKeyRef) errors.push("Choose the secret that holds your BotArmor API key");
      return { ok: errors.length === 0, errors };
    },

    async onHealth() {
      const list = ctx ? await pending().catch(() => []) : [];
      return { status: "ok", details: { pendingAudits: list.filter((p) => !p.queued).length, queuedAudits: list.filter((p) => p.queued).length } };
    },
  });
}

const plugin = createPlugin();
export default plugin;
runWorker(plugin, import.meta.url);
