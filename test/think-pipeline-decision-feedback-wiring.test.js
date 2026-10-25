/**
 * test/think-pipeline-decision-feedback-wiring.test.js —
 * DecisionFeedback 学习闭环从写下起一次都没执行过(同一形状的第二处 ReferenceError)
 *
 * 第一百七十一轮修好了同文件里 getFormulaBridge 的 ReferenceError —— 那次是
 * "一段 90 行的公式计算被 try 吞掉, 整段从未执行"。同一形状在本文件还有第二处,
 * 且更隐蔽: 它吞掉的不是 90 行, 是**整个学习闭环**。
 *
 * ═══ 缺陷 ═══
 * AREX 递归自验证段(约 123-168 行)里:
 *
 *     try {
 *       if (engine.decisionVerifier && result) {
 *         for (let cycle = 0; cycle < 2; cycle++) {
 *           const record = { ... };
 *           const vResult = engine.decisionVerifier.verify(record);
 *           ...
 *         }
 *       }
 *     } catch (_) { 空 catch, 注释写"非关键" }
 *     // [v6.7.8] DecisionFeedback 学习闭环
 *     try {
 *       if (engine.decisionFeedback && vResult) {        // ← vResult 不在作用域内
 *         engine.decisionFeedback.recordOutcome({
 *           confidence: record.confidence,               // ← record 也不在
 *         }, vResult.score >= 0.6, ...);
 *       }
 *     } catch (_) { 空 catch, 注释写"非关键" }
 *
 * `record` 与 `vResult` 都是**循环体内**的 const, 而学习闭环写在**兄弟 try 块**里。
 * 两个名字在那里都不存在 → 每次 think() 都在 `engine.decisionFeedback && vResult`
 * 上抛一次 ReferenceError, 被空 catch 吞掉。
 *
 * 实测(修复前): 同一 stub 下
 *   result._verification 正常写入, score=0.2  ← 证明 AREX 段跑通, vResult 有值
 *   decisionFeedback.recordOutcome 调用次数 = 0 ← 闭环死了
 * 调用成功、不抛错、返回结构完全合法 —— 与 getFormulaBridge 那次完全同型。
 *
 * 后果: DecisionFeedback._history / _byRule / _learnedWeights 永远收不到
 * think() 侧的自验证结论, "correct → weight +0.05 / wrong → -0.10" 这条学习规则
 * 在 think() 这条最频繁的路径上从未被喂过数据。
 *
 * ═══ 修法 ═══
 * 把两个副本提到函数作用域(lastRecord / lastVerify), 由循环内每次 verify 成功后
 * 赋值; 未跑 verify 时保持 null, 闭环自然跳过 —— 不拿空数据伪造一次学习信号。
 * 赋值点放在 `if (vResult.issues?.length > 0)` **之前**: 无 issue 时闭环记的是
 * 'verified', 不能因为没 issues 就把这次验证漏掉。
 *
 * ═══ 锁什么 ═══
 * ① 行为: 有 issues 时 recordOutcome 必须被调用(修复前 0 次, 本条红);
 * ② 行为: 无 issues 时也必须调用且记 'verified'(防只接一半);
 * ③ 行为: 置信度必须来自真实的 record(防又造一个空对象);
 * ④ fail-open: decisionVerifier 缺失 / verify 抛错 / decisionFeedback 缺失
 *    都不得崩, 且不得伪造调用;
 * ⑤ 源级: 学习闭环块内不得再出现裸 vResult / record(防同型复辟)。
 */
module.exports = function ({ test, assertEqual, assertTrue }) {
  const path = require('path');
  const fs = require('fs');
  const ROOT = path.join(__dirname, '..');
  const { runThinkPipeline } = require(path.join(ROOT, 'src', 'core', 'think-pipeline.js'));

  /** 造一个只带本次需要的两个字段的 engine, 其余一律不接(避免无关链路噪音) */
  function makeEngine(verifyImpl, onOutcome) {
    const e = {};
    if (verifyImpl) e.decisionVerifier = { verify: verifyImpl };
    if (onOutcome) e.decisionFeedback = { recordOutcome: onOutcome };
    return e;
  }
  function makeResult(confidence = 0.5) {
    return { confidence, output: { conclusion: '某个结论', meta: { confidence } } };
  }

  // ── 一、闭环必须真的跑起来 ──────────────────────────────
  test('自验证发现问题时 recordOutcome 必须被调用(修复前 0 次)', () => {
    const calls = [];
    const r = makeResult(0.5);
    return runThinkPipeline(r, '输入文本', makeEngine(
      () => ({ score: 0.2, issues: [{ type: 'no_evidence', severity: 0.5, message: '缺证据' }], repairHints: [] }),
      (d, ok, notes) => calls.push({ d, ok, notes })
    )).then(() => {
      // 先证明 AREX 段本身跑通了 —— 否则本条绿是因为 vResult 不存在, 不是因为闭环接通
      assertTrue(!!r._verification && r._verification.score === 0.2,
        '前置条件: AREX 段应写入 _verification(score=0.2), 实测 ' + JSON.stringify(r._verification));
      assertEqual(calls.length, 1,
        '自验证有 issues 时学习闭环应记录 1 次, 实测 ' + calls.length +
        ' 次 —— 0 次说明 vResult/record 又不在作用域内(闭环静默死亡)');
      assertEqual(calls[0].ok, false, 'score 0.2 < 0.6 应判为不正确决策');
      assertEqual(calls[0].notes, 'verify issues: 1', '备注应带 issue 条数');
      assertEqual(calls[0].d.type, 'thought-chain-synthesis', 'type 应保持原值');
      assertEqual(calls[0].d.ruleId, 'thought-chain-synthesis', 'ruleId 应保持原值');
    });
  });

  test('自验证无 issues 时也必须记录, 且记 verified(防只接一半)', () => {
    const calls = [];
    return runThinkPipeline(makeResult(), '输入文本', makeEngine(
      () => ({ score: 0.9, issues: [] }),
      (d, ok, notes) => calls.push({ d, ok, notes })
    )).then(() => {
      assertEqual(calls.length, 1,
        '无 issues 的验证也是学习信号, 应记录 1 次, 实测 ' + calls.length + ' 次');
      assertEqual(calls[0].ok, true, 'score 0.9 >= 0.6 应判为正确决策');
      assertEqual(calls[0].notes, 'verified', '无 issues 时备注应为 verified');
    });
  });

  test('置信度必须来自真实 record(而不是新造的空对象)', () => {
    const calls = [];
    return runThinkPipeline(makeResult(0.73), '输入文本', makeEngine(
      () => ({ score: 0.9, issues: [] }),
      (d) => calls.push(d)
    )).then(() => {
      assertEqual(calls[0].confidence, 0.73,
        'confidence 应取自 record(result.output.meta.confidence), 实测 ' + calls[0].confidence);
      assertTrue(calls[0].context && calls[0].context.source === 'think-pipeline',
        'context.source 应保持 think-pipeline');
    });
  });

  // ── 二、fail-open 必须保持 ─────────────────────────────
  test('decisionVerifier 缺失时不得崩, 也不得伪造调用', () => {
    const calls = [];
    let threw = null;
    return runThinkPipeline(makeResult(), '输入文本', makeEngine(null, () => calls.push(1)))
      .then(() => {
        assertEqual(calls.length, 0, '没跑验证就不该有学习信号, 实测 ' + calls.length + ' 次');
      })
      .catch(e => { threw = e; })
      .then(() => assertEqual(threw && threw.message, null, 'decisionVerifier 缺失不得抛错'));
  });

  test('verify() 抛错时不得崩, 也不得伪造调用', () => {
    const calls = [];
    let threw = null;
    return runThinkPipeline(makeResult(), '输入文本', makeEngine(
      () => { throw new Error('boom'); },
      () => calls.push(1)
    ))
      .then(() => { assertEqual(calls.length, 0, 'verify 抛错时不该记录学习信号, 实测 ' + calls.length + ' 次'); })
      .catch(e => { threw = e; })
      .then(() => assertEqual(threw && threw.message, null, 'verify 抛错不得逃出主链路'));
  });

  test('decisionFeedback 缺失时不得崩', () => {
    let threw = null;
    return runThinkPipeline(makeResult(), '输入文本', makeEngine(() => ({ score: 0.9, issues: [] }), null))
      .catch(e => { threw = e; })
      .then(() => assertEqual(threw && threw.message, null, 'decisionFeedback 缺失不得抛错'));
  });

  // ── 三、源级: 防同型复辟 ───────────────────────────────
  test('学习闭环块内不得再引用裸 vResult / record', () => {
    const src = fs.readFileSync(path.join(ROOT, 'src', 'core', 'think-pipeline.js'), 'utf8');
    // 取出 DecisionFeedback 那个 try 块。锚点必须是 [v6.7.8] 那一行 ——
    // 文件顶部的作用域提升说明里也提到"DecisionFeedback 学习闭环", 用宽锚点会抓到那里。
    const m = src.match(/\[v6\.7\.8\] DecisionFeedback 学习闭环[\s\S]*?try \{([\s\S]*?)\n  \} catch/);
    assertTrue(!!m, '应能定位到 DecisionFeedback 学习闭环块');
    const body = m[1];
    // 循环体内声明的两个名字, 在闭环块里必须不再裸出现
    assertTrue(!/\bvResult\b/.test(body),
      '学习闭环块内又出现了裸 vResult —— 它声明在兄弟 try 的循环体里, 这里读到的是 ReferenceError');
    assertTrue(!/\brecord\b/.test(body),
      '学习闭环块内又出现了裸 record —— 同上, 会被 catch 吞成静默死亡');
    // 并且必须确实读了提升后的变量(不是把整段删掉了事)
    assertTrue(/\blastVerify\b/.test(body) && /\blastRecord\b/.test(body),
      '学习闭环应读函数作用域的 lastVerify / lastRecord');
  });
};
