'use strict';

const dose = require('./dose');

// 从 req.body 读取计划字段并校验；返回 { values, error }
function readPlanInput(body) {
  const values = {
    exhibit_id: (body.exhibit_id || '').trim(),
    start_date: (body.start_date || '').trim(),
    end_date: (body.end_date || '').trim(),
    lights_on: (body.lights_on || '').trim(),
    lights_off: (body.lights_off || '').trim(),
    estimated_lux: (body.estimated_lux || '').trim()
  };

  if (!/^\d+$/.test(values.exhibit_id)) return { values, error: '请选择展品。' };
  const start = dose.parseDate(values.start_date);
  if (!start) return { values, error: '展出开始日期无效（应为 YYYY-MM-DD）。' };
  const end = dose.parseDate(values.end_date);
  if (!end) return { values, error: '展出结束日期无效（应为 YYYY-MM-DD）。' };
  if (end < start) return { values, error: '结束日期不能早于开始日期。' };

  const win = dose.dailyWindow(values.lights_on, values.lights_off);
  if (!win) {
    return { values, error: '每日开灯时段无效：开始/结束时间格式应为 HH:MM，且结束必须晚于开始（不支持跨夜）。' };
  }
  const lux = Number(values.estimated_lux);
  if (!(lux > 0) || !Number.isFinite(lux)) {
    return { values, error: '预计照度必须为正数（lux）。' };
  }
  values.exhibit_id = Number(values.exhibit_id);
  values.estimated_lux = lux;
  return { values, error: null };
}

function readMeasurementInput(body) {
  const values = {
    plan_id: (body.plan_id || '').trim(),
    measured_on: (body.measured_on || '').trim(),
    start_time: (body.start_time || '').trim(),
    end_time: (body.end_time || '').trim(),
    actual_lux: (body.actual_lux || '').trim(),
    note: (body.note || '').trim()
  };
  if (!/^\d+$/.test(values.plan_id)) return { values, error: '缺少计划编号。' };
  if (!dose.parseDate(values.measured_on)) return { values, error: '实测日期无效（应为 YYYY-MM-DD）。' };
  const s = dose.parseHHMM(values.start_time);
  const e = dose.parseHHMM(values.end_time);
  if (s === null || e === null) return { values, error: '实测时间格式应为 HH:MM。' };
  if (e <= s) return { values, error: '实测时段无效：结束时间必须晚于开始时间，且不支持跨夜。' };
  const lux = Number(values.actual_lux);
  if (!(lux > 0) || !Number.isFinite(lux)) return { values, error: '实测照度必须为正数（lux）。' };
  values.plan_id = Number(values.plan_id);
  values.actual_lux = lux;
  return { values, error: null };
}

function readLimitInput(body) {
  const values = {
    year: (body.year || '').trim(),
    max_dose: (body.max_dose || '').trim()
  };
  const year = Number(values.year);
  if (!Number.isInteger(year) || year < 1900 || year > 2999) {
    return { values, error: '年度无效（1900–2999）。' };
  }
  const maxDose = Number(values.max_dose);
  if (!(maxDose > 0) || !Number.isFinite(maxDose)) {
    return { values, error: '年度照度时数上限必须为正数（lux·h）。' };
  }
  values.year = year;
  values.max_dose = maxDose;
  return { values, error: null };
}

module.exports = { readPlanInput, readMeasurementInput, readLimitInput };
