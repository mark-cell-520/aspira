/**
 * test/utils/dialogue-writer.test.js — 模块加载检查
 *
 * [第十五轮修复] 这个文件原来是**把异常变成合理答复的 catch**:
 *
 *   async function run() {
 *     try {
 *       const mod = require('../../src/utils/dialogue-writer.js');
 *       console.log('PASS dialogue-writer.test.js (module loads)');
 *     } catch (e) {
 *       // Module may have optional deps or initialization requirements
 *       console.log('SKIP dialogue-writer.test.js (' + e.code + ': ' + e.message.slice(0, 60) + ')');
 *     }
 *   }
 *   run().catch(e => console.log('SKIP dialogue-writer.test.js: ' + e.code));
 *
 * 三个后果叠起来，使这个检查等于不存在:
 *   1. 加载失败时打印 SKIP，**退出码仍是 0**——与加载成功不可区分
 *      (实测: 把 require 指向不存在的模块，exit 同样为 0);
 *   2. PASS 与 SKIP 两行都不含"通过/失败"，run-all 的 emitResult 的正则
 *      /(\d+) 通过, (\d+) 失败/ 匹配不到汇总行 → 贡献 0 个用例、0 个失败;
 *   3. 它 require 了 assert 却从未使用——一个从不失败的检查。
 * 于是若 ../../src/utils/dialogue-writer.js 被删掉或引入语法错误，run-all 依然报全绿。
 *
 * 这正是仓库反复记载的形状: **一个把异常变成合理答复的 catch，比没有自检更危险**。
 * 现改为 mount 风格: 加载成功计 1 个通过，加载失败计 1 个失败并会响。
 */
module.exports = function ({ test }) {
  test('dialogue-writer 模块可加载', () => {
    require('../../src/utils/dialogue-writer.js');
  });
};
