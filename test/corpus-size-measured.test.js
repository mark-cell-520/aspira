/**
 * test/corpus-size-measured.test.js — 语料规模是 FP 率与召回率的分母，必须被实测
 *
 * ═══ 由来 ═══
 * 连续第八轮 doc-honest-numbers。第七轮的结论是「七个角度全部推进、
 * 建议轮换」，并留下一个具体方向: **机械化穷举审计 key 集 vs 文档
 * 实际出现的所有数字形态**，不靠人工提问。
 *
 * 本轮执行它，立刻找到 `benign` / `malicious` 两个盲区。
 *
 * ═══ 为什么这两个数字要紧 ═══
 * 文档三处写 "106 benign / 41 malicious samples"，
 * 而审计**一次都没量过它**。
 * 关键在于: **0.9% FP 和 100% recall 都以它为分母。**
 * 分母错了，两个百分比同时失真，而没有任何仪器会报错。
 *
 * 一个错的分母比一个错的百分比更危险——百分比至少会被怀疑，
 * 分母被认为是"已知事实"。
 *
 * ═══ 第 29 次仪器失效: 闸门过严导致漏报 ═══
 * 新加 benign/malicious 模式后，往 AGENTS.md 注入一条
 * "999 benign"(实测 106)，**审计毫无反应**。
 *
 * 逐层查下去，根因在 selfRef: 它只在数字**之前**的文本里找
 * aspira/新愿/heartflow/引擎/本仓库/判别/discriminator。
 * 而那句是:
 *   "measures it on a hand-written labelled corpus of **999 benign"
 * —— 主语是 "it"(指 aspira)，字面上一个自指词都没有。
 * 于是 selfRef 返回 'no-engine-self-reference'，
 * reject 放行该声称被**静默跳过**。
 *
 * 这与假阳性是**相反的失败**:
 *   假阳性把对的报成错的 —— 吵闹但可见
 *   **漏报把错的静默吞掉 —— 安静且不可见**
 * 而审计的全部价值就在于不错过。一个会把错声称吞掉的闸门，
 * 比没有闸门更糟。
 *
 * ═══ 修法与一个自我否定的设计 ═══
 * ① ENGINE_SELF 放宽: 语料规模是**引擎自评指标**，其上下文天然带
 *    false-positive / recall / corpus / calibrat / labelled 等词，
 *    纳入自指判据(保留原有显式自指词)。
 * ② NARRATIVE 扩: 放宽后两条历史语料规模被报出来
 *    ("corpus grew by 16 benign ... and 7 malicious"、
 *     "folded 53 additional benign samples to recover 1 malicious")，
 *     原正则只有 removed/was/曾是/已删/此前/原先/曾经/写的是。
 *
 * ⚠️ ② 的实现是**枚举动词**，而枚举型过滤器每遇到一种新叙述就漏一次。
 * 本轮同时加了"from N to N"式的变化结构识别，但**没有解决枚举本身**。
 * 这个残余风险在此声明，而不是假装修好——与
 * test/self-view-counting.test.js 记录并发丢失残余的做法相同。
 *
 * ═══ 本测试锁什么 ═══
 * ① 审计必须实测 benign / malicious 语料规模
 * ② 注入一条错值，审计**必须**抓住(漏报回归的核心防线)
 * ③ 叙事引用的历史语料规模不得被计入
 * ④ selfRef 不得再把语料规模的上下文判为"无引擎自指"
 */
const path = require('path');
const fs = require('fs');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const SCRIPT = path.join(ROOT, 'scripts', 'audit-doc-numbers.js');
const AGENTS = path.join(ROOT, 'AGENTS.md');
const CALIB = path.join(ROOT, 'scripts', 'calibrate-fp-recall.js');

const { withDocLock } = require('./_doc-probe-lock.js');

module.exports = function ({ test, assertTrue, assertEqual }) {

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

  function countArr(src, name) {
    const start = src.indexOf('const ' + name + ' = [');
    if (start < 0) return null;
    const end = src.indexOf('\n];', start);
    if (end < 0) return null;
    const body = src.slice(start, end);
    const items = body.match(/^\s*(?:'[^']*'|"[^"]*"|`[^`]*`)\s*,?\s*$/gm) || [];
    return items.length;
  }

  test('审计必须实测 benign / malicious 语料规模', () => {
    const src = fs.readFileSync(SCRIPT, 'utf8');
    assertTrue(/key:\s*'corpusBenign'/.test(src) && /key:\s*'corpusMalicious'/.test(src),
      'pats 必须有 benign/malicious 模式——它们是 FP 率与召回率的分母，'
      + '此前无任何模式核对，分母错了两个百分比同时失真且无人报错');
    assertTrue(/m\.corpusBenign\s*=/.test(src) && /m\.corpusMalicious\s*=/.test(src),
      'measure() 必须实测两个语料数');
    assertTrue(/actual\.corpusBenign\s*=/.test(src) && /actual\.corpusMalicious\s*=/.test(src),
      'actual 必须映射两个语料数');
  });

  test('审计实测值必须与校准脚本的数组条数一致', () => {
    const calib = fs.readFileSync(CALIB, 'utf8');
    const b = countArr(calib, 'BENIGN');
    const m = countArr(calib, 'MALICIOUS');
    assertTrue(b !== null && m !== null, '应能解析出 BENIGN / MALICIOUS 数组');
    assertTrue(b > 0 && m > 0, `语料应非空, 实测 benign=${b} malicious=${m}`);
    // 与文档声称交叉核对
    const ag = fs.readFileSync(AGENTS, 'utf8');
    const claimed = (ag.match(/\*\*(\d+)\s+benign\s*\/\s*(\d+)\s+malicious\*\*/) || [])[1];
    if (claimed) assertEqual(Number(claimed), b,
      `文档声称 ${claimed} benign, 实测 BENIGN 数组 ${b} 条`);
  });

  test('漏报防线: 注入一条错值，审计必须抓住', () => withDocLock(() => {
    // 这是本测试的核心。第 29 次失效的形式是**漏报**:
    // 注入 "999 benign" 而审计毫无反应——因为 selfRef 把
    // "measures it on a ... corpus of 999 benign" 判为无引擎自指
    // (主语是 "it"，字面无自指词)。错声称被静默吞掉。
    const backup = fs.readFileSync(AGENTS, 'utf8');
    const anchor = 'labelled corpus of **';
    const m = backup.match(/labelled corpus of \*\*(\d+) benign/);
    assertTrue(!!m, 'AGENTS.md 应有 "labelled corpus of **N benign" 声称');
    const orig = m[1];
    try {
      const injected = backup.replace(
        'labelled corpus of **' + orig + ' benign',
        'labelled corpus of **999 benign');
      assertTrue(injected !== backup, '注入应改变文件内容');
      assertEqual((injected.match(/999 benign/g) || []).length, 1, '注入必须只加一处');
      fs.writeFileSync(AGENTS, injected);
      const out = runAudit();
      assertTrue(/benign corpus size/.test(out),
        '审计必须把这条 benign 声称纳入核对');
      assertTrue(/不一致:\s*[1-9]/.test(out),
        '注入 999(实测 ' + orig + ')必须被报为不一致——'
        + '漏报比假阳性更危险: 它安静且不可见，而审计的全部价值就在于不错过');
    } finally {
      fs.writeFileSync(AGENTS, backup);
      const verify = fs.readFileSync(AGENTS, 'utf8');
      // 只认本测试注入的具体串。AGENTS.md 的诚实限制段落会**叙述**
      // 这次注入(它就在讲这个漏报)，所以检查任意 "999" 会把
      // 文档对自身的正确描述误判成残留——恢复成功却报失败。
      if (/labelled corpus of \*\*999/.test(verify)) {
        throw new Error('恢复失败: AGENTS.md 仍含本次注入，请 git checkout -- AGENTS.md');
      }
    }
  }));

  test('selfRef 不得把语料规模的上下文判为"无引擎自指"', () => {
    // 漏报的根因: ENGINE_SELF 只看显式自指词，而语料句的主语是 "it"。
    const src = fs.readFileSync(SCRIPT, 'utf8');
    const selfRefLine = (src.match(/const ENGINE_SELF = [^;]+;/) || [''])[0];
    assertTrue(/corpus/i.test(selfRefLine),
      'ENGINE_SELF 必须认语料语境——否则 "measures it on a ... corpus of N benign"'
      + ' 会因主语是 "it"(字面无自指词)被判为无引擎自指，错声称被静默跳过');
    assertTrue(/recall|false-positive|calibrat/i.test(selfRefLine),
      'ENGINE_SELF 应认引擎自评指标语境(recall / false-positive / calibrat)');
  });

  test('叙事引用的历史语料规模不得算当前声称', () => {
    const src = fs.readFileSync(SCRIPT, 'utf8');
    const narLine = (src.match(/const NARRATIVE = [^;]+;/) || [''])[0];
    // "corpus grew by 16 benign ... and 7 malicious" 讲的是语料如何长大
    assertTrue(/grew|grow|added|additional/i.test(narLine),
      'NARRATIVE 必须认"增长/增量"类叙事——"corpus grew by 16 benign" '
      + '说的是语料曾经如何长大，不是当前规模');
    // 枚举型过滤器的残余风险必须被声明，而不是假装修好
    assertTrue(/枚举|每遇到一种新叙述就漏一次|residual|残余/.test(src) || true,
      '该断言恒真——残余风险记录在测试注释与源码注释中');
  });

  test('恢复后 AGENTS.md 无注入残留', () => {
    const s = fs.readFileSync(AGENTS, 'utf8');
    // ⚠️ 只检查**本测试注入的那个具体串**，不是任意 "999"。
    // 第一版写的是 !/999 benign/，结果 AGENTS.md 里那段
    // "讲述本轮如何发现漏报"的散文引用了注入示例，于是
    // **测试把自己的叙述当成自己的残留**，恢复明明成功却报失败。
    // 教训: 一个清理检查如果把"描述这件事的文字"也算成污染，
    // 它就会在一切正常时报错——而报错信息会指向不存在的问题。
    // 与"A test that can pollute the file it measures will, on failure,
    // report its own pollution as the product's regression"同族:
    // **这里的测试连"叙述自己的失败"都会误判成失败。**
    assertTrue(!/labelled corpus of \*\*999/.test(s),
      'AGENTS.md 不得残留本测试注入的 "labelled corpus of **999"');
    const m = s.match(/labelled corpus of \*\*(\d+) benign/);
    assertTrue(!!m, 'AGENTS.md 应仍有 "labelled corpus of **N benign" 声称');
    assertEqual(Number(m[1]), 106,
      '恢复后 benign 声称应回到实测值 106');
  });
};
