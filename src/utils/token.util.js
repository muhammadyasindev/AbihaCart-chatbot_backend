const crypto = require('crypto');
const config = require('../config/env');

// Base64Url encoding/decoding helpers
const base64UrlEncode = (str) => {
  return Buffer.from(str)
    .toString('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
};

const base64UrlDecode = (str) => {
  let base64 = str.replace(/-/g, '+').replace(/_/g, '/');
  while (base64.length % 4) {
    base64 += '=';
  }
  return Buffer.from(base64, 'base64').toString('utf8');
};

/**
 * Returns the secret key for signing admin dashboard tokens
 */
const getSecretKey = () => {
  return (
    process.env.ADMIN_JWT_SECRET ||
    config.shopify.clientSecret ||
    config.agent.adminApiKey ||
    'abh_secure_admin_jwt_secret_token_2026'
  );
};

/**
 * Generates a signed, tamper-proof session token (HMAC-SHA256)
 * @param {Object} payload - User context e.g. { userId, username, email, role, shop, name }
 * @param {number} [expiresInSeconds=86400] - Expiration duration (default 24 hours)
 * @returns {string} Signed token
 */
const generateToken = (payload, expiresInSeconds = 24 * 3600) => {
  const header = {
    alg: 'HS256',
    typ: 'JWT',
  };

  const now = Math.floor(Date.now() / 1000);
  const fullPayload = {
    ...payload,
    iat: now,
    exp: now + expiresInSeconds,
  };

  const encodedHeader = base64UrlEncode(JSON.stringify(header));
  const encodedPayload = base64UrlEncode(JSON.stringify(fullPayload));

  const secret = getSecretKey();
  const signature = crypto
    .createHmac('sha256', secret)
    .update(`${encodedHeader}.${encodedPayload}`)
    .digest('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');

  return `${encodedHeader}.${encodedPayload}.${signature}`;
};

/**
 * Verifies and decodes a signed session token
 * @param {string} token
 * @returns {Object|null} Decoded payload or null if invalid/expired
 */
const verifyToken = (token) => {
  if (!token || typeof token !== 'string') return null;

  const parts = token.split('.');
  if (parts.length !== 3) return null;

  const [encodedHeader, encodedPayload, providedSignature] = parts;

  const secret = getSecretKey();
  const expectedSignature = crypto
    .createHmac('sha256', secret)
    .update(`${encodedHeader}.${encodedPayload}`)
    .digest('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');

  const provBuf = Buffer.from(providedSignature);
  const expBuf = Buffer.from(expectedSignature);

  if (provBuf.length !== expBuf.length || !crypto.timingSafeEqual(provBuf, expBuf)) {
    return null;
  }

  try {
    const payload = JSON.parse(base64UrlDecode(encodedPayload));
    const now = Math.floor(Date.now() / 1000);

    // Verify token expiration
    if (payload.exp && payload.exp < now) {
      return null;
    }

    return payload;
  } catch (err) {
    return null;
  }
};

module.exports = {
  generateToken,
  verifyToken,
  getSecretKey,
};
