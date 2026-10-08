/**
 * test/formula-registry-eu-contract.test.js — 公式原语的实参形状必须与实现匹配
 *
 * [test-coverage-gap·第一百四十八轮] 新建。B 类"活着但没测"清单第一件是
 * src/formula/formula-bridge.js(1580 行, 99 个公开方法, 零测试)。本轮按
 * "probing the module by calling it"的方式取事实, 不写覆盖剧场。
 *
 * ═══ 缺陷 ═══
 * `FormulaRegistry`(src/formula/formula-registry.js)把 FormulaBridge 的认知原语
 * 按环节挂载, 共 84 个 impl。其中 decision_utility 环节的两个:
 *
 *     impl: (probs, utils) => _b.expectedUtility(probs, utils)          // expected_utility
 *     impl: (outcomeUtils, probs) => _b.expectedUtility(probs, outcomeUtils)  // subjective_utility
 *
 * 传**两个平行数组**, 而 expectedUtility 的签名只收一个对象数组:
 *
 *     expectedUtility(outcomes) {                       // outcomes: [{prob, utility}]
 *       return outcomes.reduce((acc, o) => acc + (o.prob || 0) * (o.utility || 0), 0);
 *     }
 *
 * 于是 `o` 是数字, `o.prob` 是 undefined → 每一项贡献 0 → **恒返回 0**。
 * 实测(修复前): registry.call('decision_utility','expected_utility',
 * [0.5,0.5],[10,0]) → 0(正确值 5); [0.5,0.3,0.2],[100,50,0] → 0(正确值 65)。
 * subjective_utility 同因恒 0。
 *
 * 一般形状: **调用成功、不抛错、结构合法、内容已死** —— 本仓库反复记录的契约
 * 错配家族。而且 registry.call 自己有 try/catch, 连异常都被吞成 null,
 * 所以这条路径上任何形状错误都不会响。
 *
 * ═══ 修法 ═══
 * 改调同语义且已正确的 subjectiveUtility(probs, utils) —— 它就在同一个文件里
 * 被 emotion_arousal/subjective_utility 正常使用(实测 5)。不动 FormulaBridge
 * 的公开契约: formula-safe.js 与 mcp-server.js 都按对象数组形状调用
 * expectedUtility, 那一侧本来就是对的。
 *
 * ═══ 实测 ═══
 *   expected_utility:  0 → 5 / 65        (两组输入)
 *   subjective_utility: 0 → 5
 *   静态扫描 84 个 impl: 修复前 2 处实参过多, 修复后 0
 *
 * 遵循 aspira 约定 #4: 位于 test/ 根目录、module.exports=函数 导出。
 */
module.exports = function ({ test, assertEqual, assertTrue }) {
  const fs = require('fs');
  const path = require('path');
  const ROOT = path.join(__dirname, '..');
  const { getFormulaRegistry } = require(path.join(ROOT, 'src', 'formula', 'formula-registry.js'));
  const { FormulaBridge } = require(path.join(ROOT, 'src', 'formula', 'formula-bridge.js'));

  // ── 一、两个原语必须算出正确的期望效用 ──────────────────
  test('decision_utility 的 expected_utility / subjective_utility 不得恒返回 0', () => {
    const r = getFormulaRegistry();
    r.summary(); // 触发 _ensure() 注册
    const bad = [];
    // [probs, utils, 期望 EU, 说明]
    const cases = [
      [[0.5, 0.5], [10, 0], 5, '0.5*10 + 0.5*0'],
      [[0.5, 0.3, 0.2], [100, 50, 0], 65, '0.5*100 + 0.3*50'],
      [[1], [7], 7, '确定结果 EU = 效用本身'],
      [[0.3, 0.7], [-5, 20], 12.5, '负效用: 0.3*(-5) + 0.7*20'],
      [[0.25, 0.25, 0.25, 0.25], [4, 8, 12, 16], 10, '均匀分布'],
    ];
    for (const [probs, utils, want, note] of cases) {
      const gotEU = r.call('decision_utility', 'expected_utility', probs, utils);
      if (gotEU !== want) bad.push(`expected_utility(${JSON.stringify(probs)}, ${JSON.stringify(utils)}) → ${gotEU}, 期望 ${want} [${note}]`);
      // subjective_utility 的 impl 形参顺序是 (outcomeUtils, probs)
      const gotSU = r.call('decision_utility', 'subjective_utility', utils, probs);
      if (gotSU !== want) bad.push(`subjective_utility(${JSON.stringify(utils)}, ${JSON.stringify(probs)}) → ${gotSU}, 期望 ${want} [${note}]`);
    }
    assertEqual(bad.join('\n'), '', '以下调用恒返回 0 或算错(契约错配):\n' + bad.join('\n'));
  });

  // ── 二、边界: subjectiveUtility 的契约被钉住 ────────────
  test('空/不匹配输入必须返回 0 而不是 NaN 或抛错', () => {
    const r = getFormulaRegistry();
    r.summary();
    const bad = [];
    const edges = [
      [[], [], 0, '两空数组'],
      [null, null, 0, 'null 输入'],
      [[0.5, 0.5], [10, 0, 5], 0, '长度不匹配 → 0(实现契约)'],
      [[0.5, 0.5], [10], 0, 'utils 更短 → 0'],
    ];
    for (const [probs, utils, want, note] of edges) {
      let got;
      try { got = r.call('decision_utility', 'expected_utility', probs, utils); }
      catch (e) { bad.push(`${note}: 抛错 ${e.message}`); continue; }
      if (got !== want) bad.push(`${note}: → ${got}, 期望 ${want}`);
    }
    assertEqual(bad.join('\n'), '', '边界行为不符:\n' + bad.join('\n'));
  });

  // ── 三、反向控制: FormulaBridge 原契约未被改坏 ──────────
  test('FormulaBridge.expectedUtility 的对象数组契约必须保持(它另有调用方)', () => {
    const b = new FormulaBridge();
    // formula-safe.js 与 mcp-server.js 都按 [{prob, utility}] 形状调用它
    assertEqual(
      b.expectedUtility([{ prob: 0.5, utility: 10 }, { prob: 0.5, utility: 0 }]), 5,
      '对象数组形状必须仍然正确 —— 本轮只改 registry 的 impl, 不动 bridge');
    assertEqual(b.expectedUtility([]), 0, '空数组 → 0');
    assertEqual(b.subjectiveUtility([0.5, 0.5], [10, 0]), 5, '平行数组形状(subjectiveUtility)必须正确');
  });

  // ── 四、静态: registry 每个 impl 的实参数不得超过方法形参数 ──
  test('静态契约扫描: 84 个 impl 的实参个数不得多于所调方法的形参个数', () => {
    const strip = (s) => s.split('\n').filter(l => !l.trim().startsWith('//')).join('\n');
    const regSrc = strip(fs.readFileSync(path.join(ROOT, 'src', 'formula', 'formula-registry.js'), 'utf8'));
    const brSrc = strip(fs.readFileSync(path.join(ROOT, 'src', 'formula', 'formula-bridge.js'), 'utf8'));

    // bridge 方法签名表
    const brSigs = {};
    const re = /\n\s{2,}([a-zA-Z_][a-zA-Z0-9]*)\(([\s\S]*?)\)\s*\{/g;
    let m;
    while ((m = re.exec(brSrc))) {
      brSigs[m[1]] = m[2].split(',').map(s => s.trim().split('=')[0].trim()).filter(Boolean);
    }
    // registry impl 表: impl: (a, b) => _b.method(a, b)
    const impls = [];
    const re2 = /impl:\s*\(([\s\S]*?)\)\s*=>\s*_b\.([a-zA-Z_][a-zA-Z0-9]*)\(([\s\S]*?)\)/g;
    while ((m = re2.exec(regSrc))) {
      impls.push({
        implParams: m[1].split(',').map(s => s.trim().split('=')[0].trim()).filter(Boolean),
        method: m[2],
        callArgs: m[3].split(',').map(s => s.trim()).filter(Boolean),
      });
    }
    assertTrue(impls.length >= 80, `impl 表应覆盖 registry 的全部原语, 实测 ${impls.length} 个(解析失效会让本条恒绿)`);

    const bad = [];
    let checked = 0;
    for (const it of impls) {
      const sig = brSigs[it.method];
      if (!sig) continue; // 签名表未命中: 不计缺陷, 由下面的覆盖率断言兜底
      checked++;
      if (it.callArgs.length > sig.length) {
        bad.push(`_b.${it.method}: impl(${it.implParams.join(',')}) 传 ${it.callArgs.length} 个实参, ` +
          `而方法只收 ${sig.length} 个 [${sig.join(',')}] —— 多出的实参被静默丢弃`);
      }
    }
    assertEqual(checked, impls.length,
      `签名表必须覆盖全部 impl(实测 ${checked}/${impls.length}) —— 否则扫描可能因漏匹配而假绿`);
    assertEqual(bad.join('\n'), '', '以下 impl 的实参形状与实现不符:\n' + bad.join('\n'));

    // 自证: 同一个谓词必须能判"修复前的形状"为缺陷, 否则本条是恒真锁
    const before = { method: 'expectedUtility', callArgs: ['probs', 'utils'] };
    assertTrue(before.callArgs.length > brSigs[before.method].length,
      '自证失效: 判据抓不到修复前的形状(expectedUtility 传 2 个实参给只收 1 个的方法), 本条是恒真锁');
  });

  // ── 五、已测量的披露: registry.call 的 null 有三种来源 ───
  test('披露: registry.call 返回 null 时无法区分"无此原语"与"impl 抛错"(未修)', () => {
    const r = getFormulaRegistry();
    r.summary();
    // 三种情况实测都返回 null。call() 的 try/catch 把异常吞成 null, 与
    // "stage 不存在""id 不存在"同形。调用方因此无法判断一次 null 是
    // "没挂这个原语"还是"算错了", 只能看到同一个 null。
    const noStage = r.call('nope_stage', 'x', 1);
    const noId = r.call('decision_utility', 'nope_id', 1);
    // shapley_value 的 impl 需要一个函数, 传数字会抛错 → 被 catch 吞成 null
    let threw = null;
    try { threw = r.call('decision_utility', 'shapley_value', [0.5, 0.3], 0.5); } catch (_) { threw = 'THREW'; }
    assertEqual(noStage, null, '前提失效: stage 不存在应返回 null');
    assertEqual(noId, null, '前提失效: id 不存在应返回 null');
    assertEqual(threw, null, '前提失效: impl 抛错也应被吞成 null');
    // 三者同形 —— 这是本测试要钉住的披露, 不是要修的缺陷。
    assertTrue(noStage === noId && noId === threw,
      '三种 null 来源现在可区分了 —— 请更新本条披露(以及所有依赖 null 判断的调用方)');
  });

  // ── 六、已测量的披露: 本锁只覆盖 formula-bridge 的 3/99 个方法 ──
  test('披露: formula-bridge 的 99 个公开方法本轮只覆盖 3 个(未修, 勿读成已覆盖)', () => {
    const b = new FormulaBridge();
    const all = Object.getOwnPropertyNames(FormulaBridge.prototype)
      .filter(n => n !== 'constructor' && !n.startsWith('_'));
    // 本文件实际调用过的方法: expectedUtility / subjectiveUtility(第 1、2、3 例)
    const covered = ['expectedUtility', 'subjectiveUtility'];
    const missing = all.filter(n => !covered.includes(n));
    assertEqual(all.length, 99, `前提失效: FormulaBridge 公开方法数应仍是 99, 实测 ${all.length}`);
    assertTrue(missing.length === 97,
      `未覆盖方法数应仍是 97, 实测 ${missing.length} —— 变了吧? 请同步更新本条披露`);

    // 其中一个未覆盖方法 irtTestInformation 本轮实测有一处死分支:
    //   this.irt2pl ? this.irt2pl(...) : this.irt4pl(...)
    // `irt2pl` 拼写与实际方法名 irt2PL 不符 → 恒取 else → 带 c 的 item 用错模型。
    // **本轮不修**: 只改拼写并不能修好它(改成 irt2PL 后 c/d 仍被忽略),
    // 需要先决定"item 带 c/d 时该分派到 2PL/3PL/4PL 中的哪一个", 那是产品判断。
    const src = fs.readFileSync(path.join(ROOT, 'src', 'formula', 'formula-bridge.js'), 'utf8');
    assertTrue(src.includes('this.irt2pl ?'),
      'irtTestInformation 的死分支不见了 —— 它被修好了? 请同步更新本条披露');
  });
};
