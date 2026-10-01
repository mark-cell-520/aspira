/**
 * 第一百二十三轮: src/benchmark/failure-importer.js 的两条分支同族不同约。
 *
 * 测量法: 同一个"合法 JSON 但不是用例对象"的输入, 分别走
 * parseCases 的 JSONL 分支(带换行)与单行分支(不带换行)。
 *
 *   42              → JSONL: cases=[] errors=[]      (静默丢)
 *                    单行: cases=[] errors=[内容不是用例对象]
 *   "str"  / null   → 同上, 两条分支口径不一致。
 *
 * 这个模块的对外承诺是"永不抛错", 而 importFromFile 的 report.errors 是
 * 调用方**唯一**能看见"有东西没进来"的地方。一条分支静默、另一条报错,
 * 等于同一个用户错误一半会被告知、一半不会。
 *
 * 本轮修法: JSONL 分支补齐 else, 与单行分支同口径。
 * lock: 两条分支对这个输入族必须返回相同形状的 errors(都非空)。
 */
module.exports = function ({ test, assertEqual, assertTrue }) {
  const path = require('path');
  const ROOT = path.join(__dirname, '..');
  const { parseCases } = require(path.join(ROOT, 'src', 'benchmark', 'failure-importer.js'));

  const NON_OBJECT = ['42', '"str"', 'null', 'true', '3.14'];
  const OBJECT_LINE = '{"input":"x"}';

  test('JSONL 分支: 合法 JSON 但非对象必须报错(不许静默丢)', () => {
    for (const v of NON_OBJECT) {
      const r = parseCases(v + '\n' + OBJECT_LINE);
      assertEqual(r.cases.length, 1, '正常用例行仍应导入: ' + v);
      assertTrue(r.errors.length >= 1,
        '第 1 行 ' + v + ' 是非对象, 应出现在 errors 里。实测 errors=' +
        JSON.stringify(r.errors));
      assertTrue(r.errors.some(e => e.indexOf('不是用例对象') >= 0),
        '错误信息应说明原因(不是用例对象)。实测 ' + JSON.stringify(r.errors));
    }
  });

  test('单行分支: 同一输入族的口径(反向控制, 不许被改坏)', () => {
    for (const v of NON_OBJECT) {
      const r = parseCases(v);
      assertEqual(r.cases.length, 0, '非对象不该成为用例: ' + v);
      assertTrue(r.errors.length >= 1,
        '单行分支原本就报错, 现在仍须报错: ' + v + '。实测 errors=' +
        JSON.stringify(r.errors));
    }
  });

  test('两条分支对同一输入族必须同口径(本轮修的核心)', () => {
    for (const v of NON_OBJECT) {
      const a = parseCases(v + '\n' + OBJECT_LINE);
      const b = parseCases(v);
      assertTrue(a.errors.length > 0 === b.errors.length > 0,
        v + ': JSONL errors=' + JSON.stringify(a.errors) +
        ' 单行 errors=' + JSON.stringify(b.errors) + ' —— 同族不同约');
    }
  });

  test('对象行与注释/空行必须被正确导入或跳过(不许误伤)', () => {
    const src = [
      '{"input":"one"}',
      '// 这是注释',
      '# 这也是注释',
      '',
      '   ',
      '{"input":"two","expected":"block"}',
    ].join('\n');
    const r = parseCases(src);
    assertEqual(r.cases.length, 2, '两条对象行都应导入');
    assertEqual(r.errors.length, 0, '注释与空行不该产生错误');
    assertEqual(r.cases[0].input, 'one');
    assertEqual(r.cases[1].expected, 'block');
  });
};
