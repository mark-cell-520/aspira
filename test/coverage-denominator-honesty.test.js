/**
 * test/coverage-denominator-honesty.test.js — 覆盖面自报的分母必须诚实
 *
 * ═══ 由来 ═══
 * 连续第五轮 doc-honest-numbers。前四轮修了「扫哪些文件」「读哪些写法」
 * 「怎么测量层数」「声明 vs 事实」。本轮审一个**元问题**:
 * 自报说「校验 45 条 / 数字型声称 695 条 = 6.5%」——
 * **这个分母本身诚不诚实?**
 *
 * ═══ 实测发现: 分母虚高 ═══
 * 把 NUMISH 粗计拆开后:
 *   · 755 条(旧口径 2009 条中的 37.5%)是**百分比**
 *     —— "FP 率 0.9%" "召回 85%"，它们是**被测量出来的结果**，
 *        不是文档里的规模声称
 *   · 188 条在**代码围栏内** —— 示例命令、配置片段、代码注释
 *   · 大量版本号/日期
 * 拿这种分母算出的百分比，暗示"还有 96% 没审"是误导:
 * **用一个虚高的分母冒充诚实，与虚假的精确度是同一种不诚实。**
 *
 * ═══ 抽样进一步证实 ═══
 * 从"可审形态"里均匀抽 40 条，24 条可视样本中绝大多数是
 * **历史叙事**(CHANGELOG 条目、带日期的审计报告、plan 步骤、
 * 规则条数、模块字段说明)——都不是引擎规模的当前声称。
 * 只有 1 条是真规模声称(docs/audit-service-brief-zh.md 的
 * "47 维判别引擎 + 132 个运行模块"，而它写的 47 维实测是 54)。
 *
 * ═══ 修法 ═══
 * ① 分母只数**已扫文档**(DOCS_RECURSIVE)，排除已豁免文件
 * ② 分母剔除百分比、版本号/日期、代码围栏内容
 * ③ 分类报出分母构成，让读者看见它而不只是一个数
 * ④ 标签必须写"已扫文档内"而非"全仓"——全仓 721 份，
 *    已扫 601 份，写"全仓"就是把豁免文件偷偷算进分母
 * ⑤ 明说"可审 N 条"里仍含序数/括号/叙事引用/多义形态等已知不审类别，
 *    故该百分比是**有构成说明的下界**，不是疏漏率
 *
 * ═══ 本测试锁什么 ═══
 * ① 分母必须排除百分比与代码围栏
 * ② 分母必须只遍历已扫文档
 * ③ 必须分类报出分母构成
 * ④ 标签不得声称"全仓"
 */
const path = require('path');
const fs = require('fs');
const { execFileSync } = require('child_process');
const { withDocLock } = require('./_doc-probe-lock.js'); // [第七轮] 跑审计须持共享文档锁(见 test/_doc-probe-lock.js)

const ROOT = path.join(__dirname, '..');
const SCRIPT = path.join(ROOT, 'scripts', 'audit-doc-numbers.js');

module.exports = function ({ test, assertTrue, assertEqual }) {
  return withDocLock(() => {

  function runAudit() {
    try {
      return execFileSync('node', [SCRIPT], {
      cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, ASPIRA_AUDIT_SKIP_TESTS: '1' },
      });
      // [第二十二轮] 审计退出码现在承载结论(mismatch/漂移 -> 1)，execFileSync 对
      // 非零退出抛异常。活体注入要的正是那份 stdout，所以从 e.stdout 取回 ——
      // 否则一个**正确报出不符**的审计会把探针自己炸掉(周期22 实测 13 例全红)。
    } catch (e) {
      return (e.stdout || '').toString();
    }
  }

  test('分母必须剔除百分比与代码围栏(否则虚高)', () => {
    const src = fs.readFileSync(SCRIPT, 'utf8');
    assertTrue(/nPercent/.test(src) && /nFenced/.test(src),
      '审计必须分别计数百分比与代码围栏内的 NUMISH 命中');
    assertTrue(/```[\s\S]*?```/.test(src),
      '必须剥离代码围栏后再计分母');
    assertTrue(/%/.test(src.match(/const NUMISH[^\n]*/)[0]) === false
      || /nPercent\+\+/.test(src),
      '百分比命中必须被单独归类而不是混入可审分母');
  });

  test('分母只遍历已扫文档，不得把豁免文件算进去', () => {
    const src = fs.readFileSync(SCRIPT, 'utf8');
    // 分母循环的迭代对象必须是 DOCS_RECURSIVE
    const m = src.match(/let rawClaims[\s\S]{0,400}?for \(const f of (\w+)\)/);
    assertTrue(!!m, '应能找到分母计算循环');
    if (m) assertEqual(m[1], 'DOCS_RECURSIVE',
      `分母必须只遍历已扫文档集 DOCS_RECURSIVE，实测遍历 ${m[1]}——`
      + '把已豁免文件算进分母就是用一个虚高的数字冒充诚实');
  });

  test('必须分类报出分母构成(不只是一个百分比)', () => {
    const out = runAudit();
    assertTrue(/分母构成/.test(out), '必须报出分母构成');
    assertTrue(/可审\s+\d+/.test(out), '必须报出可审形态条数');
    assertTrue(/百分比\s+\d+/.test(out), '必须报出百分比条数');
    assertTrue(/代码围栏内\s+\d+/.test(out), '必须报出代码围栏内条数');
  });

  test('分母标签必须写"已扫文档内"而非"全仓"', () => {
    const out = runAudit();
    assertTrue(/已扫文档内/.test(out),
      '标签必须写"已扫文档内"——全仓 md 与已扫集不是同一个集合，'
      + '写"全仓"就是把豁免文件偷偷算进分母');
    const bad = /全仓 NUMISH 粗计/.test(out);
    assertTrue(!bad, '不得再用"全仓 NUMISH 粗计"这种把豁免文件算进去的标签');
  });

  test('百分比必须是"有构成说明的下界"而非疏漏率', () => {
    const src = fs.readFileSync(SCRIPT, 'utf8');
    assertTrue(/有构成说明的下界|下界/.test(src),
      '必须明说该百分比是下界而非疏漏率——否则读者会把 6.5% 读成"93.5% 没审"');
    assertTrue(/序数|括号|叙事引用|多义/.test(src),
      '必须列出"可审"集合里仍存在的已知不审类别');
  });

  test('运行时: 百分比与代码围栏确实被排除在分母外', () => {
    const out = runAudit();
    const mDen = out.match(/可审形态声称\s+(\d+)\s+条/);
    const mRaw = out.match(/NUMISH 粗计\s+(\d+)\s+条/);
    const mPct = out.match(/百分比\s+(\d+)/);
    const mFen = out.match(/代码围栏内\s+(\d+)/);
    assertTrue(!!mDen && !!mRaw, '应能解析出分母各项');
    if (mDen && mRaw && mPct && mFen) {
      const den = Number(mDen[1]), raw = Number(mRaw[1]);
      const pct = Number(mPct[1]), fen = Number(mFen[1]);
      assertTrue(den < raw,
        `可审分母(${den})必须小于粗计(${raw})——剔除必须真的发生`);
      assertTrue(den + pct + fen <= raw,
        `可审 ${den} + 百分比 ${pct} + 围栏 ${fen} 应 ≤ 粗计 ${raw}`);
    }
  });
  });
};
