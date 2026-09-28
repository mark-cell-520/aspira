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
  against **85%** (character-wise separators), **39%** (spaces between letters) and
  **95%** (HTML entities) on the same 41 samples. Same lesson as the corpus gap above:
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
- **The rotation mechanism that was supposed to stop slice lock-in was itself a one-way valve, and it had silently shrunk the candidate space.** For four consecutive cycles the decision engine picked `test-coverage-gap` at an identical 0.63, which I flagged last cycle as a possible broken rotator. Measuring it this cycle: the decay weight *works* — 28 completions dropped its `consequence_value` to the 0.05 floor — yet it still won, because `consequence_value` carries only **0.25** of the composite while its `feasibility` (0.75), `risk` (0.2) and `confidence` (0.7) carried the other terms. That is not the bug. The bug is that `doc-honest-numbers` — the one option that beats it, with feasibility 0.85 / risk 0.15 — **was not in the candidate list at all**. `scripts/autonomous-upgrade.js` did `if (j.once || j.exhausted) completed.add(j.chosen)`, and `add()` skipped anything in `completed`, so a single journal entry marked `exhausted: true` removed that slice **forever**. The judgement in that entry was correct at the time — the slice really was exhausted then — but **exhaustion is recoverable**: document counts drift out of sync again every time the code grows, and the slice had already been completed nine times since. A mechanism added to *produce* rotation ended up **destroying** it, because it removed the strongest counterweight to the slice that keeps winning. `once` is still permanent removal (wiring `text-normalizer` is done when it is done); `exhausted` is now a **cooldown** — the slice returns to the candidate set after 6 cycles. Immediately after the fix the engine selected `doc-honest-numbers` (0.65 vs 0.63). Two `status=decided` journals I created while debugging the fix were deleted; `test/exhausted-cooldown.test.js` (4 tests) locks that `once` stays permanent, that a freshly-exhausted slice does not compete during cooldown, that it **does** compete and win after cooldown, and that the source no longer conflates the two flags. Suite 1178 → **1182**; corpus unchanged (106 benign / FP 0.9%, 41 malicious / recall 100%); only `scripts/` and `test/` changed, so MCP was not restarted.
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
