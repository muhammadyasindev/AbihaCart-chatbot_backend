const config = require('../config/env');
const logger = require('../utils/logger');
const {
  isValidShopDomain,
  sanitizeShopDomain,
  generateNonce,
  verifyHmac,
  buildAuthorizationUrl,
} = require('../utils/shopifyAuth');
const shopifyService = require('../services/shopify.service');
const { SessionStore } = require('../models/ShopifySession');

/**
 * Initiates the Shopify Authorization Code Grant OAuth flow.
 * GET /api/shopify/auth
 */
const initiateAuth = async (req, res, next) => {
  try {
    const rawShop = req.query.shop || config.shopify.shop;
    const shop = sanitizeShopDomain(rawShop);

    if (!isValidShopDomain(shop)) {
      return res.status(400).json({
        status: 'fail',
        statusCode: 400,
        error: 'Invalid Shop Domain',
        message: 'The shop parameter must be a valid myshopify.com store domain (e.g., example.myshopify.com).',
      });
    }

    if (!config.shopify.clientId || !config.shopify.clientSecret) {
      return res.status(500).json({
        status: 'error',
        statusCode: 500,
        error: 'Configuration Error',
        message: 'Shopify Client ID or Client Secret is not configured in backend environment.',
      });
    }

    // Generate cryptographic state nonce for CSRF protection
    const state = generateNonce();
    const stateExpiresAt = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes TTL

    // Persist nonce to session store
    await SessionStore.upsertSession(shop, {
      state,
      stateExpiresAt,
    });

    const redirectUri = `${config.urls.backendUrl}/api/shopify/auth/callback`;
    const authUrl = buildAuthorizationUrl({
      shop,
      clientId: config.shopify.clientId,
      scopes: config.shopify.scopes,
      redirectUri,
      state,
    });

    logger.info(`OAuth flow initiated for shop: ${shop}`);

    // If API client explicitly requests JSON
    if (req.headers.accept && req.headers.accept.includes('application/json')) {
      return res.json({
        status: 'success',
        shop,
        authorizationUrl: authUrl,
        scopes: config.shopify.scopes,
      });
    }

    return res.redirect(authUrl);
  } catch (error) {
    logger.error('Error initiating Shopify OAuth:', { message: error.message });
    return next(error);
  }
};

/**
 * Handles the Shopify OAuth redirect callback with HMAC and state verification.
 * GET /api/shopify/auth/callback
 */
const handleCallback = async (req, res, next) => {
  try {
    const { shop: rawShop, code, state, hmac } = req.query;
    const shop = sanitizeShopDomain(rawShop);

    // 1. Validate shop domain format
    if (!isValidShopDomain(shop)) {
      logger.warn(`Rejected OAuth callback with invalid shop domain: ${rawShop}`);
      return res.status(400).json({
        status: 'fail',
        error: 'Invalid Shop',
        message: 'Shop domain must be a valid myshopify.com domain.',
      });
    }

    // 2. Validate required parameters
    if (!code || !state || !hmac) {
      logger.warn('OAuth callback missing required query parameters.');
      return res.status(400).json({
        status: 'fail',
        error: 'Bad Request',
        message: 'Missing required OAuth parameters: code, state, or hmac.',
      });
    }

    // 3. Verify HMAC signature
    const isHmacValid = verifyHmac(req.query, config.shopify.clientSecret);
    if (!isHmacValid) {
      logger.warn(`Security alert: Invalid HMAC signature in OAuth callback for shop: ${shop}`);
      return res.status(401).json({
        status: 'fail',
        error: 'Unauthorized',
        message: 'HMAC validation failed. Request may have been tampered with.',
      });
    }

    // 4. Validate CSRF state nonce against session store
    const session = await SessionStore.findByShop(shop);
    if (!session || !session.state || session.state !== state) {
      logger.warn(`Security alert: State mismatch or session not found for shop: ${shop}`);
      return res.status(403).json({
        status: 'fail',
        error: 'Forbidden',
        message: 'Invalid state nonce. CSRF validation failed.',
      });
    }

    if (session.stateExpiresAt && session.stateExpiresAt < new Date()) {
      logger.warn(`OAuth state expired for shop: ${shop}`);
      return res.status(403).json({
        status: 'fail',
        error: 'Forbidden',
        message: 'OAuth state nonce has expired. Please restart the authorization flow.',
      });
    }

    // 5. Exchange authorization code for offline access token
    const tokenData = await shopifyService.exchangeCodeForToken({ shop, code });

    // 6. Update session with secured token details (offline access)
    const updatedSession = await SessionStore.upsertSession(shop, {
      accessToken: tokenData.accessToken,
      scope: tokenData.scope,
      refreshToken: tokenData.refreshToken || null,
      expiresAt: tokenData.expiresIn
        ? new Date(Date.now() + tokenData.expiresIn * 1000)
        : null,
      state: null, // Clear state nonce after successful exchange
      stateExpiresAt: null,
      isOnline: false, // Persistent offline access
    });

    logger.info(`Shopify OAuth completed successfully for shop: ${shop}. Granted scopes: ${tokenData.scope}`);

    // Return success response without exposing tokens or secrets
    return res.status(200).json({
      status: 'success',
      message: 'Shopify app authorization completed successfully.',
      shop,
      grantedScopes: tokenData.scope.split(','),
      offlineAccess: true,
      hasRefreshToken: Boolean(tokenData.refreshToken),
      installedAt: updatedSession.installedAt,
    });
  } catch (error) {
    logger.error('Error handling Shopify OAuth callback:', { message: error.message });
    return next(error);
  }
};

module.exports = {
  initiateAuth,
  handleCallback,
};
