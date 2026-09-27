// ─── [解耦·吸收心虫slice③] formula 域门面 ─────
// core 经此桶访问 formula 域，避免直接依赖内部文件结构（formula-bridge / formula-module）。
// 与 dream/index.js 同模式。注意：src/ 下无 formula.js 并存（无 Node 同名遮蔽风险）。
// cognitive-bridge（getCognitiveBridge 单例）属跨切面关注点，由各消费方直接 require（slice① 模式），不经此桶。
module.exports = {
  ...require('./formula-bridge.js'),   // FormulaBridge, getFormulaBridge, injectHfToBridge
  ...require('./formula-module.js'),   // FormulaModule
};
