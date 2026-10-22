# BotArmor Gate — Paperclip plugin

Red-team audits of your Paperclip agents' instructions with [BotArmor](https://botarmor.eu): 13 attack levels (fake
director, angry customer, fake laws, phishing, role-play hijacks, data requests, invented facts, AI disclosure, and
"agent with hands": sending, deleting, paying or delegating without human confirmation).

The board gets a comment with the grade A–F, each failed level with a ready-to-paste patch, and a public verification
link. **The plugin informs; it never blocks.** Paperclip gives plugins no veto, and the hire decision stays with a human.

## When it audits

| Trigger | What is audited | Where the result goes |
|---|---|---|
| Hire approval (`approval.created`, type `hire_agent`) | The agent being hired | Comment on the issue that asked for the hire |
| Agent created directly (`agent.created`) | The new agent | The issue set in *Issue for results* (optional) and the activity log |
| Instructions path, template or skills changed (`agent.updated`) | The agent | Same |
| Weekly job (Monday 06:00) | Agents whose instructions changed since their last audit | Same |
| Agent tool `botarmor_audit` | An agent (`agentId`) or raw `instructions` | Returned to the calling agent |

Editing an instructions file fires no Paperclip event, so such edits are caught by the weekly fingerprint check (or
run the job by hand: `paperclipai plugin job:trigger botarmor-gate weekly-recheck`).

An audit takes 5–15 minutes. Events only start audits; the job `collect-results` (every 5 minutes) posts results when
they are ready. BotArmor runs one audit per account at a time: others wait in a queue.

## What is sent to BotArmor

- The agent's instructions: its entry file (`AGENTS.md`, from `adapterConfig.instructionsFilePath`, read on the
  Paperclip host) or its legacy prompt template, up to 8 000 characters.
- Its skill names as tools, with a risk class guessed from the name (`send_*` → external send, `delete_*` →
  destructive, `refund_*` → payment, …).

This is a **prompt-only audit**: BotArmor's simulated bot plays the instructions. No live agent is contacted. The
result is an estimate, not a test of the live agent and not a certification. BotArmor stores only a SHA-256
fingerprint of the instructions; test conversations are kept 90 days, then redacted
([privacy policy](https://botarmor.eu/legal/confidentialite.html)).

## Install

1. Create a BotArmor API key (dashboard https://app.botarmor.eu/app/ → API keys). Each audit uses one credit.
2. Store it as a Paperclip secret.
3. Install the plugin: `paperclipai plugin install paperclip-plugin-botarmor` (npm) or
   `paperclipai plugin install /path/to/paperclip-plugin-botarmor` (local build).
4. Settings → Plugins → BotArmor Gate, per company:
   - **BotArmor API key**: the secret from step 2;
   - **Minimum grade** (default B), **Report language** (en, fr, de, es, ru);
   - which triggers to use, and optionally an **Issue for results** without a linked issue.

## Develop

```bash
npm install
npm run build   # dist/worker.js and dist/manifest.js (esbuild, ESM, Node 24)
npm test        # node:test on the SDK test harness, BotArmor API stubbed
```

Requires Paperclip 2026.1012.0 or later and Node 24.11+.

## License

MIT
