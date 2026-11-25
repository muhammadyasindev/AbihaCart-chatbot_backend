const express = require('express');
const { handleShopifyWebhook } = require('../controllers/webhook.controller');
const { verifyShopifyWebhook } = require('../middleware/verifyWebhook');

const router = express.Router();

// Shopify Webhook Ingress Endpoint: POST /api/webhooks/shopify
router.post('/shopify', verifyShopifyWebhook, handleShopifyWebhook);

module.exports = router;
