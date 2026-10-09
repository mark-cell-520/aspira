/**
 * test/memory-index-spread-guard.test.js —
 * 一次 updateUser("字符串") 把 user 污染成 {"0":"字","1":"符"} 并落了盘
 *
 * [test-coverage-gap·第一百七十九轮] 新建。
 *
 * B 类之王 src/memory/memory-index.js(931 行, MemoryIndex 类, 被 heartflow.js
 * 与 identity-core.js 引用, 是真活模块, 零测试)。按 cycle 28/148/156/159/167/
 * 170/171 的纪律 probing by calling 全景调用。
 *
 * ═══ 缺陷: 对象展开把非对象展开成索引键 ═══
 * 三处 `{...x}` 展开, 而 JavaScript 的对象展开对**非对象**照样展开:
 *   updateUser("字符串")     → user = {"0":"字","1":"符","2":"串", role:null, ...}
 *   addPausedTask("任务")    → 条目 = {"0":"任","1":"务", pausedAt:...}
 *   addPausedTask([1,2,3])   → 条目 = {"0":1,"1":2,"2":3, pausedAt:...}
 * 实测(修复前) getUser() 返回 {"0":"字","1":"符","2":"串", role:null, goals:[],
 * preferences:{}, constraints:...}。
 *
 * 这是本仓库反复记录的形状, 且这次带**持久化**: 调用成功、不抛错、返回值
 * undefined, 而索引已被污染并写进 data/memory-index.json。调用方以为存了一条
 * 用户更新/一个暂停任务, 实际存的是一堆数字键 —— 而读路径全部正常返回,
 * 没有任何异常可观察。
 *
 * ═══ 修法 ═══
 * 三处都加类型闸: 只接受普通对象(不含 null 与数组), 其余原样返回不改状态。
 * _loadIndex 那道还多一层意义: 磁盘文件被外部写成数组时(手改/别的工具覆盖),
 * `{...defaults, ...data}` 会把下标展开成顶层键, meta/identity/user 全丢;
 * 实测修复后重新加载回落默认索引(七键齐全)。
 *
 * ═══ 一个被证伪的怀疑(记录) ═══
 * 探针一度报 `resolveProblem()` 抛 "Cannot read properties of undefined
 * (reading '0')"。逐层分离后确认那是**探针自己的路径写错** ——
 * unresolvedProblems 在 index.context 下而不在顶层, 我读的是
 * `getIndex().unresolvedProblems[0]`。resolveProblem 本身工作正常
 * (空数组返回 undefined, 有 id 时正确标记 resolved)。**先证伪自己的探针,
 * 再动手改代码** —— 否则会去"修"一个不坏的函数。
 *
 * ═══ 锁什么 ═══
 * ① updateUser 拒绝非对象(字符串/数字/数组/null)且不污染 user;
 * ② addPausedTask 拒绝非对象且 pausedTasks 只收合法条目;
 * ③ updateUser/addPausedTask 的合法路径不得回归(含只保留最近 5 条);
 * ④ _loadIndex 对"磁盘被写成数组"必须回落默认索引而非展开成数字键;
 * ⑤ 源级: 三处展开点都必须有类型闸(含自证)。
 */
module.exports = function ({ test, assertEqual, assertTrue }) {
  const path = require('path');
  const fs = require('fs');
  const os = require('os');
  const ROOT = path.join(__dirname, '..');
  const { MemoryIndex } = require(path.join(ROOT, 'src', 'memory', 'memory-index.js'));

  const mkTmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'mi-guard-'));
  const hasNumericKey = (o) => Object.keys(o || {}).some(k => /^\d+$/.test(k));

  // ── 一、updateUser 拒绝非对象 ───────────────────────────
  test('updateUser 必须拒绝非对象且不污染 user', () => {
    const tmp = mkTmp();
    try {
      const mi = new MemoryIndex(tmp);
      mi.updateUser({ name: '甲', role: 'owner' });
      const before = JSON.stringify(mi.getUser());
      for (const [label, v] of [['字符串', '字符串'], ['数字', 42], ['数组', [1, 2]], ['null', null], ['undefined', undefined]]) {
        mi.updateUser(v);
        const u = mi.getUser();
        assertEqual(hasNumericKey(u), false,
          `updateUser(${label}) 后 user 出现数字键: ${JSON.stringify(Object.keys(u))} —— ` +
          '对象展开把非对象按索引展开了');
        // 且不得改动已有的合法字段
        assertEqual(u.name, '甲', `updateUser(${label}) 不应清除已有 name 字段`);
        assertEqual(u.role, 'owner', `updateUser(${label}) 不应清除已有 role 字段`);
      }
      assertEqual(JSON.stringify(mi.getUser()), before,
        '连续 5 次非法调用后 user 应与调用前逐字节一致');
    } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  });

  // ── 二、addPausedTask 拒绝非对象 ────────────────────────
  test('addPausedTask 必须拒绝非对象且 pausedTasks 只收合法条目', () => {
    const tmp = mkTmp();
    try {
      const mi = new MemoryIndex(tmp);
      mi.addPausedTask({ id: 'ok-1', task: '合法任务' });
      for (const [label, v] of [['字符串', '字符串任务'], ['数字', 7], ['数组', [1, 2, 3]], ['null', null]]) {
        mi.addPausedTask(v);
      }
      mi.addPausedTask({ id: 'ok-2', task: '另一个合法任务' });
      const tasks = mi.getContext().pausedTasks;
      assertEqual(tasks.length, 2,
        `pausedTasks 应只有 2 条合法条目, 实测 ${tasks.length} 条: ${JSON.stringify(tasks.map(t => t.id))}`);
      for (const t of tasks) {
        assertEqual(hasNumericKey(t), false,
          `暂停任务出现数字键: ${JSON.stringify(t)}`);
        assertEqual(typeof t.pausedAt, 'string', '合法条目必须带 pausedAt');
      }
    } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  });

  // ── 三、合法路径不得回归 ────────────────────────────────
  test('合法路径不得回归(含 pausedTasks 只保留最近 5 条)', () => {
    const tmp = mkTmp();
    try {
      const mi = new MemoryIndex(tmp);
      // updateUser 合法
      mi.updateUser({ name: '乙', goals: ['目标一'] });
      assertEqual(mi.getUser().name, '乙', 'updateUser 合法路径应生效');
      assertEqual(mi.getUser().goals.length, 1, 'goals 应被写入');
      // addPausedTask 合法 + 上限
      for (let i = 0; i < 8; i++) mi.addPausedTask({ id: 't' + i });
      const tasks = mi.getContext().pausedTasks;
      assertEqual(tasks.length, 5, `pausedTasks 应只保留最近 5 条, 实测 ${tasks.length}`);
      assertEqual(tasks[0].id, 't3', `保留的应是最后 5 条(t3..t7), 实测首条 ${tasks[0].id}`);
      assertEqual(tasks[4].id, 't7', `末条应为 t7, 实测 ${tasks[4].id}`);
      // 其他 setter 仍工作。注意 addFeedback 有**设计内**的守卫: 必须带
      // meta.source 或 meta.userConfirmed(探索失败不自动存为教训), 所以这里
      // 要显式传 source —— 首版没传, 被守卫正确拒绝, 那是我的调用错不是缺陷。
      mi.addFeedback('validated', '这样做有效', { source: 'user' });
      assertEqual(mi.getFeedback().validated.length, 1, 'addFeedback 合法路径应生效');
      // 守卫本身也要在: 不传 source/userConfirmed 必须被拒
      const n0 = mi.getFeedback().validated.length;
      mi.addFeedback('validated', '无来源的反馈');
      assertEqual(mi.getFeedback().validated.length, n0,
        'addFeedback 无 source 且无 userConfirmed 时必须被拒(设计内守卫)');
      mi.setCurrentWork({ task: 'X' });
      assertEqual(mi.getProject().currentWork.task, 'X', 'setCurrentWork 合法路径应生效');
      mi.addUnresolvedProblem('问题A');
      const pid = mi.getContext().unresolvedProblems[0].id;
      mi.resolveProblem(pid, '已修复');
      const p = mi.getContext().unresolvedProblems[0];
      assertEqual(p.resolved, true, 'resolveProblem 应标记 resolved');
      assertEqual(p.solution, '已修复', 'resolveProblem 应记录 solution');
    } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  });

  // ── 四、磁盘被写成数组时必须回落默认索引 ────────────────
  test('_loadIndex: 磁盘文件被写成数组时必须回落默认索引而非展开成数字键', () => {
    const tmp = mkTmp();
    try {
      const mi = new MemoryIndex(tmp);
      // 先造一个正常索引
      mi.updateUser({ name: '丙' });
      const idxFile = path.join(tmp, 'data', 'memory-index.json');
      assertTrue(fs.existsSync(idxFile), '前提失效: 索引文件未生成');
      // 外部把磁盘写成数组
      fs.writeFileSync(idxFile, JSON.stringify([1, 2, 3]));
      const mi2 = new MemoryIndex(tmp);
      const idx = mi2.getIndex();
      assertEqual(hasNumericKey(idx), false,
        `索引顶层出现数字键: ${JSON.stringify(Object.keys(idx))} —— 数组被展开进了索引`);
      for (const k of ['meta', 'identity', 'user', 'feedback', 'project', 'reference', 'context']) {
        assertTrue(k in idx, `默认索引的 ${k} 键丢失(数组展开把它冲掉了)`);
      }
      // 读路径必须全部可用(不得抛)
      for (const [n, fn] of [
        ['getUser', () => mi2.getUser()],
        ['getFeedback', () => mi2.getFeedback()],
        ['getProject', () => mi2.getProject()],
        ['getContext', () => mi2.getContext()],
        ['getBootSummary', () => mi2.getBootSummary()],
        ['healthCheck', () => mi2.healthCheck()],
      ]) {
        let err = null;
        try { fn(); } catch (e) { err = e.message; }
        assertEqual(err, null, `${n}() 在损坏索引上抛错: ${err}`);
      }
    } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  });

  // ── 五、源级: 三处展开点都必须有类型闸 ──────────────────
  test('源级: updateUser / addPausedTask / _loadIndex 三处都必须有类型闸', () => {
    const src = fs.readFileSync(path.join(ROOT, 'src', 'memory', 'memory-index.js'), 'utf8')
      .split('\n').map(l => l.replace(/\/\/.*$/, m => ' '.repeat(m.length))).join('\n');
    // 5.1 updateUser
    const iU = src.indexOf('updateUser(updates) {');
    assertTrue(iU > 0, '前提失效: 找不到 updateUser');
    const segU = src.slice(iU, src.indexOf('\n  }', iU));
    assertTrue(/typeof updates !== 'object'/.test(segU),
      'updateUser 必须校验 updates 是对象');
    assertTrue(/Array\.isArray\(updates\)/.test(segU),
      'updateUser 必须排除数组(数组同样会被展开成索引键)');
    // 5.2 addPausedTask
    const iP = src.indexOf('addPausedTask(task) {');
    assertTrue(iP > 0, '前提失效: 找不到 addPausedTask');
    const segP = src.slice(iP, src.indexOf('\n  }', iP));
    assertTrue(/typeof task !== 'object'/.test(segP),
      'addPausedTask 必须校验 task 是对象');
    assertTrue(/Array\.isArray\(task\)/.test(segP),
      'addPausedTask 必须排除数组');
    // 5.3 _loadIndex
    const iL = src.indexOf('_loadIndex() {');
    assertTrue(iL > 0, '前提失效: 找不到 _loadIndex');
    const segL = src.slice(iL, src.indexOf('\n  }', iL));
    assertTrue(/Array\.isArray\(data\)/.test(segL),
      '_loadIndex 必须排除数组形态的磁盘数据');
    // 5.4 自证: 谓词必须分得清"有闸"与"无闸"
    const noGuard = 'updateUser(updates) {\n    this.index.user = { ...this.index.user, ...updates };\n  }';
    assertTrue(/typeof updates !== 'object'/.test(noGuard) === false,
      '自证失效: 谓词分不清有闸与无闸, 本条是恒真锁');
  });
};
