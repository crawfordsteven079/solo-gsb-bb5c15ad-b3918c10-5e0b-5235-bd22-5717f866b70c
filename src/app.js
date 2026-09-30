'use strict';

const path = require('path');
const express = require('express');
const session = require('express-session');
const pgSession = require('connect-pg-simple')(session);

const { pool } = require('./db');
const dose = require('./lib/dose');

const authRoutes = require('./routes/auth');
const exhibitRoutes = require('./routes/exhibits');
const planRoutes = require('./routes/plans');
const measurementRoutes = require('./routes/measurements');

function createApp() {
  const app = express();

  app.set('view engine', 'ejs');
  app.set('views', path.join(__dirname, 'views'));

  app.use(express.urlencoded({ extended: false }));

  app.use(session({
    store: new pgSession({
      pool,
      tableName: 'session',
      createTableIfMissing: false
    }),
    name: 'lightquota.sid',
    secret: process.env.SESSION_SECRET || 'dev-secret-change-me',
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      maxAge: 1000 * 60 * 60 * 8
    }
  }));

  // 简易 flash：req.flash('error', msg) / req.flash('error')
  app.use((req, res, next) => {
    req.flash = (type, msg) => {
      if (msg === undefined) {
        const list = req.session?.flash?.[type] || [];
        if (req.session?.flash) delete req.session.flash[type];
        return list;
      }
      req.session.flash = req.session.flash || {};
      (req.session.flash[type] = req.session.flash[type] || []).push(msg);
      return undefined;
    };
    next();
  });

  app.use((req, res, next) => {
    res.locals.currentUser = req.session.user || null;
    res.locals.errors = req.flash('error');
    res.locals.successes = req.flash('success');
    res.locals.fmt = (n) => {
      const num = Number(n);
      if (!Number.isFinite(num)) return '—';
      return dose.round2(num).toLocaleString('zh-CN', { maximumFractionDigits: 2 });
    };
    res.locals.roleName = (r) => (r === 'conservator' ? '保管员' : r === 'installer' ? '布展员' : r);
    next();
  });

  app.use(express.static(path.join(__dirname, 'public')));

  app.get('/', (req, res) => {
    if (!req.session.user) return res.redirect('/login');
    res.redirect('/exhibits');
  });

  app.use('/', authRoutes);
  app.use('/exhibits', exhibitRoutes);
  app.use('/plans', planRoutes);
  app.use('/measurements', measurementRoutes);

  app.use((req, res) => {
    res.status(404).render('error', { title: '页面不存在', message: '未找到请求的页面。' });
  });

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    console.error(err);
    res.status(500).render('error', { title: '服务器错误', message: err.message || '请稍后重试。' });
  });

  return app;
}

module.exports = { createApp };
