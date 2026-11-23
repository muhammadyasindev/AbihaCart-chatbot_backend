const logger = require('../utils/logger');
const config = require('../config/env');

// Centralized error handling middleware
// eslint-disable-next-line no-unused-vars
const errorHandler = (err, req, res, next) => {
  const statusCode = err.statusCode || err.status || 500;
  const message = err.isOperational ? err.message : 'Internal Server Error';

  logger.error('Unhandled Application Error:', {
    message: err.message,
    statusCode,
    path: req.originalUrl,
    method: req.method,
    stack: config.env === 'development' ? err.stack : undefined,
  });

  const rawMessage = err.message || message;
  const sanitizedMessage = typeof rawMessage === 'string'
    ? rawMessage
        .replace(/sk-[a-zA-Z0-9_\-]{20,}/g, '[REDACTED_KEY]')
        .replace(/shpat_[a-zA-Z0-9]{20,}/g, '[REDACTED_TOKEN]')
        .replace(/mongodb(?:\+srv)?:\/\/[^\s]+/g, '[REDACTED_URI]')
    : 'An error occurred';

  res.status(statusCode).json({
    status: 'error',
    statusCode,
    message: config.env === 'production' && statusCode === 500
      ? 'An unexpected error occurred. Please try again later.'
      : (config.env === 'production' ? sanitizedMessage : err.message || message),
    ...(config.env === 'development' && { stack: err.stack }),
  });
};

module.exports = errorHandler;
