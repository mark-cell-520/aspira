/**
 * test/no-tmp-corpus-dependency.test.js
 *
 * [test-coverage-gap·第二百一十二轮] 新建。
 *
 * ═══ 缺口 ═══
 * 曾有四个测试读 `/tmp/corpus149.json`。那是某轮探针写下的临时文件、**从不在
 * git 里**, 所以它的存在取决于这台机器上恰好还有什么。三种坏法:
 *
 *   ① `if (!fs.existsSync(p)) return;` —— 文件不在就**什么都不测, 退出 0**。
 *      失败与成功在输出上不可区分(cycle 15 的静默跳过形状)。本轮实测该文件
 *      在本机不存在, 所以走这条路的两个用例(absolute-claim-commitment 第三例、
 *      contradiction-self-correction 第五例)此前是**零覆盖**。
 *   ② existsSync 兜底一份固定样本 —— 永远能跑, 但文件在与不在测的是两批
 *      不同数据, 读数静默变化(dimension-guidance-coverage 第二例)。
 *   ③ 数字过时被跳过掩盖 —— contradiction-self-correction 的用例名写着
 *      "132 benign / 58 malicious", 而语料早已是 137/64。跑了会红, 不跑则
 *      永远绿, 两者互相掩盖。
 *
 * cycle 207 修了同族的另两处(run-all 的 node PATH、reasoning-coherence-gate-
 * dead-branch 的 /tmp 读取)并留下这三处, 原话是"三处的断言都要对着 199-sample
 * corpus 重新推导"。
 *
 * ═══ 修法 ═══
 * 三处都改从 `scripts/calibrate-fp-recall.js` 解析数组字面量(**不执行**它 ——
 * 它顶层跑完整校准并写 data/feedback/), 抽成共享 helper `test/_corpus-arrays.js`,
 * 解析失败抛错而非返回空数组(空数组会让某些断言恒真)。
 *
 * ═══ 本锁 ═══
 * 这不是"那三处已修"的锁(那由它们自己证明), 而是**不许再犯**的锁:
 *   ① 机械扫描 test/ 下所有活测试文件, 任何一处读 /tmp/corpus*.json 即红,
 *      并点名文件与行号 —— cycle 9 的教训: 一条我反复重新学到的规则,
 *       该由套件强制, 不该由我记得。
 *   ② 任何 `if (!fs.existsSync(<语料路径>)) return;` 的静默跳过形状即红。
 *   ③ 共享 helper 本身必须真的能从仓库内取到语料, 且取到的规模与
 *      校准脚本实测一致(否则三处修复会一起变成恒真)。
 */
module.exports = function ({ test, assertEqual, assertTrue }) {
  const fs = require('fs');
  const path = require('path');
  const { execFileSync } = require('child_process');

  const ROOT = path.join(__dirname, '..');
  const TEST_DIR = path.join(ROOT, 'test');

  // 收集活测试文件(与 runner 同口径: 只扫 test/ 下 *.test.js, 不扫 archive)
  // **排除本 lock 自己**: 它的自证用例必须内联被禁的形态(否则证明不了"剥后仍抓
  // 得到"), 而那正是前两例要扫的形态。不排除就是自己抓自己。
  // 代价披露: 若将来有人把 /tmp 依赖写进本文件, 前两例看不见它 —— 可接受,
  // 因为本文件的职责本身就是禁这个, 且自证用例仍会因形态失效而红。
  function liveTestFiles() {
    const out = [];
    const SELF = path.basename(__filename);
    const walk = (d) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) {
          if (e.name === 'archive' || e.name === 'dead-tests' || e.name === 'node_modules') continue;
          walk(p); continue;
        }
        if (/\.test\.js$/.test(e.name) && e.name !== SELF) out.push(p);
      }
    };
    walk(TEST_DIR);
    return out;
  }

  // 长度保留地剥掉注释(行注释与块注释都剥), 再匹配。
  //
  // ⚠️ 这条剥离是**必需的**, 不是装饰, 而且本 lock 自己就是它的第一个客户:
  // 本轮首版只剥了 `//` 行注释, 于是三个刚修好的文件里那段引用着被删旧代码的
  // 注释(`/tmp/corpus149.json` 与 `if (!fs.existsSync(p)) return;`)被当成罪证;
  // 补剥块注释后, **本 lock 自己的 JSDoc 文件头**又成了罪证 —— 它必须写出这条
  // 规则才能让人读懂, 而规则的字面形态正是被禁的形态。
  //
  // 这是 cycle 19/25/194/195/197/209 已记录 7 次的形状(**一把按文本匹配而不看
  // 上下文的仪器, 会把注释里的画当成代码**), 本轮是第 8 次, 且第一次栽在
  // "锁自己的文档"上 —— 因为前七次的注释都在被扫的**别的**文件里, 这次锁要扫
  // 包括它自己的全部测试文件。
  //
  // 实现要点:
  //   · **长度保留**: 注释内容换成等长空格, 行号与列号不变, 报错才指得准。
  //   · **不剥字符串**: 一个字符串里出现 "/tmp/corpus" 仍然是真在读那条路径,
  //     剥了它就是漏报(cycle 193: 剥了字符串就看不到 require 的内容)。
  //   · 只认 `//` 与 `/*`: 不尝试解析模板字符串/正则字面量, 那些里的 `//`
  //     会造成过度剥离 —— 过度剥离的方向是漏报, 所以刻意保守, 并由下面的
  //     自证用例兜住"剥得太多"这个风险。
  function codeLines(src) {
    let out = '';
    let i = 0;
    while (i < src.length) {
      const two = src.slice(i, i + 2);
      if (two === '//') {
        while (i < src.length && src[i] !== '\n') { out += ' '; i++; }
        continue;
      }
      if (two === '/*') {
        out += '  '; i += 2;
        while (i < src.length && src.slice(i, i + 2) !== '*/') {
          out += (src[i] === '\n') ? '\n' : ' ';
          i++;
        }
        if (i < src.length) { out += '  '; i += 2; }
        continue;
      }
      out += src[i]; i++;
    }
    return out.split('\n').map((text, idx) => ({ n: idx + 1, text })).filter(l => l.text !== '');
  }

  // ── 一、任何测试都不得再读 /tmp 语料 ──────────────────────
  test('任何活测试文件都不得再读 /tmp 下的语料文件', () => {
    const files = liveTestFiles();
    assertTrue(files.length > 100, `前提失效: 只找到 ${files.length} 个活测试文件, 扫描范围不对`);
    const offenders = [];
    for (const f of files) {
      for (const { n, text } of codeLines(fs.readFileSync(f, 'utf8'))) {
        if (/\/tmp\/corpus/i.test(text)) {
          offenders.push(`${path.relative(ROOT, f)}:${n}  ${text.trim().slice(0, 80)}`);
        }
      }
    }
    assertEqual(offenders.join('\n'), '',
      `以下 ${offenders.length} 处仍在读 /tmp 语料 —— 该文件从不在 git 里, ` +
      '它的存在取决于这台机器上恰好还有什么。请改用 test/_corpus-arrays.js:\n  ' +
      offenders.join('\n  '));
  });

  // ── 二、不得用 existsSync 静默跳过语料用例 ────────────────
  test('不得以 existsSync 静默跳过语料相关用例(读了不存在就退出 0)', () => {
    const files = liveTestFiles();
    const offenders = [];
    for (const f of files) {
      for (const { n, text } of codeLines(fs.readFileSync(f, 'utf8'))) {
        // 形状: if (!fs.existsSync(X)) return;
        if (/if\s*\(\s*!fs\.existsSync\([^)]*\)\s*\)\s*return\s*;/.test(text)) {
          offenders.push(`${path.relative(ROOT, f)}:${n}  ${text.trim().slice(0, 80)}`);
        }
      }
    }
    assertEqual(offenders.join('\n'), '',
      `以下 ${offenders.length} 处在语料文件不存在时直接 return —— ` +
      '那一条用例什么都不测却退出 0, 失败与成功不可区分(cycle 15 形状):\n  ' +
      offenders.join('\n  '));
  });

  // ── 二点五、自证: 注释剥离不许剥掉真代码 ──────────────────
  // 上面那条剥离是保守的(不解析模板字符串/正则), 方向是**漏报**: 剥太多就会
  // 把真在读 /tmp 的代码一起剥掉。所以必须有一个方向证明"剥完后仍抓得到"。
  // 没有这一条, 前两例可以是"因为剥得太干净而恒绿"。
  test('自证: 注释剥离后仍能抓到真的 /tmp 读取与真的 existsSync 跳过', () => {
    // ① 真代码必须仍被匹配到
    const realCode = [
      "const p = '/tmp/corpus149.json';",
      "if (!fs.existsSync(p)) return;",
    ].join('\n');
    const got = codeLines(realCode);
    assertTrue(/\/tmp\/corpus/i.test(got.map(l => l.text).join('\n')),
      '剥离把真实的 /tmp 读取也剥掉了 —— 前两例会因此恒绿');
    assertTrue(got.some(l => /if\s*\(\s*!fs\.existsSync\([^)]*\)\s*\)\s*return\s*;/.test(l.text)),
      '剥离把真实的 existsSync 静默跳过也剥掉了 —— 前两例会因此恒绿');

    // ② 纯注释必须被剥掉(否则本 lock 自己的文件头会一直被当成罪证)
    // ⚠️ 这里必须是**真实的注释形态**写在字符串内容里, 不能是"长得像注释的字符串" ——
    // 剥离器刻意不剥字符串(cycle 193: 剥了字符串就看不到 require 的内容), 所以
    // 用后者测前者, 期望本身就错了。本轮首版正是这样错了一次。
    const onlyComment = '// 曾有测试读 /tmp/corpus149.json。\n' +
      '/* if (!fs.existsSync(p)) return; */';
    const stripped = codeLines(onlyComment).map(l => l.text).join('\n');
    assertTrue(!/\/tmp\/corpus/i.test(stripped),
      '纯注释没被剥掉 —— 本 lock 自己的文档会一直被当成罪证(本轮已栽过一次)');
    assertTrue(!/existsSync/.test(stripped),
      '块注释没被剥掉 —— 本 lock 自己的 JSDoc 会一直被当成罪证');

    // ③ 长度保留: 行数必须守恒(否则报的行号是错的)
    // 用"行数守恒"而不是手数的行数 —— 手数会错(本轮首版就数错了一个 5 行的样本)。
    for (const sample of [
      'a\n// b\n/* c\nd */\ne',
      'const p = 1; // 行尾注释\nconst q = 2;',
      '/**\n * JSDoc 跨\n * 多行\n */\nfunction f() {}',
      'const s = "http://example.com"; // 字符串里的 // 不是注释',
    ]) {
      assertEqual(codeLines(sample).length, sample.split('\n').length,
        '剥离改变了行数 —— 报出来的行号会指错位置');
    }
  });

  // ── 三、共享 helper 必须真的取得到语料 ────────────────────
  test('共享 helper 取到的语料规模必须与校准脚本实测一致', () => {
    const { loadCorpus } = require('./_corpus-arrays.js');
    const c = loadCorpus();
    assertTrue(c.benignCount > 0 && c.maliciousCount > 0,
      `helper 取到空语料(benign ${c.benignCount} / malicious ${c.maliciousCount}) —— ` +
      '三处修复会因此一起变成恒真');
    assertEqual(c.ALL.length, c.benignCount + c.maliciousCount, 'ALL 必须等于两份数组之和');

    // 与校准脚本自己报的数对照(它是唯一真相源)
    let out = '';
    try {
      out = execFileSync('node', [path.join(ROOT, 'scripts', 'calibrate-fp-recall.js')], {
        cwd: ROOT, encoding: 'utf8', timeout: 300000, stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (e) { out = ((e.stdout || '') + (e.stderr || '')).toString(); }
    const ben = (/良性语料:\s*(\d+)\s*条/.exec(out) || [])[1];
    const mal = (/恶意语料:\s*(\d+)\s*条/.exec(out) || [])[1];
    assertTrue(!!ben && !!mal, '校准脚本没报语料规模 —— 输出形态变了?');
    assertEqual(c.benignCount, Number(ben),
      `helper 取到 benign ${c.benignCount}, 校准脚本实测 ${ben} —— 解析器少读了`);
    assertEqual(c.maliciousCount, Number(mal),
      `helper 取到 malicious ${c.maliciousCount}, 校准脚本实测 ${mal} —— 解析器少读了`);
    console.log(`     helper: benign ${c.benignCount} / malicious ${c.maliciousCount} / 共 ${c.corpusSize}(与校准脚本一致)`);
  });
};
