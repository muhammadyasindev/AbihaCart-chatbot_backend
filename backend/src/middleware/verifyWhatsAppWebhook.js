const whatsappService = require('../services/whatsapp.service');
const logger = require('../utils/logger');
const config = require('../config/env');

/**
 * Middleware to strictly verify Meta Webhook HMAC-SHA256 signature (X-Hub-Signature-256)
 * Validates the raw request buffer against the configured WHATSAPP_APP_SECRET
 */
const verifyMetaSignature = (req, res, next) => {
  const signatureHeader = req.get('x-hub-signature-256');

  if (!signatureHeader) {
    logger.warn(`Rejected WhatsApp webhook from ${req.ip}: Missing X-Hub-Signature-256 header.`);
    return res.status(401).json({
      status: 'fail',
      statusCode: 401,
      error: 'Unauthorized',
      code: 'MISSING_WEBHOOK_SIGNATURE',
      message: 'Meta X-Hub-Signature-256 header is required.',
    });
  }

  const isValid = whatsappService.verifyWebhookSignature(req.rawBody, signatureHeader);
  if (!isValid) {
    logger.warn(`Security alert: WhatsApp Webhook signature mismatch from ${req.ip}. Forged or tampered payload.`);
    return res.status(401).json({
      status: 'fail',
      statusCode: 401,
      error: 'Unauthorized',
      code: 'INVALID_WEBHOOK_SIGNATURE',
      message: 'Invalid Meta webhook cryptographic signature.',
    });
  }

  next();
};

module.exports = {
  verifyMetaSignature,
};
