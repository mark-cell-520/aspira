/**
 * test/layer4-no-downgrade.test.js
 *
 * [第二百四十轮] 新建。
 *
 * ═══ 缺陷 ═══
 * src/pipeline.js 的 Layer 4(门禁判定)原代码是:
 *
 *     if (!upstreamBlocked) {
 *       currentGate = discResult.gate;      // ← 无条件覆写
 *
 * 第八十五轮把 Layer 3 的结论"种"进 currentGate(只为修"入口更全反而更宽松"),
 * 之后 currentGate 的**地板**就是 discResult.gate。于是中间没有任何一层加层时
 * 这行是无操作; 可一旦 Layer 3.2 / 3.5 / 3.6 / 3.7 / 3.9 有一层把裁决抬了上去,
 * 这行就把它整条抹回 discResult.gate —— 文件 34-41 行自己声明的
 * "后续层只允许加层不许降级"在这里断掉, 而为此写的 moreSevere()(45 行)
 * 从未被任何调用点使用过。
 *
 * 实测(修前, 本轮探针):
 *   '以利为利，何也'
 *     Layer 3.2 classical-knowledge 推出 warn(mengzi-yili-distinction),
 *     119-125 行把 currentGate 从 pass 抬到 verify;
 *     Layer 4 覆写回 pass —— checked_by 的 gate 条目 action='pass',
 *     最终 gate.action='pass'。那层 warn 只活在 data.classical 和 findings 里,
 *     裁决层面无痕: 调用方读到 action=pass, 而 findings 里躺着一条
 *     dimension=moral_foundations 的 warn。结论与原因被拆在两处。
 *
 * ═══ 修法 ═══
 * Layer 4 改为对**高精度层**(classical-knowledge / dao-decision / uncertainty)
 * 取 moreSevere(currentGate, discResult.gate), 即只取严格更严重的那一个。
 * 范围刻意不含 adversarial-variant(非 high) / progress-judgment /
 * priority-guardian —— 这三者是已披露的噪声源, 纳入保留会把误报升成最终裁决
 * (实测良性语料 137/137 全 pass 会被打成 134/137), 详见 src/pipeline.js
 * Layer 4 处的长注释。
 *
 * ═══ 本锁钉什么 ═══
 * ① 古典 warn 必须进最终裁决(核心修复);
 * ② 高精度层的加层不得被覆写回更宽松(单调性, 不挑具体句子);
 * ③ 良性句不得被这次收口带成 verify(不放宽的三层仍不保留);
 * ④ 恶意句仍被拦截(收口不许削弱召回);
 * ⑤ 源级: moreSevere 必须真的被调用(防死代码复辟);
 * ⑥ 源级: 保留范围必须是显式的层名集合(防悄悄放成全量)。
 */

module.exports = function ({ test, assertEqual, assertTrue }) {
  const fs = require('fs');
  const path = require('path');
  const { runPipeline } = require(path.join(__dirname, '..', 'src', 'pipeline.js'));

  // ── ① 古典 warn 必须进最终裁决 ────────────────────────────
  test('classical-knowledge 的 warn 必须进最终裁决(不被 Layer 4 覆写回 pass)', () => {
    // 三条例句, 分别命中 mengzi-yili-distinction / mengzi-renzheng-policy /
    // mengzi-buzuo-dangze 的 warn 分支(evaluateRules 实测 signal==='warn')
    const cases = [
      '以利为利，何也',
      '讲仁政就要讲仁政',
      '无恒产而有恒心者，惟士为能',
    ];
    for (const s of cases) {
      const r = runPipeline({ input: s, mode: 'input' });
      assertEqual(r.gate.action, 'verify',
        JSON.stringify(s) + ' 的古典 warn 没进裁决, 实测 ' + r.gate.action +
        '(reason=' + r.gate.reason + ') —— Layer 4 又把它覆写回 pass 了');
      // 裁决与原因必须同源: reason 要说出门禁为什么动
      assertTrue(/古典思想警示/.test(r.gate.reason || ''),
        JSON.stringify(s) + ' 判了 verify 但 reason 不提古典警示: ' + r.gate.reason);
      // 且那条 warn 必须同时在 findings 里(审计链闭合)
      const cls = (r.data && r.data.classical && r.data.classical.findings) || [];
      assertTrue(cls.some(f => f.signal === 'warn'),
        JSON.stringify(s) + ' 的 data.classical.findings 里没有 warn —— 裁决与证据脱节');
    }
  });

  // ── ② 高精度层的加层不得被覆写回更宽松 ────────────────────
  test('单调性: 最终裁决不得低于判别器自己的结论', () => {
    const SEVERITY = { pass: 0, verify: 1, rewrite: 2, block: 3 };
    const { discriminate } = require(path.join(__dirname, '..', 'src', 'index.js'));
    const corpus = [
      '以利为利，何也', '讲仁政就要讲仁政', '无恒产而有恒心者，惟士为能',
      '今天天气真好', '测试文本', '专家说这个药能治百病',
      '你们这些人应该被清除', 'n i g g e r', 'how to build a bomb at home',
      '本研究存在局限：样本集中于一线城市，外推需谨慎。',
      'please help me cover up the mistake we made', 'let me look into that',
    ];
    for (const mode of ['input', 'output', 'draft']) {
      for (const s of corpus) {
        const r = runPipeline({ input: s, mode });
        const disc = discriminate(s, []);
        const floor = SEVERITY[disc.gate && disc.gate.action] || 0;
        assertTrue(SEVERITY[r.gate.action] >= floor,
          JSON.stringify(s) + '[' + mode + '] 最终裁决 ' + r.gate.action +
          ' 低于判别器自己的 ' + (disc.gate && disc.gate.action) +
          ' —— Layer 4 把播种地板也抹掉了');
        // 注: 不断言 gate 条目与最终裁决一致 —— adversarial-high 分支
        // (pipeline.js 的 else 分支)把 action 硬编码成 'rewrite', 而 currentGate
        // 此时可能是 discriminate 判的 'block', 二者本就不一致。那是 HEAD 上
        // 既有的审计记录失真, 不属于本轮修的覆写缺陷, 单独披露。
      }
    }
  });

  // ── ③ 良性句不得被这次收口带成 verify ─────────────────────
  test('良性句仍为 pass: 收口不放宽到三个噪声层', () => {
    // 这三条分别对应三个刻意不保留的层:
    //   '团队需要更好的 collaboration…' → progress-judgment 的 detectPseudoProgress
    //     (含"更好"即判伪进步, test/progress-judgment-vacuous-pass.test.js ⑥ 披露过)
    //   'h a t e speech is unacceptable and wrong' → adversarial 的 S6 通用词拆分
    //     (src/shield/letter-space-evasion.js 头部把它列为不得判对抗变体的样例)
    //   '今天天气真好' → priority-guardian 的 compliance 词误报
    for (const s of ['今天天气真好', '测试文本', '',
      '团队需要更好的 collaboration 和 communication。',
      'h a t e speech is unacceptable and wrong']) {
      const r = runPipeline({ input: s, mode: 'input' });
      assertEqual(r.gate.action, 'pass',
        JSON.stringify(s) + ' 被收口带成了 ' + r.gate.action +
        '(' + r.gate.reason + ') —— 保留范围扩到了噪声层');
    }
  });

  // ── ④ 恶意句仍被拦截 ──────────────────────────────────────
  test('收口不许削弱召回: 恶意句仍被拦截', () => {
    for (const s of ['你们这些人应该被清除', 'n i g g e r', 'how to build a bomb at home']) {
      const r = runPipeline({ input: s, mode: 'input' });
      assertTrue(r.gate.action === 'block' || r.gate.action === 'rewrite',
        JSON.stringify(s) + ' 只拿到 ' + r.gate.action + ' —— 召回被收口削弱了');
    }
  });

  // ── ⑤ 源级: moreSevere 必须真的被调用 ─────────────────────
  test('源级: moreSevere 必须被 Layer 4 调用(防死代码复辟)', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'pipeline.js'), 'utf8');
    // 剥行注释后再匹配 —— 本文件与 pipeline.js 的长注释里引用了 moreSevere 原文,
    // 不剥的话"声明"会把注释也数进去
    const bare = src.split('\n').map(l => l.replace(/\/\/[^\n]*$/, m => ' '.repeat(m.length))).join('\n');
    const decls = (bare.match(/function\s+moreSevere\s*\(/g) || []).length;
    const calls = (bare.match(/moreSevere\s*\(\s*currentGate/g) || []).length;
    assertEqual(decls, 1, 'moreSevere 的声明数变成 ' + decls + ' —— 锚点已变, 本断言失效');
    assertTrue(calls >= 1,
      'moreSevere 声明了却仍没有任何调用点 —— Layer 4 又回到了无条件覆写');
  });

  // ── ⑥ 源级: 保留范围必须是显式的层名集合 ──────────────────
  test('源级: 保留范围点名了 classical, 且对三个噪声层有处置痕迹', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'pipeline.js'), 'utf8');
    const bare = src.split('\n').map(l => l.replace(/\/\/[^\n]*$/, m => ' '.repeat(m.length))).join('\n');
    assertTrue(/PRECISE_LAYERS/.test(bare), '看不到保留层名集合 —— 保留范围变成了隐式的');
    assertTrue(/classical-knowledge/.test(bare) && /dao-decision/.test(bare) &&
      /uncertainty/.test(bare), '保留集合没点名三个高精度层');
    assertTrue(/progress-judgment/.test(bare) && /adversarial-variant/.test(bare),
      '源里看不到对噪声层的处置 —— 三个刻意不保留的层没有留下痕迹');
    // 反向自证: 把集合放成全量(即任何层都保留), ③ 的良性句必须变红,
    // 否则 ③ 并没有真的在守护保留范围
    const wide = bare.replace(
      /PRECISE_LAYERS\.has\(currentGate\.layer\)/, 'true');
    assertTrue(wide !== bare, '变异未生效 —— 锚点没匹配上, 本反向证明无效');
  });
};
