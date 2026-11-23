const { getDBStatus } = require('../config/db');
const config = require('../config/env');

/**
 * Health check controller
 * Reports system status, uptime, environment, and connected service health
 */
const getHealth = (req, res) => {
  const dbStatus = getDBStatus();
  const shopifyConfigured = Boolean(
    config.shopify.shop &&
    config.shopify.clientId &&
    config.shopify.clientSecret
  );
  const openAIConfigured = Boolean(config.openai.apiKey);
  const whatsAppConfigured = Boolean(
    config.whatsapp.phoneNumberId &&
    config.whatsapp.accessToken
  );

  const isHealthy = dbStatus === 'connected' || dbStatus === 'disconnected';

  res.status(isHealthy ? 200 : 503).json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    uptime: `${process.uptime().toFixed(1)}s`,
    environment: config.env,
    service: 'abihacart-support-backend',
    version: '1.0.0',
    store: config.shopify.shop,
    components: {
      database: dbStatus,
      shopify: shopifyConfigured ? 'configured' : 'pending_credentials',
      openai: openAIConfigured ? 'configured' : 'pending_credentials',
      whatsapp: whatsAppConfigured ? 'configured' : 'pending_credentials',
    },
  });
};

/**
 * Production Readiness probe controller
 * Evaluates whether core external services and configuration are ready for customer traffic
 */
const getReadiness = (req, res) => {
  const dbStatus = getDBStatus();
  const dbConnected = dbStatus === 'connected';
  const isProduction = config.env === 'production';
  const shopifyConfigured = Boolean(
    config.shopify.shop &&
    config.shopify.clientId &&
    config.shopify.clientSecret
  );
  const openAIConfigured = Boolean(config.openai.apiKey);

  // In production, database connectivity is strictly required for readiness
  const isReady = (isProduction ? dbConnected : true) && shopifyConfigured && openAIConfigured;

  res.status(isReady ? 200 : 503).json({
    status: isReady ? 'ready' : 'not_ready',
    timestamp: new Date().toISOString(),
    uptime: `${process.uptime().toFixed(1)}s`,
    environment: config.env,
    ready: isReady,
    checks: {
      database: dbConnected ? 'connected' : (isProduction ? 'failed_required' : 'disconnected_fallback_active'),
      shopify: shopifyConfigured ? 'ready' : 'pending_configuration',
      openai: openAIConfigured ? 'ready' : 'pending_configuration',
      whatsapp: 'pending_credentials (excluded for Phase 9.5)',
    },
  });
};

module.exports = {
  getHealth,
  getReadiness,
};
