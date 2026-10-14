'use strict';

function errorMiddleware(err, _req, res, _next) {
  if (err.type === 'entity.too.large') {
    return res.status(413).json({ ok: false, error: 'Payload too large' });
  }

  const statusCode = Number.isInteger(err.statusCode) ? err.statusCode : 500;
  const message = err.expose === true || statusCode < 500 ? err.message : 'Internal Server Error';

  if (statusCode >= 500) {
    console.error('[monitor] 请求处理失败:', err);
  }

  return res.status(statusCode).json({ ok: false, error: message });
}

module.exports = { errorMiddleware };
