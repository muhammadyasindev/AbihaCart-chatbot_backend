const crypto = require('crypto');
const config = require('../config/env');
const logger = require('../utils/logger');
const { WebhookDeduplicator } = require('../models/WebhookLog');

/**
 * Middleware to verify Shopify webhook HMAC-SHA256 signatures.
 * Shopify computes HMAC-SHA256 on the exact raw request body and base64 encodes it.
 */
const verifyShopifyWebhook = async (req, res, next) => {
  const hmacHeader = req.get('x-shopify-hmac-sha256');
  const topic = req.get('x-shopify-topic') || 'unknown';
  const shop = req.get('x-shopify-shop-domain') || config.shopify.shop;
  const webhookId = req.get('x-shopify-webhook-id') || null;

  if (!hmacHeader) {
    logger.warn(`Rejected Shopify webhook: Missing X-Shopify-Hmac-Sha256 header. Topic: ${topic}, Shop: ${shop}`);
    return res.status(401).json({
      status: 'fail',
      error: 'Unauthorized',
      message: 'Missing webhook signature header.',
    });
  }

  if (!config.shopify.clientSecret) {
    logger.error('Cannot verify Shopify webhook: SHOPIFY_CLIENT_SECRET is missing from environment.');
    return res.status(500).json({
      status: 'error',
      error: 'Server Configuration Error',
      message: 'Webhook verification secret not configured.',
    });
  }

  if (!req.rawBody) {
    logger.error('Cannot verify Shopify webhook: Raw request body was not captured by middleware.');
    return res.status(500).json({
      status: 'error',
      error: 'Server Configuration Error',
      message: 'Raw body buffer missing.',
    });
  }

  // Compute HMAC-SHA256 digest in Base64
  const generatedHmac = crypto
    .createHmac('sha256', config.shopify.clientSecret)
    .update(req.rawBody)
    .digest('base64');

  const hmacBuffer = Buffer.from(hmacHeader, 'utf-8');
  const genBuffer = Buffer.from(generatedHmac, 'utf-8');

  const isValid = hmacBuffer.length === genBuffer.length &&
    crypto.timingSafeEqual(hmacBuffer, genBuffer);

  if (!isValid) {
    logger.warn(`Security Alert: Invalid Shopify webhook signature. Topic: ${topic}, Shop: ${shop}`);
    return res.status(401).json({
      status: 'fail',
      error: 'Unauthorized',
      message: 'Invalid webhook signature.',
    });
  }

  // Deduplication check: prevent processing identical webhook retries
  if (webhookId) {
    const isNew = await WebhookDeduplicator.recordIfNew({ webhookId, topic, shop });
    if (!isNew) {
      logger.info(`Shopify webhook duplicate delivery detected and ignored. WebhookId: ${webhookId}, Topic: ${topic}`);
      // Acknowledge with 200 OK immediately so Shopify does not retry
      return res.status(200).json({
        status: 'ok',
        duplicate: true,
        message: 'Webhook event already processed.',
      });
    }
  }

  // Attach verified metadata to request
  req.webhookMeta = {
    topic,
    shop,
    webhookId,
  };

  return next();
};

module.exports = {
  verifyShopifyWebhook,
};
