/**
 * test/memory-kernel-input-contract.test.js — 记忆内核的输入契约
 *
 * [test-coverage-gap·第一百二十四轮] 新建。coverage-sweep 清点:
 * B 类"活着但没测"114 个模块中含 src/memory/memory-kernel.js(1209 行,
 * 注释里被 wake-up-verifier.test.js 提到过一次, 但没有任何真实 require)。
 * 它是记忆的权威持久化层(R1-R8), 冒烟探测抓到**静默改写**:
 *
 * ═══ 缺陷①: recordUser 把任何非 null 输入 String() 化后原样写入 ═══
 * 原实现 `const text = input == null ? '' : String(input)` —— 对任何非 null
 * 输入都"成功"。实测:
 *   recordUser(NaN)      -> 落盘 {"content":"NaN"}
 *   recordUser(123n)     -> 落盘 {"content":"123"}
 *   recordUser({a:1})    -> 落盘 {"content":"[object Object]"}
 *   recordUser(循环引用)  -> 落盘 {"content":"[object Object]"}
 * 调用方拿到 entry.id(看起来成功)、结构完好、内容已死 —— 契约错配家族。
 * 唯一调用方 engine-memory 前文已有 input.trim(), 恒为 string, 不受影响。
 *
 * ═══ 缺陷②: recordSelf 对空输入照写不误, 与 recordUser 行为不一致 ═══
 * recordSelf(undefined) / (null) / ({}, {}) 产出 decision/confidence/
 * emotion/insight/thinkCount **全 null** 的空记录并返回 id; 而 recordUser
 * 侧对空输入返回 null 拒绝。两个 API 同一语义两套行为。
 *
 * ═══ 修法 ═══
 * ① recordUser 入口 typeof 守卫: 非 string 一律返回 null(与空串同一形状:
 *    不落盘、不动索引、不改写既有槽);
 * ② recordSelf 对"refined 全 null"的空记录拒绝, 与 recordUser 对齐。
 *
 * ═══ 锁什么 ═══
 * ① 五类非字符串输入必须被 recordUser 拒绝(且不落盘、索引不动);
 * ② 四类空/无效输入必须被 recordSelf 拒绝;
 * ③ 合法输入仍正常写入, 且跨 reload 往返一致(守卫不是"什么都不让写");
 * ④ 反向证明(源码级): 把 typeof 守卫改回 String() coercion 必须红。
 */
const path = require('path');
const os = require('os');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'src', 'memory', 'memory-kernel.js');

function mkIn(dir) {
  delete require.cache[require.resolve(SRC)];
  const { MemoryKernel } = require(SRC);
  return new MemoryKernel(dir);
}

const NON_STRINGS = [
  ['undefined', undefined],
  ['null', null],
  ['NaN', NaN],
  ['bigint', 123n],
  ['普通对象', { a: 1 }],
  ['循环引用对象', (() => { const o = {}; o.self = o; return o; })()],
];

module.exports = function ({ test, assertEqual, assertTrue }) {

  test('recordUser: 非字符串输入必须被拒绝(不落盘、索引不动、不抛错)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mk-lock-u-'));
    try {
      const mk = mkIn(dir);
      // 先写一条合法的, 用于"拒绝即无副作用"的对照
      assertTrue(typeof mk.recordUser('合法输入') === 'string', '合法输入必须写入');
      const before = mk._index.counts.user;
      const sizeBefore = fs.statSync(mk.userMemPath).size;
      for (const [label, v] of NON_STRINGS) {
        const r = mk.recordUser(v);
        assertEqual(r, null, `${label} 必须被 recordUser 拒绝, 实测返回 ${r}`);
      }
      assertEqual(mk._index.counts.user, before, '被拒的输入不得推进计数');
      assertEqual(fs.statSync(mk.userMemPath).size, sizeBefore,
        '被拒的输入不得追加任何行(修复前 NaN/123n/对象会各写一条)');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('recordSelf: 空/无效输入必须被拒绝(全 null refined 不透传)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mk-lock-s-'));
    try {
      const mk = mkIn(dir);
      for (const [label, args] of [
        ['undefined', [undefined]],
        ['null', [null]],
        ['空对象空meta', [{}, {}]],
        ['空串 insight', [{}, { insight: '' }]],
      ]) {
        const r = mk.recordSelf(...args);
        assertEqual(r, null, `recordSelf(${label}) 必须被拒绝, 实测返回 ${r}`);
      }
      // self 文件不得存在(一条都没写)或为空
      if (fs.existsSync(mk.selfMemPath)) {
        assertEqual(fs.readFileSync(mk.selfMemPath, 'utf8').trim(), '', '空记录不得落盘');
      }
      assertEqual(mk._index.counts.self, 0, '空记录不得推进 self 计数');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('合法输入照常写入, 且新实例 reload 后内容往返一致(守卫不是恒真的)', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mk-lock-rt-'));
    try {
      const mk = mkIn(dir);
      const texts = ['用户说：明天开会', '第二段对话：关于部署方案', 'third message in English'];
      for (const t of texts) assertTrue(typeof mk.recordUser(t) === 'string', `合法输入必须写入: ${t}`);
      const id = mk.recordSelf({ decision: { type: 'RESONATE', confidence: 0.82 } }, { insight: '有洞察', thinkCount: 3 });
      assertTrue(typeof id === 'string', '合法 thinkResult 必须写入');
      await mk.flush();
      await mk.save();

      // 新实例 reload: 内容必须原样读回
      const mk2 = mkIn(dir);
      await mk2.load();
      const userLines = fs.readFileSync(mk2.userMemPath, 'utf8').split('\n').filter(Boolean);
      assertEqual(userLines.length, texts.length, `user 行数必须=${texts.length}, 实测 ${userLines.length}`);
      for (const t of texts) {
        assertTrue(userLines.some(l => JSON.parse(l).content === t), `reload 后必须读回原文本: ${t}`);
      }
      const selfLines = fs.readFileSync(mk2.selfMemPath, 'utf8').split('\n').filter(Boolean);
      assertEqual(selfLines.length, 1, 'reload 后 self 必须恰好 1 行');
      const self = JSON.parse(selfLines[0]);
      assertEqual(self.decision, 'RESONATE', 'reload 后 decision 字段不得丢失');
      assertEqual(self.insight, '有洞察', 'reload 后 insight 字段不得丢失');
      assertEqual(self.confidence, 0.82, 'reload 后 confidence 字段不得丢失');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('反向证明: typeof 守卫改回 String() coercion 后本锁必须变红', () => {
    const src = fs.readFileSync(SRC, 'utf8');
    const guard = "if (typeof input !== 'string') return null;";
    assertTrue(src.includes(guard), `锚点 "${guard}" 不存在 —— 反向证明的 mutation 没有落地, 该证明无效`);
    // 修前的形状: `const text = input == null ? '' : String(input);`
    // 该 coercion 会把 NaN->"NaN"、123n->"123"、对象->"[object Object]"。
    // 直接复现该形状, 断言它确实会通过 recordUser 的入口校验(即缺陷真实存在):
    const coerced = (input) => {
      const text = input == null ? '' : String(input);
      return text.trim() ? text : null;
    };
    for (const [label, v] of [['NaN', NaN], ['bigint', 123n], ['对象', { a: 1 }]]) {
      const text = coerced(v);
      assertTrue(typeof text === 'string' && text.length > 0,
        `修前的 String() coercion 会放行 ${label} -> "${text}" —— 若这条绿, 说明守卫已失效`, label);
    }
    // 而守卫的形状必须挡掉它们
    const guarded = (input) => (typeof input !== 'string' ? null : (input.trim() ? input : null));
    for (const [label, v] of NON_STRINGS) {
      assertEqual(guarded(v), null, `守卫形状必须拒绝 ${label}`);
    }
  });
};
