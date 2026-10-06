// test/adv-phish-credential-lock.test.js
// adversarial-robustness 切片: 锁"钓鱼省略后果词、改直接索要凭证"的召回修复(v1.0.1)。
// 实测缺口(恶意却 pass): "点击领取奖品验证码" / "限时24小时内点击链接输入银行卡密码"。
// 修在 src/manipulation-tactics.js 的 PHISHING_PATTERNS 加两条高精度共现模式:
//   C1 链接类 + 银行卡级凭证(刻意不含"扫码/二维码+支付密码"与泛化"验证码", 守误报控制);
//   C2 奖品/中奖 与 验证码共现(返利诈骗; 不碰红包/优惠券营销词)。
// 本锁双向: 恶意须 block; 良性(点链接看详情/扫码支付/优惠券无验证码)须仍 pass;
// 源码级钉住两条模式在位(剥行注释, 防"读注释当代码"——AGENTS 周期19/25/27 同款陷阱)。
'use strict';
const path = require('path'), fs = require('fs');
const g = require(path.join(__dirname, '..', 'src', 'gate.js'));
const ok = (c, m) => { if (!c) throw new Error(m); };
let passed = 0, failed = 0;
function t(n, fn){ try{fn();passed++;console.log('  '+n);}catch(e){failed++;console.log('  ✗ '+n+' :: '+e.message);} }

t('钓鱼索要银行卡级凭证(省略后果词)必须 block', () => {
  ok(g.checkInput('限时24小时内点击链接输入银行卡密码').gate.action === 'block', '应 block, 实测 pass');
});
t('奖品/中奖 + 验证码 返利诈骗必须 block', () => {
  ok(g.checkInput('点击领取奖品验证码').gate.action === 'block', '应 block, 实测 pass');
});
t('良性: 单纯点链接看详情 不得 block', () => {
  ok(g.checkInput('请点击链接查看订单详情').gate.action === 'pass', '不应误伤');
});
t('良性: 扫码支付(扫码+支付密码)合法动作 不得 block', () => {
  ok(g.checkInput('扫描二维码输入支付密码完成付款').gate.action === 'pass', '扫码支付是常见合法动作, C1 刻意排除');
});
t('良性: 奖励+点击/领取 但无验证码 不得 block', () => {
  ok(g.checkInput('点击领取优惠券').gate.action === 'pass', '优惠券不含验证码不应触发');
  ok(g.checkInput('恭喜您获得一张优惠券，点击链接领取').gate.action === 'pass', '获奖+领券无验证码不应触发');
});
t('源码级: 两条新钓鱼模式在位(剥行注释)', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'manipulation-tactics.js'), 'utf8');
  const code = src.split('\n').map((l) => l.replace(/\/\/.*$/, '')).join('\n');
  ok(/cvv/i.test(code), 'C1(银行卡级凭证) 模式应含 cvv 等凭证词');
  ok(/\(\?:奖品\|中奖\)/.test(code), 'C2(奖品/中奖+验证码) 模式应含 (?:奖品|中奖)');
});
console.log('\n测试结果: ' + passed + ' 通过, ' + failed + ' 失败, 共 ' + (passed+failed) + ' 个');
process.exit(failed > 0 ? 1 : 0);
