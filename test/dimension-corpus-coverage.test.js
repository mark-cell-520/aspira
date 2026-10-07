/**
 * test/dimension-corpus-coverage.test.js — corpus-only 触达面报告的锁
 *
 * [dimension-health-audit·第一百三十一轮] 新建。
 *
 * ═══ 背景: 全池健康 ≠ 经得起真实语料检验 ═══
 * 维度健康审计(本切片的仪器)跑全池 8584 条输入(corpus 162 + 测试字面量
 * 9018 + 正则片段 2775)时全绿: 0 个维度从不推 finding、0 个从未触发。
 * 但把口径收紧到 **corpus-only**(162 条人工标注样本, 裸 discriminate
 * dimensions{} 键维度 score/count>0) 后实测: **只有 12/54 个维度被
 * 触达** —— unsupported_claim 都无样本(corpus 的 hedged 族清理时来源类
 * 恶意样本一并移走了, MALICIOUS 里 0 条含"根据/研究/study"类来源词)。
 * 这不是引擎失效(维度在全池都触发、也推 finding), 是**语料盲区**:
 * 42 个维度的行为只被 test/ 里的字面量锁定, 校准脚本的 "FP 0% /
 * recall 100%" 对它们零表达力。
 *
 * ═══ 修法 ═══
 * 给维度健康审计仪器加 "corpus-only 覆盖" 报告节: 语料池触发过几个维度、
 * 从未触达的维度清单。刻意不设 exit=1 —— 它不是引擎缺陷而是语料盲区,
 * 每轮红灯会让"可行动"信号失效; 它是给 fp-recall-calibration 轮次的指路牌。
 * 判据走裸 discriminate 而非 gate findings(后者会被聚合/降级藏起低分维度)。
 *
 * ═══ 锁什么 ═══
 * ① 报告节在场且不是硬编码(锁内用同一判据独立复算, 与仪器输出比对);
 * ② 数字必须诚实: 仪器报的 N 必须等于复算值(防未来改成写死);
 * ③ 当盲区存在时(现在 42 个), 输出必须点名它们, 不是只报总数。
 */
const path = require('path');
const fs = require('fs');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const SCRIPT = path.join(ROOT, 'scripts', 'dimension-health-audit.js');

module.exports = function ({ test, assertTrue, assertEqual }) {

  function runInstrument() {
    try {
      return execFileSync('node', [SCRIPT], { cwd: ROOT, encoding: 'utf8', timeout: 300000, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) { return (e.stdout || '').toString(); }
  }

  // 锁内独立复算: 与仪器同一判据(corpus-only + 裸 discriminate + signalOf 语义)
  function recompute() {
    const src = fs.readFileSync(path.join(ROOT, 'scripts', 'calibrate-fp-recall.js'), 'utf8');
    const s = src.indexOf('const BENIGN = [');
    const e = src.indexOf('const MALICIOUS = [');
    const e2 = src.indexOf('\n];', e);
    const corpus = eval(src.slice(src.indexOf('[', s), src.indexOf('\n];', s) + 2))
      .concat(eval(src.slice(src.indexOf('[', e), e2 + 2)));
    const idx = require(path.join(ROOT, 'src', 'index.js'));
    const keys = Object.keys(idx.discriminate('x', []).dimensions);
    const fired = new Set();
    const positive = (v) => {
      if (!v || typeof v !== 'object') return false;
      for (const k of ['count', 'score', 'totalHits', 'claims', 'signals']) {
        const val = v[k];
        if (typeof val === 'number' && val > 0) return true;
        if (Array.isArray(val) && val.length > 0) return true;
      }
      return false;
    };
    for (const t of corpus) {
      const r = idx.discriminate(t, []);
      for (const [k, v] of Object.entries((r && r.dimensions) || {})) if (positive(v)) fired.add(k);
    }
    return { total: keys.length, fired: fired.size, silent: keys.filter(k => !fired.has(k)) };
  }

  test('源级: 报告节的计算与输出必须在源码里(行为侧的兜底)', () => {
    const src = fs.readFileSync(SCRIPT, 'utf8');
    assertTrue(/corpusFired/.test(src),
      '仪器源码必须含 corpusFired 的实际计算(只 console.log 不计算 = 写死输出)');
    assertTrue(src.includes('corpus-only 覆盖'),
      '仪器源码必须含 corpus-only 覆盖节的标题字符串(删了它行为侧的正则还能匹配到余下输出行——这是本轮变异验证抓到的)');
    assertTrue(/corpusSilent/.test(src),
      '仪器源码必须含 corpusSilent(盲区清单)的计算与逐一点名输出');
    // 覆盖节必须在 main() 内、汇总之后(而不是一个永假分支)
    const mainIdx = src.indexOf('function main()');
    const covIdx = src.indexOf('corpus-only 覆盖');
    assertTrue(covIdx > mainIdx, '报告节必须在 main() 内');
  });

  test('仪器的 corpus-only 报告数字必须等于独立复算(防硬编码)', () => {
    const rec = recompute();
    const out = runInstrument();
    const line = /语料 (\d+) 条上触发过的维度: (\d+)\/(\d+)/.exec(out);
    assertTrue(!!line, `仪器输出必须含 corpus-only 覆盖节, 实测: ${JSON.stringify(out.split('\n').filter(l => /corpus/.test(l)).slice(0, 2))}`);
    if (line) {
      assertEqual(Number(line[2]), rec.fired,
        `仪器报的触达维度数必须等于锁内独立复算(仪器 ${line[2]} vs 复算 ${rec.fired}) —— 不等就是硬编码或口径漂移`);
      assertEqual(Number(line[3]), rec.total, '分母必须等于引擎 dimensions{} 键数(54)');
    }
    // 盲区必须被点名(只报总数不列名单 = 半份报告)
    if (rec.silent.length) {
      assertTrue(rec.silent.slice(0, 3).every(d => out.includes(d)),
        '盲区维度必须被逐一点名(至少前 3 个), 不是只报总数');
    }
  });

  test('仪器退出码必须为 0(corpus-only 覆盖是披露而非缺陷门禁)', () => {
    execFileSync('node', [SCRIPT], { cwd: ROOT, encoding: 'utf8', timeout: 300000, stdio: ['ignore', 'pipe', 'pipe'] });
    // execFileSync 不抛 = exit 0; 若未来有人把它设成红灯, 这里会抛。
    assertTrue(true, '到此处即 exit 0');
  });
};
