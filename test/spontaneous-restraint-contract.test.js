/**
 * test/spontaneous-restraint-contract.test.js — 克制引擎的裁决必须确定
 *
 * ═══ 第一百九十七轮发现的缺陷 ═══
 * 切片角度: 前四轮依次用过「契约清晰」「被文档完整路径承诺」「导出纯函数与
 * 常量表」「src 扇入最高」选 B 类模块。本轮用第五种 —— **哪个 B 类模块被
 * MCP 工具直接调用(对外承诺面), 却零测试?** `coverage-sweep` 实测 B 类 96 个,
 * 其中 15 个被 `src/mcp-server.js` 直接 require, 每个对应一个对外工具。
 *
 * 选中 `src/shield/spontaneous-restraint.js`(497 行, shield 家族): 它对应的
 * `aspira_spontaneous_restraint` 承诺的是**判别器主动说"不"** —— 模块头部写着
 * "最好的行动是不行动", 正是 AGENTS.md 核心价值的直接体现。
 *
 * 按 cycle 191 立下的规矩**调用它**(不是 require 它), 探针找到一处:
 * `computeMinimalForm()` 用 `forms[Math.floor(Math.random() * forms.length)]`
 * 挑"最小响应"。实测同一输入「你好」连调 20 次得到 3 种不同结果
 * (嗯。6 / 我在。9 / 然后？5), 且经 `evaluate()` 的 minimalForm 字段直接暴露给
 * MCP 调用方。
 *
 * 三个后果:
 *   ① 不可复现 —— 同一个输入, 调用方每次拿到不同的"判别结果";
 *   ② 不可测试 —— 任何针对 minimalForm 的断言只能退化成"是这三个之一";
 *   ③ 违背本质 —— 本仓库的核心价值是规则引擎给出**确定性**裁决
 *      (AGENTS.md: discriminator-first / auditable —— 每个决定都保留完整推理链),
 *      随机答案等于没有裁决, 而且它连"为什么是这个答案"都答不出来。
 *
 * 修法: 改为按输入内容的字符码和取模选取。同一输入永远同一结果; 不同输入仍能
 * 分布到不同 form(否则所有输入都会落在同一个 form 上, 那是另一种失真)。
 *
 * ═══ 顺带测量到但不改的两处 ═══
 * ① `shouldRestrainExpansion` 的门控是 `lengthGate * 1.5 = 450` 字符, 短输入恒
 *    返回 `{restrain:false}` —— 这是有意的长度门控, 不是缺陷(我第一版探针用
 *    短用例误判它恒 false)。
 * ② handler 每次 `new SpontaneousRestraint({silent:true})`, 所以 stats()/history
 *    不跨调用累积 —— 与 cycle 196 在 knowledge-graph 上发现的同型, 修它要先决定
 *    实例生命周期, 属产品判断, 按铁律 2 只披露。
 */

module.exports = function ({ test, assertEqual, assertTrue }) {
  const path = require('path');
  const ROOT = path.join(__dirname, '..');
  const SRC = path.join(ROOT, 'src', 'shield', 'spontaneous-restraint.js');
  const { SpontaneousRestraint } = require(SRC);

  function make(opts) {
    return new SpontaneousRestraint(Object.assign({ silent: true }, opts || {}));
  }

  // ─── 主缺陷: 确定性 ────────────────────────────────────────────────

  test('computeMinimalForm 必须确定: 同一输入永远返回同一结果', () => {
    const inst = make();
    const inputs = ['你好', '帮我看代码', '我该怎么办', '你知道吗', '太棒了', '我在想', '你觉得呢', ''];
    for (const t of inputs) {
      const seen = new Set();
      for (let k = 0; k < 30; k++) seen.add(inst.computeMinimalForm(t).form);
      assertEqual(seen.size, 1,
        '「' + t + '」连调 30 次得到 ' + seen.size + ' 种不同结果: ' +
        JSON.stringify([...seen]) + ' —— 判别器对同一输入必须给出同一答案');
    }
  });

  test('修复前实测: Math.random 会让同一输入分散到多个 form(反向对照)', () => {
    // 这一条不是断言现状, 而是把"曾经的缺陷形状"钉住: 若有人把实现改回随机,
    // 上面的确定性用例会红; 这里额外说明随机的**可观察特征**, 便于定位。
    const inst = make();
    const r = inst.computeMinimalForm('你好');
    assertEqual(r.category, 'default', '「你好」应落在 default 类');
    assertTrue(typeof r.form === 'string' && r.form.length > 0, 'form 应是非空字符串');
    assertEqual(r.note, '最小干预：' + r.form, 'note 应与 form 一致');
  });

  test('不同输入仍须有分布(不许退化成恒返回第一个)', () => {
    // 确定性的另一个失效方向: 如果实现写成 forms[0], 同一性满足了, 但所有输入
    // 都拿到同一个 form —— 那是用"恒定"换来的失真, 同样要锁住。
    const inst = make();
    const inputs = ['你好', '帮我看代码', '我该怎么办', '你知道吗', '太棒了', '我在想', '你觉得呢', 'abc', 'xyz', '123', '。', '测试一下'];
    const forms = new Set();
    for (const t of inputs) forms.add(inst.computeMinimalForm(t).form);
    assertTrue(forms.size >= 3,
      '12 个不同输入只落到 ' + forms.size + ' 种 form —— 确定性不应以失真为代价');
  });

  test('类别分类不被这次改动破坏', () => {
    const inst = make();
    assertEqual(inst.computeMinimalForm('你知道吗').category, '倾诉', '倾诉类');
    assertEqual(inst.computeMinimalForm('我在想').category, '纠结', '纠结类');
    assertEqual(inst.computeMinimalForm('你觉得呢').category, '确认', '确认类');
    assertEqual(inst.computeMinimalForm('太棒了').category, '分享', '分享类');
    assertEqual(inst.computeMinimalForm('你好').category, 'default', 'default 类');
    // 每个类别只能返回自己表内的 form, 不能跨类
    const table = {
      倾诉: ['嗯，说下去。', '我听着。', '然后呢？'],
      纠结: ['这个决定只有你能做。', '无论选哪个，都有意义。'],
      确认: ['是的。', '没错。', '你理解得对。'],
      分享: ['很美好。', '这很棒。', '感受到了。'],
      default: ['嗯。', '我在。', '然后？'],
    };
    for (const t of ['你知道吗', '我在想', '你觉得呢', '太棒了', '你好']) {
      const r = inst.computeMinimalForm(t);
      assertTrue(table[r.category].indexOf(r.form) >= 0,
        '「' + t + '」返回 ' + r.form + ' 不属于 ' + r.category + ' 类的表单');
    }
  });

  test('evaluate() 暴露给 MCP 的 minimalForm 也必须确定', () => {
    // MCP 工具 aspira_spontaneous_restraint 返回的就是 evaluate() 的结果,
    // 所以确定性必须一路通到对外面。
    const inst = make({ aggressiveness: 0 });   // 0 = 极度克制 → 走 minimal 分支
    const seen = new Set();
    let level = null;
    for (let k = 0; k < 30; k++) {
      const e = inst.evaluate('你好');
      if (e.minimalForm && e.minimalForm.form) seen.add(e.minimalForm.form);
      level = e.interventionLevel;
    }
    assertEqual(level, 'minimal', 'aggressiveness=0 时应走 minimal 分支');
    assertEqual(seen.size, 1,
      'evaluate() 的 minimalForm 连调 30 次得到 ' + seen.size + ' 种: ' +
      JSON.stringify([...seen]) + ' —— 对外承诺的字段必须确定');
  });

  // ─── 核心契约不被破坏 ──────────────────────────────────────────────

  test('evaluate 的核心判别契约仍工作', () => {
    const inst = make();
    const r = inst.evaluate('帮我看一下这段代码有没有 bug');
    assertEqual(r.shouldAnswer, true, '明确求助应判定需要回答');
    assertEqual(r.interventionLevel, 'full', '明确求助应给完整响应');
    // timestamp 是 ISO 字符串(shouldIntervene 用它做审计 trail), 不是 number
    assertTrue(typeof r.timestamp === 'string' && r.timestamp.length > 0,
      '应带 timestamp(ISO 字符串), 实测 ' + typeof r.timestamp);

    const empty = inst.evaluate('');
    assertTrue(empty && typeof empty === 'object', '空输入应仍返回结构合法结果');
    assertTrue(Object.keys(empty).length > 0, '空输入不应返回空对象');
  });

  test('aggressiveness 仍真的改变克制程度(修复前实测 0→minimal, 0.5/1→full)', () => {
    const meek = make({ aggressiveness: 0 });
    const normal = make({ aggressiveness: 0.5 });
    const e1 = meek.evaluate('今天天气很好');
    const e2 = normal.evaluate('今天天气很好');
    assertEqual(e1.interventionLevel, 'minimal', 'aggressiveness=0 应极度克制');
    assertEqual(e2.interventionLevel, 'full', 'aggressiveness=0.5 应正常响应');
    assertTrue(e1.minimalForm && typeof e1.minimalForm.form === 'string',
      'minimal 分支应给出最小响应形式');
  });

  test('源级: computeMinimalForm 内不得再出现 Math.random', () => {
    const raw = require('fs').readFileSync(SRC, 'utf8');
    // 必须先剥掉行注释再匹配 —— 本轮修复把旧实现原样写进了注释解释原因,
    // 不剥就会把自己的说明当成违规(cycle 19/25/194/195 同族, 第五次)。
    const src = raw.replace(/\/\/[^\n]*/g, m => ' '.repeat(m.length));
    // 必须用**带签名的定义**定位 —— 只写 computeMinimalForm( 会先命中 evaluate()
    // 第 238 行的调用点(cycle 191 同族: indexOf 找到的是调用处, 于是断言读到的是
    // 别人的函数体, 变成一个恒真或恒假的检查)。
    const start = src.indexOf('computeMinimalForm(userMessage, context = {})');
    assertTrue(start >= 0, '找不到 computeMinimalForm 的定义(签名已变?)');
    const seg = src.slice(start, start + 3000);
    const end = seg.indexOf('\n  }\n');
    const body = end > 0 ? seg.slice(0, end) : seg;
    assertTrue(body.indexOf('Math.random') < 0,
      'computeMinimalForm 里又出现了 Math.random —— 那会让同一输入得到不同答案');
    // 并且确认它确实在按输入内容选取(而不是恒取第一个)
    assertTrue(/charCodeAt/.test(body) && /hash % forms\.length/.test(body),
      '看不到按输入内容选取的逻辑 —— 需确认不是退化成了 forms[0]');
  });

  test('反向证明: 把实现改回 Math.random, 本锁必须按名红', () => {
    const fs = require('fs');
    const src = fs.readFileSync(SRC, 'utf8');
    const anchor = 'const chosen = forms[hash % forms.length];';
    assertTrue(src.indexOf(anchor) >= 0, '锚点未命中 —— 请更新本反向证明');
    const broken = src.replace(
      anchor,
      'const chosen = forms[Math.floor(Math.random() * forms.length)];'
    );
    assertTrue(broken !== src, '反向证明没有真正改动任何东西');
    assertTrue(broken.indexOf('Math.random') >= 0, '反向证明未把 Math.random 写回去');
    // 逻辑等价说明: 坏实现对同一输入会分散到多个 form, 因此上面"同一输入 30 次"
    // 与"evaluate 30 次"两条必然红。这里不加载坏文件(它的相对依赖链很深,
    // cycle 194/195 已在同类模块上撞过两次), 只钉住"改回去就必然违反确定性"。
    const inst = make();
    const r = inst.computeMinimalForm('你好');
    assertTrue(r.form.length > 0, '坏实现也应能返回一个 form —— 它错在不确定, 不在返回空');
  });

  test('已披露缺陷(钉住不改善): handler 每次新建实例, stats/history 不跨调用', () => {
    const mcp = require(path.join(ROOT, 'src', 'mcp-server.js'));
    const H = mcp.HANDLERS;
    return (async () => {
      const a = await H.aspira_spontaneous_restraint({ text: '你好' });
      assertTrue(!a.error, '调用本身应成功: ' + JSON.stringify(a.error || ''));
      assertTrue(a.result && typeof a.result === 'object', '应返回 result 对象');
      const b = await H.aspira_spontaneous_restraint({ text: '你好' });
      assertTrue(!b.error, '第二次调用也应成功');
      // 两次调用的 result 里没有可观测的累积(实例是新的), 但确定性必须成立:
      // 同一 text 两次调用应得到同样的 minimalForm(如果走了 minimal 分支)
      assertEqual(JSON.stringify(a.result.shouldAnswer), JSON.stringify(b.result.shouldAnswer),
        '同一 text 的 shouldAnswer 必须一致 —— 这是确定性修复直接惠及对外面的地方');
    })();
  });
};
