const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const path = require('path');
const fs = require('fs');
const logger = require('./utils/logger');
const config = require('./config/env');
const errorHandler = require('./middleware/errorHandler');
const healthRoutes = require('./routes/health.routes');
const shopifyRoutes = require('./routes/shopify.routes');
const webhookRoutes = require('./routes/webhook.routes');
const chatRoutes = require('./routes/chat.routes');
const orderRoutes = require('./routes/order.routes');
const whatsappRoutes = require('./routes/whatsapp.routes');
const adminRoutes = require('./routes/admin.routes');
const { apiLimiter } = require('./middleware/rateLimiter');

const app = express();

// Security HTTP headers
app.use(helmet({
  crossOriginResourcePolicy: { policy: 'cross-origin' },
}));

// CORS configuration - restricted to approved storefront, Vercel frontend, and admin origins
const allowedOrigins = [
  'https://abihacart.myshopify.com',
  'https://admin.shopify.com',
  config.urls.frontendUrl,
  ...(config.urls.allowedOrigins || []),
].filter(Boolean);

if (config.env === 'development' || config.env === 'test') {
  allowedOrigins.push('http://localhost:3000', 'http://localhost:5000', 'http://127.0.0.1:5000', 'http://127.0.0.1:3000');
}

app.use(cors({
  origin: (origin, callback) => {
    // Allow requests with no origin (e.g. mobile apps, curl, server-to-server)
    if (!origin) return callback(null, true);
    const isAllowed = allowedOrigins.includes(origin) ||
      config.env === 'development' ||
      config.env === 'test' ||
      (origin.endsWith('.myshopify.com') && origin.startsWith('https://')) ||
      (origin.endsWith('.vercel.app') && origin.startsWith('https://'));

    if (isAllowed) {
      return callback(null, true);
    }
    logger.warn(`Blocked CORS request from unauthorized origin: ${origin}`);
    return callback(new Error('Origin not allowed by CORS'));
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'X-Shopify-Hmac-Sha256', 'X-Conversation-Token', 'X-Agent-Key', 'X-Admin-Key'],
}));

// Request body parsers (Captures raw body buffer for Shopify webhook HMAC verification)
app.use(express.json({
  limit: '2mb',
  verify: (req, res, buf) => {
    req.rawBody = buf;
  },
}));
app.use(express.urlencoded({ extended: true, limit: '2mb' }));

// Structured HTTP request logger
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    const duration = Date.now() - start;
    logger.info(`${req.method} ${req.originalUrl} ${res.statusCode} - ${duration}ms`, {
      ip: req.ip,
      userAgent: req.get('user-agent'),
    });
  });
  next();
});

// Root ping
app.get('/', (req, res) => {
  res.json({
    message: 'Abihacart AI Customer Support API is operational',
    store: config.shopify.shop,
    health: '/api/health',
  });
});

// Health check route (unlimited/high limit)
app.use('/api', healthRoutes);

// Shopify OAuth and Admin API integration routes
app.use('/api/shopify', shopifyRoutes);

// Customer storefront chat routes
app.use('/api/chat', chatRoutes);

// Customer order tracking & confirmation routes (Read-only, dual-factor verified)
app.use('/api/orders', orderRoutes);

// Meta WhatsApp Business Cloud API routes
app.use('/api/whatsapp', whatsappRoutes);

// Admin Dashboard Cockpit API routes (Protected by role-based auth & rate limiting)
app.use('/api/admin', adminRoutes);

// Static assets for Admin Dashboard and Customer Storefront Widget
const adminStaticPath = fs.existsSync(path.resolve(__dirname, '../../frontend/admin-dashboard'))
  ? path.resolve(__dirname, '../../frontend/admin-dashboard')
  : path.resolve(__dirname, '../../admin-dashboard');

const widgetStaticPath = fs.existsSync(path.resolve(__dirname, '../../frontend/storefront-widget'))
  ? path.resolve(__dirname, '../../frontend/storefront-widget')
  : path.resolve(__dirname, '../../storefront-widget');

app.use('/admin', express.static(adminStaticPath));
app.use('/widget', express.static(widgetStaticPath));

// Webhook ingress routes (Shopify HMAC verified, exempted from general API limiter)
app.use('/api/webhooks', webhookRoutes);

// Apply general API rate limiting to other /api endpoints
app.use('/api', apiLimiter);

// 404 Handler
app.use((req, res) => {
  res.status(404).json({
    status: 'fail',
    statusCode: 404,
    error: 'Not Found',
    message: `Cannot ${req.method} ${req.originalUrl}`,
  });
});

// Centralized error handler
app.use(errorHandler);

module.exports = app;
