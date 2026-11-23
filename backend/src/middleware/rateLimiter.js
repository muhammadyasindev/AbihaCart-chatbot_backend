const rateLimit = require('express-rate-limit');

// Standard API rate limiter: 100 requests per 15 minutes per IP
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    status: 429,
    error: 'Too Many Requests',
    message: 'Too many requests from this IP. Please try again after 15 minutes.',
  },
});

// Chat widget rate limiter: 30 messages per 5 minutes per session/IP
const chatLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    status: 429,
    error: 'Rate Limit Exceeded',
    message: 'You are sending messages too quickly. Please pause for a moment.',
  },
});

// Health check rate limiter: 60 requests per minute
const healthLimiter = rateLimit({
  windowMs: 1 * 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
});

// Order tracking rate limiter: 15 requests per 15 minutes per IP to prevent brute-force order enumeration
const orderTrackingLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 15,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    status: 429,
    error: 'Too Many Requests',
    message: 'Too many order tracking attempts from this IP. Please wait 15 minutes before trying again.',
  },
});

// WhatsApp Webhook rate limiter: 120 requests per minute
const whatsappWebhookLimiter = rateLimit({
  windowMs: 1 * 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
});

// Human agent reply rate limiter: 60 replies per 5 minutes per agent
const agentReplyLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
});

// Admin login rate limiter: 10 attempts per 15 minutes per IP to prevent brute-force attacks
const adminLoginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    status: 429,
    error: 'Too Many Requests',
    code: 'LOGIN_RATE_LIMIT_EXCEEDED',
    message: 'Too many login attempts from this IP. Please wait 15 minutes before trying again.',
  },
});

// Admin authenticated API limiter: 300 requests per 15 minutes
const adminApiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
});

module.exports = {
  apiLimiter,
  chatLimiter,
  healthLimiter,
  orderTrackingLimiter,
  whatsappWebhookLimiter,
  agentReplyLimiter,
  adminLoginLimiter,
  adminApiLimiter,
};
