const config = require('../config/env');
const logger = require('../utils/logger');
const {
  isValidShopDomain,
  sanitizeShopDomain,
  generateNonce,
  verifyHmac,
  buildAuthorizationUrl,
  parseCookies,
  createSignedStateCookieValue,
  verifySignedStateCookieValue,
} = require('../utils/shopifyAuth');
const shopifyService = require('../services/shopify.service');
const { SessionStore } = require('../models/ShopifySession');

const OAUTH_STATE_COOKIE = 'abihacart_oauth_state';
const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;

const isSecureRequest = (req) => (
  Boolean(req.secure) ||
  String(req.headers['x-forwarded-proto'] || '').toLowerCase() === 'https' ||
  config.env === 'production'
);

const setOAuthStateCookie = (req, res, { shop, state, expiresAtMs }) => {
  const signedVal = createSignedStateCookieValue(
    { shop, state, expiresAtMs },
    config.shopify.clientSecret
  );
  if (!signedVal) return;

  const parts = [
    `${OAUTH_STATE_COOKIE}=${encodeURIComponent(signedVal)}`,
    'Path=/api/shopify',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${Math.floor(OAUTH_STATE_TTL_MS / 1000)}`,
  ];
  if (isSecureRequest(req)) {
    parts.push('Secure');
  }
  res.setHeader('Set-Cookie', parts.join('; '));
};

const clearOAuthStateCookie = (req, res) => {
  const parts = [
    `${OAUTH_STATE_COOKIE}=`,
    'Path=/api/shopify',
    'HttpOnly',
    'SameSite=Lax',
    'Max-Age=0',
  ];
  if (isSecureRequest(req)) {
    parts.push('Secure');
  }
  res.setHeader('Set-Cookie', parts.join('; '));
};

/**
 * Initiates the Shopify Authorization Code Grant OAuth flow.
 * GET /api/shopify/auth
 */
const initiateAuth = async (req, res, next) => {
  try {
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.set('Pragma', 'no-cache');

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
    const expiresAtMs = Date.now() + OAUTH_STATE_TTL_MS;
    const stateExpiresAt = new Date(expiresAtMs);

    // Persist nonce without invalidating parallel OAuth initiation tabs/prefetches
    await SessionStore.registerAuthState(shop, state, stateExpiresAt);
    setOAuthStateCookie(req, res, { shop, state, expiresAtMs });

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
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.set('Pragma', 'no-cache');

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

    // 4. Validate CSRF state nonce against SessionStore (DB + memory) or signed HttpOnly browser cookie
    const storeCheck = await SessionStore.findAuthState(shop, state);
    const cookies = parseCookies(req.headers.cookie);
    const cookieCheck = verifySignedStateCookieValue(
      cookies[OAUTH_STATE_COOKIE],
      config.shopify.clientSecret
    );
    const cookieMatches = (
      cookieCheck.valid &&
      cookieCheck.shop === shop &&
      cookieCheck.state === state
    );
    const cookieExpired = cookieMatches && cookieCheck.expiresAtMs < Date.now();
    const cookieValid = cookieMatches && !cookieExpired;

    if (!storeCheck.matched && !cookieValid) {
      const diagnostics = {
        dbConnected: SessionStore.isDBConnected(),
        hasSession: Boolean(storeCheck.session),
        hasStoredState: Boolean(storeCheck.session?.state),
        pendingStateCount: Array.isArray(storeCheck.session?.pendingStates)
          ? storeCheck.session.pendingStates.length
          : 0,
        hasAccessToken: Boolean(storeCheck.session?.accessToken),
        stateExpiredInStore: Boolean(storeCheck.expired),
        hasStateCookie: Boolean(cookies[OAUTH_STATE_COOKIE]),
        cookieSignatureValid: Boolean(cookieCheck.valid),
        cookieShopMatches: Boolean(cookieCheck.valid && cookieCheck.shop === shop),
        cookieStateMatches: Boolean(cookieCheck.valid && cookieCheck.state === state),
        cookieExpired: Boolean(cookieExpired),
      };

      if (storeCheck.expired || cookieExpired) {
        logger.warn(`OAuth state expired for shop: ${shop}`, diagnostics);
        return res.status(403).json({
          status: 'fail',
          error: 'Forbidden',
          message: 'OAuth state nonce has expired. Please restart the authorization flow.',
          restartAuthUrl: `${config.urls.backendUrl}/api/shopify/auth?shop=${encodeURIComponent(shop)}`,
          diagnostics,
        });
      }

      logger.warn(`Security alert: State mismatch or session not found for shop: ${shop}`, diagnostics);
      return res.status(403).json({
        status: 'fail',
        error: 'Forbidden',
        message: 'Invalid state nonce. CSRF validation failed.',
        restartAuthUrl: `${config.urls.backendUrl}/api/shopify/auth?shop=${encodeURIComponent(shop)}`,
        diagnostics,
      });
    }

    // 5. Exchange authorization code for offline access token
    const tokenData = await shopifyService.exchangeCodeForToken({ shop, code });

    // 6. Update session with secured token details (offline access) and clear pending nonces
    SessionStore.clearMemoryState(shop);
    const updatedSession = await SessionStore.upsertSession(shop, {
      accessToken: tokenData.accessToken,
      scope: tokenData.scope,
      refreshToken: tokenData.refreshToken || null,
      expiresAt: tokenData.expiresIn
        ? new Date(Date.now() + tokenData.expiresIn * 1000)
        : null,
      state: null, // Clear state nonce after successful exchange
      stateExpiresAt: null,
      pendingStates: [],
      isOnline: false, // Persistent offline access
    });

    clearOAuthStateCookie(req, res);
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
