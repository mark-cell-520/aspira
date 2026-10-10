/**
 * test/self-healing-severity-contract.test.js — self-healing 的严重性分级契约
 *
 * ═══ 第一百九十四轮发现的缺陷 ═══
 * AGENTS.md 的 "Decision routing" 一节用**完整路径**公开承诺:
 *   "Retry or give up? `src/cortex/self-healing.js` — severity-based: low retries,
 *    high escalates."
 * 而 `FailureSeverity` 表每一级都显式声明了 `autoRetry`, 带中文 description。
 * 实测: `grep -rn autoRetry src/ test/` **只命中那 5 行定义** —— 这个字段被写好、
 * 被维护、却从未被任何代码读取过。
 *
 * 真正的判据是 `normalizeError().transient`, 一份**独立的第二套正则**
 * (`/timeout|econnreset|eagain|temporar|busy|rate limit|429|throttle/i`)。
 * 两套判据实测分裂:
 *   'request timed out'     classifyFailure=transient, transient=false → shouldRetry=false
 *   'operation timed out …' 同上 —— 最常见的超时表述, 分词形态不在那份正则里
 *   'econnreset'            classifyFailure=medium,    transient=true  → shouldRetry=true
 *
 * 后果不是少一个分支, 而是 **AGENTS.md 承诺的 retry 一侧对最常见的超时表述整个
 * 失效**, 同时 recover() 返回一个结构合法却自相矛盾的应答:
 *   canRetry=false · severityAction='retry' · hint='…retry once' · next_step='repair'
 * —— 调用成功、不抛错、每个字段都在, 而它们互相矛盾。
 *
 * 这与 cycle 191 的 `getFormulaBridge` 未导入、cycle 179 的 `_makeScoreResult`
 * 是同族: **一个被写完就没人再读的字段, 和它本该驱动的那段逻辑, 可以长期不一致
 * 而不产生任何报错。**
 *
 * ═══ 本测试锁什么 ═══
 * 1. severity 表的 autoRetry 必须真的决定 shouldRetry(源级 + 行为级)
 * 2. 十种真实故障形态下 severity / autoRetry / shouldRetry 三者必须一致
 * 3. recover() 的应答不得自相矛盾(canRetry 与 severityAction / hints / next_step)
 * 4. attempt 上限仍然生效(不能为了修好重试而无限重试)
 * 5. 反向证明: 判据若退回 .transient, 必有形态分裂(本锁因此能红)
 */

module.exports = function ({ test, assertEqual, assertTrue }) {
  const fs = require('fs');
  const path = require('path');
  const ROOT = path.join(__dirname, '..');
  const SRC = path.join(ROOT, 'src', 'cortex', 'self-healing.js');
  const { SelfHealing } = require(SRC);

  function make(maxRetries) {
    return new SelfHealing({ maxRetries: maxRetries === undefined ? 3 : maxRetries, backoffMs: 0 });
  }

  /** 十种真实故障形态, 覆盖五档 severity 与判据分裂的三种实测形态 */
  const SHAPES = [
    { msg: 'fatal crash in module',            level: 'critical'   },
    { msg: 'auth denied',                      level: 'high'       },
    { msg: 'unexpected token in json',         level: 'medium'     },
    { msg: 'Cannot find module ./gate.js',     level: 'medium'     },
    { msg: 'request timed out',                level: 'transient'  },
    { msg: 'operation timed out after 30s',    level: 'transient'  },
    { msg: 'econnreset by peer',               level: 'medium'     },
    { msg: 'rate limit exceeded',              level: 'transient'  },
    { msg: 'service busy',                     level: 'transient'  },
    { msg: 'something odd happened',           level: 'low'        },
  ];

  test('源级: autoRetry 必须出现在 shouldRetry 的函数体内(不再是被写完没人读的字段)', () => {
    const src = fs.readFileSync(SRC, 'utf8');
    const start = src.indexOf('shouldRetry(');
    assertTrue(start >= 0, '找不到 shouldRetry');
    // 取到该函数体结束(下一个与方法同级的两空格缩进结束括号)
    const seg = src.slice(start, start + 1500);
    const end = seg.indexOf('\n  }');
    const body = end > 0 ? seg.slice(0, end) : seg;
    assertTrue(/autoRetry/.test(body),
      'shouldRetry 函数体内没有读 autoRetry —— FailureSeverity 表声明的该级是否' +
      '自动重试从未被使用, shouldRetry 会退回它自己那套 transient 正则');
    // 并且不得再读 normalizeError(...).transient 作为重试判据
    assertTrue(!/\.transient/.test(body),
      'shouldRetry 仍在读 .transient —— 那是与 SEVERITY_MAP 并列的第二套判据, ' +
      '实测与 classifyFailure 在 "timed out"/"econnreset" 上分裂');
  });

  test('十种真实故障形态下 severity / autoRetry / shouldRetry 三者必须一致', () => {
    const h = make();
    for (const s of SHAPES) {
      const sev = h.classifyFailure({ message: s.msg }).severity;
      assertEqual(sev.level, s.level,
        `「${s.msg}」的 severity 漂移了(期望 ${s.level}, 实测 ${sev.level})` +
        ' —— 若 SEVERITY_MAP 被有意调整, 请同步更新本表并在注释里写清原因');
      const sr = h.shouldRetry({ message: s.msg, attempt: 0 });
      assertEqual(sr, sev.autoRetry === true,
        `「${s.msg}」severity=${sev.level} autoRetry=${sev.autoRetry} 但 shouldRetry=${sr}` +
        ' —— 两套判据分裂, AGENTS.md 承诺的 "low retries, high escalates" 在这里失效');
    }
  });

  test('被分裂的三种实测形态必须已被修复(本轮的直接锁)', () => {
    const h = make();
    // 修复前实测: classifyFailure=transient 而 shouldRetry=false
    for (const m of ['request timed out', 'operation timed out after 30s']) {
      const sev = h.classifyFailure({ message: m }).severity;
      assertEqual(sev.level, 'transient', `「${m}」应判 transient`);
      assertEqual(h.shouldRetry({ message: m, attempt: 0 }), true,
        `「${m}」是临时故障, shouldRetry 必须为 true(修复前为 false)`);
    }
    // 修复前实测: classifyFailure=medium 而 shouldRetry=true —— 现在两者同为 true, 一致
    const e = h.classifyFailure({ message: 'econnreset by peer' }).severity;
    assertEqual(e.level, 'medium', 'econnreset 应判 medium');
    assertEqual(h.shouldRetry({ message: 'econnreset by peer', attempt: 0 }), true,
      'econnreset 判 medium 且 MEDIUM.autoRetry=true, shouldRetry 必须为 true');
  });

  test('recover() 的应答不得自相矛盾(canRetry / severityAction / hints / next_step)', () => {
    const h = make();
    const cases = [
      { msg: 'request timed out',   canRetry: true  },
      { msg: 'fatal crash',         canRetry: false },
      { msg: 'auth denied',         canRetry: false },
      { msg: 'unexpected token',    canRetry: true  },
    ];
    for (const c of cases) {
      const r = h.recover({ message: c.msg, attempt: 0 });
      assertEqual(r.canRetry, c.canRetry,
        `「${c.msg}」recover().canRetry 应为 ${c.canRetry}, 实测 ${r.canRetry}`);
      // next_step 必须与 canRetry 同向, 不能一个说重试一个说修复
      assertEqual(r.next_step, c.canRetry ? 'retry' : 'repair',
        `「${c.msg}」canRetry=${r.canRetry} 而 next_step=${r.next_step} —— 自相矛盾`);
      // 不可重试时不得给出"催促重试"类 hint。
      // 注意区分两种含 retry 的 hint:
      //   'record full error context before any retry'  —— 前置条件(先记录再谈重试)
      //   'force structured result output before retrying' —— 前置条件
      //   'pause and retry with exponential backoff'   —— 催促重试
      //   'reduce the failure surface and retry once'  —— 催促重试
      // 判据取 "含 retry 且不含 before": 前者是被判不可重试时**不该出现**的,
      // 后者是合理的(它没有承诺会重试, 只是说真要在重试前先做什么)。
      if (!c.canRetry) {
        const retryHints = (r.hints || []).filter(x => /retry/i.test(x) && !/before/i.test(x));
        assertEqual(retryHints.length, 0,
          `「${c.msg}」已判定不可重试, hints 里却仍催促它重试: ${JSON.stringify(retryHints)}`);
      }
    }
  });

  test('attempt 上限仍然生效(修好重试不等于无限重试)', () => {
    const h = make(2);
    assertEqual(h.shouldRetry({ message: 'request timed out', attempt: 0 }), true, 'attempt 0 应可重试');
    assertEqual(h.shouldRetry({ message: 'request timed out', attempt: 1 }), true, 'attempt 1 应可重试');
    assertEqual(h.shouldRetry({ message: 'request timed out', attempt: 2 }), false,
      'attempt 达到 maxRetries(2) 后必须停止 —— 不能为了修好重试而无限重试');
  });

  test('反向证明: 判据若退回 .transient, 必有形态分裂(本锁因此能红)', () => {
    // 为什么不用"把坏实现写进临时目录再 require"做证明:
    // self-healing.js -> self-healing-rl.js -> safe-fs / atomic-write /
    // formula-registry / cognitive-bridge, 相对 require 链有四五层深,
    // 在 tmp 里复刻等于复制半个 src/。这里改用**逻辑等价**的证明:
    // 内联复刻修复前的那行判据, 证明它确实会在某个形态上分裂 ——
    // 结合上面的源级断言(函数体必须读 autoRetry 且不得读 .transient),
    // "把判据改回去" 就等于让用例②红, 无需真的改文件。
    const h = make();
    const brokenShouldRetry = (result) => {
      const normalized = h.normalizeError(result);
      return normalized.transient && (result.attempt || 0) < h.maxRetries;
    };

    let split = null;
    for (const s of SHAPES) {
      const want = h.classifyFailure({ message: s.msg }).severity.autoRetry === true;
      const broken = brokenShouldRetry({ message: s.msg, attempt: 0 });
      if (want !== broken) { split = { msg: s.msg, want, broken }; break; }
    }
    assertTrue(split !== null,
      '内联的坏判据在十种形态上竟然全部分裂不了 —— 那说明 normalizeError 的 transient ' +
      '已经和 SEVERITY_MAP 合并, 本轮修复的理由(两套判据)不再成立, 请重新审视本锁');
    assertEqual(split.broken, false,
      `「${split.msg}」autoRetry=true 而坏判据说 ${split.broken} —— 正是要抓住的分裂`);
  });

  test('诚实披露: SEVERITY_MAP 无词边界, 已知误报(本轮不修, 只钉住)', () => {
    // 实测: /oom/i 无词边界, 'Conference room is booked' 被判 critical;
    //       /auth/i 无词边界, 'author of the paper' 被判 high。
    // 这是 pattern 层的既有局限(AGENTS.md 的 Honest limitations 已声明
    // "obfuscation not covered by patterns is not caught" 的同族), 修它要动
    // SEVERITY_MAP 全部 9 条模式并回归, 超出本轮"一个最小变更"的范围。
    // 这里只把实测钉住: 若将来有人修了, 这条会红, 那时请更新断言。
    const h = make();
    const room = h.classifyFailure({ message: 'Conference room is booked' }).severity;
    assertEqual(room.level, 'critical',
      '「Conference room is booked」当前实测被判 critical(oom 命中 room) —— ' +
      '这是已知误报; 若 SEVERITY_MAP 已加词边界, 请把本断言改为期望的级别');
    const author = h.classifyFailure({ message: 'author of the paper' }).severity;
    assertEqual(author.level, 'high',
      '「author of the paper」当前实测被判 high(auth 命中 author) —— 同上, 已知误报');
  });
};
