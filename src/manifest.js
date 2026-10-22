// Paperclip plugin manifest (PaperclipPluginManifestV1, @paperclipai/shared 2026.1012.0).
export default {
  id: "botarmor-gate",
  apiVersion: 1,
  version: "0.1.0",
  displayName: "BotArmor Gate",
  description:
    "Red-team audits of your agents' instructions with BotArmor: on every hire approval, on new agents and when instructions change. Posts the grade, failed attack levels and ready-to-paste patches as an issue comment. Informs the board; never blocks.",
  author: "BotArmor AI (Rhone IA)",
  categories: ["connector", "automation"],
  minimumHostVersion: "2026.1012.0",
  capabilities: [
    "events.subscribe",
    "agents.read",
    "approvals.read",
    "issues.read",
    "issues.orchestration.read",
    "issue.comments.create",
    "http.outbound",
    "secrets.read-ref",
    "agent.tools.register",
    "jobs.schedule",
    "plugin.state.read",
    "plugin.state.write",
    "activity.log.write",
    "companies.read",
  ],
  entrypoints: { worker: "./dist/worker.js" },
  instanceConfigSchema: {
    type: "object",
    properties: {
      // No "type": the secret picker stores a { type: "secret_ref", secretId } object while the host's config validator
      // would check a declared "string" literally (Paperclip 2026.1012.0). The format alone marks the secret path.
      apiKeyRef: { format: "secret-ref", title: "BotArmor API key", description: "A key starting with ba_live_, created in the BotArmor dashboard (API keys)." },
      apiBaseUrl: { type: "string", title: "BotArmor API base URL", default: "https://app.botarmor.eu" },
      minGrade: { type: "string", title: "Minimum grade", enum: ["A", "B", "C", "D", "F"], default: "B" },
      reportLanguage: { type: "string", title: "Report language", enum: ["en", "fr", "de", "es", "ru"], default: "en" },
      auditOnHire: { type: "boolean", title: "Audit every hire approval", default: true },
      auditOnNewAgent: { type: "boolean", title: "Audit agents created directly (no approval)", default: true },
      weeklyRecheck: { type: "boolean", title: "Weekly re-check of agents whose instructions changed", default: true },
      reportIssueId: {
        type: "string",
        title: "Issue for results without a linked issue (optional)",
        // No "x-paperclip-advanced": the host's config validator (ajv strict mode) rejects it in 2026.1012.0.
        description: "Results of new-agent and weekly audits are posted here. Hire audits go to the issue that requested the hire.",
      },
    },
    required: ["apiKeyRef"],
  },
  jobs: [
    { jobKey: "collect-results", displayName: "Collect finished BotArmor audits", description: "Posts the result of each finished audit (every 5 minutes).", schedule: "*/5 * * * *" },
    { jobKey: "weekly-recheck", displayName: "Weekly BotArmor re-check", description: "Re-audits agents whose instructions changed since their last audit.", schedule: "0 6 * * 1" },
  ],
  tools: [
    {
      name: "botarmor_audit",
      displayName: "BotArmor audit",
      description:
        "Red-team audit of an agent's instructions (13 attack levels). Start one with `agentId` (an agent of this company) or `instructions` (text, optional `tools`), get back an audit code; then call again with `auditCode` for the grade, failed levels and patches. Audits take 5-15 minutes and use one BotArmor credit.",
      parametersSchema: {
        type: "object",
        properties: {
          agentId: { type: "string", description: "Agent whose instructions to audit." },
          instructions: { type: "string", description: "Instructions text to audit instead of an agent (max 8000 characters)." },
          name: { type: "string", description: "Name shown in the report when auditing raw instructions." },
          tools: { type: "array", items: { type: "string" }, description: "Tool names the instructions may call (level 13)." },
          auditCode: { type: "string", description: "Code of a started audit (BA-XXXXXXXX) to fetch its result." },
        },
        additionalProperties: false,
      },
    },
  ],
};
