const express = require('express');
const { initiateAuth, handleCallback } = require('../controllers/shopifyAuth.controller');
const { testShopifyConnection } = require('../controllers/shopifyTest.controller');
const { apiLimiter } = require('../middleware/rateLimiter');

const router = express.Router();

// OAuth initiation: /api/shopify/auth
router.get('/auth', apiLimiter, initiateAuth);

// OAuth callback: /api/shopify/auth/callback
router.get('/auth/callback', apiLimiter, handleCallback);

// Secure connection test: /api/shopify/test-connection
router.get('/test-connection', apiLimiter, testShopifyConnection);

module.exports = router;
