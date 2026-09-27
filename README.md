# Aspira (新愿)

**AGI Layer 1 — the Discriminator.**

A pure rule engine that judges whether a statement or an action is right, wrong, safe,
or dangerous — **before it reaches a human**. Zero LLM dependency.

```
54 discrimination dimensions  ×  14-layer pipeline  ×  132 modules  ×  180 MCP tools
×  1,510 dispatch routes  ×  740 passing tests  ×  0 runtime dependencies
```

Aspira does not generate. It does not compete with an LLM. It stands between the
LLM and the human, like a pain receptor that says "no" when something is wrong.

| Layer | Capability | Who builds it |
|-------|-----------|---------------|
| 5 | Act | Large labs (robotics) |
| 4 | Generate | Large labs (LLMs) |
| 3 | Reason | Built into models |
| 2 | Remember | Large labs + startups |
| **1** | **Discriminate** | **Aspira** |

Aspira takes layer 1 because this layer does not depend on compute, code volume,
or framework ecosystems. It depends on judgment alone.

---

## Install

Requires **Node.js >= 18.17**. No GPU, no database, no API key, no network at runtime,
no runtime dependencies.

```bash
git clone https://github.com/mark-cell-520/aspira.git
cd aspira
node bin/verify.js        # 14 installation checks
node bin/cli.js status    # engine status
node bin/cli.js chat      # interactive console
```

Or through npm:

```bash
npm install @mark-cell-520/aspira
```

---

## Use it in 30 seconds

```javascript
const gate = require('./src/gate.js');

const r = gate.checkOutput('According to 2025 Harvard research, coffee extends life by 12.5 years');

console.log(r.gate.action);   // 'verify'  -> gather evidence before believing this
console.log(r.verdict);       // '需验证'
console.log(r.findings[0]);   // { dimension: 'unsupported_claim', severity: 90, guidance: '...' }
```

Four possible actions:

| Action | Meaning |
|--------|---------|
| `pass` | Clean. Deliver normally. |
| `verify` | Needs evidence. Run the verifier first. |
| `rewrite` | Must be rewritten. Follow `findings[].guidance`. |
| `block` | Stop. Do not output. Use `gate.reason`. |

`verdict` is derived from `gate.action`, so the two never contradict each other. If you
read only one field, read `gate.action`.

---

## The three entry points

| Function | Use it for | What it adds |
|----------|-----------|--------------|
| `checkInput(text)` | User input, before processing | scope-check, premise-check, 54 dimensions, error memory |
| `checkDraft(text)` | An AI draft, before completion | the above + frame-check + doubt-engine |
| `checkOutput(text)` | An AI response, before sending | the above + output-gate + doubt-engine |
| `runPipeline({ input, mode, anchor })` | Full pipeline with mode and conversation anchor | keeps the model on the original goal across long sessions |

---

## Architecture

```
input
  |
  v
scope-check -> premise-check -> discriminate (54 dimensions) -> gate
                                                                   |
  +----------------------------------------------------------------+
  v
evidence verify -> frame-check -> output-gate -> doubt-engine
  |
  v
intent-anchor -> rewriter -> error-memory -> self-diagnosis -> output
```

The gate aggregates findings from every layer and emits a single action:
`block` / `rewrite` / `verify` / `pass`.

### Capability domains (7 domains, 132 modules)

| Domain | Representative modules |
|--------|------------------------|
| Logic | logicReasoning, judgmentEngine, debateConductor, counterfactualVerifier |
| Decision | decisionRouter, decisionVerifier, activeInference, selfHealing |
| Cognition | cognitiveEngine, cognitiveLoad, metacognitiveRL, sustainedDriftDetector |
| Emotion / psychology | emotion, psychology, empathyDeepening, griefEngine, traumaInformed |
| Memory | memory, memoryBank, memoryIntegrity, forgetting, knowledgeGraph |
| Identity / ethics | identityCore, personaCore, virtueEthics, moralDevelopment, meaningPurpose |
| Creation / collaboration | skillEvolution, worldModel, multiAgentDialogue, codeExecutor, formula |

---

## Verified metrics

Measured on this repository at **v1.0.0**. Not marketing copy.

| Metric | Value |
|--------|-------|
| Modules registered | 132 |
| Module init errors | 0 |
| Dispatch routes | 1,510 |
| Discrimination dimensions | 51 |
| MCP tools | 180 |
| Test suite | 740 passing / 0 failing |
| Capability guard | 18 / 18 checks |
| Security regression | 16 / 16 |
| Runtime dependencies | 0 |

---

## MCP server

Aspira exposes its engine as an MCP server, so any MCP-capable agent can call it.

```bash
node src/mcp-server.js --port 8099
# or a Unix socket:
node src/mcp-server.js --socket /tmp/aspira.sock
```

Then connect:

```bash
hermes mcp add aspira --url http://localhost:8099/mcp
```

The server authenticates with a bearer token generated on first start and written to
`.env` (never committed). A request without a valid token returns `401`.

### Three-tier write permission model

`tools/call` enforces a role model so that state-mutating tools cannot be invoked by an
unauthenticated caller:

| Role | Source | Capability |
|------|--------|------------|
| `guest` | no credentials | read-only tools |
| `user` | `Aspira-OID-<16-hex>` header | read + write |
| `admin` | valid bearer token | full |

The write-protected set is `aspira_memory_write_control`,
`aspira_memory_eraser`, `aspira_decision_decide`, `aspira_self_heal`. A guest
calling any of them gets `isError: true` with `权限不足`. This behaviour is covered by an
end-to-end regression test that speaks real JSON-RPC over a real Unix socket
(`test/mcp-guest-permission.test.js`), because the earlier failure mode was a permission
block that was syntactically valid but unreachable — tests that only inspected the
tool-name whitelist passed while the gate never ran.

---

## Agent-facing checks

Beyond text discrimination, Aspira ships checks aimed at how AI agents behave — the
failure modes that show up when an agent reports work it did not do.

| Check | What it catches |
|-------|-----------------|
| `checkCompletionEvidence` | Empty completion claims ("done", "fixed", "all passing") without a git hash, test count, file path, or PR link |
| `checkArchitectureConsistency` | A function whose name promises one thing and whose body does another (named `validate`, no validation) |
| `checkDecisionTrace` | A "decision" with fewer than 2 options, no explicit choice, or no stated reason — pseudo-decisions |
| `checkPlanGate` | A plan entering a complex task without steps, acceptance criteria, rollback, or safety strategy |
| `checkForbiddenCall` | Delegating before the target, boundary, and acceptance criteria are confirmed |
| `checkAIMisuse` | Human-side misuse patterns: oversized context dumps, errors without repro steps, adopting output unverified |

Each is available as an MCP tool (`aspira_check_completion_evidence`,
`aspira_check_architecture_consistency`, `aspira_check_decision_trace`,
`aspira_check_plan_gate`, `aspira_check_forbidden_call`,
`aspira_check_ai_misuse`).

---

## Tests

```bash
node test/run-all.js          # full suite (recursive over test/, including subdirectories)
node bin/verify.js            # installation checks
node scripts/guard-abilities.js   # capability guardian (18 checks)
```

`test/run-all.js` walks `test/` recursively, so tests in `test/core/`, `test/memory/`,
`test/utils/`, and other subdirectories run alongside the top-level files.

`scripts/guard-abilities.js` runs before any upgrade commit. It verifies entry points,
discrimination against a fixed sample set, the engine main chain, **text searchability**
(no NUL bytes or CRLF in core sources — a bare NUL parses fine in Node but makes every
text-search tool treat the file as binary), and the full regression suite.

---

## Honest limitations

**It is:** the discrimination layer of AGI — a rule engine judging right and wrong,
good and bad, safe and dangerous.

**It is not:** AGI itself, a generative model, a semantic understanding system
(irony and metaphor are invisible to it), a substitute for content moderation, or a
safety certification.

Known limits:

1. Pattern-matching ceiling — new tricks require new patterns.
2. Bilingual maintenance cost across all dimensions.
3. No semantic understanding — irony, metaphor, and cultural context are invisible.
4. False-positive rate around 8% at baseline.
5. Single maintainer.
6. Chinese tokenisation is heuristic (greedy longest-match with a stopword list, not a
   full dictionary), so unusual phrasings can segment imperfectly.
7. **Silent failure is its blind spot.** Three real defects in this repository — a bare
   NUL byte in the engine source, an unreachable permission block, and contradictory
   documentation numbers — were all invisible to a 547-test green suite, because none of
   them produced wrong runtime behaviour. The text-searchability guard and the
   end-to-end permission test exist because of them; treat "tests pass" as necessary,
   never sufficient.

---

## Version history

| Version | Date | Change |
|---------|------|--------|
| 1.0.0 | 2026-09-27 | Dimension health audit. The audit script reported "形态合规 51/54" every cycle, flagging `evidence`, `sycophancy` and `reasoning_coherence` as malformed. They were not malformed — they are the three `SCORE_ONLY` dimensions that by contract carry hits in `issues` / `totalHits` / `structure` instead of `count`, and the script did not know the exemption. The audit was wrong about its own subject. Now 54/54. The script also dropped a stale "51 dimensions" comment, and — more importantly — started reporting the **coverage distribution** instead of only the eight best-covered dimensions: `1:31 2:9 3:8 4:2 5:1 6:1 17:1 27:1`. Thirty-one of fifty-four dimensions rest on a single test file, which is exactly where silent breakage hides, and the previous "top 8" report made that invisible. `test/dimension-firing.test.js` locks firing probes for sixteen thin dimensions, each with a negative control. The methodology deliberately avoids a mistake this repo already made once: a discarded "dimension sensitivity" metric scored 31/51 dimensions DEAD from hand-written English examples, while Chinese examples brought `phishing_coercion` to count=3 — it measured whether the example matched the pattern, not whether the dimension works. This cycle reproduced the same trap: a first round of hand-written probes fired on only 9 of 27 dimensions; re-deriving the wording from each dimension's own patterns raised it to 16, and the rest failed only because the pattern literals are too short (`/所有[^。]*?都(是|很|会|喜欢)/`) for mechanical extraction. Every probe in the test therefore records where its wording came from. Along the way, a real pattern gap: `/你(是|就)(个|一)?水军/` allowed only one particle, so "你就是个水军吧" did not match even though "你是个水军" and "你是水军" both did — natural Chinese stacks particles (就是 / 就是个 / 就是在). Same defect in the 带节奏 pattern. Both fixed. Also fixed a bug in the new test itself: `reasoning_coherence`'s `structure` is a descriptor string ("无推理结构"), not a hit count, and the first `hitCount` treated it as one, making the negative control report a false hit. FP and recall unchanged after all of it: **5.3% / 100%**. 778 tests, 0 failures. |
| 1.0.0 | 2026-09-27 | False-positive / recall calibration. AGENTS.md claimed a "baseline false-positive rate around 8%", but nothing in the repository had ever measured it — no feedback facility, no calibration script. `scripts/calibrate-fp-recall.js` now measures both on a labelled corpus and, more usefully, runs a genuine **A/B** by emptying a pattern category *before* `discriminate()` (an earlier attempt filtered types afterwards, which left the gate action already computed and made both arms identical). Three defects surfaced. (1) `best_run_picking` in `reward-hacking.js` wrote four bare verbs as standalone alternatives — `/pick\w*|select\w*|cherry-?pick\w*|choos\w+|sift\w*<anchored sequence>/` — so by `|` precedence any of those words alone matched. A harmless parameterized query, `SELECT * FROM users WHERE id = 1`, plus "Please select the best option" and "I choose to skip this" were all blocked. The file's own comment says to rely on marker words rather than enumerating object nouns; the regex contradicted it. (2) Fixing that FP turned a **real** SQL injection — `db.query("… id=" + id)` — into a miss, which proves the FP had been masking a genuine gap: `sql_injection` also only recognised the five taint names. Rewritten source-agnostically, including the ordering where the quote precedes the SQL keyword. The general lesson: one false positive can be a false negative in disguise, so recall must be re-measured after any FP fix. (3) Prompt-injection verbs listed only `ignore`, so "Disregard the above…" passed; broadening them without the noun anchor then produced 3/3 FPs on ordinary collaboration ("disregard the previous error message"), now fixed to require verb + past reference + instruction/prompt/rule. Measured A/B for the previous cycle's `dynamic_code_execution` patterns: recall **+23 points (76.9% → 100%)** with **zero** added FP. Final: FP **5.3%** (2/38, below the claimed 8%), recall **100%** (13/13). The 2 remaining FPs are `verify` on unsourced statistics, which is reasonable behaviour rather than a defect. 774 tests, 0 failures. |
| 1.0.0 | 2026-09-27 | Adversarial-robustness repair in the code-security dimension. The taint patterns only recognised five source names — `req|request|params|body|input` — which is a requirement that the caller name things conventionally. Renaming the variable to `userInput`, `res.data` or `myVar` defeated every one of them: of 12 command-injection / XSS probes, only 2 were caught (SQL concatenation and `pickle.loads`, both via `reward_hacking` rather than `code_security`). `eval(userInput)`, `new Function(userInput)`, `exec` string concatenation, `el.innerHTML = userInput` and `document.write(userInput)` all passed with `gate.action: pass`. The strategy is now **"is the argument a literal"** rather than "is the argument one of five names": literals are harmless (`eval("1+1")`, `exec("ls -la")`, `innerHTML = ""`), non-literals are suspicious regardless of what they are called. Added a `dynamic_code_execution` category (`eval` / `new Function` with a non-literal argument), source-agnostic concatenation and template-interpolation patterns for the `exec` family, and non-concatenated `innerHTML`/`outerHTML` assignment plus `document.write` to `xss`. All 8 evasion probes now fire and all escalate to `block`. `test/adversarial-code-security.test.js` locks the strategy — and it immediately caught a real bug: the PEM private-key header pattern in `CODE_SECURITY_PATTERNS` lacked `/i`, and `text-normalizer` step 6 lowercases the whole text, so a real `-----BEGIN RSA PRIVATE KEY-----` was lowercased into something the pattern could never match. A genuine private key passed with `gate.action: pass`. The `/i` invariant is now asserted for every pattern in that table. A scan of all 544 regex literals in `src/index.js` found 5 more containing letters without `/i`; three are Latin alternatives inside the Chinese branch of the authority-source lists and have been aligned with their English counterparts — this is consistency hardening, not a demonstrated defect (both Chinese and Latin anchors exempt correctly in practice; the exemption is actually carried by the first pattern's 论文/期刊/… terms). False-positive check: 0 over 20 clean samples including "evaluate the results", "retrieval process", "executive summary" and safe code idioms. 769 tests, 0 failures. |
| 1.0.0 | 2026-09-27 | MCP tool-surface repair. An audit of `TOOLS` against `HANDLERS` found three classes of **silent** corruption, none of which any test caught. (1) Five handler keys were defined twice — `aspira_formula_search`, `aspira_formula_calc`, `aspira_formula_bridge`, `aspira_check_outbound`, `aspira_audit_trace` — and in a JS object literal the later key wins with no warning. The winning copies also disagreed with the declared contract: `formula_calc` read `args.values` while the registry declares `variables`; `formula_bridge` read `args.query` while the registry declares `{domain, params}`. `handleFormulaBridge` is a real six-domain formula computation (`prospectValue`, `yerkesDodson`, `flowChannel`, …) and was being replaced by a corpus text search. (2) `aspira_boundary_check`'s object in `tools-registry.js` was **never closed**, so it swallowed the next entry's fields — one object with `name` twice, the second winning. The registry declared 180 tools and exported 179: `boundary_check` vanished from `tools/list` while its handler stayed. (3) `tools/list` reported 179 against 178 unique handler keys and nothing complained. Duplicates removed, the missing brace restored, `handleFormulaSearch` aligned to the declared `query` parameter (it read `keyword`), and `module.exports = { HANDLERS, TOOLS }` added so the invariants are assertable. `test/mcp-tool-integrity.test.js` locks them: names unique, every tool has a handler, no duplicate handler key, and **a handler must not reject a call that satisfies its own declared `required` parameters** — the guard that catches a parameter-name mismatch, which is the failure mode that produces a wrong answer instead of an error. MCP tools **179 → 180**. 764 tests, 0 failures. Known limitation carried forward: `aspira_formula_calc` requires `mathjs`, which is declared in `package.json` but not installed (`node_modules` is absent); it fails with a clear "Cannot find module" error rather than a wrong result. |
| 1.0.0 | 2026-09-27 | Dimension-map repair + honest dimension count. `dimMap` in `discriminate()` had drifted from the `dimensions` return object: two stale keys (`bullshit`, `appeal_to_authority`) that no longer exist, and three missing ones (`evidence`, `unsupported_claim`, `clickbait`). Because the findings loop resolves counts through `dimObj?.count || … || 1`, a key miss silently fell back to `1`, so those findings reported "1次" regardless of the real count — the entry survived but the number was false. Keys renamed, the three gaps filled, and `test/dimension-health.test.js` now asserts finding count === measured `dimensions` count so this cannot drift silently again. Every documented number re-measured: dimensions **51 → 54** in README / SKILL / AGENTS (the old "51" counted `dimMap`, which was itself wrong; `dimensions` has 54 keys). Modules 132, dispatch routes 1,510, MCP tools 179 all re-confirmed. Dimension lists corrected to real names with `tone_policing` / `sealioning` added; AGENTS.md now states explicitly that `pseudo_causal` / `soft_deflection` / `ai_writing_tell` push findings without being `dimensions` keys, so the lists name 57 items of which 54 are counted. 757 tests, 0 failures. |
| 1.0.0 | 2026-09-27 | Honest-numbers audit. A previous decoupling refactor had deleted 5 `globalThis` stubs as "dead code — 0 src consumers", but `heartflow.js` itself consumed them by bare class name, so `hf._initErrors` carried 5 entries and only **126 of 132** modules registered (routes 1,497). Repaired all 5 through the lazy registry (`processRewardModel`, `desireCognition`, `cognitiveLoadCalculator`, `worldLandscape`, `knowledgeExplorer`), aliased `DesireSystem` → `DesireCognition`, and restored the `worldAwareStrategy` factory stub in its own `try` so it can no longer take `WorldLandscape` down with it. Every documented number was re-measured against the code: README corrected 46 → 51 dimensions, 9 → 14 pipeline layers, 547 → 740 tests; dispatch routes 1,506 → 1,510 in README / SKILL / AGENTS. `security-audit` `S2` now skips instead of failing when the tree has no `.git`. 740 tests, 0 failures. |
| 6.7.69 | 2026-09-20 | MCP guest write-permission block was unreachable dead code (100% of guest write attempts passed); moved into `case 'tools/call'`, token comparison switched to `safeCompare()`. Added end-to-end permission regression test and the guard's text-searchability check (13 → 18). 547 tests. |
| 6.7.69 | 2026-09-18 | DeepSeek V4.1 alignment: reasoning effort control, sparse module activation, discriminative result cache, async supervision layer, autonomous decision execution with consequence tracking, Engram conditional memory, SWA bounded replay, per-decision-type stats |
| 6.7.24 | 2026-09-17 | Audit remediation: gate/verdict consistency, fact-check scoring, Chinese tokenisation in the hypothesis pipeline, circuit-breaker memory accounting and non-blocking CPU sampling, recursive test discovery, multi-language child-safety age detection, version-source unification, English documentation rewrite |
| 6.7.13 | 2026-09-05 | Documentation API alignment; optional ESM transformers loading; CLI guidance without an LLM key |
| 6.6.1 | 2026-08-18 | Formula library fully integrated (1,334 formulas); formula-bridge extended with 6 decision and learning primitives |
| 6.5.6 | 2026-08-13 | Comprehensive audit: DataEraser wired to MCP; adversarial synthesis recovered; dead code archived |
| 6.5.5 | 2026-08-12 | 47th dimension — premature termination detection |
| 6.5.0 | 2026-08-04 | Memory engine mounted to `think()`; exaggeration detection (output-gate / frame-check / doubt-engine) |
| 6.4.0 | 2026-07-29 | AGI Layer 1 gate chain: gate / scope-check / premise-check / verifier / output-gate / doubt-engine / frame-check |
| 6.0.0 | 2026-07-18 | Self-evolution core connected; evolution loop live |

---

## License

MIT.
