'use strict';

// 照度时数（lux·h，即剂量）按自然年拆分的纯计算模块。
// 时间均以“本地挂钟时间”处理；存储层统一使用 TIMESTAMPTZ。

const MINUTES_PER_HOUR = 60;

function round2(n) {
  return Math.round((Number(n) + Number.EPSILON) * 100) / 100;
}

// ---- 基础校验与解析 -------------------------------------------------------

// HH:MM（24 小时制）；兼容 PostgreSQL TIME 返回的 HH:MM:SS（秒必须为 00）
function parseHHMM(s) {
  if (typeof s !== 'string') return null;
  const m = s.match(/^([01]\d|2[0-3]):([0-5]\d)(?::([0-5]\d))?$/);
  if (!m) return null;
  if (m[3] !== undefined && m[3] !== '00') return null;
  return Number(m[1]) * 60 + Number(m[2]);
}

// YYYY-MM-DD
function parseDate(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    return null;
  }
  const d = new Date(s + 'T00:00:00');
  if (Number.isNaN(d.getTime())) return null;
  // 拒绝 2026-02-31 之类被 JS 自动进位的日期
  const iso = d.getFullYear() + '-' +
    String(d.getMonth() + 1).padStart(2, '0') + '-' +
    String(d.getDate()).padStart(2, '0');
  return iso === s ? d : null;
}

function dateISO(d) {
  return d.getFullYear() + '-' +
    String(d.getMonth() + 1).padStart(2, '0') + '-' +
    String(d.getDate()).padStart(2, '0');
}

function addDays(d, n) {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
}

function yearOf(d) {
  return d.getFullYear();
}

// 将日期区间 [startDate, endDate]（含首尾）拆成各自然年的（含首尾）日期段。
function splitDateRangeByYear(startDate, endDate) {
  const segments = [];
  let cursor = new Date(startDate);
  while (cursor <= endDate) {
    const y = cursor.getFullYear();
    const yearStart = new Date(y, 0, 1);
    const yearEnd = new Date(y, 11, 31);
    const segStart = cursor < yearStart ? yearStart : new Date(cursor);
    const segEnd = endDate < yearEnd ? new Date(endDate) : yearEnd;
    segments.push({ year: y, startDate: segStart, endDate: segEnd });
    cursor = addDays(yearEnd, 1);
  }
  return segments;
}

// 计划每日开灯时段：[startMin, endMin)，必须为正长度且在一天之内（不支持跨夜）。
function dailyWindow(startHHMM, endHHMM) {
  const s = parseHHMM(startHHMM);
  const e = parseHHMM(endHHMM);
  if (s === null || e === null || e <= s) return null;
  return { startMin: s, endMin: e, minutes: e - s };
}

// 把某日的分钟数组合为该日本地 Date
function dateTimeAt(date, min) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate(),
    Math.floor(min / 60), min % 60, 0, 0);
}

// 某日期段内每日开灯产生的时段（左闭右开）列表
function windowIntervals(startDate, endDate, win) {
  const out = [];
  for (let d = new Date(startDate); d <= endDate; d = addDays(d, 1)) {
    out.push({
      start: dateTimeAt(d, win.startMin),
      end: dateTimeAt(d, win.endMin)
    });
  }
  return out;
}

// 两个左闭右开区间是否有正向重叠（仅端点接触不算）
function intervalsOverlap(aStart, aEnd, bStart, bEnd) {
  return aStart < bEnd && bStart < aEnd;
}

function minutesBetween(a, b) {
  return (b.getTime() - a.getTime()) / 60000;
}

// ---- 计划的预计剂量 -------------------------------------------------------

// 返回 [{ year, dose }]，dose 单位 lux·h
function planDoseByYear(plan) {
  const start = parseDate(plan.start_date);
  const end = parseDate(plan.end_date);
  if (!start || !end || end < start) return null;
  const win = dailyWindow(plan.lights_on, plan.lights_off);
  if (!win) return null;
  if (!(Number(plan.estimated_lux) > 0)) return null;

  const segments = splitDateRangeByYear(start, end);
  return segments.map((seg) => {
    const days = Math.round(minutesBetween(seg.startDate, seg.endDate) / (60 * 24)) + 1;
    const hours = days * win.minutes / MINUTES_PER_HOUR;
    return { year: seg.year, dose: Number(plan.estimated_lux) * hours };
  });
}

// ---- 实测记录 -------------------------------------------------------------

// 实测时段：必须是正长度，且落在“某一天 00:00–24:00”之内
function measuredInterval(rec) {
  const sd = parseDate(rec.measured_on);
  if (!sd) return null;
  const s = parseHHMM(rec.start_time);
  const e = parseHHMM(rec.end_time);
  if (s === null || e === null || e <= s) return null;
  return {
    start: dateTimeAt(sd, s),
    end: dateTimeAt(sd, e)
  };
}

function measuredDose(rec) {
  const iv = measuredInterval(rec);
  if (!iv) return null;
  if (!(Number(rec.actual_lux) > 0)) return null;
  return {
    year: iv.start.getFullYear(),
    dose: Number(rec.actual_lux) * minutesBetween(iv.start, iv.end) / MINUTES_PER_HOUR
  };
}

// 该实测在计划各年开灯窗口内“替代掉的原估算剂量”：
// 按计划预计照度 × 测量时段与计划开灯窗口的重叠分钟计算（测量不跨夜，至多落在一天）
function replacedEstimatedByYear(rec, plan) {
  const iv = measuredInterval(rec);
  if (!iv) return [];
  const win = dailyWindow(plan.lights_on, plan.lights_off);
  const pStart = parseDate(plan.start_date);
  const pEnd = parseDate(plan.end_date);
  if (!win || !pStart || !pEnd) return [];
  const day = iv.start;
  const dayStart = new Date(day.getFullYear(), day.getMonth(), day.getDate());
  if (dayStart < pStart || dayStart > pEnd) return [];
  const winStart = dateTimeAt(day, win.startMin);
  const winEnd = dateTimeAt(day, win.endMin);
  if (!intervalsOverlap(iv.start, iv.end, winStart, winEnd)) return [];
  const lo = iv.start > winStart ? iv.start : winStart;
  const hi = iv.end < winEnd ? iv.end : winEnd;
  const mins = minutesBetween(lo, hi);
  const lux = Number(plan.estimated_lux);
  return [{ year: day.getFullYear(), dose: lux * mins / MINUTES_PER_HOUR }];
}

// 实测时段是否落在计划有效期内的开灯窗口中
function measurementWithinPlan(rec, plan) {
  const iv = measuredInterval(rec);
  if (!iv) return false;
  const day = iv.start;
  const pStart = parseDate(plan.start_date);
  const pEnd = parseDate(plan.end_date);
  if (!pStart || !pEnd) return false;
  // 以日历日零点比较，避免展期最后一天因带时分而被误判为超出
  const dayStart = new Date(day.getFullYear(), day.getMonth(), day.getDate());
  if (dayStart < pStart || dayStart > pEnd) return false;
  // 实测必须在同一天（不跨夜），结束时间不能越日
  if (iv.end.getFullYear() !== day.getFullYear() ||
      iv.end.getMonth() !== day.getMonth() ||
      iv.end.getDate() !== day.getDate()) {
    return false;
  }
  const win = dailyWindow(plan.lights_on, plan.lights_off);
  if (!win) return false;
  const winStart = dateTimeAt(day, win.startMin);
  const winEnd = dateTimeAt(day, win.endMin);
  return iv.start >= winStart && iv.end <= winEnd;
}

// ---- 计划时间重叠 ---------------------------------------------------------

// 两个计划的“展出日期 × 每日开灯时段”是否存在时间重叠
function plansOverlap(a, b) {
  const aStart = parseDate(a.start_date);
  const aEnd = parseDate(a.end_date);
  const bStart = parseDate(b.start_date);
  const bEnd = parseDate(b.end_date);
  if (!aStart || !aEnd || !bStart || !bEnd) return false;
  if (aEnd < bStart || bEnd < aStart) return false;
  const wa = dailyWindow(a.lights_on, a.lights_off);
  const wb = dailyWindow(b.lights_on, b.lights_off);
  if (!wa || !wb) return false;
  // 每日开灯窗口不重叠（仅端点接触可接受），则日期重叠也不会真正重叠
  if (wa.endMin <= wb.startMin || wb.endMin <= wa.startMin) return false;
  return true;
}

// 同一展品已确认实测之间是否时间重叠（端点接触不算）
function measurementsOverlap(a, b) {
  const ia = measuredInterval(a);
  const ib = measuredInterval(b);
  if (!ia || !ib) return false;
  return intervalsOverlap(ia.start, ia.end, ib.start, ib.end);
}

// ---- 年度额度汇总 ---------------------------------------------------------

// plans: 计划列表（仅 'approved' / 'pending_review' 计入占用，其余忽略）；
// measurements: 实测列表（仅 'confirmed' 计入，其余忽略）。
// 返回 { years: [{ year, measured, estimatedRemaining, total, sources: [...] }] }
// sources: { type:'measured'|'estimated', plan_id, amount, note }
function summarizeByYear(plans, measurements) {
  const activePlans = plans.filter((p) => ['approved', 'pending_review'].includes(p.status));
  const confirmedMeasurements = measurements.filter((m) => (m.status || 'confirmed') === 'confirmed');
  const byYear = new Map();
  const entry = (year) => {
    if (!byYear.has(year)) {
      byYear.set(year, { year, measured: 0, estimatedRemaining: 0, total: 0, sources: [] });
    }
    return byYear.get(year);
  };
  // 1) 已确认实测：按实测照度计入
  for (const m of confirmedMeasurements) {
    const d = measuredDose(m);
    if (!d) continue;
    const e = entry(d.year);
    e.measured += d.dose;
    e.total += d.dose;
    e.sources.push({
      type: 'measured',
      plan_id: m.plan_id,
      amount: d.dose,
      note: `计划 #${m.plan_id} 实测 ${dateISO(measuredInterval(m).start)}`
    });
  }

  // 2) 被实测覆盖时段“替代掉的原估算剂量”（按计划预计照度 × 覆盖分钟）
  const planById = new Map(activePlans.map((p) => [p.id, p]));
  const replacedByPlan = new Map();
  for (const m of confirmedMeasurements) {
    const plan = planById.get(m.plan_id);
    if (!plan) continue;
    for (const r of replacedEstimatedByYear(m, plan)) {
      if (!replacedByPlan.has(m.plan_id)) replacedByPlan.set(m.plan_id, new Map());
      const ym = replacedByPlan.get(m.plan_id);
      ym.set(r.year, (ym.get(r.year) || 0) + r.dose);
    }
  }
  for (const p of activePlans) {
    const rows = planDoseByYear(p) || [];
    for (const r of rows) {
      const e = entry(r.year);
      const replaced = replacedByPlan.get(p.id)?.get(r.year) || 0;
      const remaining = Math.max(0, r.dose - replaced);
      e.estimatedRemaining += remaining;
      e.total += remaining;
      if (remaining > 0) {
        e.sources.push({
          type: 'estimated',
          plan_id: p.id,
          amount: remaining,
          note: `计划 #${p.id} 估算剩余（${p.status === 'pending_review' ? '待复核' : '已批准'}）`
        });
      }
    }
  }
  return { years: [...byYear.values()].sort((a, b) => a.year - b.year) };
}

module.exports = {
  round2,
  parseHHMM,
  parseDate,
  dateISO,
  addDays,
  yearOf,
  splitDateRangeByYear,
  dailyWindow,
  windowIntervals,
  intervalsOverlap,
  minutesBetween,
  planDoseByYear,
  measuredInterval,
  measuredDose,
  replacedEstimatedByYear,
  measurementWithinPlan,
  plansOverlap,
  measurementsOverlap,
  summarizeByYear
};
