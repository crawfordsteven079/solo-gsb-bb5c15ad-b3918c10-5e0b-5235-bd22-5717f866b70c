'use strict';

const express = require('express');
const { pool, withTransaction } = require('../db');
const dose = require('../lib/dose');
const { requireLogin, requireRole } = require('../middleware/auth');
const { readMeasurementInput } = require('../lib/validation');

const router = express.Router();
router.use(requireLogin);

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// 录入实测表单（仅保管员；基于一个已批准/待复核计划录入）
router.get('/new', requireRole('conservator'), async (req, res, next) => {
  try {
    const planId = Number(req.query.plan_id || 0);
    const { rows: plans } = await pool.query(
      `SELECT p.*, e.code AS exhibit_code, e.title AS exhibit_title
         FROM plans p JOIN exhibits e ON e.id = p.exhibit_id
        WHERE p.status IN ('approved', 'pending_review')
        ORDER BY p.start_date DESC, p.id DESC`
    );
    const selected = plans.find((p) => p.id === planId) || null;
    res.render('measurements/new', {
      plans,
      selected,
      values: {
        plan_id: planId || '',
        measured_on: '',
        start_time: selected ? selected.lights_on.slice(0, 5) : '09:00',
        end_time: selected ? selected.lights_off.slice(0, 5) : '17:00',
        actual_lux: '',
        note: ''
      }
    });
  } catch (err) {
    next(err);
  }
});

// 保存“待确认”实测（尚不影响额度）
router.post('/', requireRole('conservator'), async (req, res, next) => {
  try {
    const { values, error } = readMeasurementInput(req.body);
    if (error) {
      req.flash('error', error);
      return res.status(400).redirect(`/measurements/new?plan_id=${values.plan_id || ''}`);
    }
    const { rows: planRows } = await pool.query(
      `SELECT * FROM plans WHERE id = $1 AND status IN ('approved', 'pending_review')`,
      [values.plan_id]
    );
    const plan = planRows[0];
    if (!plan) {
      req.flash('error', '只能针对已批准（含待复核）的计划录入实测。');
      return res.status(400).redirect('/measurements/new');
    }
    const candidate = {
      measured_on: values.measured_on,
      start_time: values.start_time,
      end_time: values.end_time,
      actual_lux: values.actual_lux
    };
    if (!dose.measurementWithinPlan(candidate, plan)) {
      req.flash('error', '实测时段必须落在计划展出日期的每日开灯时段内。');
      return res.status(400).redirect(`/measurements/new?plan_id=${plan.id}`);
    }
    const { rows } = await pool.query(
      `INSERT INTO measurements
         (exhibit_id, plan_id, measured_on, start_time, end_time, actual_lux, note, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
      [plan.exhibit_id, plan.id, values.measured_on, values.start_time, values.end_time,
        values.actual_lux, values.note || null, req.session.user.id]
    );
    req.flash('success', `实测记录 #${rows[0].id} 已保存，确认前不影响额度。`);
    res.redirect(`/plans/${plan.id}`);
  } catch (err) {
    next(err);
  }
});

// 确认实测：以实测替代估算；重叠实测拒绝；超限则级联“未开始”计划为待复核
router.post('/:id/confirm', requireRole('conservator'), async (req, res) => {
  const id = Number(req.params.id);
  let redirectTo = `/plans`;
  try {
    const result = await withTransaction(async (client) => {
      // 1. 读取并锁定实测
      const { rows: mRows } = await client.query(
        'SELECT * FROM measurements WHERE id = $1 FOR UPDATE',
        [id]
      );
      if (!mRows[0]) throw new HttpError(404, '实测记录不存在。');
      const m = mRows[0];
      redirectTo = `/plans/${m.plan_id}`;
      if (m.status === 'confirmed') throw new HttpError(409, '该实测已确认。');

      // 2. 锁定展品审批锁，与计划审批互斥
      await client.query(
        `INSERT INTO exhibit_lock (exhibit_id) VALUES ($1) ON CONFLICT DO NOTHING`,
        [m.exhibit_id]
      );
      const { rows: lockRows } = await client.query(
        'SELECT exhibit_id FROM exhibit_lock WHERE exhibit_id = $1 FOR UPDATE',
        [m.exhibit_id]
      );
      if (!lockRows.length) throw new HttpError(409, '展品状态异常，缺少审批锁。');

      // 3. 锁定计划并复核时段合法性
      const { rows: pRows } = await client.query(
        'SELECT * FROM plans WHERE id = $1 FOR UPDATE',
        [m.plan_id]
      );
      const plan = pRows[0];
      if (!plan || !['approved', 'pending_review'].includes(plan.status)) {
        throw new HttpError(409, '所属计划已不在批准状态，不能确认实测。');
      }
      if (!dose.measurementWithinPlan(m, plan)) {
        throw new HttpError(400, '实测时段不在该计划展出日期的每日开灯时段内。');
      }

      // 4. 与同展品其他已确认实测做时间重叠检查（端点接触允许）
      const { rows: confirmed } = await client.query(
        `SELECT * FROM measurements
          WHERE exhibit_id = $1 AND status = 'confirmed'
          ORDER BY measured_on, start_time`,
        [m.exhibit_id]
      );
      for (const other of confirmed) {
        if (dose.measurementsOverlap(m, other)) {
          throw new HttpError(409,
            `与已确认实测 #${other.id}（${other.measured_on} ${other.start_time.slice(0, 5)}–${other.end_time.slice(0, 5)}，计划 #${other.plan_id}）时间重叠，已拒绝。`);
        }
      }

      // 5. 确认实测
      await client.query(
        `UPDATE measurements
            SET status = 'confirmed', confirmed_by = $2, confirmed_at = now()
          WHERE id = $1`,
        [id, req.session.user.id]
      );
      const confirmedNow = [...confirmed, { ...m, status: 'confirmed' }];

      // 6. 重新汇总各年度剂量（生效计划：已批准 + 待复核）
      const { rows: activePlans } = await client.query(
        `SELECT * FROM plans WHERE exhibit_id = $1 AND status IN ('approved', 'pending_review') FOR UPDATE`,
        [m.exhibit_id]
      );
      const { rows: limitRows } = await client.query(
        'SELECT year, max_dose FROM annual_limits WHERE exhibit_id = $1',
        [m.exhibit_id]
      );
      const limits = new Map(limitRows.map((l) => [l.year, Number(l.max_dose)]));
      const summary = dose.summarizeByYear(activePlans, confirmedNow);

      const exceededYears = [];
      for (const y of summary.years) {
        const limit = limits.get(y.year);
        if (limit !== undefined && y.total > limit + 1e-9) {
          exceededYears.push({ year: y.year, total: y.total, limit, excess: y.total - limit });
        }
      }

      // 7. 超限级联：相应年度中“尚未开始”的已批准计划转待复核（保留审批与测量记录）
      let cascaded = [];
      if (exceededYears.length) {
        const today = new Date();
        const todayISO = dose.dateISO(today);
        const impactedIds = [];
        for (const y of exceededYears) {
          const yearStart = `${y.year}-01-01`;
          const yearEnd = `${y.year}-12-31`;
          const { rows: futurePlans } = await client.query(
            `SELECT id FROM plans
              WHERE exhibit_id = $1
                AND status = 'approved'
                AND start_date > $2
                AND start_date <= $3
                AND end_date >= $4`,
            [m.exhibit_id, todayISO, yearEnd, yearStart]
          );
          for (const fp of futurePlans) {
            if (!impactedIds.includes(fp.id) && fp.id !== m.plan_id) impactedIds.push(fp.id);
          }
        }
        if (impactedIds.length) {
          const reason = exceededYears
            .map((y) => `${y.year} 年因迟到实测确认后合计 ${dose.round2(y.total)} lux·h，超出上限 ${dose.round2(y.limit)} lux·h，超额 ${dose.round2(y.excess)} lux·h，需复核。`)
            .join('；');
          const { rows: upd } = await client.query(
            `UPDATE plans SET status = 'pending_review', review_reason = $2
              WHERE id = ANY ($1) RETURNING id`,
            [impactedIds, reason]
          );
          cascaded = upd.map((r) => r.id);
        }
      }

      return { exceededYears, cascaded };
    });

    if (result.exceededYears.length) {
      const detail = result.exceededYears
        .map((y) => `${y.year} 年合计 ${dose.round2(y.total)} lux·h，上限 ${dose.round2(y.limit)} lux·h，超额 ${dose.round2(y.excess)} lux·h`)
        .join('；');
      const tail = result.cascaded.length
        ? ` 未开始的计划 #${result.cascaded.join('、#')} 已转为待复核。`
        : ' 当前无未开始计划需要级联。';
      req.flash('error', `实测 #${id} 已确认，但超限：${detail}.${tail}`);
    } else {
      req.flash('success', `实测 #${id} 已确认，该时段以实测剂量替代估算。`);
    }
  } catch (err) {
    if (err instanceof HttpError) {
      req.flash('error', err.message);
      return res.status(err.status).redirect(redirectTo);
    }
    console.error(err);
    req.flash('error', '确认处理失败，请重试。');
  }
  res.redirect(redirectTo);
});

// 删除未确认的录入
router.post('/:id/delete', requireRole('conservator'), async (req, res) => {
  const id = Number(req.params.id);
  let redirectTo = '/plans';
  try {
    const { rows } = await pool.query(
      'DELETE FROM measurements WHERE id = $1 AND status = $2 RETURNING plan_id',
      [id, 'recorded']
    );
    if (!rows.length) {
      req.flash('error', '只有尚未确认的实测记录可以删除。');
    } else {
      redirectTo = `/plans/${rows[0].plan_id}`;
      req.flash('success', `未确认实测 #${id} 已删除。`);
    }
  } catch (err) {
    console.error(err);
    req.flash('error', '删除失败，请重试。');
  }
  res.redirect(redirectTo);
});

module.exports = router;
