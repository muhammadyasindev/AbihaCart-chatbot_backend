const config = require('../config/env');
const logger = require('../utils/logger');
const shopifyService = require('./shopify.service');
const { SessionStore } = require('../models/ShopifySession');

/**
 * Standard UAE Mock Test Orders
 * Used exclusively for local automated testing and development verification when live Shopify OAuth is pending.
 * Clearly tagged with dataSource: 'MOCK_TEST_DATA' and isLiveShopifyData: false.
 */
const MOCK_TEST_ORDERS = new Map([
  [
    '#ABH-1001',
    {
      id: 'gid://shopify/Order/1001001',
      name: '#ABH-1001',
      email: 'customer@example.com',
      phone: '+971501234567',
      createdAt: '2026-11-20T10:00:00Z',
      displayFinancialStatus: 'PAID',
      displayFulfillmentStatus: 'IN_PROGRESS',
      totalPrice: '249.00',
      currencyCode: 'AED',
      fulfillmentLocation: 'Dubai Fulfillment Center (UAE Hub)',
      fulfillments: [],
      lineItems: [
        {
          id: 'gid://shopify/LineItem/1101',
          title: 'Abihacart Premium Coffee Maker',
          quantity: 1,
          price: '249.00',
          currencyCode: 'AED',
        },
      ],
      estimatedDelivery: '1 to 2 business days across UAE',
      note: 'Line items have been verified and are being safely packed for courier dispatch.',
    },
  ],
  [
    '#ABH-1002',
    {
      id: 'gid://shopify/Order/1001002',
      name: '#ABH-1002',
      email: 'customer@example.com',
      phone: '0501234567',
      createdAt: '2026-11-19T14:30:00Z',
      displayFinancialStatus: 'PAID',
      displayFulfillmentStatus: 'FULFILLED',
      totalPrice: '498.00',
      currencyCode: 'AED',
      fulfillmentLocation: 'Dubai Fulfillment Center (UAE Hub)',
      fulfillments: [
        {
          id: 'gid://shopify/Fulfillment/5001',
          status: 'SUCCESS',
          createdAt: '2026-11-20T08:00:00Z',
          trackingInfo: [
            {
              company: 'Emirates Post',
              number: 'EP971002456AE',
              url: 'https://track.emiratespost.ae/EP971002456AE',
            },
          ],
        },
      ],
      lineItems: [
        {
          id: 'gid://shopify/LineItem/1102',
          title: 'Abihacart Premium Coffee Maker',
          quantity: 2,
          price: '249.00',
          currencyCode: 'AED',
        },
      ],
      estimatedDelivery: 'Out for delivery via Emirates Post',
      note: 'Package handed over to Emirates Post courier. Transit tracking active.',
    },
  ],
  [
    '#ABH-1003',
    {
      id: 'gid://shopify/Order/1001003',
      name: '#ABH-1003',
      email: 'cod.buyer@example.ae',
      phone: '+971551122334',
      createdAt: '2026-11-21T08:00:00Z',
      displayFinancialStatus: 'PENDING', // COD Order
      displayFulfillmentStatus: 'UNFULFILLED',
      totalPrice: '259.00', // AED 249 product + AED 10 COD fee
      currencyCode: 'AED',
      fulfillmentLocation: 'Dubai Fulfillment Center (UAE Hub)',
      fulfillments: [],
      lineItems: [
        {
          id: 'gid://shopify/LineItem/1103',
          title: 'Abihacart Premium Coffee Maker',
          quantity: 1,
          price: '249.00',
          currencyCode: 'AED',
        },
      ],
      estimatedDelivery: '2 to 3 business days across UAE',
      note: 'Cash on Delivery order confirmed. Standard AED 10 courier collection fee applies upon arrival.',
    },
  ],
  [
    '#ABH-9999',
    {
      id: 'gid://shopify/Order/9999999',
      name: '#ABH-9999',
      email: 'realowner@example.com',
      phone: '+971509999999',
      createdAt: '2026-11-20T10:00:00Z',
      displayFinancialStatus: 'PAID',
      displayFulfillmentStatus: 'IN_PROGRESS',
      totalPrice: '249.00',
      currencyCode: 'AED',
      fulfillmentLocation: 'Dubai Fulfillment Center (UAE Hub)',
      fulfillments: [],
      lineItems: [],
      estimatedDelivery: '1 to 2 business days across UAE',
      note: 'Simulated order for security testing.',
    },
  ],
]);

// Failed verification attempts tracking: max 5 consecutive failures before 15-minute temporary lockout
const failedAttemptsTracker = new Map();
const MAX_FAILED_ATTEMPTS = 5;
const LOCKOUT_MS = 15 * 60 * 1000; // 15 minutes

// AI tool rate limiting tracker: max 10 lookups per 15 minutes per chat session
const aiToolTracker = new Map();
const MAX_AI_LOOKUPS = 10;
const AI_WINDOW_MS = 15 * 60 * 1000;

class OrderService {
  /**
   * Resets failed verification attempts for testing or manual admin unlock
   */
  resetFailedAttempts(key) {
    if (key) {
      failedAttemptsTracker.delete(key);
    } else {
      failedAttemptsTracker.clear();
    }
  }

  /**
   * Clears all tracking state (used in automated test tearDown)
   */
  clearAllTracking() {
    failedAttemptsTracker.clear();
    aiToolTracker.clear();
  }

  /**
   * Validates and sanitizes order reference number input
   * - Must be a non-empty string
   * - Length must be between 1 and 50 characters
   * - Allowed characters: alphanumeric, '#', '_', '-', and spaces
   * - Rejects injection patterns (objects, arrays, SQL/NoSQL special characters)
   */
  validateOrderNumber(orderNumber) {
    if (orderNumber === undefined || orderNumber === null) {
      return { valid: false, code: 'MISSING_ORDER_NUMBER', message: 'Order reference number is required (e.g. #ABH-1001).' };
    }
    if (typeof orderNumber !== 'string') {
      return { valid: false, code: 'INVALID_INPUT', message: 'Order reference number must be a valid text string.' };
    }
    const trimmed = orderNumber.trim();
    if (!trimmed) {
      return { valid: false, code: 'MISSING_ORDER_NUMBER', message: 'Order reference number cannot be blank.' };
    }
    if (trimmed.length > 50) {
      return { valid: false, code: 'INVALID_INPUT', message: 'Order reference number exceeds maximum allowed length of 50 characters.' };
    }
    // Safe character pattern: only letters, digits, hash, hyphen, underscore, space
    if (!/^[A-Za-z0-9#_\-\s]+$/.test(trimmed)) {
      return { valid: false, code: 'INVALID_INPUT', message: 'Order reference number contains invalid characters.' };
    }
    return { valid: true, value: trimmed };
  }

  /**
   * Validates and sanitizes customer contact inputs (email, phone, contact string)
   */
  validateContactInputs({ email, phone, contact }) {
    if (email !== undefined && email !== null) {
      if (typeof email !== 'string') {
        return { valid: false, code: 'INVALID_INPUT', message: 'Email must be a valid string.' };
      }
      if (email.length > 100) {
        return { valid: false, code: 'INVALID_INPUT', message: 'Email exceeds maximum allowed length (100 characters).' };
      }
      if (email.trim() && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
        return { valid: false, code: 'INVALID_INPUT', message: 'Email address format is invalid.' };
      }
    }

    if (phone !== undefined && phone !== null) {
      if (typeof phone !== 'string') {
        return { valid: false, code: 'INVALID_INPUT', message: 'Phone number must be a valid string.' };
      }
      if (phone.length > 30) {
        return { valid: false, code: 'INVALID_INPUT', message: 'Phone number exceeds maximum allowed length (30 characters).' };
      }
      if (phone.trim() && !/^[+\d\s().\-]+$/.test(phone.trim())) {
        return { valid: false, code: 'INVALID_INPUT', message: 'Phone number contains invalid characters.' };
      }
    }

    if (contact !== undefined && contact !== null) {
      if (typeof contact !== 'string') {
        return { valid: false, code: 'INVALID_INPUT', message: 'Contact details must be a valid string.' };
      }
      if (contact.length > 100) {
        return { valid: false, code: 'INVALID_INPUT', message: 'Contact details exceed maximum allowed length (100 characters).' };
      }
    }

    return { valid: true };
  }

  /**
   * Checks AI-tool-based order tracking rate limits per chat session / conversation
   */
  checkAiToolRateLimit(sessionId) {
    if (!sessionId) return { allowed: true };
    const now = Date.now();
    const record = aiToolTracker.get(sessionId) || { count: 0, resetAt: now + AI_WINDOW_MS };

    if (now > record.resetAt) {
      record.count = 1;
      record.resetAt = now + AI_WINDOW_MS;
      aiToolTracker.set(sessionId, record);
      return { allowed: true };
    }

    if (record.count >= MAX_AI_LOOKUPS) {
      const waitMinutes = Math.ceil((record.resetAt - now) / 60000);
      return {
        allowed: false,
        code: 'AI_TOOL_RATE_LIMITED',
        message: `You have reached the maximum number of order status requests for this chat session. Please pause for ${waitMinutes} minute(s) before checking again, or speak with our support team.`,
      };
    }

    record.count += 1;
    aiToolTracker.set(sessionId, record);
    return { allowed: true };
  }

  /**
   * Normalizes customer email address (trim, lowercase)
   */
  normalizeEmail(email) {
    if (!email || typeof email !== 'string') return '';
    return email.trim().toLowerCase();
  }

  /**
   * Normalizes phone number digits for UAE and international phone matching
   * Extracts the national significant digits (e.g. 501234567) to match 0501234567, +971501234567, and 00971501234567
   */
  normalizePhone(phone) {
    if (!phone || typeof phone !== 'string') return '';
    const digits = phone.replace(/\D/g, '');
    if (!digits) return '';

    // Handle UAE numbers (starts with 00971 or 971 or 05)
    if (digits.startsWith('00971')) {
      return digits.substring(5); // Strips 00971
    }
    if (digits.startsWith('971')) {
      return digits.substring(3); // Strips 971
    }
    if (digits.startsWith('0') && digits.length === 10) {
      return digits.substring(1); // Strips leading 0 (e.g. 0501234567 -> 501234567)
    }

    return digits;
  }

  /**
   * Masks email address to protect customer PII (e.g. c***r@example.com)
   */
  maskEmail(email) {
    if (!email || !email.includes('@')) return '***@***.***';
    const [user, domain] = email.split('@');
    if (user.length <= 2) {
      return `${user[0]}***@${domain}`;
    }
    return `${user[0]}***${user[user.length - 1]}@${domain}`;
  }

  /**
   * Masks phone number to protect customer PII (e.g. +971 50 *** **67)
   */
  maskPhone(phone) {
    if (!phone) return '***-***-****';
    const digits = phone.replace(/\D/g, '');
    if (digits.length < 4) return '***-****';
    const last2 = digits.slice(-2);
    const first2 = digits.slice(0, 2);
    return `+971 ${first2}*** **${last2}`;
  }

  /**
   * Normalizes order reference number (e.g. 1001, abh-1001 -> #ABH-1001)
   */
  normalizeOrderNumber(orderNumber) {
    if (!orderNumber || typeof orderNumber !== 'string') return '';
    const trimmed = orderNumber.trim().toUpperCase();
    if (trimmed.startsWith('#')) return trimmed;
    if (trimmed.startsWith('ABH-')) return `#${trimmed}`;
    if (/^\d+$/.test(trimmed)) return `#ABH-${trimmed}`;
    return `#${trimmed}`;
  }

  /**
   * Checks whether the provided contact info matches the order's records
   */
  verifyContactMatch(order, { email, phone }) {
    if (!order) return false;

    // Check email match
    if (email && order.email) {
      const inputEmailNorm = this.normalizeEmail(email);
      const orderEmailNorm = this.normalizeEmail(order.email);
      if (inputEmailNorm && inputEmailNorm === orderEmailNorm) {
        return true;
      }
    }

    // Check phone match
    if (phone && order.phone) {
      const inputPhoneNorm = this.normalizePhone(phone);
      const orderPhoneNorm = this.normalizePhone(order.phone);
      if (inputPhoneNorm && orderPhoneNorm && inputPhoneNorm === orderPhoneNorm) {
        return true;
      }
    }

    return false;
  }

  /**
   * Core Two-Field Customer Verification and Status Lookup
   * Strictly enforces:
   * 1. Two-field verification (Order # + Email or Phone matching records)
   * 2. Clear distinction of data source (CONFIRMED_SHOPIFY_DATA vs MOCK_TEST_DATA vs SHOPIFY_AUTH_PENDING)
   * 3. Zero order mutations (Read-Only)
   * 4. PII masking and anti-enumeration lockout after 5 consecutive failures
   *
   * @param {Object} params
   * @param {string} params.orderNumber - Order Reference Number (#ABH-XXXX)
   * @param {string} [params.contact] - Email or Phone number used for verification
   * @param {string} [params.email] - Optional explicit email
   * @param {string} [params.phone] - Optional explicit phone
   * @param {string} [params.shop] - Shopify store domain
   * @param {string} [params.clientId] - IP, session, or conversation ID for rate limiting
   * @returns {Promise<Object>} Verification and order tracking payload
   */
  async verifyAndGetOrder({ orderNumber, contact, email, phone, shop = config.shopify.shop, clientId }) {
    // 1. Validate and sanitize required order number
    const orderNumVal = this.validateOrderNumber(orderNumber);
    if (!orderNumVal.valid) {
      return {
        verified: false,
        status: 'invalid_request',
        code: orderNumVal.code,
        message: orderNumVal.message,
      };
    }

    // 2. Validate and sanitize contact inputs
    const contactVal = this.validateContactInputs({ email, phone, contact });
    if (!contactVal.valid) {
      return {
        verified: false,
        status: 'invalid_request',
        code: contactVal.code,
        message: contactVal.message,
      };
    }

    const normalizedNum = this.normalizeOrderNumber(orderNumVal.value);
    logger.info(`Initiating secure order lookup for [${normalizedNum}] on ${shop}`);

    // Determine contact input
    let targetEmail = this.normalizeEmail(email);
    let targetPhone = this.normalizePhone(phone);

    if (contact && typeof contact === 'string') {
      const trimmedContact = contact.trim();
      if (trimmedContact.includes('@')) {
        targetEmail = this.normalizeEmail(trimmedContact);
      } else if (/\d/.test(trimmedContact)) {
        targetPhone = this.normalizePhone(trimmedContact);
      }
    }

    // 3. Two-Field Customer Verification Requirement: Must supply either Email or Phone
    if (!targetEmail && !targetPhone) {
      return {
        verified: false,
        status: 'unverified',
        code: 'MISSING_VERIFICATION_CONTACT',
        message: 'To protect customer privacy and order security, please provide the email address or phone number used at checkout along with your order number.',
      };
    }

    // 4. Repeated Failed Verification Attempts Check (Anti-Enumeration Lockout)
    const trackingKey = clientId ? `${clientId}:${normalizedNum}` : normalizedNum;
    const lockEntry = failedAttemptsTracker.get(trackingKey) || failedAttemptsTracker.get(normalizedNum);
    if (lockEntry && lockEntry.lockedUntil && lockEntry.lockedUntil > Date.now()) {
      const remainingMinutes = Math.ceil((lockEntry.lockedUntil - Date.now()) / 60000);
      logger.warn(`Security alert: Order lookup blocked by repeated failed attempt lockout for ${normalizedNum}.`);
      return {
        verified: false,
        status: 'rate_limited',
        code: 'TOO_MANY_FAILED_ATTEMPTS',
        message: `Too many failed verification attempts. For customer security, order lookup has been temporarily suspended. Please try again after ${remainingMinutes} minute(s) or contact support on WhatsApp.`,
      };
    }

    // 5. Check Shopify OAuth Session Status
    let hasLiveShopifySession = false;
    try {
      const session = await SessionStore.findByShop(shop);
      if (session && session.accessToken && !session.isTokenExpired()) {
        hasLiveShopifySession = true;
      }
    } catch (e) {
      hasLiveShopifySession = false;
    }

    // 6. Attempt Retrieval from Live Shopify GraphQL Admin API (if session active)
    let rawOrder = null;
    let dataSource = 'CONFIRMED_SHOPIFY_DATA';
    let isLiveShopifyData = false;

    if (hasLiveShopifySession) {
      try {
        rawOrder = await shopifyService.getOrderByNameOrNumber({
          orderNumber: normalizedNum,
          shop,
        });
        if (rawOrder) {
          isLiveShopifyData = true;
          dataSource = 'CONFIRMED_SHOPIFY_DATA';
        }
      } catch (err) {
        logger.error(`Live Shopify GraphQL order lookup error for ${normalizedNum}:`, { message: err.message });
        return {
          verified: false,
          status: 'unavailable',
          code: 'SHOPIFY_API_ERROR',
          message: 'Order status is temporarily unavailable due to a Shopify communication error. Please try again shortly.',
        };
      }
    }

    // 7. Fallback for Local Development & Offline Test Fixtures (when live OAuth is pending)
    if (!rawOrder) {
      const mockOrder = MOCK_TEST_ORDERS.get(normalizedNum);
      if (mockOrder) {
        rawOrder = mockOrder;
        dataSource = 'MOCK_TEST_DATA';
        isLiveShopifyData = false;
      } else {
        // Not found in test fixture and live OAuth is pending
        if (!hasLiveShopifySession) {
          return {
            verified: false,
            status: 'unavailable',
            code: 'SHOPIFY_AUTH_PENDING',
            message: 'Live order tracking is temporarily unavailable because Shopify OAuth authorization is pending completion for this store. Please contact customer support on WhatsApp or check your order confirmation email.',
            dataSource: 'UNAVAILABLE_PENDING_OAUTH',
          };
        }

        // Live session active but order genuinely does not exist in store
        return {
          verified: false,
          status: 'not_found',
          code: 'ORDER_NOT_FOUND',
          message: `Order ${normalizedNum} was not found in our records. Please double-check your order reference number.`,
        };
      }
    }

    // 8. Enforce Contact Matching (Two-Field Customer Verification)
    const isVerified = this.verifyContactMatch(rawOrder, {
      email: targetEmail,
      phone: targetPhone,
    });

    if (!isVerified) {
      const prevEntry = failedAttemptsTracker.get(trackingKey) || { count: 0, lockedUntil: null };
      const newCount = prevEntry.count + 1;
      const isLocked = newCount >= MAX_FAILED_ATTEMPTS;

      failedAttemptsTracker.set(trackingKey, {
        count: newCount,
        lockedUntil: isLocked ? Date.now() + LOCKOUT_MS : null,
      });
      failedAttemptsTracker.set(normalizedNum, {
        count: newCount,
        lockedUntil: isLocked ? Date.now() + LOCKOUT_MS : null,
      });

      logger.warn(`Security alert: Failed order verification attempt for ${normalizedNum}. Contact mismatch. (Attempt ${newCount}/${MAX_FAILED_ATTEMPTS})`);

      if (isLocked) {
        return {
          verified: false,
          status: 'rate_limited',
          code: 'TOO_MANY_FAILED_ATTEMPTS',
          message: 'Too many failed verification attempts. For customer security, order lookup has been temporarily suspended. Please try again after 15 minutes or contact support on WhatsApp.',
        };
      }

      return {
        verified: false,
        status: 'unverified',
        code: 'VERIFICATION_FAILED',
        message: 'Order verification failed. The provided contact details do not match the records for this order reference. For customer security, order information cannot be disclosed.',
      };
    }

    // Reset failed attempts upon successful verification
    failedAttemptsTracker.delete(trackingKey);
    failedAttemptsTracker.delete(normalizedNum);

    // 7. Extract & Structure Safe, Masked Order Details
    // Extract tracking info from fulfillments
    const fulfillments = rawOrder.fulfillments || [];
    let trackingInfo = [];
    let carrierName = null;
    let trackingNumber = null;
    let trackingUrl = null;

    for (const f of fulfillments) {
      const infos = f.trackingInfo || [];
      for (const info of infos) {
        trackingInfo.push({
          company: info.company || 'UAE Local Courier',
          number: info.number || 'Pending Tracking ID',
          url: info.url || null,
        });
        carrierName = carrierName || info.company;
        trackingNumber = trackingNumber || info.number;
        trackingUrl = trackingUrl || info.url;
      }
    }

    // Map fulfillment status to clear UAE customer-facing status
    let customerFulfillmentStage = 'Processing at Dubai Fulfillment Center';
    const rawFulfillmentStatus = rawOrder.displayFulfillmentStatus || 'UNFULFILLED';

    if (rawFulfillmentStatus === 'FULFILLED') {
      customerFulfillmentStage = trackingNumber
        ? `Dispatched via ${carrierName || 'Courier'} (${trackingNumber})`
        : 'Dispatched / Out for Delivery';
    } else if (rawFulfillmentStatus === 'IN_PROGRESS' || rawFulfillmentStatus === 'PARTIALLY_FULFILLED') {
      customerFulfillmentStage = 'Packing & Quality Inspection at Dubai Hub';
    }

    // Map financial status
    let financialStatusDesc = 'Paid in Full';
    if (rawOrder.displayFinancialStatus === 'PENDING') {
      financialStatusDesc = 'Pending Payment (Cash on Delivery)';
    }

    // Extract line items safely
    let lineItems = [];
    if (Array.isArray(rawOrder.lineItems)) {
      lineItems = rawOrder.lineItems.map((li) => ({
        title: li.title,
        quantity: li.quantity,
        currencyCode: li.currencyCode || 'AED',
      }));
    } else if (rawOrder.lineItems?.edges) {
      lineItems = rawOrder.lineItems.edges.map((e) => ({
        title: e.node.title,
        quantity: e.node.quantity,
        currencyCode: rawOrder.currencyCode || 'AED',
      }));
    }

    logger.info(`Order ${normalizedNum} successfully verified for customer (${dataSource}).`);

    return {
      verified: true,
      status: 'verified',
      orderNumber: rawOrder.name || normalizedNum,
      orderDate: rawOrder.createdAt,
      financialStatus: financialStatusDesc,
      fulfillmentStatus: customerFulfillmentStage,
      rawFulfillmentStatus,
      fulfillmentLocation: rawOrder.fulfillmentLocation || 'Dubai Fulfillment Center (UAE Hub)',
      estimatedDelivery: rawOrder.estimatedDelivery || '1 to 2 business days across UAE',
      carrier: carrierName,
      trackingNumber,
      trackingUrl,
      trackingInfo,
      lineItems,
      totalAmount: `${rawOrder.currencyCode || 'AED'} ${rawOrder.totalPrice || rawOrder.totalPriceSet?.shopMoney?.amount || '0.00'}`,
      maskedEmail: this.maskEmail(rawOrder.email),
      maskedPhone: this.maskPhone(rawOrder.phone),
      dataSource,
      isLiveShopifyData,
      notice: isLiveShopifyData
        ? 'Verified Live Shopify Store Data.'
        : 'Notice: This order status was retrieved from a verified local test fixture and does not represent live Shopify store data.',
      note: rawOrder.note || 'Line items have been verified and are being processed for local UAE delivery.',
    };
  }

  /**
   * Strictly Prohibited Mutation Boundary:
   * Rejects any attempt to cancel or modify orders directly through customer support.
   */
  async cancelOrder() {
    throw new Error('Order cancellation is strictly prohibited in customer support mode. Read-only policy enforced.');
  }

  async modifyOrder() {
    throw new Error('Order modification is strictly prohibited in customer support mode. Read-only policy enforced.');
  }

  async refundOrder() {
    throw new Error('Financial refunds are strictly prohibited in customer support mode. Read-only policy enforced.');
  }
}

module.exports = new OrderService();
module.exports.OrderService = OrderService;
module.exports.MOCK_TEST_ORDERS = MOCK_TEST_ORDERS;
