// test/lesson-retrieval-priority-sort-recency.test.js
//
// 锁的缺陷：src/cortex/lesson-retrieval.js 的 prioritySort() 把 lastSeen /
// createdAt 当数字用，而 lesson-bank.js 的每一个写入点写的都是
// new Date().toISOString() —— 字符串。`now - "2026-10-28T20:13:16.267Z"`
// 得 NaN，ageA/ageB、decayA/decayB、scoreA/scoreB 一路 NaN，排序比较器
// 对每一对都返回 NaN，V8 把 NaN 当 0，于是整个排序退化成无操作。
// retrieve() / getTopN() / filterBy() 三条公开路径都走 prioritySort，
// 文件头 v2.0.48 升级说明第 2 条「时间衰减因子（recency boost）纳入优先级
// 排序」从写下起就没生效过。
//
// 修法：加 _toTimestamp() 归一（数字 / Date / ISO 字符串都收），
// prioritySort 改走它。lesson-bank 的 decayImportance() 第 136 行本来就是
// `new Date(l.lastSeen).getTime()` 先转再用 —— 产出侧自己知道这字段是字符串。

const assert = require('assert');
const path = require('path');

const SRC = path.join(__dirname, '..', 'src', 'cortex', 'lesson-retrieval.js');
const { LessonRetrievalEngine } = require(SRC);
const { lessonBank } = require(path.join(__dirname, '..', 'src', 'cortex', 'lesson-bank.js'));

const DAY = 24 * 60 * 60 * 1000;

// 形状严格照 lessonBank.add() 的产出：lastSeen / createdAt 是 ISO 字符串
function mk(id, importance, frequency, ageDays) {
  const ts = Date.now() - ageDays * DAY;
  return {
    id, type: 'insight', content: id, importance, frequency,
    createdAt: new Date(ts).toISOString(),
    lastSeen: new Date(ts).toISOString(),
  };
}

module.exports = function ({ test }) {
  const lr = new LessonRetrievalEngine();
  const original = lessonBank.lessons;
  const restore = () => { lessonBank.lessons = original; };

  test('prioritySort: ISO 字符串时间戳不得让排序退化成无操作', () => {
    // 同分(importance/frequency 都相同)，只有新旧不同
    const items = [mk('stale', 5, 3, 30), mk('fresh', 5, 3, 0)];
    const out = lr.prioritySort(items).map(l => l.id);
    assert.deepStrictEqual(out, ['fresh', 'stale'],
      `同分时近期者必须靠前，实测 ${out.join(' -> ')}`);
  });

  test('prioritySort: 内部 age 计算不得为 NaN', () => {
    const items = [mk('a', 5, 3, 30), mk('b', 5, 3, 0), mk('c', 5, 3, 10)];
    const now = Date.now();
    for (const l of items) {
      // 复算 prioritySort 内部的 age，但走修好后的 _toTimestamp 归一
      const lastSeen = lr._toTimestamp(l.lastSeen, lr._toTimestamp(l.createdAt, now));
      const age = Math.min(1, (now - lastSeen) / (7 * DAY));
      assert.ok(!Number.isNaN(age),
        `lastSeen 是 ISO 字符串时 age 不得为 NaN，实测 ${age}`);
      assert.ok(age >= 0 && age <= 1, `age 应落在 [0,1]，实测 ${age}`);
    }
  });

  test('prioritySort: 数字时间戳(findSimilar 的产出)同样有效', () => {
    const ts = Date.now();
    const items = [
      { id: 'stale', type: 'insight', content: 'x', importance: 5, frequency: 3, createdAt: ts - 30 * DAY, lastSeen: ts - 30 * DAY },
      { id: 'fresh', type: 'insight', content: 'y', importance: 5, frequency: 3, createdAt: ts, lastSeen: ts },
    ];
    const out = lr.prioritySort(items).map(l => l.id);
    assert.deepStrictEqual(out, ['fresh', 'stale'],
      `数字时间戳同样应按近期优先，实测 ${out.join(' -> ')}`);
  });

  test('prioritySort: 缺少时间字段不得崩溃', () => {
    const items = [
      { id: 'x', type: 'insight', content: 'x', importance: 5, frequency: 1 },
      { id: 'y', type: 'insight', content: 'y', importance: 5, frequency: 1 },
    ];
    const out = lr.prioritySort(items).map(l => l.id);
    assert.strictEqual(out.length, 2, '两条都应保留');
  });

  test('getTopN: 多样性路径在 ISO 字符串时间戳下仍工作', () => {
    lessonBank.lessons = [mk('a', 9, 9, 0), mk('b', 8, 8, 1), mk('c', 7, 7, 2)];
    lessonBank.lessons[2].type = 'bug';
    try {
      const top = lr.getTopN(3);
      assert.strictEqual(top.length, 3, `应返回 3 条，实测 ${top.length}`);
      assert.strictEqual(top[0].id, 'a', '最高分者应在首位');
    } finally { restore(); }
  });

  test('_toTimestamp: 三种形状都归一成有限数', () => {
    const t = lr._toTimestamp(new Date(1000).toISOString());
    assert.strictEqual(t, 1000, `ISO 字符串应归一为 1000，实测 ${t}`);
    assert.strictEqual(lr._toTimestamp(2000), 2000, '数字应原样通过');
    assert.strictEqual(lr._toTimestamp(new Date(3000)), 3000, 'Date 应归一');
    assert.ok(Number.isFinite(lr._toTimestamp(undefined, 42)), 'undefined 应回退到 fallback');
    assert.ok(Number.isFinite(lr._toTimestamp('not-a-date', 42)), '非法字符串应回退到 fallback');
  });
};
