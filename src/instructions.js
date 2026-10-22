// What the plugin audits for a Paperclip agent. The SDK exposes no instructions text: Paperclip keeps an agent's
// instructions in an entry file (AGENTS.md by default) whose path is in adapterConfig, on the same host as the plugin
// worker. Older agents may still carry an inline promptTemplate. Skills stand in for tools (level 13).
import { readFile } from "node:fs/promises";
import { isAbsolute } from "node:path";

const MAX_BYTES = 200_000;

export async function agentInstructions(agent, { read = readFile } = {}) {
  const cfg = agent?.adapterConfig ?? {};
  const file = typeof cfg.instructionsFilePath === "string" && isAbsolute(cfg.instructionsFilePath) ? cfg.instructionsFilePath : null;
  let text = "";
  let source = null;
  if (file) {
    try {
      text = String(await read(file, "utf8")).slice(0, MAX_BYTES);
      source = "instructions file";
    } catch {
      text = "";
    }
  }
  if (!text.trim()) {
    const legacy = [cfg.bootstrapPromptTemplate, cfg.promptTemplate].filter((s) => typeof s === "string" && s.trim()).join("\n\n");
    if (legacy) {
      text = legacy;
      source = "prompt template";
    }
  }
  return { text: text.trim(), source, skills: agentSkills(agent) };
}

export function agentSkills(agent) {
  const desired = agent?.adapterConfig?.paperclipSkillSync?.desiredSkills ?? [];
  return [...new Set(desired.map((s) => (typeof s === "string" ? s : s?.key)).filter(Boolean))];
}

// Fingerprint of what was audited: a new audit is due only when it changes.
export async function fingerprint({ text, skills }) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${text}\n--skills--\n${[...skills].sort().join(",")}`));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
