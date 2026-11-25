const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const path = require('path');
const fs = require('fs');
const logger = require('./utils/logger');
const config = require('./config/env');
const errorHandler = require('./middleware/errorHandler');
const { isValidShopDomain, sanitizeShopDomain } = require('./utils/shopifyAuth');
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

// CORS configuration - restricted to approved storefront, Vercel frontend, admin origins,
// and Shopify Checkout/Extension origins strictly on customer-facing order confirmation endpoints
const allowedOrigins = [
  'https://abihacart.myshopify.com',
  'https://admin.shopify.com',
  config.urls.frontendUrl,
  ...(config.urls.allowedOrigins || []),
].filter(Boolean);

const shopifyCustomerCheckoutOrigins = [
  'https://extensions.shopifycdn.com',
  'https://shopify.com',
  'https://checkout.shopify.com',
  'https://shop.app',
];

const customerOrderConfirmationCorsPaths = new Set([
  '/api/orders/checkout-confirmation-status',
  '/api/orders/confirm-shopify-order',
  '/api/orders/cancel-shopify-order',
]);

if (config.env === 'development' || config.env === 'test') {
  allowedOrigins.push('http://localhost:3000', 'http://localhost:5000', 'http://127.0.0.1:5000', 'http://127.0.0.1:3000');
}

const isStandardAllowedOrigin = (origin) => (
  allowedOrigins.includes(origin) ||
  config.env === 'development' ||
  (origin.endsWith('.myshopify.com') && origin.startsWith('https://')) ||
  (origin.endsWith('.vercel.app') && origin.startsWith('https://'))
);

app.use(cors((req, callback) => {
  const origin = req.headers.origin;
  const normalizedPath = (req.path || '/').replace(/\/+$/, '') || '/';
  const isCustomerOrderEndpoint = customerOrderConfirmationCorsPaths.has(normalizedPath);

  const corsBaseOptions = {
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'X-Shopify-Hmac-Sha256', 'X-Conversation-Token', 'X-Agent-Key', 'X-Admin-Key'],
    optionsSuccessStatus: 204,
  };

  // Allow requests with no Origin header (e.g. mobile apps, curl, server-to-server)
  if (!origin) {
    return callback(null, { ...corsBaseOptions, origin: true, credentials: !isCustomerOrderEndpoint });
  }

  // Strictly scoped support for Shopify Checkout / Order Status / Extension Web Worker origins
  if (isCustomerOrderEndpoint) {
    if (origin === 'null' || shopifyCustomerCheckoutOrigins.includes(origin)) {
      return callback(null, {
        ...corsBaseOptions,
        origin: true,
        credentials: false,
      });
    }
    if (isStandardAllowedOrigin(origin)) {
      return callback(null, {
        ...corsBaseOptions,
        origin: true,
        credentials: false,
      });
    }
  } else if (isStandardAllowedOrigin(origin)) {
    return callback(null, {
      ...corsBaseOptions,
      origin: true,
      credentials: true,
    });
  }

  logger.warn(`Blocked CORS request from unauthorized origin: ${origin}`, {
    path: normalizedPath,
    method: req.method,
  });
  const corsError = new Error('Origin not allowed by CORS');
  corsError.statusCode = 403;
  corsError.isOperational = true;
  return callback(corsError);
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

const escapeHtml = (value) => String(value || '')
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')
  .replace(/'/g, '&#39;');

const getConfiguredShopDomain = () => {
  const sanitized = sanitizeShopDomain(config.shopify.shop || 'abihacart.myshopify.com');
  return isValidShopDomain(sanitized) ? sanitized : 'abihacart.myshopify.com';
};

const getEmbeddedFrameAncestors = () => [
  `https://${getConfiguredShopDomain()}`,
  'https://admin.shopify.com',
];

const embeddedAppSecurityHeaders = (req, res, next) => {
  // Override X-Frame-Options and CSP frame-ancestors strictly for the embedded Shopify app route
  res.removeHeader('X-Frame-Options');
  const frameAncestors = getEmbeddedFrameAncestors();

  return helmet.contentSecurityPolicy({
    directives: {
      defaultSrc: ["'self'"],
      baseUri: ["'self'"],
      fontSrc: ["'self'", 'https:', 'data:'],
      formAction: ["'self'"],
      frameAncestors,
      imgSrc: ["'self'", 'data:', 'https://cdn.shopify.com'],
      objectSrc: ["'none'"],
      scriptSrc: ["'self'", 'https://cdn.shopify.com'],
      scriptSrcAttr: ["'none'"],
      styleSrc: ["'self'", 'https:', "'unsafe-inline'"],
      connectSrc: ["'self'", ...frameAncestors, 'https://cdn.shopify.com'],
    },
  })(req, res, next);
};

const renderEmbeddedAppHtml = () => {
  const shop = getConfiguredShopDomain();
  const safeShop = escapeHtml(shop);
  const safeClientId = escapeHtml(config.shopify.clientId || '');
  const appBridgeTag = safeClientId
    ? `<meta name="shopify-api-key" content="${safeClientId}" />\n  <script src="https://cdn.shopify.com/shopifycloud/app-bridge.js"></script>`
    : '';

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  ${appBridgeTag}
  <title>Abihacart AI Customer Support</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      background: #f6f6f7;
      color: #202223;
      padding: 28px 20px;
      line-height: 1.5;
    }
    .container {
      max-width: 720px;
      margin: 0 auto;
      background: #ffffff;
      border: 1px solid #e1e3e5;
      border-radius: 12px;
      padding: 24px 28px;
      box-shadow: 0 2px 8px rgba(0, 0, 0, 0.04);
    }
    .header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      padding-bottom: 16px;
      border-bottom: 1px solid #e1e3e5;
      margin-bottom: 18px;
      flex-wrap: wrap;
    }
    h1 { font-size: 20px; font-weight: 700; color: #111827; }
    .badge {
      display: inline-block;
      background: #e3f1df;
      color: #005b34;
      font-size: 12px;
      font-weight: 600;
      padding: 4px 10px;
      border-radius: 999px;
    }
    .grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
      gap: 14px;
      margin-bottom: 20px;
    }
    .card {
      background: #fafbfb;
      border: 1px solid #e5e7eb;
      border-radius: 8px;
      padding: 14px 16px;
    }
    .label { font-size: 12px; color: #6d7175; margin-bottom: 4px; }
    .value { font-size: 14px; font-weight: 600; color: #111827; word-break: break-word; }
    .actions { display: flex; gap: 10px; flex-wrap: wrap; }
    .btn {
      display: inline-block;
      padding: 9px 16px;
      border-radius: 8px;
      font-size: 13px;
      font-weight: 600;
      text-decoration: none;
      border: 1px solid #c9cccf;
      color: #202223;
      background: #ffffff;
    }
    .btn-primary {
      background: #008060;
      border-color: #008060;
      color: #ffffff;
    }
  </style>
</head>
<body>
  <main class="container">
    <div class="header">
      <h1>Abihacart AI Customer Support</h1>
      <span class="badge">Embedded App Active</span>
    </div>
    <div class="grid">
      <div class="card">
        <div class="label">Connected Store</div>
        <div class="value">${safeShop}</div>
      </div>
      <div class="card">
        <div class="label">Order Confirmation Extension</div>
        <div class="value">Checkout Thank You &amp; Order Status Ready</div>
      </div>
      <div class="card">
        <div class="label">API Status</div>
        <div class="value">Operational</div>
      </div>
    </div>
    <div class="actions">
      <a class="btn btn-primary" href="/api/shopify/auth?shop=${encodeURIComponent(shop)}" target="_top">Authorize Store Connection</a>
      <a class="btn" href="/api/shopify/test-connection?shop=${encodeURIComponent(shop)}" target="_blank" rel="noopener noreferrer">Check Connection Status</a>
      <a class="btn" href="/api/health" target="_blank" rel="noopener noreferrer">System Health</a>
    </div>
  </main>
</body>
</html>`;
};

// Shopify Embedded App entry & Root API ping
app.get('/', embeddedAppSecurityHeaders, (req, res) => {
  const accept = String(req.headers.accept || '');
  const isEmbeddedRequest =
    req.query.embedded === '1' ||
    Boolean(req.query.host) ||
    (Boolean(req.query.shop) && !accept.includes('application/json'));
  const prefersHtml = accept.includes('text/html') && !accept.includes('application/json');

  if (isEmbeddedRequest || prefersHtml) {
    return res.status(200).type('html').send(renderEmbeddedAppHtml());
  }

  return res.json({
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
