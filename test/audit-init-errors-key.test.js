/**
 * test/audit-init-errors-key.test.js — 模块初始化错误数的审计锁
 *
 * [doc-honest-numbers·第一百三十轮] 新建。
 *
 * ═══ 背景: cycle 11 的 key 集 diff 重演 ═══
 * 本轮 diff pats 的 key 集与 measure() 实际赋值的 key 集(先扫 `actual.x =`
 * 形态, 后补对象字面量属性——首版漏了它, 得出 5 个假阳性, 已修正), 发现:
 * `initErrors` **每轮都被实测**(start() 后读), SKILL/README 的指标表也有
 * 声称(| Module init errors | 0 |), 但 actual 从未接收它、pats 没有 key。
 * 一个被测量、被打印的数字与一个被声称的数字从未相遇 —— cycle 11 修过
 * version/testsFailed 两个, 这是同族第三例。
 *
 * ═══ 修法 ═══
 * ① pats 加 initErrors key(表格形 + 散文形, 散文形带 selfRef/narrative
 *    reject——讨论历史错误的句子是叙事);
 * ② actual 对象字面量加 initErrors(紧贴 suspectedDead, 同族实测);
 * ③ **实测口径对齐文档**: SKILL 表格第三列明写口径是 `hf._initErrors.length`,
 *    而原实测读 inst.initErrors(实例上没这个字段, 永远 undefined/null),
 *    于是"文档说 0"一直沦落为"无法实测"。测量口径与声称口径不一致是
 *    cycle 44/47 教过的错, 这是第三次。改成优先 _initErrors.length。
 *
 * ═══ 锁什么 ═══
 * ① 源级: key/模式/actual 赋值/实测口径都在;
 * ② 活体: 注入错值审计必须点名 README;
 * ③ 恢复后 0 不一致。
 */
const path = require('path');
const fs = require('fs');
const { execFileSync } = require('child_process');
const { withDocLock } = require('./_doc-probe-lock.js');

const ROOT = path.join(__dirname, '..');
const SCRIPT = path.join(ROOT, 'scripts', 'audit-doc-numbers.js');
const README = path.join(ROOT, 'README.md');

module.exports = function ({ test, assertTrue }) {

  // 含 spawn 的具名辅助函数 —— doc-probe-lock-coverage 的判据(spawn 写在
  // 模块层辅助函数里, 持锁在调用处; cycle 129 首版内联被判"无法判定")。
  function runAuditQuiet() {
    try {
      return execFileSync('node', [SCRIPT], {
        cwd: ROOT, encoding: 'utf8', timeout: 300000, stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, ASPIRA_AUDIT_SKIP_TESTS: '1' },
      });
    } catch (e) { return (e.stdout || '').toString(); }
  }

  test('源级: initErrors 的 key/模式/actual 赋值/实测口径都必须在', () => {
    const src = fs.readFileSync(SCRIPT, 'utf8');
    assertTrue(/key:\s*'initErrors'/.test(src),
      'pats 必须有 initErrors key —— 少了它, "Module init errors" 声称无人核对');
    assertTrue(/Module init errors\\s\*\|\\s\*\(\\d\+\)|Module\s+init\s+errors/.test(src),
      'initErrors 的模式必须覆盖表格形(与 README/SKILL 的指标表一致)');
    assertTrue(/initErrors:\s*m\.initErrors/.test(src),
      'actual 对象字面量必须接收 initErrors(漏了它 = key 永远"无法实测")');
    assertTrue(/_initErrors/.test(src),
      '实测口径必须读 _initErrors.length(SKILL 表格第三列明写的口径; 读 inst.initErrors 永远 undefined)');
  });

  test('活体: 注入错值, 审计必须抓住', () => withDocLock(() => {
    const backup = fs.readFileSync(README, 'utf8');
    const from = '| Module init errors | 0 |';
    if (!backup.includes(from)) throw new Error('README.md 无 "| Module init errors | 0 |" 锚点');
    try {
      fs.writeFileSync(README, backup.replace(from, '| Module init errors | 3 |'));
      const out = runAuditQuiet();
      const sec = out.split('与实测不符')[1] || '';
      assertTrue(/README\.md/.test(sec),
        '注入 3 后审计必须点名 README.md 不符 —— 抓不到就是恒真锁。实测: ' +
        JSON.stringify(out.split('\n').filter(l => /不一致/.test(l)).slice(0, 2)));
      assertTrue(/initErrors|Module init/.test(sec) || /3/.test(sec),
        '不一致明细必须体现 initErrors 声称(实测 0 vs 声称 3)');
    } finally {
      fs.writeFileSync(README, backup); // 铁律 0: 不得留注入态
    }
  }));

  test('恢复后: 审计必须无不一致', () => withDocLock(() => {
    const out = runAuditQuiet();
    const mism = /不一致: (\d+)/.exec(out);
    assertTrue(mism && Number(mism[1]) === 0,
      `恢复后审计应 0 不一致, 实测 ${mism ? mism[1] : '?'}`);
  }));
};
