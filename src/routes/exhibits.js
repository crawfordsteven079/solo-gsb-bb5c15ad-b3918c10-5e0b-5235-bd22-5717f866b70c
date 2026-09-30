'use strict';

const express = require('express');
const { pool } = require('../db');
const dose = require('../lib/dose');
const { requireLogin, requireRole } = require('../middleware/auth');
const { readLimitInput } = require('../lib/validation');

const router = express.Router();
router.use(requireLogin);

// 展品列表（概览各年剩余额度）
router.get('/', async (req, res, next) => {
  try {
    const { rows: exhibits } = await pool.query(
      `SELECT e.*, u.display_name AS creator_name
         FROM exhibits e LEFT JOIN users u ON u.id = e.created_by
        ORDER BY e.code`
    );
    const { rows: limits } = await pool.query(
      'SELECT exhibit_id, year, max_dose FROM annual_limits ORDER BY year'
    );
    const limitMap = new Map(limits.map((l) => [`${l.exhibit_id}:${l.year}`, Number(l.max_dose)]));

    const { rows: plans } = await pool.query(
      `SELECT * FROM plans WHERE status IN ('approved', 'pending_review')`
    );
    const { rows: measurements } = await pool.query(
      `SELECT * FROM measurements WHERE status = 'confirmed'`
    );

    const overview = exhibits.map((e) => {
      const ps = plans.filter((p) => p.exhibit_id === e.id);
      const ms = measurements.filter((m) => m.exhibit_id === e.id);
      const summary = dose.summarizeByYear(ps, ms);
      const years = summary.years.map((y) => ({
        year: y.year,
        used: y.total,
        limit: limitMap.get(`${e.id}:${y.year}`) ?? null,
        remaining: (limitMap.get(`${e.id}:${y.year}`) ?? 0) - y.total
      }));
      const over = years.filter((y) => y.limit !== null && y.total > y.limit);
      return { ...e, years, overCount: over.length };
    });

    res.render('exhibits/index', { exhibits: overview });
  } catch (err) {
    next(err);
  }
});

// 新建展品表单
router.get('/new', requireRole('conservator'), (req, res) => {
  res.render('exhibits/new', { values: { code: '', title: '', medium: '' } });
});

router.post('/', requireRole('conservator'), async (req, res, next) => {
  try {
    const values = {
      code: (req.body.code || '').trim(),
      title: (req.body.title || '').trim(),
      medium: (req.body.medium || '').trim()
    };
    if (!values.code || !values.title) {
      req.flash('error', '展品编号与名称为必填项。');
      return res.status(400).render('exhibits/new', { values });
    }
    try {
      const { rows } = await pool.query(
        `INSERT INTO exhibits (code, title, medium, created_by)
         VALUES ($1, $2, $3, $4) RETURNING id`,
        [values.code, values.title, values.medium, req.session.user.id]
      );
      await pool.query(
        `INSERT INTO exhibit_lock (exhibit_id) VALUES ($1) ON CONFLICT DO NOTHING`,
        [rows[0].id]
      );
      req.flash('success', `展品“${values.title}”已登记。`);
      res.redirect(`/exhibits/${rows[0].id}`);
    } catch (e) {
      if (e.code === '23505') {
        req.flash('error', '展品编号已存在。');
        return res.status(409).render('exhibits/new', { values });
      }
      throw e;
    }
  } catch (err) {
    next(err);
  }
});

// 展品详情：各年额度、剩余、占用来源
router.get('/:id', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const { rows } = await pool.query(
      `SELECT e.*, u.display_name AS creator_name
         FROM exhibits e LEFT JOIN users u ON u.id = e.created_by
        WHERE e.id = $1`,
      [id]
    );
    if (!rows[0]) {
      req.flash('error', '展品不存在。');
      return res.redirect('/exhibits');
    }
    const exhibit = rows[0];

    const { rows: limits } = await pool.query(
      'SELECT * FROM annual_limits WHERE exhibit_id = $1 ORDER BY year',
      [id]
    );
    const limitMap = new Map(limits.map((l) => [l.year, Number(l.max_dose)]));

    const { rows: plans } = await pool.query(
      `SELECT p.*, u.display_name AS creator_name, a.display_name AS approver_name
         FROM plans p
         LEFT JOIN users u ON u.id = p.created_by
         LEFT JOIN users a ON a.id = p.approved_by
        WHERE p.exhibit_id = $1
        ORDER BY p.created_at DESC`,
      [id]
    );
    for (const p of plans) {
      p.doseRows = dose.planDoseByYear(p) || [];
    }
    const activePlans = plans.filter((p) => ['approved', 'pending_review'].includes(p.status));

    const { rows: measurements } = await pool.query(
      `SELECT m.*, u.display_name AS creator_name, c.display_name AS confirmer_name
         FROM measurements m
         LEFT JOIN users u ON u.id = m.created_by
         LEFT JOIN users c ON c.id = m.confirmed_by
        WHERE m.exhibit_id = $1
        ORDER BY m.measured_on DESC, m.start_time DESC`,
      [id]
    );

    const summary = dose.summarizeByYear(activePlans, measurements.filter((m) => m.status === 'confirmed'));
    const years = summary.years.map((y) => ({
      ...y,
      limit: limitMap.get(y.year) ?? null,
      remaining: (limitMap.get(y.year) ?? 0) - y.total
    }));
    // 登记了上限但暂无占用的年份也要展示
    for (const [year, maxDose] of limitMap) {
      if (!years.some((y) => y.year === year)) {
        years.push({ year, measured: 0, estimatedRemaining: 0, total: 0, limit: maxDose, remaining: maxDose, sources: [] });
      }
    }
    years.sort((a, b) => a.year - b.year);

    const today = dose.dateISO(new Date());

    res.render('exhibits/show', { exhibit, limits, plans, measurements, years, today });
  } catch (err) {
    next(err);
  }
});

// 设置/更新年度照度时数上限
router.post('/:id/limits', requireRole('conservator'), async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const { values, error } = readLimitInput(req.body);
    if (error) {
      req.flash('error', error);
      return res.status(400).redirect(`/exhibits/${id}`);
    }
    const exists = await pool.query('SELECT 1 FROM exhibits WHERE id = $1', [id]);
    if (!exists.rowCount) {
      req.flash('error', '展品不存在。');
      return res.redirect('/exhibits');
    }
    await pool.query(
      `INSERT INTO annual_limits (exhibit_id, year, max_dose, updated_by, updated_at)
       VALUES ($1, $2, $3, $4, now())
       ON CONFLICT (exhibit_id, year)
       DO UPDATE SET max_dose = $3, updated_by = $4, updated_at = now()`,
      [id, values.year, values.max_dose, req.session.user.id]
    );
    req.flash('success', `${values.year} 年度上限已保存为 ${dose.round2(values.max_dose)} lux·h。`);
    res.redirect(`/exhibits/${id}`);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
