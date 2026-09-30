'use strict';

// 认证与角色权限
function requireLogin(req, res, next) {
  if (req.session && req.session.user) return next();
  req.session.returnTo = req.originalUrl;
  req.flash('error', '请先登录。');
  return res.redirect('/login');
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.session.user) return res.redirect('/login');
    if (!roles.includes(req.session.user.role)) {
      req.flash('error', '当前账号无权执行该操作。');
      return res.status(403).redirect('/');
    }
    next();
  };
}

module.exports = { requireLogin, requireRole };
