const crypto = require('crypto');
const config = require('../config/env');
const logger = require('../utils/logger');
const { verifyToken } = require('../utils/token.util');

/**
 * Constant-time string equality check to protect against timing attacks
 */
const safeCompare = (a, b) => {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const aBuf = Buffer.from(a, 'utf8');
  const bBuf = Buffer.from(b, 'utf8');
  if (aBuf.length !== bBuf.length) return false;
  return crypto.timingSafeEqual(aBuf, bBuf);
};

/**
 * Middleware for Role-Based Human Support Agent Authentication & Authorization
 * Protects agent reply, ticket lookup, and escalation queue endpoints.
 * Supports signed session tokens (JWT) and static agent/admin API keys.
 * @param {Array<string>} [allowedRoles=['agent', 'admin']]
 */
const requireAgentAuth = (allowedRoles = ['agent', 'admin']) => {
  return async (req, res, next) => {
    // Check headers: X-Agent-Key, X-Admin-Key, or Authorization: Bearer <token>
    let token = req.get('x-agent-key') || req.get('x-admin-key');
    const authHeader = req.get('authorization');

    if (!token && authHeader && authHeader.startsWith('Bearer ')) {
      token = authHeader.substring(7).trim();
    }

    if (!token) {
      logger.warn(`Unauthorized access attempt to agent endpoint: ${req.method} ${req.originalUrl} from IP: ${req.ip}`);
      return res.status(401).json({
        status: 'fail',
        statusCode: 401,
        error: 'Unauthorized',
        code: 'MISSING_AGENT_AUTH',
        message: 'Agent authentication is required. Please provide a valid X-Agent-Key or Bearer token.',
      });
    }

    // In production, fallback development tokens are strictly prohibited
    if (config.env === 'production') {
      if (token === 'abh_agent_secure_auth_token_default' || token === 'abh_admin_secure_auth_token_default') {
        logger.warn(`Security alert: Attempted use of development fallback agent key in production from IP: ${req.ip}`);
        return res.status(401).json({
          status: 'fail',
          statusCode: 401,
          error: 'Unauthorized',
          code: 'INVALID_AGENT_AUTH',
          message: 'Development fallback tokens are prohibited in production.',
        });
      }
    }

    let authenticatedRole = null;
    let agentIdentifier = 'Agent';
    let userId = null;
    let username = null;
    let userShop = config.shopify.shop;

    // 1. Attempt session token verification (JWT)
    const sessionPayload = verifyToken(token);
    if (sessionPayload && sessionPayload.role) {
      authenticatedRole = sessionPayload.role;
      agentIdentifier = sessionPayload.name || (authenticatedRole === 'admin' ? 'Administrator' : 'Support Specialist');
      userId = sessionPayload.userId;
      username = sessionPayload.username;
      userShop = sessionPayload.shop || config.shopify.shop;
    }

    // 2. Fall back to static API key verification (Phase 7 compatibility)
    if (!authenticatedRole) {
      const agentKey = config.agent.apiKey;
      const adminKey = config.agent.adminApiKey;

      if (config.env === 'production' && !agentKey && !adminKey) {
        logger.error('CRITICAL: AGENT_API_KEY / ADMIN_API_KEY are not configured for production environment.');
        return res.status(500).json({
          status: 'error',
          statusCode: 500,
          code: 'AGENT_AUTH_NOT_CONFIGURED',
          message: 'Agent authentication is not configured for production.',
        });
      }

      if (adminKey && safeCompare(token, adminKey)) {
        authenticatedRole = 'admin';
        agentIdentifier = 'Administrator';
      } else if (agentKey && safeCompare(token, agentKey)) {
        authenticatedRole = 'agent';
        agentIdentifier = 'Support Specialist';
      }
    }

    if (!authenticatedRole) {
      logger.warn(`Failed agent authentication attempt with invalid key on ${req.method} ${req.originalUrl}`);
      return res.status(401).json({
        status: 'fail',
        statusCode: 401,
        error: 'Unauthorized',
        code: 'INVALID_AGENT_AUTH',
        message: 'Invalid agent credentials provided.',
      });
    }

    // Role-based permission check
    if (!allowedRoles.includes(authenticatedRole)) {
      logger.warn(`Agent with role [${authenticatedRole}] forbidden from accessing [${req.originalUrl}]`);
      return res.status(403).json({
        status: 'fail',
        statusCode: 403,
        error: 'Forbidden',
        code: 'INSUFFICIENT_PERMISSIONS',
        message: `Action requires one of the following roles: ${allowedRoles.join(', ')}`,
      });
    }

    // Attach trusted agent context to request (including verified store ownership)
    req.agent = {
      id: userId,
      username,
      role: authenticatedRole,
      title: agentIdentifier,
      name: req.body?.agentName || agentIdentifier,
      shop: userShop,
    };

    next();
  };
};

module.exports = {
  requireAgentAuth,
  safeCompare,
};
