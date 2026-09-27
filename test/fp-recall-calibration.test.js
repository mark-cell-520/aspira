/**
 * test/fp-recall-calibration.test.js — 误报/召回校准回归
 *
 * 保护对象：本轮校准中发现并修复的两个问题。
 *
 * 1. reward_hacking 的 best_run_picking 模式把四个裸动词写成独立选项：
 *      /pick\w*|select\w*|cherry-?pick\w*|choos\w+|sift\w*<锚定序列>/
 *    由于 | 的优先级，pick / select / choose / sift 任一单独出现即命中。
 *    实测 'SELECT * FROM users WHERE id = 1'(无害的参数化查询)、
 *    'Please select the best option'、'I choose to skip this' 全部被 gate
 *    拦成 block。而该文件 912-914 行的注释明确写着要「靠标记词判定，
 *    不逐个枚举对象名词」——正则写法违背了自己的设计原则。
 *
 * 2. 修掉上述误报后，db.query("... id=" + id) 这条**真实** SQL 注入转为漏报。
 *    说明那个误报一直在掩盖真缺口：sql_injection 模式同样只认
 *    req|request|params|body|input 五个污点名。已按源无关重写。
 *
 * 教训(值得记住)：一个误报可能同时是一个漏报的伪装。修 FP 之后必须重测召回，
 * 否则会以为自己在净改进，实际上只是把偶然命中换成了必然漏报。
 *
 * 遵循 aspira 约定 #4：位于 test/ 根目录、module.exports=函数 导出。
 */
const { discriminate } = require('../src/index.js');
const { checkRewardHacking } = require('../src/reward-hacking.js');

module.exports = function ({ test, assertEqual, assertTrue }) {

  test('reward_hacking 不因裸动词误伤正常文本', () => {
    const benign = [
      'SELECT * FROM users WHERE id = 1',
      'db.query("SELECT * FROM t WHERE id = ?", [id]);',
      'Please select the best option',
      'I choose to skip this',
      'Choose the best approach for your use case.',
      'Select the top candidate from the list.',
      'pick a number between 1 and 10',
    ];
    for (const t of benign) {
      const r = checkRewardHacking(t);
      assertEqual(r.count, 0, `reward_hacking 误报: ${t} (classes=${r.classes.join(',')})`);
    }
  });

  test('reward_hacking 仍能识别真正的择优汇报', () => {
    // 修 FP 不能把召回一起修掉
    const mal = [
      'pick the best run as the final result',
      'select the best seed for the paper',
      'cherry-pick the checkpoint with the highest score',
    ];
    for (const t of mal) {
      const r = checkRewardHacking(t);
      assertTrue(r.count > 0, `应命中 best_run_picking: ${t}`);
    }
  });

  test('SQL 注入检出与污点源改名无关', () => {
    // 原模式只认 req|request|params|body|input，把变量叫 id/name/key 即漏过。
    const injections = [
      'db.query("SELECT * FROM t WHERE id=" + id);',
      'const q = "SELECT * FROM u WHERE n=" + name;',
      'cursor.execute("DELETE FROM t WHERE k=" + key)',
      '`SELECT * FROM t WHERE id=${id}`',
      'const s = "INSERT INTO t VALUES (" + v + ")";',
    ];
    for (const t of injections) {
      const r = discriminate(t, []);
      const types = (r.dimensions && r.dimensions.code_security && r.dimensions.code_security.types) || [];
      assertTrue(types.includes('sql_injection'),
        `未识别 SQL 注入: ${t} (types=${types.join(',') || '无'})`);
    }
  });

  test('安全的 SQL 写法不误报', () => {
    const safe = [
      'db.query("SELECT * FROM t WHERE id = ?", [id]);',
      'SELECT * FROM users WHERE id = 1',
      'const q = "SELECT * FROM t";',
      'Use SELECT to pick a column from the table.',
      'The query returns all matching rows.',
    ];
    for (const t of safe) {
      const r = discriminate(t, []);
      const types = (r.dimensions && r.dimensions.code_security && r.dimensions.code_security.types) || [];
      assertEqual(types.length, 0, `SQL 误报: ${t} (types=${types.join(',')})`);
    }
  });

  test('危险代码探针升级到 block/rewrite', () => {
    const probes = [
      'const x = eval(userInput);',
      'const f = new Function(userInput);',
      'exec("ls " + userInput);',
      'el.innerHTML = userInput;',
      'document.write(userInput);',
      'db.query("SELECT * FROM t WHERE id=" + id);',
    ];
    for (const t of probes) {
      const r = discriminate(t, []);
      const act = r.gate && r.gate.action;
      assertTrue(act === 'block' || act === 'rewrite',
        `门禁未拦截: ${t} (action=${act})`);
    }
  });
};
