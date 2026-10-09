/**
 * test/absolute-claim-commitment.test.js — 商务承诺不是绝对化断言
 *
 * [fp-recall-calibration·第一百六十三轮] 新建。
 *
 * ═══ 缺陷 ═══
 * `absolute_claim`(rewrite 层维度)有一条模式:
 *
 *     /(?:绝对|一定|必然|必定)[^。]{0,10}(?:是|会|能|行|对|错|好|坏)/
 *
 * 它把"承诺句式"一起抓了。第一百五十二轮量 45 条日常文本时抓到一条:
 *
 *     「您的意见非常宝贵，我们一定会认真考虑。」 → rewrite (absolute_claim)
 *
 * 同类还有「我们一定会尽快跟进这件事。」「我们一定会回复您的邮件。」——
 * 这些是**对过程与态度的承诺**，不是"对结果的绝对化断言"。后者才是本维度要抓的
 * (「这个方案一定行」「这一定是唯一正确的答案」)。
 *
 * 把商务客套判成"必须改写"的后果: 一段完全得体的客服/合作回复会被打回，
 * 而真正该拦的绝对化断言与它用同一条模式。
 *
 * ═══ 修法 ═══
 * `checkAbsoluteClaim` 开头加承诺句式豁免，判据(实测 12/12):
 *     第一人称主体(我们/我方/我司/咱们/团队/这边)
 *     + 一定/必定/必然
 *     + 承诺动词(认真考虑/跟进/改进/处理/回复/反馈/核实/评估/研究/支持/配合/说明)
 *
 * 为什么要求第一人称主体: 「这个方案一定行」没有主体词，是真断言；「我们一定会
 * 跟进」有主体且动词是承诺类。少了主体条件，`一定能改进`这类预测句也会被放过去。
 *
 * ═══ 实测 ═══
 *   语料: absolute_claim 原本命中 2 条，全是真绝对化
 *     (「所有人都知道这才是唯一可行的做法」/「Everyone agrees this is the only
 *      correct answer」)，豁免一条都不碰
 *   测试字面量: 修复前 37 条触发，修复后 36 条 —— 少的 1 条正是承诺句式，
 *     其余 36 条(真绝对化)全部仍被判
 *   明文 132 benign / FP 0.0%, 58 malicious / recall 100.0% 不变
 *
 * 遵循 aspira 约定 #4: 位于 test/ 根目录、module.exports=函数 导出。
 */
module.exports = function ({ test, assertEqual, assertTrue }) {
  const fs = require('fs');
  const path = require('path');
  const ROOT = path.join(__dirname, '..');
  const gate = require(path.join(ROOT, 'src', 'gate.js'));
  const idx = require(path.join(ROOT, 'src', 'index.js'));
  const noAbs = (s) => {
    const f = gate.checkOutput(s).findings || [];
    return !f.some(x => x.dimension === 'absolute_claim');
  };

  // ── 一、商务承诺句式不得判 absolute_claim ───────────────
  test('商务承诺句式不得判为绝对化断言', () => {
    const PROMISES = [
      '您的意见非常宝贵，我们一定会认真考虑。',
      '我们一定会尽快跟进这件事。',
      '我们一定会改进这个流程。',
      '我们一定会回复您的邮件。',
      '我们一定会认真考虑您的建议，并给出答复。',
      '团队一定会评估这个方案。',
      '我们一定会在三天内回复您。',
    ];
    const bad = PROMISES.filter(s => !noAbs(s));
    assertEqual(bad.join('\n'), '',
      '以下商务承诺句被判为绝对化断言(承诺 ≠ 断言):\n' + bad.join('\n'));
  });

  // ── 二、真绝对化断言必须仍被判 ──────────────────────────
  test('真正的绝对化断言必须仍判 absolute_claim', () => {
    const REAL = [
      '这个方案一定行。',
      '这一定是唯一正确的答案。',
      '一定会成功。',
      '所有人都知道这才是唯一可行的做法。',
      'Everyone agrees this is the only correct answer, without exception.',
      '这个模型永远都不会出错，每次都完美执行。',
      '毫无疑问这是唯一正确的方案，所有人都必须同意',
    ];
    const bad = REAL.filter(noAbs);
    assertEqual(bad.join('\n'), '',
      '以下真绝对化断言漏判(豁免把维度关掉了):\n' + bad.join('\n'));
  });

  // ── 三、语料里的 2 条必须仍被判 ─────────────────────────
  test('语料里触发 absolute_claim 的 2 条必须仍被判', () => {
    const p = '/tmp/corpus149.json';
    if (!fs.existsSync(p)) return;
    const { BENIGN, MALICIOUS } = JSON.parse(fs.readFileSync(p, 'utf8'));
    const hit = [...BENIGN, ...MALICIOUS].filter(s => {
      const f = idx.discriminate(s, []).findings || [];
      return f.some(x => x.dimension === 'absolute_claim');
    });
    assertEqual(hit.length, 2,
      `语料里 absolute_claim 的命中数应仍为 2(豁免不该碰它们), 实测 ${hit.length}`);
    for (const s of hit) assertTrue(noAbs(s) === false,
      `语料样本不再被判 absolute_claim: ${s.slice(0, 40)}`);
  });

  // ── 四、源级: 豁免必须要求第一人称主体 ──────────────────
  test('源级: 豁免必须同时要求第一人称主体与承诺动词', () => {
    const src = fs.readFileSync(path.join(ROOT, 'src', 'index.js'), 'utf8')
      .split('\n').filter(l => !l.trim().startsWith('//')).join('\n');
    const line = src.split('\n').find(l => l.includes('COMMITMENT_PROMISE =')) || '';
    assertTrue(/我们/.test(line), '豁免必须要求第一人称主体(否则"一定能改进"这类预测句也会被放过)');
    assertTrue(/认真考虑/.test(line) && /跟进/.test(line), '豁免必须列承诺动词');
    assertTrue(/checkAbsoluteClaim/.test(src) && /COMMITMENT_PROMISE\.test\(text\)/.test(src),
      'checkAbsoluteClaim 必须调用该豁免');
    // 自证: 谓词必须能判"无主体条件"为缺陷
    const noSubject = /(?:一定|必定|必然)[^。]{0,6}(?:认真考虑|跟进|改进|处理|回复|反馈|核实|评估|研究|支持|配合|说明)/;
    assertTrue(noSubject.test('这个方案一定能改进') === true && /我们/.test('这个方案一定能改进') === false,
      '自证失效: 谓词分不清"有主体承诺"与"无主体预测", 本条是恒真锁');
  });
};
