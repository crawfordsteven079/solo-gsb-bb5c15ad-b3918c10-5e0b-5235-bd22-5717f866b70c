'use strict';

// 核心剂量规则的无外部依赖测试：node test/dose.test.js
const dose = require('../src/lib/dose');
const { computeApprovalCheck } = require('../src/routes/plans');

let passed = 0;
let failed = 0;

function assert(cond, name) {
  if (cond) {
    passed += 1;
  } else {
    failed += 1;
    console.error('✗ ' + name);
  }
}

function approx(a, b, eps = 1e-6) {
  return Math.abs(Number(a) - Number(b)) <= eps;
}

// 1. 按自然年拆分：2026-12-30 至 2027-01-02，每天 10:00-12:00（2h），50 lux
//    2026 年 2 天 = 200 lux·h；2027 年 2 天 = 200 lux·h
{
  const plan = {
    start_date: '2026-12-30', end_date: '2027-01-02',
    lights_on: '10:00', lights_off: '12:00', estimated_lux: 50
  };
  const rows = dose.planDoseByYear(plan);
  assert(rows.length === 2, '跨年计划应拆为两个年度');
  assert(rows[0].year === 2026 && approx(rows[0].dose, 200), '2026 年剂量 = 50lux×2h×2天 = 200');
  assert(rows[1].year === 2027 && approx(rows[1].dose, 200), '2027 年剂量 = 200');
}

// 2. 非整年/闰年天数正确：2024-02-28 至 2024-03-01 共 3 天，每天 8h，100 lux = 2400
{
  const rows = dose.planDoseByYear({
    start_date: '2024-02-28', end_date: '2024-03-01',
    lights_on: '09:00', lights_off: '17:00', estimated_lux: 100
  });
  assert(rows.length === 1 && rows[0].year === 2024 && approx(rows[0].dose, 2400), '闰年跨月天数与剂量正确');
}

// 3. 非法每日时段
assert(dose.dailyWindow('17:00', '09:00') === null, '结束早于开始（跨夜）非法');
assert(dose.dailyWindow('09:00', '09:00') === null, '零长度时段非法');
assert(dose.dailyWindow('9:00', '17:00') === null, '非 HH:MM 格式非法');
assert(dose.dailyWindow('24:00', '25:00') === null, '越界时间非法');

// 4. 非正照度
assert(dose.planDoseByYear({ start_date: '2026-01-01', end_date: '2026-01-02', lights_on: '09:00', lights_off: '17:00', estimated_lux: 0 }) === null, '预计照度 0 非法');
assert(dose.planDoseByYear({ start_date: '2026-01-01', end_date: '2026-01-02', lights_on: '09:00', lights_off: '17:00', estimated_lux: -5 }) === null, '负照度非法');
assert(dose.measuredDose({ measured_on: '2026-01-01', start_time: '10:00', end_time: '11:00', actual_lux: 0 }) === null, '实测照度 0 非法');

// 4b. 兼容 PostgreSQL TIME 的 HH:MM:SS 返回值（秒为 00）
assert(dose.parseHHMM('09:00:00') === 540, 'HH:MM:00 可解析');
assert(dose.parseHHMM('09:00:30') === null, '非零秒拒绝');
{
  const rows = dose.planDoseByYear({
    start_date: '2026-01-01', end_date: '2026-01-01',
    lights_on: '09:00:00', lights_off: '11:00:00', estimated_lux: 50
  });
  assert(rows.length === 1 && approx(rows[0].dose, 100), '库内 TIME 格式的计划剂量为 100');
  assert(dose.plansOverlap(
    { start_date: '2026-01-01', end_date: '2026-01-02', lights_on: '09:00:00', lights_off: '12:00:00' },
    { start_date: '2026-01-01', end_date: '2026-01-02', lights_on: '11:00', lights_off: '13:00' }
  ), '库内/表单两种时间格式混合仍能判定重叠');
}

// 5. 非法日期
assert(dose.parseDate('2026-02-31') === null, '2026-02-31 不存在');
assert(dose.planDoseByYear({ start_date: '2026-13-01', end_date: '2026-13-02', lights_on: '09:00', lights_off: '17:00', estimated_lux: 10 }) === null, '月份越界非法');

// 6. 计划时间重叠
{
  const a = { start_date: '2026-03-01', end_date: '2026-03-10', lights_on: '09:00', lights_off: '12:00' };
  const b = { start_date: '2026-03-05', end_date: '2026-03-08', lights_on: '11:00', lights_off: '15:00' };
  assert(dose.plansOverlap(a, b), '日期重叠且每日窗口重叠 => 重叠');

  const c = { start_date: '2026-03-05', end_date: '2026-03-08', lights_on: '12:00', lights_off: '15:00' };
  assert(!dose.plansOverlap(a, c), '每日窗口仅端点接触 => 不重叠');

  const d = { start_date: '2026-03-05', end_date: '2026-03-08', lights_on: '13:00', lights_off: '15:00' };
  assert(!dose.plansOverlap(a, d), '每日窗口完全错开 => 不重叠');

  const e = { start_date: '2026-03-11', end_date: '2026-03-12', lights_on: '09:00', lights_off: '12:00' };
  assert(!dose.plansOverlap(a, e), '日期首尾相接但不重叠 => 不重叠');
}

// 7. 审批额度合计：实测 + 其他计划估算剩余 + 新计划
{
  const plan = {
    id: 3, start_date: '2026-05-01', end_date: '2026-05-01',
    lights_on: '09:00', lights_off: '17:00', estimated_lux: 100 // 800
  };
  const other = {
    id: 2, status: 'approved',
    start_date: '2026-06-01', end_date: '2026-06-02',
    lights_on: '09:00', lights_off: '17:00', estimated_lux: 100 // 1600
  };
  // 计划 #2 在 2026-06-01 已有 2h、100lux 实测 = 200，则其估算剩余 = 1600-200 = 1400
  const confirmed = [{
    id: 10, plan_id: 2, measured_on: '2026-06-01',
    start_time: '09:00', end_time: '11:00', actual_lux: 100, status: 'confirmed'
  }];
  const limits = [{ year: 2026, max_dose: 2000 }];
  const check = computeApprovalCheck(plan, limits, [other], confirmed);
  // 800 + 1400（计划2另一天估算） + 200（实测） = 2400，超额 400
  assert(!check.ok, '超限计划不得通过');
  assert(check.problems[0].includes('2026') && check.problems[0].includes('超额 400'), '指出年份与超额量: ' + check.problems.join('|'));

  const check2 = computeApprovalCheck(plan, [{ year: 2026, max_dose: 2400 }], [other], confirmed);
  assert(check2.ok, '刚好等于上限可以通过');
}

// 8. 缺上限不能批准
{
  const plan = { id: 1, start_date: '2027-01-01', end_date: '2027-01-01', lights_on: '09:00', lights_off: '10:00', estimated_lux: 100 };
  const check = computeApprovalCheck(plan, [], [], []);
  assert(!check.ok && check.problems[0].includes('2027 年尚未登记'), '未登记上限年度须指出');
}

// 9. 实测必须落在计划开灯时段内
{
  const plan = { start_date: '2026-03-01', end_date: '2026-03-10', lights_on: '09:00', lights_off: '17:00' };
  assert(dose.measurementWithinPlan({ measured_on: '2026-03-05', start_time: '10:00', end_time: '12:00' }, plan), '计划窗口内容许');
  assert(dose.measurementWithinPlan({ measured_on: '2026-03-01', start_time: '09:00', end_time: '17:00' }, plan), '整段开灯窗口容许');
  assert(!dose.measurementWithinPlan({ measured_on: '2026-03-05', start_time: '08:59', end_time: '10:00' }, plan), '早于开灯时间拒绝');
  assert(!dose.measurementWithinPlan({ measured_on: '2026-03-05', start_time: '16:00', end_time: '17:01' }, plan), '晚于关灯时间拒绝');
  assert(!dose.measurementWithinPlan({ measured_on: '2026-02-28', start_time: '10:00', end_time: '12:00' }, plan), '展期外拒绝');
  assert(!dose.measurementWithinPlan({ measured_on: '2026-03-05', start_time: '23:00', end_time: '23:30' }, plan), '窗口外拒绝');
}

// 10. 实测重叠判定
{
  const a = { measured_on: '2026-03-05', start_time: '10:00', end_time: '11:00' };
  const b = { measured_on: '2026-03-05', start_time: '11:00', end_time: '12:00' };
  const c = { measured_on: '2026-03-05', start_time: '10:30', end_time: '10:45' };
  const d = { measured_on: '2026-03-06', start_time: '10:00', end_time: '11:00' };
  assert(!dose.measurementsOverlap(a, b), '端点接触不算重叠');
  assert(dose.measurementsOverlap(a, c), '包含关系重叠');
  assert(!dose.measurementsOverlap(a, d), '不同日期不重叠');
}

// 11. 汇总：实测替代估算
{
  const plan = {
    id: 1, status: 'approved',
    start_date: '2026-03-01', end_date: '2026-03-02',
    lights_on: '09:00', lights_off: '17:00', estimated_lux: 50 // 400/天，共 800
  };
  // 第一天实测 100 lux × 8h = 800
  const ms = [{ id: 1, plan_id: 1, measured_on: '2026-03-01', start_time: '09:00', end_time: '17:00', actual_lux: 100, status: 'confirmed' }];
  const s = dose.summarizeByYear([plan], ms);
  const y = s.years[0];
  assert(approx(y.measured, 800), '已确认实测 800');
  assert(approx(y.estimatedRemaining, 400), '剩余估算仅第二天 400（实测替代估算）');
  assert(approx(y.total, 1200), '合计 1200');
}

// 12. 待复核计划仍计入占用
{
  const plan = {
    id: 1, status: 'pending_review',
    start_date: '2026-03-01', end_date: '2026-03-01',
    lights_on: '09:00', lights_off: '10:00', estimated_lux: 100
  };
  const s = dose.summarizeByYear([plan], []);
  assert(approx(s.years[0].total, 100), '待复核计划仍占用额度');
}

// 13. 未确认（recorded）实测不计入
{
  const s = dose.summarizeByYear([], [{ id: 1, plan_id: 9, measured_on: '2026-03-01', start_time: '09:00', end_time: '10:00', actual_lux: 100, status: 'recorded' }]);
  assert(s.years.length === 0, '待确认实测不占用额度');
}

// 14. 待审批(pending)计划不阻塞其他计划审批、不占额
{
  const pending = {
    id: 1, status: 'pending',
    start_date: '2026-03-01', end_date: '2026-03-10',
    lights_on: '09:00', lights_off: '17:00', estimated_lux: 100
  };
  const newcomer = {
    id: 2, start_date: '2026-03-05', end_date: '2026-03-06',
    lights_on: '10:00', lights_off: '12:00', estimated_lux: 100
  };
  const check = computeApprovalCheck(newcomer, [{ year: 2026, max_dose: 100000 }], [pending], []);
  assert(check.ok, '其他待审批计划不参与重叠与额度计算');
}

// 15. 待复核计划再次批准：自身已确认实测已在现状中，新增只计未替代估算，不重复
{
  // 计划：2026-03-01～03-02 每天 09:00-17:00（8h），预计 50 lux => 800
  const plan = {
    id: 5, status: 'pending_review',
    start_date: '2026-03-01', end_date: '2026-03-02',
    lights_on: '09:00', lights_off: '17:00', estimated_lux: 50
  };
  // 第一天已确认实测 100 lux×8h = 800（替代第一天估算 400）
  const confirmed = [{
    id: 1, plan_id: 5, status: 'confirmed',
    measured_on: '2026-03-01', start_time: '09:00', end_time: '17:00', actual_lux: 100
  }];
  // 上限 1200：现状 800 + 新增（仅剩第二天估算 400）= 1200，不超限
  const check = computeApprovalCheck(plan, [{ year: 2026, max_dose: 1200 }], [], confirmed);
  assert(check.ok, '待复核再批准不重复计自身实测: ' + check.problems.join('|'));
  assert(approx(check.yearRows[0].current, 800), '现状为实测 800');
  assert(approx(check.yearRows[0].addDose, 400), '新增仅未替代估算 400');
  assert(approx(check.yearRows[0].projected, 1200), '合计 1200');

  const check2 = computeApprovalCheck(plan, [{ year: 2026, max_dose: 1199 }], [], confirmed);
  assert(!check2.ok && check2.problems[0].includes('超额 1'), '上限 1199 时超额 1: ' + check2.problems.join('|'));
}

// 16. 部分实测只覆盖窗口一部分：按覆盖分钟扣减原估算
{
  const plan = {
    id: 6, status: 'approved',
    start_date: '2026-03-01', end_date: '2026-03-01',
    lights_on: '09:00', lights_off: '17:00', estimated_lux: 50 // 整天估算 400
  };
  // 实测只覆盖 2h（09:00-11:00），100 lux = 200；替代估算 50×2=100
  const ms = [{ id: 1, plan_id: 6, status: 'confirmed', measured_on: '2026-03-01', start_time: '09:00', end_time: '11:00', actual_lux: 100 }];
  const s = dose.summarizeByYear([plan], ms);
  const y = s.years[0];
  assert(approx(y.measured, 200), '实测剂量 200');
  assert(approx(y.estimatedRemaining, 300), '估算剩余 400-100=300');
  assert(approx(y.total, 500), '合计 500');
}

console.log(`\n${passed} 通过, ${failed} 失败`);
process.exit(failed ? 1 : 0);
