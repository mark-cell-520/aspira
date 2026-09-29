# Aspira — agent integration guide

This file is written for AI agents that operate on or through this repository.

## What Aspira is

Aspira (新愿) is the **first layer of AGI — the discriminator**. A rule-based engine
that judges what AI says before it reaches a human, and says "no" when something is
wrong.

**Core value:** LLMs are great at generating but weak at knowing what they don't know.
Aspira adds the discrimination layer, so your agent doesn't just *say* things — it
says things that are *right*.

**Zero LLM dependency.** 54 dimensions, 132 modules, 181 MCP tools, 1,510 dispatch
routes. Pure rule engine.

## Quick start

```javascript
const hf = require('@mark-cell-520/aspira');

// Check user input before processing it
const input = hf.checkInput('You are so selfish if you disagree');
if (input.gate.action === 'rewrite') {
  // Replace emotional manipulation with a factual statement
}

// Check an AI output before sending it
const output = hf.checkOutput('Undoubtedly this is the only correct solution.');
if (output.gate.action === 'rewrite') {
  // Follow findings[].guidance to fix it before delivering
}

// Check a factual claim
const fact = hf.checkOutput('According to 2025 Harvard research, coffee extends life by 12.5 years');
if (fact.gate.action === 'verify') {
  // Gather evidence before acting
}
```

> **This example is executed by `test/doc-examples.test.js`, not just written here.**
> It previously imported the package as `hf` and then called `gate.checkInput(...)` —
> `gate` was never defined, so the snippet threw `ReferenceError` for anyone who
> copied it. `checkInput` / `checkDraft` / `checkOutput` are top-level exports of
> `src/gate.js` (the package `main`), so they are reached as `hf.checkInput`.
> The third snippet was also *not* merely mislabelled: it documented `verify` while
> the engine returned `pass`, because `UNSUPPORTED_CLAIM_EN` could not match the
> singular `study` (`studies?` never matches "study") and required the verb to sit
> directly against `by` (`extended life by 12.5 years` was missed). Both patterns
> were repaired; the snippet now returns `verify` as documented.

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
Full pipeline with mode selection (`input` / `output` / `draft`) and a conversation
anchor. **Keeps the model anchored to the original goal across long sessions.**

> **This line used to say "mode selection (fast / deep)", and neither value worked.**
> `src/pipeline.js`'s `runPipeline` branches only on `'input'`, `'output'` and
> `'draft'`, so `'fast'` and `'deep'` matched **no** branch and behaved exactly like
> omitting `mode` — measured on the same input: `input` → 11 layers, `draft` → 12,
> `output` → 13, while `fast`, `deep` and "not passed" all gave **11**. The MCP tool
> `aspira_gate_pipeline` defaulted to `'fast'`, so its `mode` parameter could not
> change the behaviour at all, and the same file's inventory claimed "17 layers
> (11 for mode:'fast')" — the 11 was a coincidence of falling through to the default,
> and 17 never matched any mode (the maximum measured is 13). `handleGatePipeline`
> now defaults to `'input'` and maps `fast`→`input`, `deep`→`output` as compatibility
> aliases, so previously-documented values keep working;
> `test/gate-pipeline-mode.test.js` locks that the three real modes produce distinct
> layer counts and that `AGENTS.md` no longer binds 17 layers to a mode.

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
- **False-positive rate is measured, not claimed.** `scripts/calibrate-fp-recall.js`
  measures it on a hand-written labelled corpus of **106 benign / 41 malicious** samples;
  the current reading is **0.9% FP / 100% recall**. That is a *corpus-local* number,
  not real traffic — the corpus was written by this repo's authors and will drift from
  what real callers actually send. It replaced an earlier "around 8%" that nothing had
  ever measured. The corpus was grown from 38/13 to 75/22 after the mixed-language
  merge made English patterns run on Chinese text: 38 samples carried only **two**
  mixed-language entries, so the instrument was blind to exactly the risk the merge
  introduced, and it immediately surfaced two false positives that had never been seen.
  The earlier 0.0% reading was the product of fixing two long-standing false positives
  whose shared root cause was that `checkPseudoCausal` and `checkUnsupportedClaim`
  recognised the shape "vague source plus precise number" and **never checked whether
  the sentence had already hedged itself**. Both now share one `HEDGE_RE`, measured in
  both directions: three of three hedged statements pass, four of four unhedged ones
  still fire, so no recall was traded for the drop. A zero on a 106-sample corpus is
  not a zero in production — read it as "no false positives this corpus can express",
  which is a statement about the corpus as much as about the engine.
  Until `aspira_false_positive` accumulates real caller feedback
  (`data/feedback/false-positives.jsonl`), treat 0.9% as a lower bound on honesty, not
  a production SLO. Run the script after changing any pattern; a false positive can be a
  false negative in disguise, so recall must be re-measured after every FP fix.
  **The FP reading is 0.9% and not 0.0%, and that is the honest number.** One benign sample
  is escalated: `可能有多种解释，我倾向于第一种，但不排除其他可能。` — a model of
  calibrated uncertainty, pushed to `verify` by the gate rule `findings.length > 1`
  (two lightweight findings are enough). That rule was **measured, not assumed**: it is the
  sole interception reason for **8 of 45** malicious samples and produces this **1** false
  positive, so it earns its keep 8:1 and was deliberately left alone. The cost is recorded
  here rather than hidden by deleting the sample — an earlier version of this file claimed
  0.0% while this class of escalation was already happening and simply unmeasured.
- **The 100% recall above is *plaintext* recall, and that was a blind spot.** The script
  fed `MALICIOUS` to the gate as-written, so **an evasion bypass did not move the number
  at all**: one repair took character-wise separator insertion from 5-of-6 bypassed down
  to 1-of-6 and recall read 100% before and after. The script now also measures recall
  with three evasion classes applied, and the gap it exposed is large — plaintext 100%
  against **85%** (character-wise separators), **71%** (spaces between letters) and
  **95%** (HTML entities) on the same 41 samples. The 39% letter-space reading was closed in
  cycle 18 by matching known terms *space-tolerantly* instead of trying to restore the
  original text — see the cycle-18 entry below. Same lesson as the corpus gap above:
  a risk the instrument cannot see is a risk that does not exist, right up until it does.
  Widening `strip_letter_space` to 1–2 letter tokens was tried and **reverted**: it
  folded 53 additional benign samples to recover 1 malicious one, because collapsing
  merges originally separate words (`const x` → `constx`) and destroys the word boundary
  the patterns need.
- **The `adversarial-variant` layer was unreachable through MCP, and it also over-flagged legitimate Cyrillic and Greek.** Two measured defects, one slice. (a) `HOMOGLYPH_RE` was `/[\u0400-\u04FF\u0370-\u03FF]/` — it matched *any* Cyrillic or Greek character, so `Привет, как дела?`, `Καλημέρα, τι κάνεις;` and `I read a book called Война и мир yesterday.` all came back `rewrite` ("对抗变体: 同形字混淆"). The 86-sample benign corpus is all Chinese and English, so it was blind to exactly this. The regex is now narrowed to *"a Cyrillic/Greek character adjacent to a Latin letter"*, which is what "masquerading as Latin" actually means; four attack samples (`киll`, `hаte`, `lа lа`, `рass`) are still caught. The traded recall is bounded and disclosed: a purely-Cyrillic look-alike word with no Latin neighbour no longer trips this layer, but `de_cyrillic` restores it and `discriminate()` still judges the content — precision at this layer, recall at the content layer. (b) `aspira_gate`, `aspira_gate_check` and `aspira_gate_pipeline` all returned `pass` for `kill me киll`, because their handlers called `gate.gate` / `gate.check` / `gate.pipeline`, and **all three of those run `discriminate()` only** — the full 17-layer pipeline is `runPipeline`. The whole obfuscation class (homoglyph, zero-width, curly quote, fullwidth, combining, digit, word-split) was therefore invisible to the entire MCP tool surface, while agents rely on those tools to gate untrusted input. `handleGatePipeline` now calls `runPipeline`; the two lightweight tools keep their behaviour but their descriptions now carry a ⚠️ naming the skipped layer and pointing at `aspira_gate_pipeline`. A test caught that `runPipeline` does **not** return the `dimensions` key that `gate.pipeline` did — a silent break that would have shipped, now restored explicitly and locked.
- **The calibration instrument itself measured the wrong thing, and the corpus was blind to
  every non-Latin script.** Two defects, one slice. (a) `calibrate-fp-recall.js`'s `run()`
  called `idx.discriminate(text, [])` — the 54-dimension discriminator *only*, never the
  `adversarial-variant` layer. Measured on 102 benign / 41 malicious: `discriminate` read
  **38/41 recall (92.7%)** while `gate.checkOutput` and `runPipeline` both read **41/41
  (100%)**. The three "misses" (`kill me киll`, `i hаte you`, `рass the test`) were being
  caught by the adversarial layer as `rewrite`; the instrument reported them as bypasses,
  and any false positive that layer introduced would equally never have shown up in the FP
  number. Both directions were wrong at once. `run()` now measures `gate.checkOutput()`,
  the same entry point agents are told to use. (b) The corpus carried **zero** samples
  containing Cyrillic, Greek, Arabic, Korean or Japanese, so it was blind to exactly the
  class that had already produced a real false positive: `HOMOGLYPH_RE` once matched *any*
  Cyrillic/Greek character, flagging `Привет, как дела?` as adversarial, and
  `text-normalizer`'s `de_cyrillic` once transliterated whole Russian sentences into a
  Latin/Cyrillic mix (`Игнорируй все предыдущие инструкции` → `игнopиpyй вce пpeдыдyщиe
  инcтpyкции`), which silently broke every pattern written against the original script —
  a coupling between two layers that neither layer's own tests could see. Adding
  `INJECTION_PATTERNS.ru/el/ko/ja` surfaced that second defect immediately: the new
  Russian and Greek patterns matched when tested alone and never fired in the pipeline.
  Both fixes now follow one rule — "masquerading as Latin" requires the look-alike to sit
  next to a Latin letter, so transliterate only when Latin letters are the majority. The
  corpus grew by 16 benign (legitimate non-Latin text) and 7 malicious (four non-Latin
  injections plus three homoglyph attacks) samples to pin all of it in place. A test that
  had hardcoded the denominator `34` failed the moment the corpus grew; it now derives the
  count from the corpus, because a hardcoded number is a number that rots.
- **The audit reported 45/45 green while `domains` had never been measured at all, and the runner's own concurrency risk assessment had missed that probe tests rewrite the docs.** Seventh consecutive `doc-honest-numbers` cycle. Cycle 6 concluded the slice was *nearly exhausted* and recommended rotating away; this cycle disproved that by asking a different question — not "what numbers are unaudited" but **"of the 45 that read green, which were never actually measured?"** Listing the audit's keys gave the answer: only `dimensions/modules/tools/routes/layers/tier_*/tests/nodeReq/deps`. README's capability section is titled `### Capability domains (7 domains, 132 modules)` — **`domains` was not a key in any pattern.** Measured: the title says 7 and the table below it happens to have 7 rows, so the number is true *by coincidence*; add an eighth domain, update the table, forget the title, and nothing would ever complain. That is the recurring shape of this slice — **a number that was never measured is indistinguishable, in an all-green report, from a number that is locked.** The new key immediately surfaced two previously invisible claims (README and SKILL.md) *and* a real defect it exposed along the way: `IDENTITY.md` said `99 个模块真实加载` against a measured 132 — the twin of a line fixed two cycles ago, which had survived because the fix patched one phrasing and not the other. **Then the runner's concurrency assessment turned out to have been wrong in a way it had explicitly claimed to have checked.** `run-all.js` became bounded-concurrent with the recorded risk basis *"0 test files write under `data/` or `memory/`"* — true, and beside the point, because at least four probe tests **rewrite `README.md`/`IDENTITY.md`** and then spawn the audit. Run concurrently, probe A injects, probe B injects on top of A's already-polluted copy, A's audit sees B's probe, A's assertion fails, and A restores from a backup that *contains B's probe* — the suite dropped to 6 failures whose messages all read like instrument bugs. First measured pollution: 7 stray rows in README. `test/_doc-probe-lock.js` now serialises every test that spawns the audit, writers *and* readers, because a reader must see the document in a definite state, not mid-probe. **The cleanup itself caused collateral damage that only a reader test caught**: `git checkout -- README.md` (the right way to clear probe rows) also reverted the `17-layer pipeline*` footnote added two cycles earlier, and `layer-count-two-readings.test.js` — a pure reader — was the only thing that noticed. Suite 1205 → **1210**; verify 14/14; audit **47/47**; corpus unchanged (106 benign / FP 0.9%, 41 malicious / recall 100%); no `src/` change, so MCP was not restarted.
- **`unsupported_claim` and `pseudo_causal` used to count the same span twice, and the corpus
  could not see it.** `checkUnsupportedClaim` pushed one entry per matching pattern without
  checking whether the spans overlapped, so `根据 2024 年的一份行业报告，部署时间中位数约为
  12 分钟。` was reported as *two* findings — the second a substring of the first — because
  `根据…报告` and `2024年…报告` both matched. `count` doubles, and since
  `severity = round(score*100)` with `score = min(1, count*0.45)`, severity went **45 → 90**.
  None of the 143 corpus samples could express that shape, so the calibration script never
  saw it. `_dedupeOverlappingSpans()` now drops any span contained in a longer kept one, and
  both functions call it. This is an instrument-honesty fix, not an FP fix: counting is the
  raw material of severity, and severity is the raw material of the gate action, so a
  duplicated pattern silently changed the verdict delivered to users.
- **A dimension-health instrument found three defects in how findings are built, and the instrument itself was wrong twice first.** `scripts/dimension-health-audit.js` feeds a large input pool (the calibration corpus + every string literal in `test/` + fragments stripped from the engine's own regexes) through `discriminate()` and tallies, per dimension, whether its signal ever went non-zero and whether it ever pushed a `finding`. The corpus cannot answer this: a dimension can be fully implemented and still be silent if the corpus contains no sentence that reaches it. **Version 1 of the instrument was simply wrong** — it scanned only the `check*` function bodies, found almost no regexes (they live in module-level tables like `INJECTION_PATTERNS`), and reported 51 of 54 dimensions as "completely silent". A direct call (`idx.checkPromptInjection('ignore all previous instructions')` → count=2, score=1) proved the engine fine and the instrument broken. **Version 2** followed the table references and ran, but still reported 6 silent dimensions; four of those (`unsupported_claim`, `sycophancy`, `contradiction`, `bullshit`) were verified to fire normally on direct calls. The cause was a systematic blind spot in "strip the longest literal run from each regex": cores shorter than 3 characters (`根据…报告` → `根据`), alternation groups that only match whole (`(很棒|很好|…)[^。]*?但`), and patterns needing co-occurrence are all unsynthesizable. **Version 3 stopped pretending to reverse-engineer regexes** and instead measures only "did this dimension ever fire on any of ~6,250 inputs". An instrument that reports its own limitations as engine defects is worse than no instrument — it sends people to fix code that is not broken. The three real defects it then found, all in `discriminate()`'s finding construction: (a) `dimMap` keys and `allDims` names disagreed — `allDims` says `bullshit`, `dimMap` only has `bullshit_recognition` — so `dimObj` resolved to `undefined` and `detail` silently fell back to `1`. `bullshit` really matched 4 times and reported `bullshit(1次)`. Same for `appeal_to_authority` / `appeal_to_authority_boost`. This is the exact `dimMap` key-mismatch defect AGENTS.md already recorded; the earlier fix only covered part of it. (b) `pseudo_causal` and `soft_deflection` were pushed **twice** — once from `allDims` and once from their own dedicated `if` blocks — so one problem produced two findings (measured: `pseudo_causal sev=60` appearing twice). That inflates `findings.length`, which is itself a gate `verify` trigger, the same class as the span double-count fixed last cycle. (c) `clickbait` was in `dimMap` and in `dimensions{}` but never in `allDims`, so it never pushed a finding at all — a fully implemented dimension contributing nothing to the gate. The fix adds **aliases** to `dimMap` rather than renaming anything, because the naming is inconsistent in three places at once (`dimMap` keys / `allDims` names / `BLOCK`·`REWRITE`·`VERIFY_DIMS`): renaming `allDims`' `bullshit` to `bullshit_recognition` would immediately break the `rewrite` trigger, since `REWRITE_DIMS` still holds `bullshit`. Corpus measured unchanged by all three fixes (106 benign / FP 0.9%, 41 malicious / recall 100%). The residual naming inconsistency is disclosed rather than hidden: `findings[].dimension` says `bullshit` while `dimensions{}` says `bullshit_recognition`, and the instrument now reports that separately as "pushed under an alias" instead of miscounting it as a defect.
- **I re-committed a mistake this repository had already recorded.** While growing the corpus
  I added 4 "hedged fabrication" samples to `MALICIOUS` and 4 hedged benign samples to
  `BENIGN`. Both were wrong, and `scripts/calibrate-fp-recall.js` lines 281-292 already said
  why: the "vague source + precise number" class correctly produces **`verify`** (because
  `unsupported_claim` is a *verify-tier* dimension) while the script's "caught" means
  `block` or `rewrite`, so putting them in `MALICIOUS` counts correct behaviour as a miss.
  I had not read that note before adding samples. They were removed and the class is now
  guarded at the dimension level in `test/fp-hedge-exemption.test.js`, which also locks
  "these strings must not reappear in the corpus arrays". A measurement settled the related
  question too: the benign and malicious members of this class produce **identical**
  dimension profiles (`适量运动…20-30%` vs `这种药物…12.5 年`), so no hedge vocabulary can
  separate them — widening `HEDGE_RE` would exempt the malicious ones as well.
- Chinese tokenisation in the hypothesis stage is heuristic (greedy longest-match with a
  stopword list), not dictionary-based.
- **Reverse-enumerating the audit's own key set found two measurements that were taken every
  run and locked nothing — one of them the number convention #1 names explicitly.** Eleventh
  consecutive `doc-honest-numbers` cycle, and deliberately a *hardening* cycle rather than a
  new angle: the previous four had asked the audit about its keys (cycle 7), its patterns
  (cycle 8), its gates (cycle 9) and its file set (cycle 10), and all four were now covered.
  So this cycle diffed `pats`' key set against the keys `measure()` actually assigns. Of 32
  assigned keys, 21 had no pattern — and most of those are legitimately intermediate
  (`depsDeclared`, `depsOptional`, `nodeScannedFiles`, `instantInstallWorks`), inputs to a
  real key rather than claims of their own. But two were **current claims in the documents
  with nothing checking them**: `version`, which convention #1 singles out in its own words
  (*"Never hardcode the version. `VERSION` is the single source of truth… `package.json` and
  `SKILL.md` must match"*) while `measure()` has been reading it and the audit has been
  printing it all along — **measured, displayed, and never compared**; and `testsFailed`,
  parsed by the very same regex that produces `m.tests` and then dropped on the floor, so the
  "0 failing" in README, SKILL.md and CURRENT_STATE.md was a sentence that never had to be
  true. Both confirmed by injection: `v1.0.0` → `v9.9.9` and `0 failing` → `7 failing` each
  left the audit at 78/78 with **zero** mismatches. This is the cycle-7 `domains` shape
  again — a number that is measured is not a number that is locked — except this time it hit
  the one number the repository's own first convention names. **The version fix is the
  interesting one, because the obvious pattern is the wrong one.** Matching a bare
  `v?\d+\.\d+\.\d+` looks like coverage and is a trap: the scanned documents contain
  **551** version-shaped strings, and nearly all are roadmap and architecture milestones
  (`ARCHITECTURE.md`'s v6.3.0 / v6.4.0 / v6.5.0, `ROADMAP.md`'s v6.0.6) that are not the
  package version. That is the 26th instrument failure's lesson restated — an enumerating
  filter leaks once per new way of narrating, and version numbers have a dozen narrations.
  So the pattern only accepts two **labelled** forms: `| Engine version | 1.0.0 |` in
  SKILL.md's metric table and `> 版本 | v1.0.0` at the head of CURRENT_STATE.md. **And one
  near-miss is disclosed rather than quietly included:** `REFLECTION.md` carries
  `| 版本 | 6.2.7 |` under `## 现在（2026-07-25）`, a point-in-time snapshot pinned inside a
  "past / present / future" reflection document — checking it against today would
  manufacture a false alarm, and the bare Chinese `版本` label is no guarantee of "engine
  version" in an arbitrary table. Both new keys were verified by live injection in both
  directions, and the failing-count check could only be verified *without*
  `ASPIRA_AUDIT_SKIP_TESTS` — that flag nulls `m.testsFailed` along with `m.tests`, so under
  it a wrong failure count lands in "unmeasurable" instead of "mismatched", the same probe
  artefact recorded in cycle 9. Suite 1233 → **1239** (`test/audit-unlocked-measurements.test.js`,
  6 cases); verify 14/14; audit **82/82**; corpus unchanged (106 benign / FP 0.9%,
  41 malicious / recall 100%); no `src/` change, so MCP was not restarted. **One process
  note, recorded because it is the same class as everything above:** while live-injecting
  three documents I used a shell loop whose `IFS='|'` split on the pipe characters *inside*
  the markdown table rows, which silently corrupted `CURRENT_STATE.md`'s version line into
  ` v1.0.0| v1.0.0`. It was caught by re-reading `git diff` before running the gate and
  repaired, but the lesson is the one this file keeps relearning — **a tool that reports
  success while having written the wrong thing is worse than one that fails**, and here the
  shell's own success message was the misleading part.

- **The angle never asked was the inverse of cycle 10's, and answering it found an instrument that cannot tell "the document is wrong" from "the probe that rewrote the document did not put it back."** Nineteenth cycle, `doc-honest-numbers` again, and the engine chose it decisively this time (0.65, confidence 0.75 — the first discriminated pick since the tie). Cycles 7-12 had asked the audit about its keys, its patterns, its gates, its file set, its measured-vs-patterned keys, and a re-enumeration. The one question never asked is the inverse of cycle 10's *"what files does it scan?"*: **what is in the exemption list?** An exemption is the strongest form of not-measuring — it is a decision to not measure — so the list is where unaudited claims hide by design. Measured first, before touching anything: the audit scans **218** documents and exempts **1,215+**, of which `data/` is 1,120 byte-identical `CORE_VALUES.md` copies (1 distinct content, verified), `docs/` 40, `report/` 8, `plans/` 1, plus 66 name-exempted files (`EXEMPT_NAME_RE`). `skills/` — 246 files, the largest directory after `data/` — turned out to **be** scanned (189 of them), so the angle's first hypothesis was wrong and that was worth establishing rather than assuming. Two real defects came out of it, and the second is much deeper than the first. **The first: an exemption entry that points at a broken symlink.** `HISTORICAL_DOCS` lists `CHAT_LOG_HeartFlow_完整备份_2026-05-16.md`, and it cannot be read. The old code pushed ENOENT and permission errors into the same `exemptUnreadable` bucket, printed one ⚠️ and `continue`d — so the entry still counted in "显式豁免 N 份" while contributing nothing to "不同内容 N 份": **the audit inflated "how much is unaudited" with a document it cannot open.** That is the cycle-10 shape turned inside out — that time 682 copies were counted as *scanned* documents, this time a phantom was counted as an *exempt* one. The truth is better than "the file is missing": it is a **git-tracked symlink** pointing at `/root/mount/CHAT_LOG_HeartFlow_完整备份_2026-05-16_0437a209.md`, a path that exists only in some other environment. `readdirSync` sees it (it does not follow links); `readFileSync` follows it and gets ENOENT. The message now names the cause instead of conflating the two cases. **The second defect is the one worth the cycle, and I caused it while investigating the first.** The audit's main flow is `const m = measure()` (spawns `test/run-all.js` and runs the entire suite) **and only then** `const cl = claims()` (which is where documents are read). The test suite contains probe tests that *rewrite `SKILL.md`, `README.md` and `CURRENT_STATE.md`* — injecting `v9.9.9`, `139 modules` and the like, then restoring. Lines 964-965 of the script already acknowledged this coupling in a comment, but only to explain why `execSync` threw; nobody ever asked **what happens when a probe does not put the document back**. I found out by killing my own 60s-timeout audit runs: SIGTERM propagated audit → `run-all.js` → a probe test, killing it between injection and restore. The pollution stayed on disk, `claims()` read it, and the audit produced **7 mismatches blaming `SKILL.md`/`README.md` for "claiming 9.9.9" and "139 modules"** — none of which the repository claims. **The instrument cannot distinguish "the document is wrong" from "the probe that rewrites the document did not put it back,"** and it blamed the documents. Worse, the thing that runs the polluting tests is the audit itself: **the instrument measures itself through the thing it is measuring.** The fix is to snapshot every document's content *before* spawning, and have `claims()` read only the snapshot; whatever the probes do afterwards is invisible to the audit, which now checks the claims as they were when it started. Verified behaviourally, not just structurally: a `--require` preload hook intercepts the audit's `spawnSync('node', ['test/run-all.js'])`, dirties `SKILL.md` *during* `measure()`, and returns a fake runner summary — with the snapshot in place the audit reports no version mismatch, and the paired negative case (the document genuinely wrong, no hook) proves the check is not vacuous. **A third defect, pre-existing since cycle 10 and invisible until now: the repository's standard comment stripper silently deletes 44% of `audit-doc-numbers.js`.** The stripper (`test/self-diagnostic-paths.test.js:49`) assumes `/*` only appears in block comments. This file has a legal `/**` header on line 1, a `/*` hidden inside a *line comment* on line 57 (`skills/*/SKILL.md`), and a `*/` hidden inside a *string literal* on line 81 (`_tc_*/_cache_probe_*`). The block-comment regex therefore ran from line 1's `/**` all the way to line 81's `*/`: measured **58,528 bytes stripped to 32,679 (55.8% retained)**, and the entire `EXEMPT_DIRS` table — including the `data` entry — was deleted as "comment". **Any source-level lock on this file built on "strip comments first" matches nothing at all** — a check that can never fail, wearing the costume of a working check, which is the shape this file keeps recording. Both literals were rewritten to contain neither `/*` nor `*/`; retention is now a normal 56% and every key symbol survives, with a canary that fails the moment either literal comes back. **And the same cycle paid for a recorded lesson a third time: cleaning the probe pollution with `git checkout -- SKILL.md README.md CURRENT_STATE.md` reverted all three documents to HEAD (`8b2853c`), which predates the cycle 12-18 syncs.** Test counts fell back to 1182, the formula count to 1286, and the `17-layer pipeline*` footnote added two cycles earlier vanished; the only thing that noticed was `layer-count-two-readings.test.js`, a pure reader — exactly as cycle 7 recorded. **`git checkout -- <doc>` is not a safe way to clear probe pollution, because it restores the document to a stale commit rather than to its last-good state, and the pollution and the legitimate content live in the same file.** Suite 1351 → **1359** (`test/audit-self-pollution.test.js`, 8 cases, with live injection in three directions plus two "this lock can fail" proofs); verify 15/15; audit **84/84** (was 85/85 — the count is a function of document content, and no *current* scale claim lost coverage: 110 lines carrying numbers beside scale words were checked and all are historical narrative, code samples, per-file counts or quotations under criticism). `scripts/` and `test/` changed but `src/` did not, so **MCP was not restarted** (still 401 unauthenticated). One process note, same class as everything above: a timed-out command left `scripts/zz-orig.js` behind because its `rm` never ran — **a killed command leaves its debris, and the debris is indistinguishable from source until someone looks.**

- **The largest known gap was 39% vs 100%, the recorded "naive fix" had been measured net-negative, and the reason it failed is that the evasion transform is lossy — so the fix is to match space-tolerantly instead of restoring the text.** Eighteenth cycle, and the first on `adversarial-robustness` since cycle 4; the engine chose it itself (0.61, tie-broken by consequence_value after four options landed on the same score, confidence 0). The gap is the largest single one on record: letter-space evasion recall **39%** (16/41) against plaintext **100%** (41/41). AGENTS.md already recorded that widening `strip_letter_space` to 1–2 letter tokens was tried and **reverted** — 53 benign samples folded to recover 1 malicious one. This cycle re-measured before touching anything, and the control measurement is what reframed the problem: **every one of the 41 malicious samples is caught in plaintext, and zero are missed in both plaintext and evasion**, so all 25 evasion misses are *pure* evasion gaps, not pattern gaps. That matters because it means the fix belongs in the obfuscation layer, not the pattern tables. **Then the first thing I had wrong was the shape of the evasion itself.** I assumed `replace(/([a-z])([a-z])/gi, a+' '+b)` produces a uniform `d i s g u s t i n g n i g g e r` — one long run of single letters. It does not: the pairing is non-overlapping, so the product is **letters grouped in pairs**, `d is gu st in g n ig ge r`, with residual two-letter segments. Two consequences, and the second is the one that decides the architecture: (a) the residual `is`/`gu`/`st` segments break `strip_letter_space`'s "≥3 consecutive single letters" requirement, so the collapse layer never fires at all; (b) more fundamentally, **the transform is lossy** — the space that originally separated `disgusting` from `nigger` is byte-identical to every space the transform inserted, so collapsing yields `disgustingnigger` and the word boundary is unrecoverable, while `/\bnigger\b/` requires exactly that boundary. So the reverted attempt was not a badly-chosen threshold; **it was a dead-end route, and its net-negative measurement was the correct verdict on the wrong approach.** Any "restore then match" design has a ceiling set by the transform itself. The fix is to not restore: compile the term `nigger` to `\bn\s*i\s*g\s*g\s*e\s*r\b` and match it **in place on the original text**, where the surrounding spaces are still spaces and the `\b` anchors still hold. No collapse, no merging, no lost boundary. Measured: letter-space recall **16/41 → 29/41 (39% → 70.7%)**, +13, with plaintext 41/41 and benign FP **0/106** both unchanged, and the other two evasion classes untouched (char-separator 85.4%, HTML entity 95.1%). **Two boundaries were load-bearing and both were learned by getting them wrong.** First, `\s*` matches *zero* spaces, so every space-tolerant pattern is a strict superset of its plaintext form — which means the term list may only contain terms the engine **already blocks in plaintext**, because enabling the tolerance on a benign word converts that word into a false positive. Measured: auto-extracting literals from the pattern tables pulled out `always` and `rather`, and four benign samples were immediately mis-flagged. So `src/shield/letter-space-evasion.js` carries a hand-curated list, restricted to slurs and injection phrases already blocked by `hate_speech`/injection patterns. Second, and the more instructive failure: the signal is *named* "字母间距混淆", so it must not fire on plaintext. My first predicate required whitespace between **every** adjacent letter — which is exactly the uniform-single-letter shape I had wrongly assumed, so the module reported "not detected" for every real evasion. The correct predicate is *at least one* gap in the term's letter sequence. Both boundaries are now locked behaviourally rather than remembered. `test/letter-space-evasion.test.js` (8 cases) locks the pair-grouped shape itself, detection of seven evasion forms, that plaintext `nigger`/`developer mode`/`ignore all previous instructions` are **not** reported by this layer, that benign text including `h a t e speech is unacceptable and wrong` does not fire, that the term list contains no benign words, that the adversarial layer returns `rewrite`, and an eighth case that proves the lock itself can go red by running the *wrong* (uniform-single-letter) predicate and asserting it fails — **a check that can never fail is indistinguishable from no check**. Verified live in three directions: short-circuiting the detector, reverting the predicate to the uniform form, and deleting `nigger` from the term list each turn the lock red *by name*. Live MCP (restarted, 401 unauthenticated, `tools/list` → **181/181**) returns `rewrite` with reason `对抗变体: 词拆分、字母间距混淆(隐藏已知术语)` for `y ou a re a d is gu st in g n ig ge r` and `a ll n ig ge rs m us t d ie`, `block` for the plaintext slur, and `pass` for `hello world` and `今天天气不错`. Suite 1343 → **1351**; verify 15/15; audit **85/85**; AGENTS.md's own 39% evasion reading was corrected to 71% with a pointer to this entry. **The 12 residual misses are disclosed, not counted as solved:** eight are code-semantic samples (`eval(userInput)`, `new Function(userInput)`, `innerHTML`, `document.write`, SQL concatenation, `exec`, an RSA private key, a password assignment) that need code patterns rather than a word list; `women belong in the kitchen 女人就该待在厨房` needs phrase-level tolerance with mixed Chinese/English, which needs its own measured cycle; and `all f_aggot_s must die` belongs to the underscore-separator family, not this one. **One disclosure carried forward from an earlier cycle and confirmed again here:** the adversarial layer is reachable only through `aspira_gate_pipeline` — `aspira_gate_check` on the same evaded text still returns `pass`, because it runs `discriminate()` only. Agents that gate untrusted input with the lightweight tool are still outside this protection.

- **Static tool accounting had been green for three cycles, and calling all 181 handlers once found a gate that could never say "pass" — plus a test that had locked the defect in place by rationalising it.** Seventeenth cycle, and the first after `test-coverage-gap` was marked exhausted; the engine rotated on its own to **`mcp-tool-enhancement`** (0.62/0.65). The measurement was deliberately *behavioural* rather than static: convention #3's three-place rule and tool/handler mutual coverage were already locked by `test/mcp-tool-integrity.test.js` (7 cases, all green), so instead every one of the **181** handlers was actually invoked. First run of that instrument was wrong and had to be corrected before it meant anything: it called the handlers synchronously, so the **async** ones returned a Promise, `JSON.stringify` of a Promise is `{}`, and twelve healthy tools were reported as "returns size 2" while their rejections escaped as unhandled rejections — **an instrument that measures the wrong thing reports healthy code as hollow**. With `await`, the picture is clean: **132 ok / 18 throw "X 是必填参数" (correct validation) / 31 error-obj, of which 29 are also correct missing-parameter messages.** Two genuine defects. **The first was in `src/gate-outbound.js`'s `scanPII`, and it is the recorded shape at its purest:**

```
const findings = [
  { pattern: /邮箱正则/g,   type: 'email',       level: '内部' },
  { pattern: /\b[4-6]\d{15}\b/g, type: 'credit_card', level: '机密' },
  { pattern: /\b[PEG]\d{8}\b/g,  type: 'passport',    level: '机密' },
];
```

Three **pattern descriptors** that nothing ever matched against the text, pushed into the results as if they were findings. Three consequences: (a) each serialises to `{}` — no `id`, `name`, `severity`, `match` or `position`, so the caller receives a batch of **empty objects it cannot act on**; (b) `piiFindings.length` is therefore always ≥ 3, so `checkOutbound`'s `piiFindings.length > 0` branch is always true and **`action` can never be `'pass'`**; (c) real hits are inflated by 3 (measured: 2 real PII reported as `piiCount: 5`). Measured before the fix: `今天天气不错`, `hello world`, `12345` and `'   '` all returned `rewrite` with `reason: "命中 PII 规则 (3 处)"` — **and not one of those 3 existed.** An outbound gate that reports PII for every input is no gate at all, and it looked perfectly healthy because real PII *was* still caught. Fix: `findings` starts empty, and of the three descriptors only **passport** was genuinely uncovered — `email` is equivalent to `PII_RULES.EMAIL` and `\b[4-6]\d{15}\b` is a subset of `PII_RULES.BANK_CARD`, so re-adding either would double-count the same span (the `unsupported_claim`/`pseudo_causal` shape already recorded), while `PASSPORT` is promoted to a real rule so it gets the same `id`/`name`/`severity` as every other rule and enters `maskPII`. **The second defect is the one worth the most, because a test had locked the first one in place:** `test/compliance/compliance.test.js`'s `G3-4` asserted `checkOutbound({ text: '今天天气真好' }).action === 'rewrite'`, with the comment *"实际: 公开内容触发 PII 规则 rewrite（非 bug，是 PII 规则触发）"*. That sentence is **the defect's own product, offered as a justification** — the author mistook the phantom findings for real PII hits, and the assertion then made the broken behaviour load-bearing. It is the same lesson as `G3-3` in the same file, fixed earlier: that time `forcedLevel`'s string/object contract mismatch killed the classification `block` branch, and the test's comment likewise recorded the broken behaviour as "实际". **Twice in one file a comment has argued that a defect is the design.** `G3-4` now asserts the designed behaviour (`pass`, `piiCount: 0`) and keeps its original *intent* — PII present → `rewrite` with sanitisation — using a text that actually contains PII. The second genuine defect was smaller: `aspira_check_outbound` returned a raw `TypeError` message (`Cannot read properties of undefined (reading 'toLowerCase')`) where the other 18 missing-parameter tools return a clean `text 是必填参数`, because `checkOutbound`'s parameter was destructured with no default; the parameter is now normalised first (a `= {}` default alone is not enough — it covers `undefined` but not `null`) and validated at entry. `test/outbound-pii-no-phantom.test.js` (5 cases) locks it: `findings` must initialise to `[]`, `pass` must be reachable for PII-free text, `piiCount` must equal the real hit count for four single-PII cases, every finding must carry actionable fields, and a fifth case proves the lock itself can go red by running its own predicate against a known-phantom array — **a check that can never fail is indistinguishable from no check**. Verified live in three directions: re-adding the phantom turns three cases red *by name*, and the live server (restarted, 401 unauthenticated, `tools/list` → **181/181**) now returns `pass`/`piiCount 0` for clean text and `rewrite`/`piiCount 1` for a phone number. Suite 1338 → **1343**; verify 15/15; audit **85/85**; corpus unchanged (106 benign / FP 0.9%, 41 malicious / recall 100%); `src/gate-outbound.js` changed, so MCP was restarted.

- **Convention #6 had never been enforced by anything, and following "what can the gate not see" found a second instance of the same shape: two self-diagnostic steps that fail 100% of the time, in a diagnostic no test has ever run.** Sixteenth cycle, fourth consecutive `test-coverage-gap`. Convention #6 reads: *"Verify syntax after every edit: `node --check <file>`."* A pure human-discipline rule: measured, **no test in the repository executes it** — `--check` appears exactly once in `test/`, inside a comment in `test/unwired-module-coverage.test.js`. There are **351** JS files under `src/`. The claim was checked rather than assumed: instrumented `Module._load` via `NODE_OPTIONS='--require'`, which the runner's 236 subprocesses inherit, and measured that the whole gate loads **348 of 351** — **29 never loaded, of which 21 are live non-archive modules** (`src/dream/dream-engine.js`, `src/core/sleep-wake.js`, `src/heartflow-api-server.js`, `src/reasoning/verifier.js`, …). A syntax error in any of those 21 is *completely* silent. Proven by injection, and the proof required correcting my own instrument twice: first I measured "uncovered" by grepping test *text* for the module name, and injected into `src/ai-anti-pattern.js` — the suite went **1002/130 red**, because that file *is* loaded by `heartflow.js`; a name not mentioned in tests is not a module not loaded. Second, the decisive run had to **move the new lock out of the tree** to simulate the gate as it was, and with the lock removed, a syntax error in `src/dream/dream-engine.js` left **run-all at 1333/0 and verify at 15/0 — both all-green, with zero mention of the file**. The kicker that makes this the recorded shape rather than a coverage statistic: there *is* a `test/dream-engine.test.js`, and it passes — but it requires `src/dream/engine.js`, **a different file**. So the module looks covered by name. `test/src-syntax-check.test.js` (2 cases) now runs `node --check` over all of `src/`, and its second case is deliberately more important than its first: a deliberately-broken temp file *must* be reported, because **a check that can never fail is indistinguishable from no check** — the deduplicator that printed "811 份全不同、0 重复" while its `crypto.createHash` threw a swallowed `ReferenceError` is the same lesson, and the instrument choice here was corrected for the same reason: `new vm.Script(src)` is 180× faster and reported `src/core/heartflow.js` as *"Illegal return statement"* where `node --check` reports zero errors, because `vm.Script` does not wrap the module and a top-level `return` is legal in CommonJS — **an instrument that reports its own limitation as an engine defect**. Convention #6's own wording is used verbatim, no translation layer. **Then the second gap, found by the same thread and the same shape:** `src/core/self-diagnostic.js`'s 20-step diagnostic has **step 17 and step 18 failing on every single run** — step 17's engine table points **5 of 6 entries at directories that do not exist** (`PsychologyEngine` says `src/core`, real is `src/emotion`; `DreamEngine` says `src/core`, real `src/dream`; `SelfModel` says `src/core/consciousness`, real `src/identity`; `SelfHealingRL` and `LessonBank` say `src/core`, real `src/cortex`), measured `allFound = 1/6` against the step's own pass threshold of `>= 4`; step 18 looked for `dream-engine.js` / `dream.js` / `interactive-dream.js` under `src/core/` when all three live in `src/dream/`, so `found` is always empty. Nothing noticed because **no test anywhere calls `runDiagnostic`** (`grep -rln runDiagnostic test/` → empty): the entire 20-step self-diagnostic has never been executed by the gate. And the most pointed detail is in the old comment above step 17's table — titled *"引擎实际文件位置（已确认）"* and listing *"DreamEngine: dream.js"*, while the `dir` on the very next line still says `src/core`: **the comment knew the correct location and the code used the wrong one.** Both steps were repaired (measured `6/6` and `found: [3 files]`, 20 steps, **0 failing**). The lock is deliberately *source-level* and does not run the diagnostic, because `step19_versionSync` **writes files** — it rewrites `package.json`, `SKILL.md`, `README.md` and `heartflow.js` when versions disagree, so letting a test run `runDiagnostic()` would let the suite rewrite repository source, and under the concurrent runner two processes doing that at once is exactly the cycle-7 probe-pollution defect; the same discipline as *a test that spawns the audit must hold the doc lock* — **anything that can write must not be casually run**. `test/self-diagnostic-paths.test.js` (3 cases) statically核对 the table against disk, guards against vacuous pass by requiring exactly 6 parsed entries, and strips comments first — necessary because the repair wrote the real locations into comments, and an un-stripped lock would read its own documentation as the offence, which is the cycle-14 and cycle-15 trap for the third cycle running. Verified live in three directions: reverting either wrong path is caught *by name*, and a comment-only change still passes. Suite 1335 → **1338**; verify 15/15; audit **85/85**; corpus unchanged (106 benign / FP 0.9%, 41 malicious / recall 100%); `src/core/self-diagnostic.js` changed, so **MCP was restarted** — 401 unauthenticated, and `tools/list` with the token returns **181/181** `aspira_*` tools. One process failure worth recording because it is the same class: an earlier injection script was killed by its 60s timeout *after* writing a broken module and *before* restoring it, so `src/dream/dream-engine.js` sat broken and the next script silently adopted the broken content as its "backup" — caught only because the restore check compared against `git status` rather than trusting the in-memory copy. **A restore that trusts the same variable that was corrupted is not a restore.**

- **Cycle 14 fixed the mount files that were never counted; following the same thread found 33 test files that were checking nothing at all, and whose failure output was byte-for-byte indistinguishable from success.** Fifteenth cycle, third consecutive `test-coverage-gap`. The thread was: *of all the test files run-all executes, which ones contribute **zero** cases to the total?* Cycle 14's fix made every mount-style file count. Measured next: **32 files still contributed 0 cases**, and none of them was mount-style — all 33 (32 plus one at root) shared one template:

```
const assert = require('assert');          // required, never used
async function run() {
  try {
    const mod = require('../../src/utils/logger.js');
    console.log('PASS logger.test.js (module loads)');
  } catch (e) {
    // Module may have optional deps or initialization requirements
    console.log('SKIP logger.test.js (' + e.code + ': ' + e.message.slice(0, 60) + ')');
  }
}
run().catch(e => console.log('SKIP logger.test.js: ' + e.code));
```

Three consequences stack to make this check **equivalent to not existing**: (1) on load failure it prints `SKIP` and **exits 0** — measured directly by repointing the `require` at a nonexistent module, exit code is 0 in both cases, so *load failure and load success are indistinguishable*; (2) neither the `PASS` nor the `SKIP` line contains 通过/失败, so run-all's `emitResult` regex `/(\d+) 通过, (\d+) 失败/` matches no summary line and the file contributes **0 passes and 0 failures**; (3) it requires `assert` and never calls it — a check that cannot fail by construction. So **if `src/utils/logger.js` were deleted, renamed, or given a syntax error, run-all would still report all-green.** This is not low coverage; it is a thing that claims to be checking while checking nothing, and whose failure mode is *textually identical in shape* to its success mode. It is the recorded shape — **a catch that turns an exception into a plausible answer is more dangerous than no self-check** — except here it is not one catch inside one self-check: it is **one catch replicated across 33 files**, and its failure output (`SKIP ...`) looks exactly like a legitimate test status line. All 33 were converted to mount style (`test('X 模块可加载', () => require(...))`), so a load failure is now 1 counted failure. All 33 loaded successfully before conversion, verified first, so nothing was traded away. `test/no-silent-skip-loadcheck.test.js` (3 cases) mechanically forbids the shape from returning, checks that the converted files really do count ≥1 case with 0 failures, and checks that no "module loads" file requires an unused `assert`. **The lock then failed against its own fix, at 33-file scale**: the conversion script wrote the *old template verbatim* into each repaired file's JSDoc to explain what it replaced, so "this shape must not appear" immediately judged all 33 freshly-repaired files guilty. This is the cycle-14 trap exactly — that time `pickJob`'s JSDoc quoted the removed bypass and an un-stripped source lock read its own documentation as the offence — relearned once, and paid for again one cycle later at 33× the size. Both predicates now strip comments before matching, and the second injection case exists specifically to prove the stripping works. **The lock's scope also had to be corrected:** it initially scanned `archive/` too and went red on 10 dead-test files whose target modules were deliberately deleted. A lock that scans files the runner never executes can be red for reasons that do not affect the gate at all, which trains people to ignore it — so it now scans exactly `collectTestFiles`' live set and **discloses** the 10 archived occurrences in a `[note]` line rather than hiding them or failing on them. Suite 1297 → **1333**; verify 15/15; audit **85/85**; corpus unchanged (106 benign / FP 0.9%, 41 malicious / recall 100%); no `src/` change, so MCP was not restarted.

- **Convention #4 warned about the wrong thing, and the real gap was one layer earlier: run-all.js bypassed every subdirectory test file before it ever looked at the file's style.** Fourteenth cycle, second consecutive `test-coverage-gap` (the engine chose it again, 0.63/0.7 — the slice is not exhausted). Convention #4 reads: *"Tests must be reachable by `test/run-all.js`. It walks `test/` recursively and executes each file in a subprocess. A test file that requires `../src/...` from a subdirectory must use the correct relative depth, or it will never run."* It warns about **relative depth**. Measured: all **271** non-archive test files *are* collected and *are* executed — depth is not the problem. The problem is **how**: the dynamic loop opened with `if (rel.includes('/')) { jobs.push(subTestJob(...)); continue; }`, so every subdirectory file was run with bare `node <file>` and the style detection below it — mount / arrow-mount / jest, the very detection that had already been repaired once for root-level files at lines 234-238 — **never applied to them at all**. The same rule covered exactly half the files, and that half was every subdirectory. Consequence for a mount-style file: `node <file>` exits 0 with no output, `emitResult` matches no summary line, and the file contributes **0 cases and 0 failures**. Measured cost: **39 pre-existing test cases had never entered the total** — `identity/agent-psychology.test.js` (21 `test()` calls; bare → nothing, via `_mount.js` → 21), and two `CORE_TESTS` entries that used `subTestJob` directly and so bypassed detection a second time: `knowledge/classics-value-mapper.test.js` (10) and `agent-boundary-guard.test.js` (8). run-all reported **1253 passing** with 39 of those cases never counted, and 1253 looked entirely normal. **This is the cycle-7 shape at the suite level: a number measured, displayed, and never compared — except here it is starker, because the cases were not merely unmeasured, they were *present, traversed, and silently reduced to zero*.** `classics-value-mapper.test.js` was **doubly** silent: it declared the mount signature `function({ test })`, never called `test()`, built its own `cases` array, and printed `classics-value-mapper: 11 cases passed` — a line containing neither 通过 nor 失败, so even a correct harness would have counted 0. Converting it to real harness usage surfaced a **wrong expectation that had never run**: it asserted `parseHit('no-colon-here').file` is truthy, while the real contract (`src/knowledge/classics-rules.js:1033`) degrades to `{ file: null, line: null, raw }`. **An assertion that has never executed is not an assertion** — it had been green only because it had never run at all. Fixes: one shared `pickJob()` now decides every file's style (CORE_TESTS *and* the dynamic walk), and the file itself now calls `test()` with the expectation corrected to the real degraded shape. `test/subdirectory-test-reachability.test.js` (5 cases) locks it in two layers — a static check that every mount-style file's export body actually calls `test()`, and a behavioural check that each subdirectory mount file yields ≥1 case with 0 failures through `_mount.js`. Both layers were needed: the static check matches the *text* `test(`, so renaming the injected parameter (`function ({ test: _unused })` while still calling `test(...)`) slips past it, and only the behavioural check catches that. The source-level lock that the bypass is gone had to **strip comments first** — `pickJob`'s own JSDoc quotes the removed bypass verbatim to explain what it replaced, and an un-stripped lock treated its own documentation as the offence and would have stayed red until someone deleted the real lock along with it. Suite 1253 → **1297**; verify 15/15; audit **85/85**; corpus unchanged (106 benign / FP 0.9%, 41 malicious / recall 100%); no `src/` change, so MCP was not restarted.

- **Convention #1 named five places that must agree on the version, and nothing checked any of them.** Thirteenth cycle, and the first after `doc-honest-numbers` was marked exhausted — the engine rotated to **`test-coverage-gap`** on its own, which is where the cross-slice gap recorded in cycles 11 and 12 belonged. Convention #1 reads: *"Never hardcode the version. `VERSION` is the single source of truth. `src/core/version.js` reads it and carries a fallback that must match. `package.json` and `SKILL.md` must match. `hf.version` reads `VERSION` at runtime."* Five named locations. Measured: **`bin/verify.js` checked none of them** (its only version-ish check is the Node major version), **no test called `scripts/sync-version.js`** (it is referenced only in `package.json`), and `scripts/audit-doc-numbers.js` — added in cycle 11 — locks only the *document* claims (`| Engine version | 1.0.0 |` in SKILL.md, `> 版本 | v1.0.0` in CURRENT_STATE.md), which says nothing about `package.json`, the fallback literal, `BUILD_DATE`, or the runtime value. So `sync-version.js` is a **writer with no verifier**: bump `VERSION`, forget to run it, miss any one of the five, and nothing anywhere says a word. All five happened to agree at 1.0.0, which is exactly why this survived — **a consistent system and a locked system look identical until the day they diverge.** `test/version-consistency.test.js` (8 cases) now locks all five, and the same check was added to `bin/verify.js` as a fifteenth item so the convention's own prescribed gate reports it. **The fallback is the case worth the whole cycle, because `src/core/version.js` already documented the hazard in its own comment:** *"兜底值必须与 VERSION 保持同步 —— 否则 VERSION 文件读失败时(打包遗漏/权限问题)引擎会自报一个落后几十个版本的号，**且外部没有任何提示**。"* That is the guard-that-hides-the-failure shape this repository keeps recording: the fallback exists solely for the moment the `VERSION` read fails, and on every normal run the read succeeds, so **the fallback is never evaluated — a wrong fallback produces no output at all.** It only speaks at the worst moment, and at that moment it is silent about being wrong. The test therefore proves the fallback path actually executes rather than merely asserting the literal matches: it copies `version.js` into a temp directory with `safe-fs` stubbed to throw (stubbing rather than copying the real dependency chain, because `safe-fs.js` itself requires `path-guard.js` and the scenario being simulated is "the read fails" — missing file, permission denied, or the guard rejecting the path are one `catch` to `version.js`), and asserts the module falls back to the literal. No repository file is touched, which matters after cycle 11's lesson that a tool reporting success while writing the wrong thing is worse than one that fails. All four injected drifts (`package.json`, `SKILL.md`, the fallback literal, `BUILD_DATE`) turn the suite red by name; verify 14 → **15**; run-all 1245 → **1253**; audit **85/85**; corpus unchanged (106 benign / FP 0.9%, 41 malicious / recall 100%); no `src/` change, so MCP was not restarted.

- **Re-running the cycle-8 enumeration after the scan set shrank fourfold found the formula library — three documents, three numbers, and zero measurements.** Twelfth consecutive `doc-honest-numbers` cycle. The previous five had asked the audit about its keys (cycle 7), its patterns (cycle 8), its gates (cycle 9), its file set (cycle 10) and its measured-vs-patterned keys (cycle 11), so this cycle re-ran cycle 8's mechanical enumeration rather than inventing a new angle — the earlier conclusion was measured on **798 scanned documents and 2,792 numeric hits**, and both the file set (now **218**) and the key set (six keys added) had since changed, so "we already enumerated this" was itself a stale reading. Of the **623** auditable forms that still produce no claim, the scale-level ones are almost all subdirectory workflow guidance (`500 行`, `164 个 JS/TS`) and historical milestones — **except one**: the formula library. `INSTALL.md` claimed `公式库(2397个)`, `CURRENT_STATE.md` claimed `1286 formulas`, and `formulas/README.md` described `formulas.json` as `未拆分前的完整382条公式文件`. Three documents, three numbers, and **`formulas` appeared zero times in the audit**. Measured: `src/formula/formula-module.js:13`'s `formulasFile` default is `formulas/formulas.json`, which holds **608** entries — so the first claim was inflated ~4×, the second ~2×, and the third was a *pre-split* value that had been overtaken by growth (cognitive_science 119→149, psychology 61→101, philosophy 34→65, physics 12→95, mathematics 84→126). **A stale reading is harder to catch than a wrong one, because it was once correct.** The patterns deliberately lock only the *total*: `formulas-core.json` (284) and `formulas-archive.json` (98) are per-file counts, both measured true, and matching them against 608 would manufacture false alarms — the same confusion between two different quantities in one family that has produced instrument failures before. **Then the new keys broke two existing regression locks in a way worth recording, because it is the misleading-failure shape this file keeps documenting.** `test/audit-gate-scope.test.js`'s `作用域计数不得被当成引擎总量` and `行内代码跨度内的数字…` both asserted `assertEqual(mismatchCount(out), 0)`, and their own comment explained why: *"「当前文档 0 不符」就是 notScoped 的回归锁"*. The moment three documents were found to have genuinely wrong formula numbers, both turned red — with failure messages pointing at `notScoped` and `inCodeSpan`, while the real cause sat in `INSTALL.md`. **A regression lock that uses "the whole audit is green" as a proxy for "my gate works" is coupled to every future new key**, and it fails by naming the wrong suspect. Both are now targeted: they assert only that the specific phrases their gate is responsible for (`Tier-2 module`, `tier 1 modules`, `across 8 modules`, the quoted `1216`) never enter the mismatch list — so removing `notScoped` still fails them, but an unrelated wrong document no longer does. Suite 1239 → **1245** (`test/formula-count-measured.test.js`, 6 cases, with live injection in all three documents plus a regression lock that the per-file counts are never matched against the total); verify 14/14; audit **85/85**; scanned documents 218 (217 distinct, 1 duplicate); corpus unchanged (106 benign / FP 0.9%, 41 malicious / recall 100%); no `src/` change, so MCP was not restarted.

- **The audit had never been asked which *files* it scans, and the answer inflated its own
  coverage number fourfold.** Tenth consecutive `doc-honest-numbers` cycle. The previous
  three cycles asked the audit about its keys (cycle 7: "what was never measured?"), its
  patterns (cycle 8: "what numeric forms exist?"), and its gates (cycle 9: "which of my own
  rules can never let a claim through?"). This cycle asked the one question never asked:
  **what is in the file set?** Measured answer: the audit self-reported *"已扫文档 904 份"* —
  but `data/` held **682 byte-identical copies of `CORE_VALUES.md`**, one per
  `_tc_<ts>_<rand>/` and `_cache_probe_<ts>/` directory, all leaked test cache/probe
  artifacts. Real distinct documents: **222**. The self-reported number was **4× inflated**,
  and **6,192 of the 28,592 raw numeric forms (21.7%)** came from those copies, so the
  coverage percentage's numerator and denominator were both polluted by one 332-byte
  constitution containing nine list ordinals and **zero** engine-scale claims. Same family as
  the recorded "22.3% only counted the root directory, so the self-report was itself
  optimistic" — opposite direction: that time the denominator was too small, this time the
  denominator held things that were not the denominator. **A count that reports copies as
  documents is worse than no count, because it makes coverage look broader than it is.**
  `data/` is now exempt with a written reason (runtime data, not documentation), and the
  self-report additionally prints **distinct-content** and **byte-duplicate** counts, because
  a number that can silently re-inflate is a number that will. **A second artifact surfaced
  in the same probe**: a directory in the repo root literally named `"`, containing an entire
  quoted absolute path tree (`"/var/folders/…/T/aspira-mx-D4BRqZ"/` with its own
  `CORE_VALUES.md`, `.opencode/memory/heartflow_state.json`, `data/agent-card.json`). Its
  entry point was already fixed in an earlier cycle (`resolveHFDir()` returned
  `process.env.HEARTFLOW_DIR` unvalidated, so a quoted value silently built a quoted tree;
  both copies now run `sanitizeHFDir()`), `.gitignore` carries `*aspira-mx-*`, and the
  leaked tree was **never cleaned up** — the audit kept scanning it. `walkMd` now skips
  directories whose names contain quotes, backticks, or control characters: a legitimate
  documentation directory never has a quote in its name. **And the deduplication I added to
  make the self-report honest was itself silently broken.** It read
  `catch (_) { nDistinct++; continue; }` while `crypto` was never imported, so
  `crypto.createHash` threw a `ReferenceError` that the catch swallowed, and every file fell
  into the "count as distinct" branch — the output read *"811 份全不同、0 重复"*, which looks
  exactly like a working deduplicator and is a deduplicator that never ran once. A catch that
  turns an exception into a plausible answer is more dangerous than no deduplication at all:
  it makes a broken self-check display as passing. Both the import and the loud failure are
  now locked. Suite 1227 → **1233** (`test/audit-scan-set-hygiene.test.js`, 6 cases, with
  live injection: a directory named with a quote must not increase the scanned-document
  count, and must be reported as a leaked artifact); verify 14/14; audit **78/78**; scanned
  documents **904 → 218 (217 distinct, 1 duplicate)**; raw numeric forms **28,592 → 1,242**;
  corpus unchanged (106 benign / FP 0.9%, 41 malicious / recall 100%); no `src/` change, so
  MCP was not restarted.

- **The audit's third angle was to ask which of its own rules can never let a claim
  through — and the answer was that the README front page, the repo's most prominent
  claims line, was unaudited in its entirety.** Ninth consecutive `doc-honest-numbers`
  cycle. The previous two cycles asked the *documents* ("what was never measured?" →
  `domains`; "what numeric forms exist?" → `benign`/`malicious`). This cycle asked the
  *audit*: **which of my own gates can never pass?** Probing README's front page —
  `54 discrimination dimensions × 17-layer pipeline* × 132 modules × 181 MCP tools ×
  1,510 dispatch routes × 1216 passing tests × 0 runtime dependencies` — number by
  number gave: `0 runtime dependencies` → **swallowed by `selfRef`**; `1216 passing
  tests` → **swallowed by `selfRef`**. Meanwhile the *same* number in the table below
  (`| Test suite | 1216 passing`) was audited. The cause: `selfRef` looks for
  `aspira|新愿|heartflow|引擎|本仓库|判别|discriminator` only in the text *before* the
  number, and that line's context contains none of them — **of course it doesn't: the
  README is the engine describing itself, and it need not shout its own name inside its
  own house.** So the most visible line in the repository, including the headline design
  principle "zero runtime dependencies", was outside the audit altogether. Same family as
  the 29th failure, but worse: that time one pattern was eaten; this time **a whole class
  of document (the engine's self-description) was systematically excluded**, and 53/53
  green only meant "the 53 it knows about are right". The fix is **not** to delete
  `selfRef` (that reintroduces the subdirectory false positives it was built for) but to
  narrow its scope to the problem it was built to solve: it guards *subdirectory* docs —
  generic specs, case descriptions, upgrade examples whose numbers are not engine scale.
  Top-level self-description documents exist to describe this engine, so a scale claim in
  them is a claim about this engine *by construction*. **Then a second gate was needed,
  because widening the first immediately flooded in local counts**: `Never require a
  Tier-2 module at the top of heartflow.js`, `At low effort only tier 1 modules run`,
  `11 refs across 8 modules`. All three are about aspira but none is about aspira's
  *total*. `selfRef` answers "is this claim about aspira?"; `notScoped` answers "is it
  about aspira's **total**?" — a number preceded by a scoping word (`tier`, `across`,
  `only`, `each`…) is a local quantity, not an inventory. **And the same probing exposed a
  third, subtler shape**: the key existed, the pattern existed, and the claim was still
  invisible because the word order was reversed — the docs write `1216 passing tests`
  while every pattern expected `tests passing`. Rounds 7 and 8 fixed "no such key"; this
  round found **"the key and the pattern both exist and that one phrasing still never
  matches"**, which looks like coverage and is not. The new pattern immediately surfaced
  a stale `165 passing tests` in SKILL.md — a *historical* reading ("were silently never
  counted", describing the old runner's blind spot), which `narrativeQuote` missed because
  it only inspected the text *before* the number and the past-tense verb sat *after* it.
  Suite 1216 → **1227** (`test/audit-gate-scope.test.js`, 9 cases, plus
  `test/doc-probe-lock-coverage.test.js`, 2 cases); verify 14/14;
  audit **76/76**; corpus unchanged (106 benign / FP 0.9%, 41 malicious / recall 100%);
  no `src/` change, so MCP was not restarted. **And I re-committed the cycle-56
  concurrency defect in my own new test**: `作用域计数不得被当成引擎总量` spawned the
  audit *without* holding `_doc-probe-lock`, so under the concurrent runner it read another
  test's probe injection and reported a mismatch that did not exist. Direct run: 8/8 green.
  Under `run-all`: 1 failure, pointing at an assertion unrelated to the real cause. A test
  that spawns the audit must hold the lock — the same rule, relearned. **I violated it a
  third time in the very next test I wrote** (`行内代码跨度内的数字是被引用的字面量`), so the
  rule is now locked *mechanically*: `test/doc-probe-lock-coverage.test.js` scans every test
  file, finds the helper that spawns `audit-doc-numbers.js`, and requires every one of its
  call sites to sit inside a `withDocLock` callback. That guard was itself wrong twice
  before it worked — it matched a generic `execFileSync('node', [SCRIPT]` and pulled in two
  tests that run *other* audit scripts (`mcp-contract-audit.js`, `mcp-echo-audit.js`), and it
  inspected the spawn *statement* instead of the helper's *call sites*, so every compliant
  file was reported as an offender. Verified live: removing one lock makes it name the exact
  file and line. A rule I keep relearning is a rule the suite should enforce, not one I
  should remember.
- **The audit's own blind spot was found by enumerating the key set against every numeric
  form the documents actually contain — and the new instrument then failed in the opposite
  direction, swallowing a wrong claim instead of reporting it.** Eighth consecutive
  `doc-honest-numbers` cycle. The previous cycle ended by recommending rotation and leaving
  one concrete direction: *mechanically enumerate* the audit's key set against every numeric
  form the docs contain, instead of asking a human. Done. Of 2,792 numeric hits across 798
  scanned docs, the patterns covered **121 (4.3%)**; almost all of the rest is noise
  (`ms`, `KB`, `Phase`, `Astra`), but filtering to engine-scale forms surfaced
  `benign` / `malicious` — and **the corpus size is the denominator of both the 0.9% FP and
  the 100% recall**, so a wrong denominator silently distorts two percentages at once while
  nothing reports it. A wrong denominator is worse than a wrong percentage: the percentage at
  least gets doubted, the denominator is treated as known. Measured by parsing
  `calibrate-fp-recall.js`'s array literals — **not** by requiring it, because that script's
  top level runs the whole calibration and writes to `data/feedback/`; measuring something
  means first checking what it does as a side effect. **Then the new instrument failed the
  way this slice had never failed before.** Injecting a wrong value (against a measured 106) produced
  **no report at all**. Traced layer by layer: `selfRef` looks for
  `aspira|新愿|heartflow|引擎|本仓库|判别|discriminator` only in the text *before* the
  number, and the sentence is *"measures it on a hand-written labelled corpus of a wrong count"* — the subject is `it`, so not one self-reference word appears literally, so
  `reject` passed the claim through and the wrong number was **silently skipped**. That is
  the mirror image of a false positive: a false positive reports a true thing wrongly —
  loud but visible; **a miss swallows a false thing quietly — and the whole value of an
  audit is that it misses nothing.** A gate that eats wrong claims is worse than no gate.
  `ENGINE_SELF` now also recognises the engine's self-assessment vocabulary
  (`false-positive` / `recall` / `corpus` / `calibrat` / `labelled`), and `NARRATIVE` gained
  the growth/increment forms (`grew by`, `additional`, `to recover`, `from N to N`) that the
  widening immediately exposed — *"The corpus grew by 16 benign … and 7 malicious"* and
  *"folded 53 additional benign samples to recover 1 malicious one"* describe how the corpus
  once grew, not what it is now. **The second fix is an enumeration, and an enumerating
  filter leaks once per new way of narrating.** Declared as residual risk in the source
  comments and here, not papered over. Suite 1210 → **1216** (`test/corpus-size-measured.test.js`,
  6 cases, with live injection: a wrong corpus number must turn the audit red); verify 14/14;
  audit **51/51**; corpus unchanged (106 benign / FP 0.9%, 41 malicious / recall 100%);
  no `src/` change, so MCP was not restarted.
- **`self-view.json` 的计数曾经一次 `think()` 被计两次，并发下还会丢——前者已修，后者只修了一半。**
  `src/core/think-pipeline.js:190` 与 `src/core/heartflow.js` 里各有一处自增
  `thinkCount`/`lowConfCount`/`blockedCount`，于是串行 think 5 次得 10、think 10 次得 20，
  正好翻倍；6 个进程各 think 一次得 12（期望 6）。计数现已只保留 pipeline 一处，
  heartflow 那处退化为只落盘 + 喂 Reflector，并顺带统一了 `lowConfCount` 的阈值
  （原先 pipeline 用 `conf<0.3`、heartflow 用 `conf<0.4`，同一次 think 会因阈值不同被分别计一次）。
  并发丢失那一半**没有**修好：原实现是「内存态整份覆写」，启动时读一次旧文件、
  之后每次 think 把自己累加后的整份 `_selfView` 覆写回去，多进程并发时后写覆盖先写。
  实测 6 进程同时各 think 10 次（每次间 120ms 拉宽窗口）丢失 67%–83%。
  现已改为「写前重读磁盘 + 合并 + 临时文件 rename」，修掉了「读者读到写了一半的文件」
  这一类，但取计数器 max 只能取到「走得最远的那份」，无法还原总量——**残余丢失仍在**。
  彻底解法是 append-only 增量日志或文件锁；增量日志试过，因与既有的
  「启动载入视图」语义双算（`thinkCount` 飙到 1700 万）而回退。
  `test/self-view-counting.test.js` 锁住已修的部分，并把残余风险写在测试注释里而不是假装修好。


## GitHub

https://github.com/mark-cell-520/aspira
