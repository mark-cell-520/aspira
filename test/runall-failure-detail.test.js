/**
 * test/runall-failure-detail.test.js — 失败的输出必须带上断言消息
 *
 * [doc-honest-numbers·第一百四十三轮] 新建。
 *
 * ═══ 被挡住的一次诊断 ═══
 * 本轮排查一个间歇失败: 套件里 `audit-domains-blindspot` 偶发红，而单独跑全绿。
 * 想看是三条断言里的哪条 —— **输出里只有标题，没有原因**:
 *     ✗ 活体验证: 表格加一行而标题不改，审计必须抓住
 *     (没有下一行)
 *
 * 根因在 `test/run-all.js` 的 emitResult: 它只保留含"通过/✗/失败"的行，
 * 于是 harness 打出的断言消息(`    期望 truthy，实际 false。<原因>`)被整行丢掉。
 *
 * ═══ 为什么这是 doc-honest-numbers 的形状 ═══
 * 铁律 3 要求失败比对"双通道"、并要求**逐个说明来源**; 而仪器恰好把"来源"
 * (每条失败的原因)丢掉了。于是一个诚实的门禁流程被迫在信息缺失下做判断:
 *   · 要么重新单独跑那个文件(它单独跑往往全绿，因为失败是并发/嵌套探针残留);
 *   · 要么去读源码猜是哪条断言。
 * 这与本切片反复记录的形状同族: **一个把诊断信息丢掉的仪器，比没有仪器更贵** ——
 * 它让每一轮排查都从零开始。修好后同一份输出立刻多出关键信息，例如本轮
 * drift-detection 的三条失败第一次显示出"实测: 不一致: 1"，直接指向快照没能
 * 挡住发生在它之前的污染。
 *
 * ═══ 修法 ═══
 * keep 的判据从"含关键词"扩为"含关键词，或上一保留行是 ✗ 且本行是缩进非空行"。
 * 后者正是 harness 固定用 4 空格缩进打印的断言消息; 用"上一行是 ✗"锚定，
 * 不会误收测试自己的普通输出。
 *
 * 遵循 aspira 约定 #4: 位于 test/ 根目录、module.exports=函数 导出。
 */
module.exports = function ({ test, assertTrue }) {
  const fs = require('fs');
  const path = require('path');

  const RUNNER = path.join(__dirname, 'run-all.js');
  const src = fs.readFileSync(RUNNER, 'utf8')
    .split('\n').filter(l => !l.trim().startsWith('//')).join('\n');

  // ── 一、源级: 必须保留 ✗ 行后面的缩进消息行 ────────────
  test('emitResult 必须保留失败断言的消息行', () => {
    // 新判据的两个成分都要在: "上一保留行含 ✗" 且 "本行是缩进非空行"
    assertTrue(/prev\.includes\('✗'\)/.test(src),
      'keep 判据必须锚定"上一保留行是 ✗ 行" —— 缺它则断言消息仍被丢掉');
    assertTrue(/\^\\s\+\\S/.test(src),
      'keep 判据必须识别"缩进的非空行" —— 缺它则收不住 harness 的消息行');
    // 旧的无条件 filter 不得回来(它正是丢消息的那个形态)
    assertTrue(!/const keep = out\.split\('\\n'\)\.filter\(/.test(src),
      '不得回退到"只按关键词 filter"的形态 —— 那会把每条失败的原因整行丢掉');
  });

  // ── 二、行为: 该判据对真实输出形状确实有效 ────────────
  test('判据必须把 ✗ 行后面的消息行留下来', () => {
    // 用 harness 的真实输出形状验证(标题行 + 4 空格缩进的消息行 + 汇总行)。
    // 这条同时防"写了个恒真判据": 若判据不工作，下面的断言会红。
    const sample = [
      '  ✓ 某条通过的用例',
      '  ✗ 某条失败的用例',
      '    期望 truthy，实际 false。这是原因，必须被保留',
      '测试结果: 1 通过, 1 失败, 共 2 个',
      '',
    ].join('\n');
    // 与 run-all.js 中相同的判据(刻意复刻，见下方自检)
    const keep = [];
    for (const l of sample.split('\n')) {
      if (l.includes('通过') || l.includes('✗') || l.includes('失败')) { keep.push(l); continue; }
      const prev = keep.length ? keep[keep.length - 1] : '';
      if (/^\s+\S/.test(l) && prev.includes('✗')) keep.push(l);
    }
    const kept = keep.join('\n');
    assertTrue(kept.includes('这是原因，必须被保留'),
      '断言消息必须被保留 —— 判据对真实输出形状无效(恒真锁)');
    // 反向: 通过行的普通输出不得被误收(判据不能太宽)
    const sample2 = [
      '  ✓ 某条通过的用例',
      '    这行是测试自己的普通输出，不该被收',
      '测试结果: 1 通过, 0 失败, 共 1 个',
    ].join('\n');
    const keep2 = [];
    for (const l of sample2.split('\n')) {
      if (l.includes('通过') || l.includes('✗') || l.includes('失败')) { keep2.push(l); continue; }
      const prev = keep2.length ? keep2[keep2.length - 1] : '';
      if (/^\s+\S/.test(l) && prev.includes('✗')) keep2.push(l);
    }
    assertTrue(!keep2.join('\n').includes('不该被收'),
      '通过用例的普通输出不得被误收 —— 判据太宽会污染日志');
  });

  // ── 三、自检: 复刻的判据必须与源一致 ──────────────────
  test('本锁复刻的判据必须与 run-all.js 源一致(否则自证失效)', () => {
    // 防"锁里那份判据与线上那份漂移": 两者都必须含同样的两个锚点。
    assertTrue(/prev\.includes\('✗'\)/.test(src) && /\^\\s\+\\S/.test(src),
      'run-all.js 与锁内复刻本必须含相同锚点; 源变了而锁没变时本条红');
  });
};
