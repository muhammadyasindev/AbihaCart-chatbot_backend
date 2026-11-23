const config = require('../config/env');
const logger = require('../utils/logger');
const { isValidShopDomain, sanitizeShopDomain } = require('../utils/shopifyAuth');
const shopifyService = require('../services/shopify.service');
const { SessionStore } = require('../models/ShopifySession');

/**
 * Diagnostic & connection testing controller for Shopify Admin API
 * GET /api/shopify/test-connection
 */
const testShopifyConnection = async (req, res, next) => {
  try {
    const rawShop = req.query.shop || config.shopify.shop;
    const shop = sanitizeShopDomain(rawShop);

    if (!isValidShopDomain(shop)) {
      return res.status(400).json({
        status: 'fail',
        error: 'Invalid Shop Domain',
        message: 'Shop must be a valid myshopify.com domain.',
      });
    }

    // Check credential presence
    const credentialsConfigured = Boolean(
      config.shopify.clientId && config.shopify.clientSecret
    );

    if (!credentialsConfigured) {
      return res.status(200).json({
        status: 'unconfigured',
        shop,
        credentials: {
          clientId: Boolean(config.shopify.clientId),
          clientSecret: Boolean(config.shopify.clientSecret),
        },
        message: 'Shopify Client ID or Client Secret is not set in backend environment variables.',
      });
    }

    // Check if an authorized session exists in session store
    const session = await SessionStore.findByShop(shop);

    if (!session || !session.accessToken) {
      return res.status(200).json({
        status: 'pending_authorization',
        shop,
        message: 'Shopify Client ID and Client Secret are present, but the store has not completed the OAuth Authorization Code flow.',
        distribution: 'Custom Distribution / Standalone App',
        requiredScopes: config.shopify.scopes,
        authFlow: {
          step: 'Initiate OAuth Handshake',
          initiateUrl: `${config.urls.backendUrl}/api/shopify/auth?shop=${shop}`,
          callbackUrl: `${config.urls.backendUrl}/api/shopify/auth/callback`,
          note: 'Ensure the Allowed redirection URL in your Shopify Partner Dashboard matches this callback URL.',
        },
      });
    }

    // Run connection test and retrieve shop metadata + small product sample
    logger.info(`Running Shopify GraphQL connection test for ${shop}...`);
    const connectionResult = await shopifyService.testConnection(shop);

    return res.status(200).json({
      status: 'connected',
      shop: connectionResult.shop,
      apiVersion: config.shopify.apiVersion,
      productSampleCount: connectionResult.productSampleCount,
      sampleProducts: connectionResult.sampleProducts,
      session: session.toSafeObject(),
      timestamp: connectionResult.timestamp,
    });
  } catch (error) {
    logger.error('Shopify connection test failed:', { message: error.message });
    return res.status(502).json({
      status: 'error',
      statusCode: 502,
      error: 'Shopify API Error',
      message: error.message,
    });
  }
};

module.exports = {
  testShopifyConnection,
};
