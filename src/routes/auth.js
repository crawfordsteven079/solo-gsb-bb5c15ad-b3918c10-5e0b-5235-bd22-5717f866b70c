'use strict';

const express = require('express');
const bcrypt = require('bcryptjs');
const { pool } = require('../db');

const router = express.Router();

router.get('/login', (req, res) => {
  if (req.session.user) return res.redirect('/');
  res.render('login', { username: '' });
});

router.post('/login', async (req, res, next) => {
  try {
    const username = (req.body.username || '').trim();
    const password = req.body.password || '';
    const { rows } = await pool.query(
      'SELECT id, username, display_name, password_hash, role FROM users WHERE username = $1',
      [username]
    );
    const user = rows[0];
    if (!user || !(await bcrypt.compare(password, user.password_hash))) {
      req.flash('error', '用户名或密码错误。');
      return res.status(401).render('login', { username });
    }
    req.session.user = {
      id: user.id,
      username: user.username,
      display_name: user.display_name,
      role: user.role
    };
    const target = req.session.returnTo || '/';
    delete req.session.returnTo;
    res.redirect(target);
  } catch (err) {
    next(err);
  }
});

router.post('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/login'));
});

module.exports = router;
