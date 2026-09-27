/**
 * dream 域门面（吸收心虫 slice② 解耦）
 * 核心经此统一引用 dream 引擎家族，避免 core 直连 dream/ 内部多个文件。
 * 约束：不得存在同名 src/dream.js（会遮蔽本门面）——已确认无冲突。
 */
module.exports = {
  ...require('./dream.js'),
  DreamConsolidation: require('./dream-consolidation.js').DreamConsolidation,
  DreamEngineV2: require('./dream-engine-v2.js').DreamEngineV2,
};
