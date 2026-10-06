// test/dimension-coverage-floor.test.js
// dimension-health-audit 切片：锁"跨文件引用覆盖地板"，防覆盖被静默侵蚀。
// 与 test/dimension-health-invariant.test.js(锁仪器 exit0 + SCORE_ONLY 自洽)是**不同面**：
//   那个管"判别是否健康"; 这个管"每个维度是否仍被足够多的回归文件覆盖"(AGENTS.md 覆盖分布 2:N 概念)。
//
// 2026-10-06 实测: 54 维度全部被 ≥3 个 test/*.test.js 引用, 薄覆盖(≤2)=0(优于历史 2:28)。
// 维度名取自 dimension-health-audit.js 输出(判定逻辑复用, 不手打清单)；文件清单排除 archive(与 run-all 契约一致)。
// dimension-health-audit.js 只读、不写文档, spawn 它不会加剧 doc 探针并发污染。
'use strict';
const path = require('path'), fs = require('fs');
const { execFileSync } = require('child_process');
const ok = (c, m) => { if (!c) throw new Error(m); };
let passed = 0, failed = 0;
function t(n, fn){ try{fn();passed++;console.log('  '+n);}catch(e){failed++;console.log('  ✗ '+n+' :: '+e.message);} }

let dims = [];
{
  const out = execFileSync('node', [path.join(__dirname,'..','scripts','dimension-health-audit.js')],
    { cwd: path.join(__dirname,'..'), encoding:'utf8', timeout:120000, maxBuffer:64*1024*1024 });
  dims = [...new Set([...out.matchAll(/^\s{2}([a-z][a-z0-9_]+)\s+信号\s+\d+/gm)].map(x => x[1]))];
}
const walk = d => { const o=[]; for(const e of fs.readdirSync(d,{withFileTypes:true})){const p=path.join(d,e.name); e.isDirectory()?o.push(...walk(p)):(e.name.endsWith('.test.js') && !p.includes(path.sep+'archive'+path.sep) && o.push(p));} return o; };
const testFiles = walk(path.join(__dirname,'..','test'));
const contents = testFiles.map(f=>({f,t:fs.readFileSync(f,'utf8')}));
const refs = dims.map(d=>({d, n: contents.filter(c=>c.t.includes(d)).length}));

t('维度名齐备(54)', () => ok(dims.length===54, `取到 ${dims.length} 个维度名, 应 54`));
t('无薄覆盖维度: 每维度至少被 3 个测试文件引用', () => {
  const thin = refs.filter(x => x.n <= 2);
  ok(thin.length===0, `薄覆盖(≤2)维度 ${thin.length} 个: ${thin.map(x=>x.d+'('+x.n+')').join(', ')} — 覆盖被侵蚀(AGENTS.md 覆盖分布 2:N), 需补回归`);
});
const minRef = Math.min(...refs.map(x => x.n));
console.log('  ── 实测: ' + dims.length + ' 维度 × ' + testFiles.length + ' 测试文件; 每维度引用数最小=' + minRef + ', 薄(≤2)=0 ──');
console.log('\n测试结果: ' + passed + ' 通过, ' + failed + ' 失败, 共 ' + (passed+failed) + ' 个');
process.exit(failed>0?1:0);
