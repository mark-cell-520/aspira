// test/safe-regex-contract.test.js
// test-coverage-gap 切片: 为引擎不加载、test/ 零引用(grep basename=0)的纯安全件
//   src/utils/safe-regex.js 补回归覆盖。三函数是动态正则构建/ReDoS 防护的底层守门。
// 契约全部"非恒真"、可往返, 改动即红:
//   escapeRegExp: 转义后 new RegExp 只匹配字面量(元字符不再是元字符);
//   checkRegexSafe: 认出嵌套量词 (ab+)+ 与重叠交替 (a|ab)+ 两类 ReDoS, 放过干净式;
//   safeMatch: 空/超长(默认10000/自定义max)输入返回 null, 正常返回匹配。
'use strict';
const path = require('path');
const { escapeRegExp, checkRegexSafe, safeMatch } = require(path.join(__dirname, '..', 'src', 'utils', 'safe-regex.js'));
const ok = (c, m) => { if (!c) throw new Error(m); };
let passed = 0, failed = 0;
function t(n, fn){ try{fn();passed++;console.log('  '+n);}catch(e){failed++;console.log('  ✗ '+n+' :: '+e.message);} }

t('escapeRegExp: 13 个元字符全部转义且可往返匹配字面量', () => {
  const metas = ['.','*','+','?','^','$','{','}','(',')','|','[',']','\\'];
  for (const c of metas) {
    const escaped = escapeRegExp(c);
    ok(escaped.indexOf('\\') >= 0, JSON.stringify(c) + ' 应被转义(加反斜杠)');
    ok(new RegExp(escaped).test(c) === true, '转义后 ' + JSON.stringify(c) + ' 应匹配其字面量');
  }
});
t('escapeRegExp: 元字符不再当元字符用(. 不再通配任意字符)', () => {
  ok(new RegExp(escapeRegExp('a.b')).test('a.b') === true, '应匹配字面 a.b');
  ok(new RegExp(escapeRegExp('a.b')).test('axb') === false, '. 已成为字面, 不应匹配 axb');
});
t('checkRegexSafe: 嵌套量词 (ab+)+ 判不安全(ReDoS)', () => {
  const r = checkRegexSafe(new RegExp('(ab+)+'));
  ok(r.safe === false, '(ab+)+ 应不安全, 实测 ' + JSON.stringify(r));
  ok(/nested/.test(r.risk || ''), '风险应指向 nested quantifiers, 实测 ' + r.risk);
});
t('checkRegexSafe: 重叠交替 (a|ab)+ 判不安全(ReDoS)', () => {
  const r = checkRegexSafe(new RegExp('(a|ab)+'));
  ok(r.safe === false, '(a|ab)+ 应不安全, 实测 ' + JSON.stringify(r));
  ok(/overlapping/.test(r.risk || ''), '风险应指向 overlapping alternatives, 实测 ' + r.risk);
});
t('checkRegexSafe: 干净正则判安全', () => {
  for (const s of ['abc', '(abc)?def']) {
    const r = checkRegexSafe(new RegExp(s));
    ok(r.safe === true && r.risk === null, s + ' 应判安全, 实测 ' + JSON.stringify(r));
  }
});
t('safeMatch: 空/超长(默认10000/自定义max)返回 null, 正常返回匹配', () => {
  ok(safeMatch(/x/, '') === null, '空输入应 null');
  ok(safeMatch(/x/, 'a'.repeat(10001)) === null, '超过默认 10000 应 null');
  ok(safeMatch(/x/, 'abc', 2) === null, '超过自定义 max 应 null');
  const m = safeMatch(/x/, 'xbox');
  ok(m && m[0] === 'x', '正常输入应返回匹配 x, 实测 ' + m);
});
console.log('\n测试结果: ' + passed + ' 通过, ' + failed + ' 失败, 共 ' + (passed + failed) + ' 个');
process.exit(failed > 0 ? 1 : 0);
