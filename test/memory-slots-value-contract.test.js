/**
 * test/memory-slots-value-contract.test.js — 记忆槽的持久化边界契约
 *
 * ═══ 为什么补这个测试 ═══
 * `src/memory/slots.js`(1240 行)在 `scripts/coverage-sweep.js` 的清点里属 B 类:
 * **没有测试引用，但有 src 引用** —— heartflow 的 lazy 注册把它接进引擎
 * (`src/core/heartflow.js:2260` / `src/core/engine-constructor.js:205`)，
 * 模块级快捷方法(setSlot/getSlot/...)也直接挂在 MCP 可触达的路径上,
 * 却没有任何断言说它该怎样工作。
 *
 * ═══ 本测试锁定的真缺陷 ═══
 * `setSlot(name, value)` 此前只校验 name(`Invalid slot name`), **从不校验 value**。
 * 而 `save()` 是 `JSON.stringify(data)` 落盘, 于是一整类值被静默改写:
 *   - `bigint` / 循环引用 → `JSON.stringify` **抛 TypeError**, 被 save() 的 catch
 *     吞掉后返回 false。实测(修复前): `good1` + `bigint` + `good2` 三条槽,
 *     reload 后 **good1 与 good2 全部读回 null** —— 一个坏值连坐同实例全部合法数据。
 *   - `undefined` / `function` / `symbol` → 序列化后 key 整个消失, reload 取回 undefined。
 *   - `NaN` / `Infinity` → 变成 `null`, 内容被改写而非报错。
 * 共同后果: `setSlot` 返回 `success: true`, reload 之后"结构完好、内容已死"。
 * 修复是在 `setSlot` 入口加持久化边界守卫(模块级 `_isPersistableValue`, 与既有
 * name 校验同一形状: 返回 `{success:false}` 而不抛错, 且不落盘、不改写既有槽)。
 *
 * ═══ 断言的边界(实测出来的, 不是想当然) ═══
 * · 守卫只看写入那一刻的形态, 看不见**事后变异**: 合法值(如 `{}`)存入后被调用方
 *   改造成循环引用, save() 仍会静默失败并连坐。这是明确记录的残余风险(调用方
 *   自己把合法对象改坏), 不在本轮扩大改动范围。
 * · 嵌套结构里的 `undefined` 键(如 `{a: undefined}`)仍会消失 —— 守卫只锁
 *   **顶层**契约, 嵌套丢失是 JSON 的通行语义, 不在本轮范围。
 * · 全部用例在 `os.tmpdir()` 的临时目录里跑, 不触碰仓库 `data/`。
 */
const os = require('os');
const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '..', 'src', 'memory', 'slots.js');

function mkSlots() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'slots-lock-'));
  delete require.cache[require.resolve(SRC)];
  const { Slots } = require(SRC);
  return { dir, slots: new Slots({ dataDir: dir, autoSave: false, saveDelay: 0 }) };
}

function cleanup(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* 临时目录, 无副作用 */ }
}

module.exports = function ({ test, assertEqual, assertTrue }) {

  test('bigint 槽值必须在写入时被拒绝(而非毒化整个 save)', () => {
    const { dir, slots } = mkSlots();
    try {
      const r = slots.setSlot('big', 9007199254740993n);
      assertEqual(r.success, false, 'bigint 必须被拒绝');
      assertTrue(/Invalid slot value/.test(r.error || ''),
        `错误信息应指明朝向值, 实测 ${r.error}`);
      assertEqual(slots.getSlot('big'), null, '被拒绝的槽不得落库');
    } finally { cleanup(dir); }
  });

  test('连坐回归: 坏值被拒后, 合法槽跨 save+reload 完好无损', async () => {
    const { dir, slots } = mkSlots();
    try {
      slots.setSlot('big', 123n); // 修复前: 这一条会让下面三条全部丢失
      slots.setSlot('good1', '重要数据1');
      slots.setSlot('good2', { nested: [1, 2, 3] });
      const ok = await slots.save();
      assertEqual(ok, true, 'save 必须成功(此前 bigint 让它返回 false 且不写文件)');
      assertTrue(fs.existsSync(path.join(dir, 'slots.json')), 'slots.json 必须已落盘');

      delete require.cache[require.resolve(SRC)];
      const { Slots } = require(SRC);
      const reloaded = new Slots({ dataDir: dir, autoSave: false, saveDelay: 0 });
      assertEqual(reloaded.getSlot('good1'), '重要数据1', 'reload 后 good1 不得丢失');
      assertEqual(JSON.stringify(reloaded.getSlot('good2')),
        JSON.stringify({ nested: [1, 2, 3] }), 'reload 后 good2 不得丢失');
    } finally { cleanup(dir); }
  });

  test('四类静默丢失/改写值全部被拒', () => {
    const { dir, slots } = mkSlots();
    try {
      for (const [label, v] of [
        ['undefined', undefined],
        ['function', () => 1],
        ['symbol', Symbol('s')],
        ['NaN', NaN],
        ['Infinity', Infinity],
        ['circular', (() => { const o = {}; o.self = o; return o; })()],
      ]) {
        const r = slots.setSlot('bad', v);
        assertEqual(r.success, false, `${label} 必须被拒绝`);
        assertEqual(slots.getSlot('bad'), null, `${label} 被拒后不得落库`);
      }
      // 合法值不受影响(反向对照: 守卫不是"什么都不让写")
      slots.setSlot('ok', { a: 1 });
      assertEqual(JSON.stringify(slots.getSlot('ok')), JSON.stringify({ a: 1 }), '合法对象照常写入');
    } finally { cleanup(dir); }
  });

  test('非法值不得改写同名旧槽(拒绝即无副作用)', () => {
    const { dir, slots } = mkSlots();
    try {
      slots.setSlot('k', '旧值');
      const r = slots.setSlot('k', 10n);
      assertEqual(r.success, false, '坏值必须被拒');
      assertEqual(slots.getSlot('k'), '旧值', '旧值必须原样保留, 不被坏值覆盖');

      slots.setSlot('k2', 'v2');
      const r2 = slots.setSlot('k2', () => 1);
      assertEqual(r2.success, false, 'function 也必须被拒');
      assertEqual(slots.getSlot('k2'), 'v2', '第二个旧值同样保留');
    } finally { cleanup(dir); }
  });

  test('守卫移除后本锁必须能变红(反向证明: 锁不是恒真的)', () => {
    // 把模块拷贝到临时目录、剥掉守卫再加载, 断言"缺陷复现"——
    // 若这条也绿, 说明上面的断言绑的不是守卫。
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'slots-mut-'));
    try {
      const original = fs.readFileSync(SRC, 'utf8');
      const anchor = 'if (!_isPersistableValue(value)) {';
      assertTrue(original.includes(anchor),
        `锚点 "${anchor}" 不存在, 反向证明的 mutation 没有落地, 该证明无效`);
      const mutated = original.replace(anchor, 'if (false) {')
        // 临时副本放在 os.tmpdir(), 相对 require 重写成绝对路径,
        // 避免两种更坏的选项: 拷进 src/ 会和其他并发测试争抢扫描,
        // 原样拷贝则 require('../utils/...' 解析不到任何东西。
        .split("require('../").join(`require('${path.join(__dirname, '..', 'src')}/`);
      assertTrue(mutated !== original, 'mutation 必须真的改动了源码');
      const mutPath = path.join(dir, 'slots-mutated.js');
      fs.writeFileSync(mutPath, mutated);

      const { Slots } = require(mutPath);
      const dataDir = path.join(dir, 'data');
      fs.mkdirSync(dataDir, { recursive: true });
      const s = new Slots({ dataDir: dataDir, autoSave: false, saveDelay: 0 });
      const r = s.setSlot('big', 123n);
      assertEqual(r.success, true,
        '守卫移除后 bigint 必须重新被接受(证明修复前确实如此)');
      return s.save().then(ok => {
        assertEqual(ok, false,
          '守卫移除后 save 必须因 bigint 静默失败(证明修复前毒化真实存在)');
      });
    } finally {
      cleanup(dir);
    }
  });
};
