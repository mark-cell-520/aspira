/**
 * test/unwired-module-coverage.test.js — 从未被引擎加载的实质模块
 *
 * ═══ 这个缺口是怎么量出来的 ═══
 * 按"测试文件里是否出现模块 basename"来算覆盖，会得到 133 个"无覆盖"模块——
 * 但那是**错的**：src/pipeline.js 里的 priority-guardian / progress-judgment /
 * uncertainty-quantifier / dao-decision 都被流水线间接跑到，只是没有测试
 * 直接点名它们。用 basename 匹配会把间接覆盖算成缺口。
 *
 * 改为**实测加载**: 在 require 链上挂钩子，记录引擎启动时真正 require 到的
 * src/ 文件。378 个模块中引擎只加载 245 个，**133 个从未加载**。
 * 剔除 archive/ 与 <80 行的空壳后，剩 **100 个实质模块从未被加载**。
 *
 * 先确认它们不是坏的: 逐个 `node --check`，**语法错误 0 个**；
 * 98 个有 module.exports。所以它们是**可加载但从未接线**的代码。
 * (曾尝试逐个 require 来验证，触发重量级初始化，400s 超时被杀——
 * 说明"能加载"和"能安全加载"是两件事，静态检查才是可规模化的手段。)
 *
 * ═══ 本轮覆盖哪两个 ═══
 * 100 个不可能一个周期做完(约定: 单次周期聚焦一个切片，不贪多)。
 * 挑选标准是**被文档承诺过却从未接线**——那比单纯"没测"更危险:
 *   - src/core/action-tracker.js
 *     AGENTS.md「Decision routing」明确写着:
 *       "Did it actually work? src/core/action-tracker.js —
 *        assessEffectiveness() checks the effect, not the action."
 *     文档把调用方指向一个引擎从不加载的模块。
 *   - src/core/meta-calibration.js
 *     头部注释写着职责是"把校准结果转成**调用方可读的诚实声明**"，
 *     对齐"缺事实就说不知道——不编造"的设计原则。诚实外显是 Aspira
 *     的核心价值，却没有测试锁定它的行为。
 *
 * 两个都是纯逻辑、无 IO、无外部依赖，适合直接测。
 */
module.exports = function ({ test, assertEqual, assertTrue }) {
  const path = require('path');
  const { ActionTracker } = require('../src/core/action-tracker.js');
  const MetaCalibration = require('../src/core/meta-calibration.js');

  // ══════════════════ MetaCalibration ══════════════════

  test('MetaCalibration: 校准置信度低于阈值必须显式声明不确定', () => {
    const mc = new MetaCalibration();
    const r = mc.annotate({ calibration: { calibratedConfidence: 0.3 } });
    assertTrue(r.honest === true, '低于阈值应标记 honest');
    assertEqual(r.level, 'low');
    assertEqual(r.calibratedConfidence, 0.3);
    assertEqual(r.gaps.length, 1);
    assertEqual(r.gaps[0].what, '整体结论');
    assertTrue(typeof r.statement === 'string' && r.statement.length > 0,
      'honest 为真时必须生成可读声明');
    // 声明里必须出现置信度数值，不能含糊其辞
    assertTrue(r.statement.includes('0.30'), '声明应包含具体置信度');
  });

  test('MetaCalibration: 高置信度不得假装不确定', () => {
    const mc = new MetaCalibration();
    const r = mc.annotate({ calibration: { calibratedConfidence: 0.85 } });
    assertTrue(r.honest === false, '高置信度不应标记 honest');
    assertEqual(r.level, 'high');
    assertEqual(r.statement, null, '无需声明时 statement 必须为 null');
    assertEqual(r.gaps.length, 0);
  });

  test('MetaCalibration: 阈值与 0.8 之间是 medium', () => {
    const mc = new MetaCalibration();
    const r = mc.annotate({ calibration: { calibratedConfidence: 0.6 } });
    assertEqual(r.level, 'medium');
    assertTrue(r.honest === false);
  });

  test('MetaCalibration: 缺 calibratedConfidence 时回退 originalConfidence', () => {
    const mc = new MetaCalibration();
    const r = mc.annotate({ calibration: { originalConfidence: 0.42 } });
    assertEqual(r.calibratedConfidence, 0.42, '应回退到 originalConfidence');
    assertTrue(r.honest === true, '0.42 低于默认阈值 0.5，应声明不确定');
  });

  test('MetaCalibration: 两者都缺时默认 0.3(不编造高置信)', () => {
    const mc = new MetaCalibration();
    const r = mc.annotate({ calibration: {} });
    assertEqual(r.calibratedConfidence, 0.3, '无任何置信度输入应默认 0.3');
    assertTrue(r.honest === true);
    // 完全空 ctx 也不能抛异常
    const r2 = mc.annotate();
    assertEqual(r2.calibratedConfidence, 0.3);
    assertTrue(r2.honest === true);
  });

  test('MetaCalibration: 被下调且校准置信低的子系统必须单独列为缺口', () => {
    const mc = new MetaCalibration();
    const r = mc.annotate({
      calibration: {
        calibratedConfidence: 0.75,
        subsystemCalibration: {
          memory: { adjusted: true, confidence: { calibrated: 0.42 } },
          emotion: { adjusted: false, confidence: { calibrated: 0.1 } },
        },
      },
    });
    // 只有 adjusted===true 且 calibrated<0.5 的项算缺口
    assertEqual(r.gaps.length, 1, `应只有 1 个缺口，实测 ${r.gaps.length}`);
    assertEqual(r.gaps[0].what, '子系统[memory]');
    assertTrue(r.gaps[0].why.includes('0.42'), '缺口原因应带上校准数值');
  });

  test('MetaCalibration: needsUncertaintyMarker 且无其他缺口时兜底一条', () => {
    const mc = new MetaCalibration();
    const r = mc.annotate({
      calibration: { calibratedConfidence: 0.7, needsUncertaintyMarker: true, uncertaintyPhrase: '缺少关键前提' },
    });
    assertEqual(r.gaps.length, 1, '兜底缺口应有且仅有一条');
    assertEqual(r.gaps[0].what, '关键论断');
    assertEqual(r.gaps[0].why, '缺少关键前提', '应使用调用方给的 uncertaintyPhrase');
  });

  test('MetaCalibration: needsUncertaintyMarker 但已有缺口时不得重复添加', () => {
    const mc = new MetaCalibration();
    const r = mc.annotate({
      calibration: { calibratedConfidence: 0.2, needsUncertaintyMarker: true },
    });
    assertEqual(r.gaps.length, 1, '已有"整体结论"缺口时不应再叠加"关键论断"');
    assertEqual(r.gaps[0].what, '整体结论');
  });

  test('MetaCalibration: 自定义阈值必须生效', () => {
    const strict = new MetaCalibration({ threshold: 0.9 });
    const r = strict.annotate({ calibration: { calibratedConfidence: 0.75 } });
    assertTrue(r.honest === true, '0.75 应低于自定义阈值 0.9');
    assertEqual(r.level, 'low');
    const loose = new MetaCalibration({ threshold: 0.1 });
    const r2 = loose.annotate({ calibration: { calibratedConfidence: 0.75 } });
    assertTrue(r2.honest === false, '0.75 应高于宽松阈值 0.1');
  });

  test('MetaCalibration: 不得越界写 persona 或替代事实核查', () => {
    // 设计原则 3: 不站队、只标注确定性缺口。note 字段是这条边界的显式声明，
    // 必须始终存在——它是"诚实外显层"与"编造第一人称体验"的分界。
    const mc = new MetaCalibration();
    for (const c of [0.1, 0.5, 0.9]) {
      const r = mc.annotate({ calibration: { calibratedConfidence: c } });
      assertTrue(typeof r.note === 'string' && r.note.includes('不替代事实核查'),
        `置信度 ${c} 下 note 边界声明必须存在`);
    }
  });

  // ══════════════════ ActionTracker ══════════════════

  test('ActionTracker: commit→execute 成功路径必须走完状态机', () => {
    const at = new ActionTracker();
    const c = at.commit('修复登录缺陷', Date.now() + 3600000);
    assertEqual(c.status, 'committed');
    assertTrue(typeof c.id === 'string' && c.id.length > 0);
    assertTrue(c.tracking && c.tracking.overdue === false, '未到期的承诺 overdue 应为 false');
    assertEqual(at.getStats().totalPlanned, 1);

    const r = at.execute(c.id, { success: true });
    assertTrue(r.success === true);
    assertEqual(at.getStats().totalExecuted, 1);
    assertEqual(at.getStats().totalCompleted, 1);
    assertEqual(at.getStats().streakDays, 1, '成功应累加连续天数');
    assertEqual(at.state.commitments.active.length, 0, '执行后承诺应离开 active');
    assertEqual(at.state.commitments.fulfilled.length, 1);
  });

  test('ActionTracker: execute 失败必须计入 broken 并清零连续天数', () => {
    const at = new ActionTracker();
    const c1 = at.commit('任务一');
    at.execute(c1.id, { success: true });
    assertEqual(at.getStats().streakDays, 1);
    const c2 = at.commit('任务二');
    const r = at.execute(c2.id, { success: false, reason: 'timeout' });
    assertTrue(r.success === false);
    assertEqual(at.getStats().streakDays, 0, '失败必须清零连续天数');
    assertEqual(at.state.commitments.broken.length, 1);
    assertEqual(at.state.actions.failed.length, 1);
    // successRate = completed / executed = 1/2
    assertEqual(at.getStats().successRate, 0.5);
  });

  test('ActionTracker: 未知 id 必须返回失败而不是抛异常', () => {
    const at = new ActionTracker();
    const r = at.execute('不存在的id', { success: true });
    assertEqual(r.success, false);
    assertEqual(r.reason, 'Commitment not found');
    assertEqual(at.trackCommitment('不存在的id'), null);
    assertEqual(at.trackAction('不存在的id'), null);
    assertEqual(at.assessQuality('不存在的id'), null);
    assertEqual(at.learnFromAction('不存在的id'), null);
  });

  test('ActionTracker: act→reportResult 的无承诺路径', () => {
    const at = new ActionTracker();
    const a = at.act('直接跑一次检查');
    assertEqual(a.status, 'executed');
    // 未上报结果前是 in_progress
    assertEqual(at.trackAction(a.id).status, 'in_progress');
    const r = at.reportResult(a.id, { success: true, effectiveness: 0.9 });
    assertTrue(r.success === true);
    assertEqual(at.trackAction(a.id).status, 'completed');
    assertEqual(at.getStats().totalCompleted, 1);
  });

  test('ActionTracker: reportResult 对未知 action 返回 success:false', () => {
    const at = new ActionTracker();
    const r = at.reportResult('nope', { success: true });
    assertEqual(r.success, false);
  });

  test('ActionTracker: assessEffectiveness 检查效果而非行动(AGENTS.md 引用点)', () => {
    // AGENTS.md「Decision routing」写着:
    //   "Did it actually work? src/core/action-tracker.js —
    //    assessEffectiveness() checks the effect, not the action."
    // 这一条把文档承诺的行为钉住: 有效性取自 result.effectiveness，
    // 没有该字段时才按 success 兜底。
    const at = new ActionTracker();
    assertEqual(at.assessEffectiveness({ result: { effectiveness: 0.93 } }), 0.93,
      '应优先使用 result.effectiveness');
    assertEqual(at.assessEffectiveness({ success: true }), 0.8, '无 effectiveness 时成功兜底 0.8');
    assertEqual(at.assessEffectiveness({ success: false }), 0.4, '无 effectiveness 时失败兜底 0.4');
    assertEqual(at.assessEffectiveness({}), 0.4, '两者都缺按失败兜底');
  });

  test('ActionTracker: assessQuality 三维取平均并做指数平滑', () => {
    const at = new ActionTracker();
    const a = at.act('做一件事');
    at.reportResult(a.id, { success: true, thoroughness: 1, effectiveness: 1, completedAt: Date.now() });
    const q = at.assessQuality(a.id);
    // thoroughness=1, effectiveness=1, timeliness 由耗时推得(刚完成 <60s → 1)
    assertEqual(q.thoroughness, 1);
    assertEqual(q.effectiveness, 1);
    assertEqual(q.timeliness, 1);
    assertEqual(q.overall, 1);
    // 指数平滑: 0.7*0.9 + 1*0.1 = 0.73
    assertTrue(Math.abs(at.state.quality.thoroughness - 0.73) < 1e-9,
      `平滑后 thoroughness 应为 0.73，实测 ${at.state.quality.thoroughness}`);
  });

  test('ActionTracker: 意图-行为对齐度计算与缺口上报', () => {
    const at = new ActionTracker();
    // 无任何已完成/违背的承诺时，对齐度定义为 1(不惩罚空白历史)
    assertEqual(at.checkIntentBehaviorAlignment().alignment, 1);
    assertEqual(at.checkIntentBehaviorAlignment().gaps.length, 0);

    const c1 = at.commit('A'); at.execute(c1.id, { success: true });
    const c2 = at.commit('B'); at.execute(c2.id, { success: true });
    const c3 = at.commit('C'); at.execute(c3.id, { success: false });
    const al = at.checkIntentBehaviorAlignment();
    assertEqual(al.alignment, 2 / 3);
    assertEqual(al.gaps.length, 1, '对齐度 0.67 < 0.8 应上报缺口');
    // 注意字面量是 intention_behavior_gap(不是 intent_behavior_gap)——
    // 首版按记忆里的简称写，实测不符。这类字面量必须以源码为准。
    assertEqual(al.gaps[0].type, 'intention_behavior_gap');
    // 缺口严重度应为 1 - alignment
    assertTrue(Math.abs(al.gaps[0].severity - (1 - 2 / 3)) < 1e-9);
  });

  test('ActionTracker: 变革阶段只能前进到 maintenance 并停住', () => {
    const at = new ActionTracker();
    assertEqual(at.state.changeStage, 'contemplation');
    const seen = [at.advanceChangeStage().currentStage];
    for (let i = 0; i < 10; i++) seen.push(at.advanceChangeStage().currentStage);
    assertEqual(seen[seen.length - 1], 'maintenance', '必须停在最后一个阶段');
    // 不得出现越界或回退
    const stages = ['precontemplation', 'contemplation', 'preparation', 'action', 'maintenance'];
    for (const s of seen) assertTrue(stages.includes(s), `出现越界阶段: ${s}`);
  });

  test('ActionTracker: learnFromAction 与 suggestImprovement 的分诊', () => {
    const at = new ActionTracker();
    const a = at.act('尝试修复');
    at.reportResult(a.id, { success: false, reason: 'timeout' });
    const lesson = at.learnFromAction(a.id);
    assertEqual(lesson.success, false);
    assertEqual(at.state.learning.lessonsLearnt.length, 1);
    assertEqual(at.state.learning.improvements.length, 1, '失败且带 reason 应产出改进建议');
    assertEqual(at.suggestImprovement({ result: { reason: 'timeout' } }), '需要更充足的时间或分阶段完成');
    assertEqual(at.suggestImprovement({ result: { reason: 'resource' } }), '需要更多资源或简化目标');
    assertEqual(at.suggestImprovement({ result: { reason: 'other' } }), '重新评估可行性后再次尝试');
    assertEqual(at.suggestImprovement({}), '重新评估可行性后再次尝试');
  });

  test('ActionTracker: getSummary 与 getActiveCommitments 一致性', () => {
    const at = new ActionTracker();
    const c1 = at.commit('进行中的承诺', Date.now() + 60000);
    at.commit('另一条');
    const active = at.getActiveCommitments();
    assertEqual(active.length, 2);
    assertEqual(active[0].promise, '进行中的承诺');
    assertEqual(active[0].overdue, false);
    const sum = at.getSummary();
    assertEqual(sum.activeCommitments, 2);
    assertEqual(sum.stats.totalPlanned, 2);
    assertEqual(sum.changeStage, 'contemplation');
    assertEqual(sum.lessonsLearnt, 0);
    assertEqual(typeof sum.alignment.alignment, 'number');
  });

  test('ActionTracker: 逾期承诺必须被标出', () => {
    const at = new ActionTracker();
    // 截止时间设为过去 → overdue 应为 true
    const c = at.commit('已逾期的承诺', Date.now() - 1000);
    assertEqual(at.trackCommitment(c.id).overdue, true, '过去的截止时间应判为逾期');
    assertEqual(at.getActiveCommitments()[0].overdue, true);
  });

  test('ActionTracker: initialState 注入必须被保留', () => {
    const at = new ActionTracker({ initialState: { changeStage: 'action', stats: { streakDays: 7 } } });
    assertEqual(at.state.changeStage, 'action');
    assertEqual(at.getStats().streakDays, 7, '注入的初始状态应可读取');
  });

  test('这两个模块必须确实从未被引擎加载(缺口本身要被锁住)', () => {
    // 若将来有人把它们接进引擎，这条测试会失败——那正是想要的效果:
    // 覆盖缺口的消失应该是一个**有意识的决定**，而不是无声发生。
    const fs = require('fs');
    const path = require('path');
    const engineSrc = ['src/pipeline.js', 'src/index.js', 'src/core/heartflow.js']
      .map(f => fs.readFileSync(path.join(__dirname, '..', f), 'utf8')).join('\n');
    for (const mod of ['action-tracker', 'meta-calibration']) {
      assertTrue(!engineSrc.includes(`'./core/${mod}.js'`) && !engineSrc.includes(`"./core/${mod}.js"`),
        `${mod} 似乎已被引擎接线——若这是有意的，请更新本条测试的说明`);
    }
  });
};
