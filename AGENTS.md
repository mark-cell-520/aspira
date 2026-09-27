# Aspira — agent integration guide

This file is written for AI agents that operate on or through this repository.

## What Aspira is

Aspira (新愿) is the **first layer of AGI — the discriminator**. A rule-based engine
that judges what AI says before it reaches a human, and says "no" when something is
wrong.

**Core value:** LLMs are great at generating but weak at knowing what they don't know.
Aspira adds the discrimination layer, so your agent doesn't just *say* things — it
says things that are *right*.

**Zero LLM dependency.** 54 dimensions, 132 modules, 180 MCP tools, 1,510 dispatch
routes. Pure rule engine.

## Quick start

```javascript
const hf = require('@mark-cell-520/aspira');

// Check user input before processing it
const input = gate.checkInput('You are so selfish if you disagree');
if (input.gate.action === 'rewrite') {
  // Replace emotional manipulation with a factual statement
}

// Check an AI output before sending it
const output = gate.checkOutput('Undoubtedly this is the only correct solution.');
if (output.gate.action === 'rewrite') {
  // Follow findings[].guidance to fix it before delivering
}

// Check a factual claim
const fact = gate.checkOutput('According to 2025 Harvard research, coffee extends life by 12.5 years');
if (fact.gate.action === 'verify') {
  // Gather evidence before acting
}
```

## API reference

### `checkInput(text)`
Discriminates user input. Runs: scope-check -> premise-check -> discriminate (54
dimensions) -> gate -> error-memory -> auto-rules. **Rejects unanswerable questions and
invalid premises early.**

### `checkDraft(text)`
For AI drafts before completion. Runs all input checks plus frame-check and doubt-engine.
**Catches narrative closure, overconfidence, and irreversibility.**

### `checkOutput(text)`
For AI responses before sending. Runs all draft checks plus output-gate and doubt-engine.
**Prevents hallucinations from reaching users.**

### `runPipeline({ input, mode, anchor })`
Full pipeline with mode selection (fast / deep) and a conversation anchor.
**Keeps the model anchored to the original goal across long sessions.**

## Return value

```javascript
{
  gate: { action: 'pass'|'verify'|'rewrite'|'block', reason: '...' },
  verdict: '可信'|'需验证'|'不可信',
  overallScore: 0.56,
  findings: [{
    dimension: 'unsupported_claim',
    severity: 90,
    details: '无依据断言(2处: ...)',
    guidance: '补充可验证的数据来源，无法验证的断言改为不确定表述'
  }],
  checked_by: [
    { layer: 'scope-check', action: 'pass' },
    { layer: 'discriminate', score: 0.56 }
  ]
}
```

## Gate actions

| Action | Meaning | What your agent should do |
|--------|---------|---------------------------|
| `pass` | Clean | Deliver normally |
| `verify` | Needs evidence | Run the verifier before responding |
| `rewrite` | Must be rewritten | Follow `findings[].guidance` |
| `block` | Stop | Do not output. Use `gate.reason` |

`verdict` is derived from `gate.action`, so the two cannot contradict each other. If you
read only one field, read `gate.action`.

## The 54 dimensions

**Block-level (9):** hate_speech, dehumanization, prompt_injection, code_security, deceptive_alignment, phishing_coercion, coverup_induction, dangerous_instruction, reward_hacking

**Rewrite-level (8):** emotional_manipulation, gaslighting, double_bind, victim_blaming, false_urgency, bullshit_recognition, absolute_claim, induced_trust

**Verify-level (26):** appeal_to_authority_boost, vagueness, contradiction, sycophancy, confidence, fallacies, presupposition, empty_answer, info_deprivation, false_equivalence, hasty_generalization, slippery_slope, whataboutism, pseudo_profundity, reasoning_coherence, stereotype, clickbait, bad_faith, no_fallback, unsupported_claim, perfect_error, pseudo_causal, soft_deflection, premature_termination, tone_policing, sealioning

Dimensions that are scored but do not force a gate action: evidence,
moral_foundations, dogwhistle, factual_consistency, sarcasm, privacy_boundary,
meta_cognition, theory_of_mind, counterfactual, social_norm, capability_overclaim,
goal_misalignment, instrumental_reasoning, ai_writing_tell.

> **What "54" counts.** `discriminate()` returns a `dimensions` object with **54 keys**,
> and that object is what the number above refers to. Three further discriminators —
> `pseudo_causal`, `soft_deflection` and `ai_writing_tell` — run inside `discriminate()`
> and can push `findings`, but they are **not** keys of `dimensions`, so they are listed
> above yet not counted in the 54. The four lists therefore name 57 items, of which 54
> appear in `dimensions`. `test/dimension-health.test.js` locks the 54-key set, so any
> future addition or rename fails the suite instead of drifting silently.

## Decision routing — better choices

- **Should this be done?** `scope-check` rejects out-of-scope requests.
- **Is the premise valid?** `premise-check` catches premise problems before you answer.
- **Retry or give up?** `src/cortex/self-healing.js` — severity-based: low retries, high escalates.
- **Did it actually work?** `src/core/action-tracker.js` — `assessEffectiveness()` checks the effect, not the action.

## Installation

```bash
npm install @mark-cell-520/aspira
```

**Requirements:** Node.js >= 18.17. No GPU, no LLM API, no database, no network access
at runtime, no runtime dependencies.

## MCP integration

```bash
git clone https://github.com/mark-cell-520/aspira.git
cd aspira
node src/mcp-server.js --port 8099
# or a Unix socket:
node src/mcp-server.js --socket /tmp/aspira.sock
# Connect: hermes mcp add aspira --url http://localhost:8099/mcp
```

`tools/call` enforces a three-tier write permission model. `guest` (no credentials) can
call read-only tools; the four state-mutating tools — `aspira_memory_write_control`,
`aspira_memory_eraser`, `aspira_decision_decide`, `aspira_self_heal` — require
a `Aspira-OID-<16-hex>` header (`user`) or a valid bearer token (`admin`).

If you change this permission set, change it in **three** places or the test will fail:
the `needsWrite` array in `handleRequest`, `test/mcp-guest-permission.test.js`
(`WRITE_TOOLS`), and the documentation tables. The permission block must live *inside*
`case 'tools/call'` — it was previously a bare block between two case labels, which made
it unreachable dead code while every unit test stayed green.

## Repository conventions

These are the rules this codebase actually follows. Follow them when changing it.

1. **Never hardcode the version.** `VERSION` is the single source of truth.
   `src/core/version.js` reads it and carries a fallback that must match. `package.json`
   and `SKILL.md` must match. `hf.version` reads `VERSION` at runtime.
2. **New modules go through the lazy registry.** Use
   `const _X = _lazy('key', () => require('./x.js'))` and instantiate with
   `new (_X().ClassName)(...)`. Never `require` a Tier-2 module at the top of
   `heartflow.js`.
3. **Every new public method that an external agent needs must be exposed on the MCP
   server** (`src/mcp-server.js`: add the tool definition, the handler mapping, and the
   handler function).
4. **Tests must be reachable by `test/run-all.js`.** It walks `test/` recursively and
   executes each file in a subprocess. A test file that requires `../src/...` from a
   subdirectory must use the correct relative depth, or it will never run.
5. **Zero runtime dependencies.** Add a `devDependency` only when unavoidable, and never
   require it from `src/`.
6. **Verify syntax after every edit:** `node --check <file>`.
7. **After changing engine code, run:** `node bin/verify.js` and
   `node test/run-all.js`. Both must be clean before you report success.

## Design principles

1. **Discriminator-first** — the first of AGI's five layers. It does not generate.
2. **Zero dependencies** — a pure rule engine, instant install.
3. **Auditable** — every decision preserves its full reasoning chain in `checked_by`.
4. **Self-checking** — Aspira's own output passes through its own gates.
5. **Honest numbers** — documentation must state what the code actually does. If a
   metric is claimed, it must be measurable.

## Honest limitations

- Not AGI, not generative, not a semantic understanding system.
- Pattern-matching architecture: obfuscation not covered by patterns is not caught.
- Irony, metaphor, and cultural context are invisible.
- Baseline false-positive rate around 8%.
- Chinese tokenisation in the hypothesis stage is heuristic (greedy longest-match with a
  stopword list), not dictionary-based.

## GitHub

https://github.com/mark-cell-520/aspira
