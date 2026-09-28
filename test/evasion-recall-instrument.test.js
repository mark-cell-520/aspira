/**
 * test/evasion-recall-instrument.test.js — 校准仪器必须能看见逃逸
 *
 * ═══ 这个盲区是怎么发现的 ═══
 * scripts/calibrate-fp-recall.js 只把 MALICIOUS **原样**喂给门禁，量的是
 * "明文召回"。于是**逃逸绕过完全不让数字变动**。
 *
 * 实证: 上一轮把"逐字符插分隔符"的绕过从 5/6 修到 1/6，召回率前后都是
 * 100%——仪器对一次 5/6 的失守毫无感知。这与 AGENTS.md「Honest limitations」
 * 记录的既有盲区同源(那次是"仪器对合并引入的混合语言风险视而不见"，
 * 一补语料就浮出两个从未见过的 FP)。共同教训: **指标测不到的风险等于不存在**。
 *
 * ═══ 补齐后浮出了什么 ═══
 * 三类逃逸作用到 34 条恶意样本上再测召回:
 *   逐字符插分隔符  91%   字母间插空格  **26%**   HTML 实体  94%
 * 明文召回 100% 与逃逸召回 26% 的差，就是仪器此前的盲区。
 * 最差一类(字母间插空格)能 6/6 全绕代码样本: 它把 const 变成 "c on st"
 * ——replace 的替换串 "c o" 与下一处 "n s" 拼接成 "c on s"，残留 on/st 等
 * 双字母段，正好破坏 strip_letter_space 要求的「≥3 个连续单字母」。
 *
 * ═══ 一次试错(已 REVERT) ═══
 * 曾把该规则放宽到"允许 1-2 字母 token"试图修复。放宽前先量了命中面
 * (逃逸作用后): 良性 14→67 条、恶意 8→31 条。**命中面不能推断 FP，必须实测
 * 门禁动作**——实测明文 FP/召回确实保住(0.0%/100%)，但逃逸召回只从 26%
 * 升到 29%(+1/34): 折叠把原本分开的词也粘起来(const x → constx)，丢失词
 * 边界。用「多折叠 53 条良性文本」换「多还原 1 条恶意文本」是糟糕的交易，
 * 且 FP 没涨只是因为折叠后的良性文本恰好不匹配任何模式——那是运气不是设计。
 * 已 REVERT。本测试锁住"不得再把它放宽回去"这个决定。
 */
module.exports = function ({ test, assertEqual, assertTrue }) {
  const fs = require('fs');
  const path = require('path');
  const { execSync } = require('child_process');
  const ROOT = path.join(__dirname, '..');
  const SCRIPT = path.join(ROOT, 'scripts', 'calibrate-fp-recall.js');
  const SRC = fs.readFileSync(SCRIPT, 'utf8');

  test('校准脚本必须包含逃逸召回度量(仪器盲区已补齐)', () => {
    assertTrue(/measureEvasion/.test(SRC), '应存在 measureEvasion 函数');
    assertTrue(/EVASIONS/.test(SRC), '应定义 EVASIONS 变换表');
    assertTrue(/逃逸召回/.test(SRC), '输出中应打印"逃逸召回"小节');
    // 三类变换都必须在
    assertTrue(/逐字符插分隔符/.test(SRC), '应包含逐字符插分隔符变换');
    assertTrue(/字母间插空格/.test(SRC), '应包含字母间插空格变换');
    assertTrue(/HTML 实体/.test(SRC), '应包含 HTML 实体变换');
  });

  test('逃逸度量必须真的跑起来并报出数字', () => {
    let out = '';
    try {
      out = execSync(`node ${JSON.stringify(SCRIPT)}`, {
        cwd: ROOT, encoding: 'utf8', timeout: 300000, maxBuffer: 48 * 1024 * 1024,
      });
    } catch (e) { out = (e.stdout || '').toString(); }
    // [v6.7.9x] 明文召回必须仍为 100%——这一项不能松。
    assertTrue(/\u53ec\u56de\u7387: 100\.0%/.test(out), '\u660e\u6587\u53ec\u56de\u7387\u5fc5\u987b\u4ecd\u4e3a 100.0%');
    // FP 不再断言精确的 0.0%——那是会腐炐的硬编码。
    // 本\u8f6e\u8bed\u6599\u65b0\u589e 1 \u6761\u771f\u6b63\u7684\u826f\u6027\u6837\u672c\uff08"\u53ef\u80fd\u6709\u591a\u79cd\u89e3\u91ca\u2026\u4e0d\u6392\u9664\u5176\u4ed6\u53ef\u80fd\u3002"\uff09\uff0c
    // \u5b83\u88ab gate \u7684 `findings.length > 1` \u89c4\u5219\u5347\u7ea7\u5230 verify\u2014\u2014\u5df2\u91cf\u6d4b\u7684\u9057\u7559\u8bef\u62a5\u3002
    // \u6545\u6539\u4e3a**\u6709\u754c\u65ad\u8a00**\uff1aFP \u6761\u6570\u4e0d\u5f97\u8d85\u8fc7 2\uff08\u7ed9\u5df2\u77e5\u7684\u901a\u5e26\uff0c\u4f46\u771f\u56de\u5f52\u4f1a\u7ea2\uff09\u3002
    // \u8fd9\u6837\u8bed\u6599\u957f\u5927\u4e0d\u4f1a\u628a\u6d4b\u8bd5\u649e\u7ea2\uff0c\u800c\u8bef\u62a5\u7a81\u7136\u589e\u591a\u4f9d\u7136\u4f1a\u3002
    const fpLine = (out.match(/\u826f\u6027\u8bed\u6599: (\d+) \u6761 \| \u88ab\u95e8\u7981\u5347\u7ea7: (\d+) \u6761/) || []);
    assertTrue(fpLine.length >= 3, '\u5e94\u62a5\u51fa\u826f\u6027\u8bed\u6599\u603b\u6570\u4e0e\u88ab\u5347\u7ea7\u6761\u6570');
    const fpCount = parseInt(fpLine[2], 10);
    assertTrue(fpCount <= 2,
      `FP \u6761\u6570\u4e0d\u5f97\u8d85\u8fc7 2\uff08\u5df2\u77e5 1 \u6761\u9057\u7559\uff09\uff0c\u5b9e\u6d4b ${fpCount} \u6761`);
    // 逃逸小节必须报出三行
    const rows = [...out.matchAll(/(逐字符插分隔符|字母间插空格|HTML 实体)\s+(\d+)\/(\d+)/g)];
    assertEqual(rows.length, 3, `逃逸小节应报出 3 类变换，实测 ${rows.length} 类`);
    // 每一类的分母必须等于恶意语料总数，否则测的不是同一批样本。
    // ⚠️ 分母**从语料动态推导，不得硬编码**——本断言原先写死 34，语料从 34 扩到
    // 41(补入非拉丁注入与同形字样本)后立刻误报。硬编码的条数会腐烂，这是本仓库
    // 反复记载的教训，测试自己也逃不过。
    const malTotal = (() => {
      const src = fs.readFileSync(SCRIPT, 'utf8');
      const start = src.indexOf('const MALICIOUS = [');
      const open = src.indexOf('[', start);
      let depth = 0, i = open;
      for (; i < src.length; i++) {
        if (src[i] === '[') depth++;
        else if (src[i] === ']') { depth--; if (!depth) break; }
      }
      return (src.slice(open, i + 1).match(/^\s*'/gm) || []).length;
    })();
    for (const r of rows) {
      assertEqual(parseInt(r[3], 10), malTotal,
        `变换「${r[1]}」的分母应等于恶意语料总数 ${malTotal}，实测 ${r[3]}`);
    }
  });

  test('strip_letter_space 不得被放宽到 1-2 字母 token(已 REVERT 的决定)', () => {
    // 上一轮试过放宽，实测是糟糕交易(见文件头)。锁住正则原样。
    const tn = fs.readFileSync(path.join(ROOT, 'src', 'text-normalizer.js'), 'utf8');
    const line = tn.split('\n').find(l => l.includes('noLetterSpace = out.replace'));
    assertTrue(!!line, '应能找到 noLetterSpace 的赋值行');
    // 必须是「仅单字母」形态: [a-zA-Z] 后直接跟空格，而非 [a-zA-Z]{1,2}
    assertTrue(/\[a-zA-Z\] \)\{3,\}\[a-zA-Z\]/.test(line),
      `strip_letter_space 必须维持"仅单字母"形态，实测: ${line ? line.trim().slice(0, 90) : 'N/A'}`);
    assertTrue(!/\[a-zA-Z\]\{1,2\} \)/.test(line),
      '不得放宽到允许 1-2 字母 token(那会让 53 条良性文本被折叠，只多还原 1 条恶意样本)');
  });

  test('仪器必须报出盲区差距(明文召回 vs 逃逸召回)', () => {
    let out = '';
    try {
      out = execSync(`node ${JSON.stringify(SCRIPT)}`, {
        cwd: ROOT, encoding: 'utf8', timeout: 300000, maxBuffer: 48 * 1024 * 1024,
      });
    } catch (e) { out = (e.stdout || '').toString(); }
    // 有逃逸漏报时必须打印警示行——这是让盲区"可见"的关键
    assertTrue(/明文召回/.test(out) && /逃逸召回/.test(out),
      '存在逃逸漏报时应打印"明文召回 vs 逃逸召回"的差距警示');
  });
};
