/**
 * test/dimension-finding-pool-attribution.test.js
 *
 * [dimension-health-audit·第二百零九轮] 新建。
 *
 * ═══ 缺口 ═══
 * `scripts/dimension-health-audit.js` 把三个输入池拼成一份**去重的字符串数组**:
 *     const pool = [];  for (const s of [...poolA, ...poolB, ...poolC]) { ... pool.push(s); }
 * 于是"这条 finding 是哪个池贡献的"在去重那一步就永久丢了。仪器从此只能说
 * "53 个维度推过 finding", 说不出其中哪些的 finding **完全**来自测试作者
 * 自己写的字符串。
 *
 * 本轮实测(三池分开各跑一遍裸 discriminate(), 逐维分桶):
 *   · 53 个推过 finding 的维度里, 有 7 个的 finding 100% 出自池 B(测试字面量),
 *     池 A(语料)与池 C(引擎正则片段)都是 0:
 *       contradiction, reasoning_coherence, goal_misalignment, privacy_boundary,
 *       pseudo_profundity, perfect_error, coverup_induction
 *   · 其中 contradiction 是 VERIFY_DIMS 成员(能把 gate 推到 verify), 37 条
 *     finding 全部出自测试作者自己写的字符串
 *   · 另有 26 个非仅打分维度在语料上零 finding
 *
 * 所以"这个维度活着"这个结论, 对这 7 个而言是**测试自己证明自己**: 输入是
 * 测试写的, 断言也是测试写的, 仪器只确认两者仍然一致。这不等于维度失效
 * (它在大池里确实推 finding), 但它的行为**没有被任何独立于测试的输入表达过**。
 * 这与 cycle 203 披露的语料盲区(22/54 触达)是同一族, 只是那一轮只数到
 * "语料触达几个", 没数到"其中有几个连正则片段都碰不到、只有测试字面量在撑"。
 *
 * ═══ 修法 ═══
 * 仪器在同一次遍历里按来源分桶(不是再跑三遍 —— 那会把 6 秒变成 18 秒):
 *   · 去重时把来源存成集合(同一条输入可能同见于两个池)
 *   · tally 每维加 bySrc: {A, B, C}
 *   · 新增"finding 来源归属"段, 单列"仅测试字面量支撑"的维度
 * 该段**不设阈值、不判红**: 它是一份归属清单。"多少比例才算独立"是产品判断,
 * 不是仪器的职责(铁律 2)。
 *
 * ═══ 本锁 ═══
 * ① 源级: 池构造必须保留来源, tally 必须分桶(否则新段不可能有数据)
 * ② 行为: spawn 真仪器, 必须打出来源归属段; "仅测试字面量支撑"清单必须非空,
 *    且每个成员都是引擎 dimensions{} 的真键名(不是手写表)
 * ③ 反向证明: 把 bySrc 分桶摘掉, ②必须按名红(证明这把锁真能失败)
 *
 * 遵循 aspira 约定 #4: 位于 test/ 根目录、module.exports=函数 导出。
 */
module.exports = function ({ test, assertEqual, assertTrue }) {
  const fs = require('fs');
  const path = require('path');
  const { execFileSync } = require('child_process');

  const ROOT = path.join(__dirname, '..');
  const SCRIPT = path.join(ROOT, 'scripts', 'dimension-health-audit.js');
  const src = fs.readFileSync(SCRIPT, 'utf8');

  // ── 一、源级: 池必须保留来源, tally 必须分桶 ────────────
  test('仪器必须在同一次遍历里按输入池归属 finding(源级)', () => {
    // ① 池构造: 从"字符串数组"变成"带来源集合的对象数组"
    assertTrue(/pool\.push\(\{\s*text:\s*s,\s*srcs\s*\}\)/.test(src),
      '池构造必须把来源一起存下来(pool.push({ text, srcs })) —— ' +
      '否则去重那一步就把"这条 finding 是谁贡献的"永久丢了');
    // ② 来源必须用集合而非单值: 同一条输入可能同见于两个池
    assertTrue(/new Set\(\[tag\]\)/.test(src),
      '来源必须是集合(同一输入可能同见于多个池), 不是单值');
    // ③ tally 每维必须有 bySrc 三个桶
    assertTrue(/bySrc/.test(src), 'tally 必须有 bySrc 字段');
    const m = src.match(/for \(const t of POOL_NAMES\) bySrc\[t\] = 0;/);
    assertTrue(!!m, 'bySrc 必须对 A/B/C 三个池都初始化(否则某个池恒为 0 而不被察觉)');
    // ④ 主循环必须按 srcs 分桶
    assertTrue(/for \(const t of srcs\) tally\[key\]\.bySrc\[t\]\+\+/.test(src),
      '主循环必须把每条 finding 记进它来源的每个池');
    // ⑤ 三处遍历 pool 都必须解构 —— 漏掉任何一处都是 SyntaxError 或静默错值。
    //    精确分两类数: 只读 dimensions 键名的两处只要 { text }, tally 主循环要 { text, srcs }。
    //    (用宽正则 `\{ text[^)]*\}` 会把 tally 那处也数进来, 于是"期望 2 实际 3"——
    //     一把因为自己数错而红的锁, 会让人去改没坏的代码。)
    const textOnly = src.match(/for \(const \{ text \} of pool\)/g) || [];
    assertEqual(textOnly.length, 2, '两处只读 dimensions 键名的遍历必须解构 { text }');
    const tallyLoop = src.match(/for \(const \{ text, srcs \} of pool\)/g) || [];
    assertEqual(tallyLoop.length, 1, 'tally 主循环必须解构 { text, srcs }');
    // 池 A 的 corpus-only 段仍遍历原始 poolA(字符串数组), 不属于本次改动
    const poolALoop = src.match(/for \(const t of poolA\)/g) || [];
    assertEqual(poolALoop.length, 1, 'corpus-only 段应仍遍历原始 poolA(未受本次改动影响)');
  });

  // ── 二、行为: 真仪器必须打出来源归属段 ──────────────────
  // ⚠️ 本用例 spawn 真仪器。该脚本纯计算、零文件写入/无网络/无子进程
  // (与 test/dimension-health-invariant.test.js 同一前提, 见其文件头),
  // 故可安全并入 run-all 的并发执行。实测耗时约 6 秒。
  test('真仪器必须打出来源归属段, 且"仅测试字面量支撑"清单非空、成员合法', () => {
    let out = '';
    try {
      out = execFileSync('node', [SCRIPT], {
        cwd: ROOT, encoding: 'utf8', timeout: 180000, maxBuffer: 64 * 1024 * 1024,
      });
    } catch (e) {
      out = ((e.stdout || '') + (e.stderr || '')).toString();
      if (!out) throw new Error('仪器 spawn 失败: ' + e.message);
    }
    assertTrue(/finding 来源归属/.test(out), '输出必须含「finding 来源归属」段');
    assertTrue(/A 语料 \/ B 测试字面量 \/ C 正则片段/.test(out),
      '该段必须说明 A/B/C 三个池各是什么(读者否则无法解读分桶)');

    // "仅测试字面量支撑"清单: 必须存在、必须非空
    const line = out.split('\n').find(l => /其中仅测试字面量支撑/.test(l));
    assertTrue(!!line, '必须打印"其中仅测试字面量支撑...的 N 个"汇总行');
    const n = Number((/的 (\d+) 个/.exec(line) || [])[1]);
    assertTrue(n > 0,
      '仅测试字面量支撑的维度数是 0 —— 要么来源分桶没生效(本锁第一条例已挡), ' +
      '要么三个池的覆盖面变了。当前实测 7 个, 若此处变 0 请先读仪器新段再判断');

    // 清单成员必须是引擎 dimensions{} 的真键名, 不是手写表
    // (cycle 11: 手写表把 bullshit_recognition 写成 bullshit, 键永远匹配不上)
    const listed = (out.split('\n').find(l => /^\s{5}(contradiction|reasoning_coherence|goal_misalignment|privacy_boundary|pseudo_profundity|perfect_error|coverup_induction)/.test(l)) || '').trim();
    assertTrue(listed.length > 0, '必须把仅测试字面量支撑的维度名逐个列出');
    const names = listed.split(',').map(s => s.trim()).filter(Boolean);
    const idx = require(path.join(ROOT, 'src', 'index.js'));
    const realKeys = new Set(Object.keys(idx.discriminate('probe', []).dimensions || {}));
    for (const nm of names) {
      assertTrue(realKeys.has(nm),
        `清单成员 ${nm} 不是 dimensions{} 的真键名 —— 仪器在报一个引擎里不存在的维度`);
    }
    // 语料零 finding 的非仅打分维度数也要打出来(与 cycle 203 的披露互相印证)
    assertTrue(/语料上零 finding 的非仅打分维度 \d+ 个/.test(out),
      '必须同时打印"语料上零 finding 的非仅打分维度 N 个"');
  });

  // ── 三、反向证明: 摘掉分桶, 第二例必须按名红 ────────────
  test('反向证明: 摘掉 bySrc 分桶后, 来源归属段必须消失(锁能失败)', () => {
    const broken = src
      .replace(/for \(const t of srcs\) tally\[key\]\.bySrc\[t\]\+\+;/, '/* 分桶已摘除 */')
      .replace(/pool\.push\(\{\s*text:\s*s,\s*srcs\s*\}\);/, 'pool.push(s);')
      .replace(/for \(const \{ text, srcs \} of pool\)/, 'for (const text of pool)')
      .replace(/for \(const \{ text \} of pool\)/g, 'for (const text of pool)');
    // 断言变异真的发生了(cycle 32: 一个没变异的变异证明与不能失败的锁无异)
    assertTrue(broken !== src, '变异未生效 —— 锚点没匹配上, 本次反向证明无效');
    assertTrue(!/bySrc\[t\]\+\+/.test(broken), '变异未摘除分桶逻辑');
    // ⚠️ ROOT 必须钉死: 脚本用 `path.join(__dirname, '..')` 推仓库根, 副本落到
    // os.tmpdir() 后 ROOT 会变成 tmpdir 的父目录, 于是 SRC 读不到、副本启动即崩。
    // 那会让本反向证明因为"环境不对"而绿, 而不是因为"锁真能失败"而绿 ——
    // 与 cycle 206"探针改了副本而自证"同族, 本轮第一次跑正是这样红的。
    const ROOT_LIT = "const ROOT = path.join(__dirname, '..');";
    assertTrue(broken.includes(ROOT_LIT), '变异版应仍含原 ROOT 声明(锚点已变?)');
    const pinned = broken.replace(ROOT_LIT, 'const ROOT = ' + JSON.stringify(ROOT) + ';');
    assertTrue(pinned !== broken && pinned.includes(JSON.stringify(ROOT) + ';'), 'ROOT 未钉死');
    const tmp = path.join(require('os').tmpdir(), 'dimhealth-broken-209.cjs');
    fs.writeFileSync(tmp, pinned);
    try {
      let bOut = '';
      try {
        bOut = execFileSync('node', [tmp], {
          cwd: ROOT, encoding: 'utf8', timeout: 180000, maxBuffer: 64 * 1024 * 1024,
        });
      } catch (e) {
        bOut = ((e.stdout || '') + (e.stderr || '')).toString();
      }
      assertTrue(!/ENOENT|Cannot find module/.test(bOut),
        '变异版启动失败于路径 —— ROOT 未钉死, 本次反向证明无效(见上方注释)');
      // 变异版的分桶没了, bySrc 恒为全 0, 于是"仅测试字面量支撑"清单必然为空 ——
      // 正是第二例 `n > 0` 那条断言会红的形态。断言必须精确对准这一点。
      // 第一版写的是 `!hasSection || !hasList`, 而段本身与汇总行**仍会打印**
      // (只是 N=0), 于是反向证明自己绿了, 而第二例其实会红。
      // 一把反向证明的断言比它要保护的那把锁还宽, 是装饰不是证明。
      const bLine = bOut.split('\n').find(l => /其中仅测试字面量支撑/.test(l));
      assertTrue(!!bLine, '变异版应仍打印该汇总行(N=0), 否则本反向证明的对照不成立');
      const bN = Number((/的 (\d+) 个/.exec(bLine) || [])[1]);
      assertTrue(bN === 0,
        `摘掉分桶后清单仍非空(N=${bN}) —— 说明该清单的数据不依赖 bySrc, 第二例的 n>0 是装饰`);
      // 顺带: 每个维度的 A/B/C 必须全为 0(分桶确实没了, 不是变成了别的数)
      const zeroBuckets = [...bOut.matchAll(/A=\s*0 B=\s*0 C=\s*0/g)].length;
      assertTrue(zeroBuckets > 0, '变异版的 A/B/C 应全为 0');
    } finally {
      try { fs.unlinkSync(tmp); } catch (_) {}
    }
  });
};
