/**
 * test/audit-self-pollution.test.js — 审计不得把自己跑出来的探针污染当成文档缺陷
 *
 * ═══ 由来(第十九轮 doc-honest-numbers) ═══
 * 前十二轮问的是"文档里哪个数字没被测到"(键/形态/闸门/文件集/已测vs已模式化/重枚举)。
 * 第十九轮问的是那个从没被问过的反面: **豁免清单里躺着什么?**
 * —— 豁免是"最彻底的不测量": 一条豁免就是一次决定不去测。
 *
 * 实测抓到两件事，第二件比第一件深得多:
 *
 * ① HISTORICAL_DOCS 里 `CHAT_LOG_HeartFlow_完整备份_2026-05-16.md` 读不到。
 *    旧代码把 ENOENT 和权限错误同流，打一句 ⚠️ 就 continue —— 于是该条目仍计入
 *    "显式豁免 N 份"却不计入"不同内容 N 份": **用一份打不开的文档夸大"有多少没审"**。
 *    这是第十轮形状的翻面: 那次拿 682 份副本充数「已扫文档」，这次拿幽灵充数「豁免文档」。
 *    真相更妙: 它不是"不存在"，而是一个**被 git 跟踪的坏符号链接**:
 *      CHAT_LOG_HeartFlow_完整备份_2026-05-16.md
 *        -> /root/mount/CHAT_LOG_HeartFlow_完整备份_2026-05-16_0437a209.md
 *    readdirSync 看得见它(不跟随链接)，readFileSync 跟随它 → ENOENT。
 *
 * ② **审计先跑测试套件，再读文档; 而测试套件里就有改写这些文档的探针。**
 *    主流程: measure()(spawn run-all.js) → claims()(此刻才 readDoc)。
 *    第964-965行的注释早已承认这个耦合，却只用来解释 execSync 抛异常，
 *    从没问过: **探针没把文档放回去时会怎样?**
 *    实测(本轮真实发生): 探针在"已注入、未恢复"之间被杀，污染留在磁盘上，
 *    claims() 读到被污染的文档，产出 7 条假警报，全部指责 SKILL.md/README.md
 *    "声称 9.9.9 / 139 个模块"——**仪器分不清"文档错了"和"改写文档的探针没放回去"**，
 *    把一次探针泄漏报成了文档缺陷，方向完全指错。而跑测试套件的正是审计自己:
 *    **仪器通过被它测量的东西来测量自己。**
 *
 * ═══ 修法 ═══
 * 在 spawn 之前把文档内容读进内存快照，claims() 只读快照。
 * 探针此后怎么折腾都影响不了审计 —— 审计核对的是**它启动时磁盘上的声称**。
 *
 * ═══ 同轮连带记录(第三次犯同一个错) ═══
 * 清理探针污染时用了 `git checkout -- SKILL.md README.md CURRENT_STATE.md`。
 * 这退回了 HEAD(8b2853c)，而 HEAD 早于周期12-18的文档同步: 测试数退回 1182、
 * 公式数退回 1286，连 `17-layer pipeline*` 的脚注都被回退。
 * 唯一发现的是 `layer-count-two-readings.test.js` —— 一个纯读者测试。
 * **`git checkout -- <doc>` 不是安全的清污方式**: 它把文档退回到一个过期的提交，
 * 而不是退回到它的"最后一次正确状态"。探针污染和合法内容在同一个文件里，git 分不开。
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const SCRIPT = path.join(ROOT, 'scripts', 'audit-doc-numbers.js');
const SKILL = path.join(ROOT, 'SKILL.md');
const { withDocLock } = require('./_doc-probe-lock.js');

// 剥掉注释后再做源码级匹配 —— 否则修复自己的注释会 quoted 被删掉的代码，
// 未剥注释的锁会把它的文档当成罪行(cycle-14/15 的陷阱，第三次)。
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

function runAudit(extraEnv) {
  return execFileSync('node', [SCRIPT], {
    cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, ASPIRA_AUDIT_SKIP_TESTS: '1', ...(extraEnv || {}) },
  });
}

// 预载钩子: 拦截审计对 run-all.js 的 spawn，在 measure() 执行期间弄脏 SKILL.md，
// 然后返回一份假的 run-all 输出(省掉真的跑 1351 个用例)。
// 若审计没有快照，claims() 就会读到这份污染并报一条假的版本不符。
const HOOK = [
  "const cp = require('child_process');",
  "const fs = require('fs');",
  "const real = cp.spawnSync;",
  "cp.spawnSync = function (cmd, args, opts) {",
  "  if (args && args[0] && String(args[0]).indexOf('run-all.js') >= 0) {",
  "    try {",
  "      const p = " + JSON.stringify(SKILL) + ";",
  "      const orig = fs.readFileSync(p, 'utf8');",
  "      fs.writeFileSync(p, orig.replace(/(\\|\\s*Engine version\\s*\\|\\s*v?)(\\d+\\.\\d+\\.\\d+)/, '$19.9.9'));",
  "    } catch (e) {}",
  "    return { stdout: '测试结果: 1351 通过, 0 失败, 共 1351 个\\n', status: 0 };",
  "  }",
  "  return real.apply(cp, arguments);",
  "};",
].join('\n');

module.exports = function ({ test, assertTrue, assertEqual }) {
  const src = stripComments(fs.readFileSync(SCRIPT, 'utf8'));

  test('文档内容必须在 spawn 测试套件之前被快照(顺序锁)', () => {
    const snapAt = src.indexOf('DOC_SNAPSHOT');
    const fillAt = src.indexOf('for (const f of DOCS_RECURSIVE) DOC_SNAPSHOT.set');
    const spawnAt = src.indexOf("spawnSync('node', ['test/run-all.js']");
    assertTrue(snapAt > 0, '审计必须定义 DOC_SNAPSHOT');
    assertTrue(fillAt > 0, '审计必须在模块加载时把 DOCS_RECURSIVE 的内容填进快照');
    assertTrue(spawnAt > 0, '审计必须 spawn run-all.js 取测试数');
    assertTrue(fillAt < spawnAt,
      `快照填充必须在 spawn 之前(实测 填充@${fillAt} spawn@${spawnAt})——` +
      '否则测试套件里的探针会在审计读文档之前把它们弄脏');
  });

  test('readDoc 必须优先返回快照，而不是重新读磁盘', () => {
    assertTrue(/DOC_SNAPSHOT\.has\(f\)/.test(src) && /DOC_SNAPSHOT\.get\(f\)/.test(src),
      'readDoc 必须先查快照——直接 readFileSync 会让快照形同虚设');
    assertTrue(/function readDocRaw\(f\)/.test(src),
      '快照未命中时应回落到真实读取，且回落必须与快照读取分开');
  });

  test('活体注入: measure() 期间弄脏文档，不得被报成文档声称不符', () => withDocLock(() => {
    const hookPath = path.join(os.tmpdir(), 'aspira-cycle19-hook.cjs');
    fs.writeFileSync(hookPath, HOOK);
    const backup = fs.readFileSync(SKILL, 'utf8');
    let out = '';
    try {
      out = execFileSync('node', [SCRIPT], {
        cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, NODE_OPTIONS: '--require ' + hookPath },
      });
    } finally {
      fs.writeFileSync(SKILL, backup);
      try { fs.unlinkSync(hookPath); } catch (_) {}
    }
    // 钩子确实执行过: SKILL.md 在 spawn 期间被写成 9.9.9，finally 已恢复
    assertTrue(!/9\.9\.9/.test(fs.readFileSync(SKILL, 'utf8')), '测试后 SKILL.md 必须已恢复');
    const bad = (out.match(/声称「[^\n]*/g) || []);
    const versionBad = bad.filter(l => /Engine version|engine version/.test(l));
    assertEqual(versionBad.length, 0,
      'measure() 期间的探针污染不得进入审计的"与实测不符"清单，实测: ' + versionBad.join(' | '));
  }));

  test('反向证明: 文档真的写错时审计必须报出来(锁不能永远不会失败)', () => withDocLock(() => {
    const backup = fs.readFileSync(SKILL, 'utf8');
    let out = '';
    try {
      fs.writeFileSync(SKILL, backup.replace(/(\|\s*Engine version\s*\|\s*v?)(\d+\.\d+\.\d+)/, '$19.9.9'));
      out = runAudit();
    } finally {
      fs.writeFileSync(SKILL, backup);
    }
    assertTrue(/Engine version[^\n]*9\.9\.9/.test(out) || /9\.9\.9/.test(out),
      'SKILL.md 真的写成 9.9.9 时审计必须报出不符——否则上面的快照锁是个永不会失败的检查');
  }));

  test('坏符号链接的豁免条目必须按名报出，并说明是符号链接目标不存在', () => withDocLock(() => {
    const out = runAudit();
    assertTrue(/CHAT_LOG_HeartFlow_完整备份_2026-05-16\.md/.test(out),
      '读不到的豁免条目必须按名报出，不能只报个数');
    assertTrue(/符号链接目标不存在/.test(out),
      '必须区分"文件不存在"与"符号链接目标不存在(指向仓库外)"——旧消息把两者混成一团');
  }));

  test('豁免理由不得硬编码会腐烂的份数，份数必须被实测后报出', () => withDocLock(() => {
    // 源码级: data/ 的理由里不得再出现 "682 份" 这类写死的数
    assertTrue(!/\d+\s*份/.test((src.match(/'data':\s*'[^']*'/) || [''])[0]),
      'data/ 的豁免理由不得硬编码份数 —— 该数随测试运行增长(一次会话内 1063/1066/1072)，硬编码必然腐烂');
    // 行为级: 每个豁免目录都必须被实测并报出份数/内容种数
    const out = runAudit();
    assertTrue(/\[豁免理由实测\]/.test(out), '审计必须输出「豁免理由实测」');
    for (const d of ['report', 'docs', 'plans', 'data']) {
      assertTrue(new RegExp(d + '/=\\d+份/\\d+种').test(out),
        `豁免目录 ${d}/ 必须被实测并报出份数与内容种数`);
    }
    assertTrue(!/理由已失效/.test(out), '当前所有豁免理由都必须成立');
  }));

  test('源码锁的前提: 标准注释剥离器不得吞掉本文件的代码', () => {
    // ═══ 周期 10 就存在、直到本轮才被发现的预存陷阱 ═══
    // 仓库标准的 stripComments(见 test/self-diagnostic-paths.test.js:49)是:
    //   .replace(/\/\*[\s\S]*?\*\//g, '')      // 块注释
    //   .replace(/(^|[^:])\/\/[^\n]*/g, '$1')  // 行注释
    // 它假设 /* 只出现在块注释里。而 audit-doc-numbers.js 里:
    //   - 第1行是合法的 /** 文件头块注释(开到第25行左右)
    //   - 第57行注释里写着 skills/*/SKILL.md —— 一个**藏在行注释里的** /*
    //   - 第81行字符串里写着 _tc_*/_cache_probe_* —— 一个**藏在字符串字面量里的** */
    // 于是块注释正则从第1行的 /** 一路吃到第81行的 */:
    //   实测 58528 字节被剥成 32679 字节, 保留 55.8% ——
    //   EXEMPT_DIRS 整表(含 data 条目)被当成注释删掉。
    // **后果: 任何基于"先剥注释再匹配"的源码锁, 在这个文件上永远匹配不到东西。**
    // 那正是本文件反复记录的形状: 一个永远不会失败的检查，和不检查没有区别。
    // 修法: 两处字面量都不含 /* 与 */(skills/ 下的 SKILL.md、_tc_ 与 _cache_probe_ 前缀)。
    // 保留率 56% 是正常的(本文件注释极多); 判据是**关键符号必须存活**，不是字节数。
    const stripped = stripComments(fs.readFileSync(SCRIPT, 'utf8'));
    for (const k of ['EXEMPT_DIRS', 'HISTORICAL_DOCS', 'DOC_SNAPSHOT', 'spawnSync']) {
      assertTrue(stripped.includes(k),
        `剥注释后仍须保留 ${k} —— 否则基于剥离结果的源码锁是永不会失败的检查`);
    }
    assertTrue(/'data':/.test(stripped), '剥注释后仍须保留 EXEMPT_DIRS 的 data 条目');
    // 反向证明这条哨兵本身能失败: 把 /* 塞回第57行的注释，
    // 块注释正则就会从那个 /* 吃到后面的 */，把 data 条目当成注释删掉。
    const poisoned = stripComments(
      fs.readFileSync(SCRIPT, 'utf8').replace('skills/ 下的 SKILL.md 保留', 'skills/*/SKILL.md 保留'));
    assertTrue(!/'data':/.test(poisoned),
      '把 /* 塞回 skills/ 那行注释后，同一条哨兵必须能判它有罪——否则它也检查不了任何东西');
  });

  test('活体注入: 把硬编码份数塞回 data/ 理由必须变红', () => withDocLock(() => {
    const backup = fs.readFileSync(SCRIPT, 'utf8');
    let out = '';
    try {
      // 塞回一个写死的份数(模拟腐烂的理由重新长回来)
      fs.writeFileSync(SCRIPT, backup.replace(
        /'data':\s*'[^']*'/,
        "'data': '运行时数据而非文档: 682 份 CORE_VALUES.md 逐字节相同副本'"));
      out = runAudit();
    } finally {
      fs.writeFileSync(SCRIPT, backup);
    }
    assertTrue(/\d+\s*份/.test((stripComments(fs.readFileSync(SCRIPT, 'utf8')).match(/'data':\s*'[^']*'/) || [''])[0]) === false,
      '恢复后脚本里不得再留下硬编码份数');
    // 变红的判据: 源码级断言必须能在被注入的副本上失败。
    // 这里直接复算那条断言，证明它不是永不会失败的检查。
    const injected = stripComments(backup.replace(
      /'data':\s*'[^']*'/,
      "'data': '运行时数据而非文档: 682 份 CORE_VALUES.md 逐字节相同副本'"));
    const reason = (injected.match(/'data':\s*'[^']*'/) || [''])[0];
    assertTrue(/\d+\s*份/.test(reason),
      '注入硬编码份数后，同一条断言必须能判它有罪——否则这条锁检查不了任何东西');
  }));
};
