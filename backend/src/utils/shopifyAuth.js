const crypto = require('crypto');

/**
 * Validates whether a given domain matches the Shopify store domain format.
 * Matches: [subdomain].myshopify.com where subdomain contains only alphanumeric characters and hyphens.
 * Prevents SSRF, path traversal, and malicious domain injection.
 * @param {string} shop
 * @returns {boolean}
 */
const isValidShopDomain = (shop) => {
  if (!shop || typeof shop !== 'string') return false;
  const shopRegex = /^[a-zA-Z0-9][a-zA-Z0-9\-]*\.myshopify\.com$/;
  return shopRegex.test(shop.trim().toLowerCase());
};

/**
 * Sanitizes and extracts the shop domain from user or URL input.
 * Strips protocols (https://, http://), trailing slashes, and downcases.
 * @param {string} input
 * @returns {string}
 */
const sanitizeShopDomain = (input) => {
  if (!input || typeof input !== 'string') return '';
  let cleaned = input.trim().toLowerCase();
  cleaned = cleaned.replace(/^https?:\/\//, '');
  cleaned = cleaned.replace(/\/.*$/, '');
  return cleaned;
};

/**
 * Generates a cryptographically secure random nonce for OAuth CSRF protection.
 * @returns {string}
 */
const generateNonce = () => {
  return crypto.randomBytes(16).toString('hex');
};

/**
 * Verifies the HMAC signature from Shopify OAuth callback or webhook query.
 * Implements constant-time timing-safe comparison to prevent timing attacks.
 * @param {Object} queryParams - Express req.query object
 * @param {string} clientSecret - Shopify Client Secret
 * @returns {boolean}
 */
const verifyHmac = (queryParams, clientSecret) => {
  if (!queryParams || !clientSecret) return false;
  const { hmac, signature, ...rest } = queryParams;

  if (!hmac || typeof hmac !== 'string') return false;

  // Lexicographically sort query parameter keys
  const sortedKeys = Object.keys(rest).sort();
  const message = sortedKeys
    .map((key) => {
      const val = rest[key];
      const serialized = Array.isArray(val) ? val.join(',') : String(val);
      return `${key}=${serialized}`;
    })
    .join('&');

  const computedHmac = crypto
    .createHmac('sha256', clientSecret)
    .update(message)
    .digest('hex');

  const hmacBuffer = Buffer.from(hmac, 'utf-8');
  const computedBuffer = Buffer.from(computedHmac, 'utf-8');

  if (hmacBuffer.length !== computedBuffer.length) {
    return false;
  }

  return crypto.timingSafeEqual(hmacBuffer, computedBuffer);
};

/**
 * Builds the Shopify OAuth 2.0 Authorization URL for Authorization Code Grant.
 * Uses offline access (omits grant_options[]=per-user) for persistent background support queries.
 * @param {Object} options
 * @param {string} options.shop
 * @param {string} options.clientId
 * @param {string[]} options.scopes
 * @param {string} options.redirectUri
 * @param {string} options.state
 * @returns {string}
 */
const buildAuthorizationUrl = ({ shop, clientId, scopes, redirectUri, state }) => {
  const scopeString = Array.isArray(scopes) ? scopes.join(',') : scopes;
  const params = new URLSearchParams({
    client_id: clientId,
    scope: scopeString,
    redirect_uri: redirectUri,
    state,
  });

  return `https://${shop}/admin/oauth/authorize?${params.toString()}`;
};

module.exports = {
  isValidShopDomain,
  sanitizeShopDomain,
  generateNonce,
  verifyHmac,
  buildAuthorizationUrl,
};
