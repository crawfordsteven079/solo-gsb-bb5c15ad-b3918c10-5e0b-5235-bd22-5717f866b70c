'use strict';

const express = require('express');
const { pool, withTransaction } = require('../db');
const dose = require('../lib/dose');
const { requireLogin, requireRole } = require('../middleware/auth');
const { readPlanInput } = require('../lib/validation');

const router = express.Router();
router.use(requireLogin);

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// 计划列表（审批视图：保管员看全部待办；布展员看自己的提交）
router.get('/', async (req, res, next) => {
  try {
    const isConservator = req.session.user.role === 'conservator';
    const params = [];
    let where = '';
    if (!isConservator) {
      params.push(req.session.user.id);
      where = 'WHERE p.created_by = $1';
    }
    const { rows: plans } = await pool.query(
      `SELECT p.*, e.code AS exhibit_code, e.title AS exhibit_title,
              u.display_name AS creator_name
         FROM plans p
         JOIN exhibits e ON e.id = p.exhibit_id
         LEFT JOIN users u ON u.id = p.created_by
         ${where}
         ORDER BY
           CASE p.status WHEN 'pending' THEN 0 WHEN 'pending_review' THEN 1 ELSE 2 END,
           p.created_at DESC`,
      params
    );
    for (const p of plans) p.doseRows = dose.planDoseByYear(p) || [];
    res.render('plans/index', { plans, isConservator });
  } catch (err) {
    next(err);
  }
});

// 新建计划表单
router.get('/new', requireRole('installer'), async (req, res, next) => {
  try {
    const { rows } = await pool.query('SELECT id, code, title FROM exhibits ORDER BY code');
    res.render('plans/new', { exhibits: rows, values: { exhibit_id: req.query.exhibit_id || '', start_date: '', end_date: '', lights_on: '09:00', lights_off: '17:00', estimated_lux: '' } });
  } catch (err) {
    next(err);
  }
});

// 提交计划：先做基础格式校验，暂不占用额度（待保管员批准）
router.post('/', requireRole('installer'), async (req, res, next) => {
  try {
    const { values, error } = readPlanInput(req.body);
    const { rows: exhibits } = await pool.query('SELECT id, code, title FROM exhibits ORDER BY code');
    if (error) {
      req.flash('error', error);
      return res.status(400).render('plans/new', { exhibits, values });
    }
    const ex = await pool.query('SELECT 1 FROM exhibits WHERE id = $1', [values.exhibit_id]);
    if (!ex.rowCount) {
      req.flash('error', '所选展品不存在。');
      return res.status(400).render('plans/new', { exhibits, values });
    }
    const { rows } = await pool.query(
      `INSERT INTO plans (exhibit_id, created_by, start_date, end_date, lights_on, lights_off, estimated_lux)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
      [values.exhibit_id, req.session.user.id, values.start_date, values.end_date,
        values.lights_on, values.lights_off, values.estimated_lux]
    );
    req.flash('success', `计划 #${rows[0].id} 已提交，等待保管员审批。`);
    res.redirect(`/plans/${rows[0].id}`);
  } catch (err) {
    next(err);
  }
});

// 计划详情
router.get('/:id', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const { rows } = await pool.query(
      `SELECT p.*, e.code AS exhibit_code, e.title AS exhibit_title,
              u.display_name AS creator_name, a.display_name AS approver_name
         FROM plans p
         JOIN exhibits e ON e.id = p.exhibit_id
         LEFT JOIN users u ON u.id = p.created_by
         LEFT JOIN users a ON a.id = p.approved_by
        WHERE p.id = $1`,
      [id]
    );
    if (!rows[0]) {
      req.flash('error', '计划不存在。');
      return res.redirect('/plans');
    }
    const plan = rows[0];
    plan.doseRows = dose.planDoseByYear(plan) || [];

    const { rows: limits } = await pool.query(
      'SELECT year, max_dose FROM annual_limits WHERE exhibit_id = $1 ORDER BY year',
      [plan.exhibit_id]
    );
    const { rows: measurements } = await pool.query(
      `SELECT m.*, u.display_name AS creator_name, c.display_name AS confirmer_name
         FROM measurements m
         LEFT JOIN users u ON u.id = m.created_by
         LEFT JOIN users c ON c.id = m.confirmed_by
        WHERE m.plan_id = $1
        ORDER BY m.measured_on DESC, m.start_time DESC`,
      [id]
    );

    // 试算所需：同展品其他生效计划 + 该展品全部已确认实测
    const { rows: otherPlans } = await pool.query(
      `SELECT * FROM plans
        WHERE exhibit_id = $1 AND id <> $2 AND status IN ('approved', 'pending_review')`,
      [plan.exhibit_id, id]
    );
    const { rows: confirmedAll } = await pool.query(
      `SELECT * FROM measurements WHERE exhibit_id = $1 AND status = 'confirmed'`,
      [plan.exhibit_id]
    );
    const preview = computeApprovalCheck(plan, limits, otherPlans, confirmedAll);

    res.render('plans/show', { plan, limits, measurements, preview });
  } catch (err) {
    next(err);
  }
});

// 纯函数：在给定限额、其他生效计划、已确认实测下，判断 plan 是否可批准。
// otherPlans 不含 plan 自身；confirmedMeasurementsAll 为同展品全部已确认实测。
// 待复核计划重新批准时，其自身已确认实测已计入现状，新增部分只取尚未被实测替代的估算。
function computeApprovalCheck(plan, limitRows, otherPlans, confirmedMeasurementsAll) {
  const limits = new Map(limitRows.map((l) => [l.year, Number(l.max_dose)]));
  const planEstimateByYear = new Map((dose.planDoseByYear(plan) || []).map((r) => [r.year, r.dose]));

  // 该计划已被自身实测替代掉的估算（按年）
  const selfReplaced = new Map();
  for (const m of confirmedMeasurementsAll) {
    if (m.plan_id !== plan.id) continue;
    for (const r of dose.replacedEstimatedByYear(m, plan)) {
      selfReplaced.set(r.year, (selfReplaced.get(r.year) || 0) + r.dose);
    }
  }
  const targetByYear = new Map();
  for (const [year, est] of planEstimateByYear) {
    targetByYear.set(year, Math.max(0, est - (selfReplaced.get(year) || 0)));
  }

  const problems = [];
  const activeOthers = otherPlans.filter((p) => ['approved', 'pending_review'].includes(p.status));
  for (const other of activeOthers) {
    if (dose.plansOverlap(plan, other)) {
      problems.push(`与${other.status === 'pending_review' ? '待复核' : '已批准'}计划 #${other.id}（${other.start_date} 至 ${other.end_date}，每日 ${other.lights_on.slice(0, 5)}–${other.lights_off.slice(0, 5)}）时间重叠，不得批准。`);
    }
  }

  const summary = dose.summarizeByYear(activeOthers, confirmedMeasurementsAll);
  const usageByYear = new Map(summary.years.map((y) => [y.year, y]));

  const yearRows = [];
  for (const [year, addDose] of targetByYear) {
    const limit = limits.get(year);
    const current = usageByYear.get(year)?.total || 0;
    const projected = current + addDose;
    if (limit === undefined) {
      problems.push(`${year} 年尚未登记照度时数上限，无法批准，请先由保管员登记。`);
    } else if (projected > limit + 1e-9) {
      problems.push(`${year} 年合计 ${dose.round2(projected)} lux·h，超过上限 ${dose.round2(limit)} lux·h，超额 ${dose.round2(projected - limit)} lux·h。`);
    }
    yearRows.push({ year, limit: limit ?? null, current, addDose, projected, excess: limit !== undefined ? Math.max(0, projected - limit) : null });
  }
  return { ok: problems.length === 0, problems, yearRows };
}

// 批准计划（事务 + 行锁，串行化同展品并发审批，杜绝超配）
router.post('/:id/approve', requireRole('conservator'), async (req, res) => {
  const id = Number(req.params.id);
  try {
    await withTransaction(async (client) => {
      // 1. 锁定该展品的审批串行锁
      await client.query(
        `INSERT INTO exhibit_lock (exhibit_id)
         SELECT id FROM exhibits WHERE id = (SELECT exhibit_id FROM plans WHERE id = $1)
         ON CONFLICT DO NOTHING`,
        [id]
      );
      await client.query('SELECT exhibit_id FROM exhibit_lock WHERE exhibit_id = (SELECT exhibit_id FROM plans WHERE id = $1) FOR UPDATE', [id]);

      // 2. 锁定并读取目标计划
      const { rows: planRows } = await client.query('SELECT * FROM plans WHERE id = $1 FOR UPDATE', [id]);
      if (!planRows[0]) throw new HttpError(404, '计划不存在。');
      const plan = planRows[0];
      if (plan.status !== 'pending' && plan.status !== 'pending_review') {
        throw new HttpError(409, `当前状态为 ${plan.status}，不能批准。`);
      }

      // 3. 读取其他生效计划（已批准、待复核）
      const { rows: others } = await client.query(
        `SELECT * FROM plans
          WHERE exhibit_id = $1 AND id <> $2
            AND status IN ('approved', 'pending_review')`,
        [plan.exhibit_id, id]
      );

      // 4. 该展品全部已确认实测
      const { rows: confirmed } = await client.query(
        `SELECT * FROM measurements WHERE exhibit_id = $1 AND status = 'confirmed'`,
        [plan.exhibit_id]
      );

      // 5. 年度上限
      const { rows: limits } = await client.query(
        'SELECT year, max_dose FROM annual_limits WHERE exhibit_id = $1',
        [plan.exhibit_id]
      );

      const check = computeApprovalCheck(plan, limits, others, confirmed);
      if (!check.ok) {
        throw new HttpError(409, check.problems.join('\n'));
      }

      await client.query(
        `UPDATE plans
            SET status = 'approved', approved_by = $2, approved_at = now(),
                review_reason = NULL
          WHERE id = $1`,
        [id, req.session.user.id]
      );
    });
    req.flash('success', `计划 #${id} 已批准。`);
  } catch (err) {
    if (err instanceof HttpError) {
      req.flash('error', err.message);
      return res.status(err.status).redirect(`/plans/${id}`);
    }
    console.error(err);
    req.flash('error', '审批处理失败，请重试。');
  }
  res.redirect(`/plans/${id}`);
});

// 拒绝计划
router.post('/:id/reject', requireRole('conservator'), async (req, res) => {
  const id = Number(req.params.id);
  const reason = (req.body.reason || '').trim();
  try {
    const { rows } = await pool.query(
      `UPDATE plans SET status = 'rejected', review_reason = $2
        WHERE id = $1 AND status IN ('pending', 'pending_review') RETURNING id`,
      [id, reason || null]
    );
    if (!rows.length) {
      req.flash('error', '只有待审批或待复核的计划可以拒绝。');
    } else {
      req.flash('success', `计划 #${id} 已拒绝。`);
    }
  } catch (err) {
    console.error(err);
    req.flash('error', '操作失败，请重试。');
  }
  res.redirect(`/plans/${id}`);
});

// 布展员撤销自己尚未审批的计划
router.post('/:id/cancel', requireRole('installer'), async (req, res) => {
  const id = Number(req.params.id);
  try {
    const { rows } = await pool.query(
      `UPDATE plans SET status = 'rejected', review_reason = '提交人撤销'
        WHERE id = $1 AND created_by = $2 AND status = 'pending' RETURNING exhibit_id`,
      [id, req.session.user.id]
    );
    if (!rows.length) {
      req.flash('error', '只有自己提交的、待审批计划可以撤销。');
      return res.redirect(`/plans/${id}`);
    }
    req.flash('success', `计划 #${id} 已撤销。`);
    res.redirect(`/exhibits/${rows[0].exhibit_id}`);
  } catch (err) {
    console.error(err);
    req.flash('error', '操作失败，请重试。');
    res.redirect(`/plans/${id}`);
  }
});

module.exports = router;
module.exports.computeApprovalCheck = computeApprovalCheck;
