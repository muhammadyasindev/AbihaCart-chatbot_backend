const { ShopifyOrderConfirmationStore, maskPhone } = require('../models/ShopifyOrderConfirmation');
const smsService = require('./sms.service');
const emailNotificationService = require('./emailNotification.service');
const config = require('../config/env');
const logger = require('../utils/logger');

/**
 * Normalizes a Shopify numeric ID or Order/OrderIdentity GID to its trailing numeric ID.
 * Returns null for malformed or non-Order GIDs.
 */
const normalizeShopifyOrderIdInput = (rawOrderId) => {
  if (rawOrderId === undefined || rawOrderId === null) return null;
  const trimmed = String(rawOrderId).trim();
  if (!trimmed) return null;
  if (/^\d+$/.test(trimmed)) return trimmed;
  const gidMatch = trimmed.match(/^gid:\/\/shopify\/(?:Order|OrderIdentity)\/(\d+)$/i);
  return gidMatch ? gidMatch[1] : null;
};

const normalizeOrderNumberInput = (rawOrderNumber) => {
  if (!rawOrderNumber) return '';
  return String(rawOrderNumber).trim().replace(/^#/, '').toLowerCase();
};

class OrderConfirmationService {
  /**
   * Formats the customer order confirmation SMS message
   */
  formatCustomerConfirmationSms({ customerName, orderNumber, totalAmount, currency, confirmationUrl }) {
    return `Hello ${customerName || 'Valued Customer'},

Thank you for shopping with Abihacart!

Your order ${orderNumber} has been received.

Order Total: ${currency} ${Number(totalAmount).toFixed(2)}

Please confirm your order using this secure link:

${confirmationUrl}

This link expires in 30 minutes.

If you did not place this order, please ignore this message.`;
  }

  /**
   * Processes a verified Shopify orders/create webhook payload
   * Idempotent: Skips duplicate processing if order is already recorded
   */
  async processShopifyOrderCreated(payload, shop = config.shopify.shop) {
    if (!payload || !payload.id) {
      throw new Error('Invalid Shopify order payload: Missing order id');
    }

    const shopifyOrderId = String(payload.id);
    const orderNumber = payload.name || `#${payload.order_number}` || `#${shopifyOrderId}`;

    // 1. Idempotency Check: Prevent duplicate processing & duplicate SMS
    const existing = await ShopifyOrderConfirmationStore.findByShopifyOrderId(shopifyOrderId);
    if (existing) {
      logger.info(`Shopify order [${shopifyOrderId}] (${orderNumber}) already processed with status [${existing.status}]. Skipping duplicate webhook.`);
      return {
        duplicate: true,
        alreadyProcessed: true,
        record: existing,
      };
    }

    // 2. Extract Customer Details
    const customer = payload.customer || {};
    const shippingAddress = payload.shipping_address || {};
    const billingAddress = payload.billing_address || {};

    let customerName = `${customer.first_name || ''} ${customer.last_name || ''}`.trim();
    if (!customerName) customerName = shippingAddress.name || billingAddress.name || 'Valued Customer';

    const rawPhone = shippingAddress.phone || customer.phone || billingAddress.phone || payload.phone || '';
    const customerEmail = payload.email || customer.email || '';

    // 3. Extract Line Items
    const lineItems = (payload.line_items || []).map((item) => ({
      title: item.title || item.name || 'Product',
      variantTitle: item.variant_title || '',
      quantity: parseInt(item.quantity, 10) || 1,
      price: parseFloat(item.price || 0),
      sku: item.sku || '',
      image: item.image?.src || item.image || (item.featured_image ? item.featured_image.url : '') || '',
    }));

    // 4. Extract Financials
    const subtotal = parseFloat(payload.subtotal_price || payload.current_subtotal_price || 0);
    const shippingCharges = parseFloat(
      payload.total_shipping_price_set?.shop_money?.amount ||
      (payload.shipping_lines && payload.shipping_lines[0] ? payload.shipping_lines[0].price : 0) ||
      0
    );
    const totalAmount = parseFloat(payload.total_price || payload.current_total_price || (subtotal + shippingCharges));
    const currency = payload.currency || 'AED';

    // 5. Generate Tamper-Proof Single-Use Token (30 min expiry)
    const tokenInfo = ShopifyOrderConfirmationStore.generateToken(shopifyOrderId, 30);
    const confirmationUrl = `${config.urls.backendUrl}/api/orders/confirm-shopify-order?token=${encodeURIComponent(tokenInfo.token)}`;

    // 6. Persist Pending Order Confirmation Record
    const recordData = {
      shopifyOrderId,
      orderNumber,
      shop,
      customerName,
      customerPhone: rawPhone,
      customerEmail,
      lineItems,
      subtotal,
      shippingCharges,
      totalAmount,
      currency,
      shippingAddress: {
        name: shippingAddress.name || customerName,
        address1: shippingAddress.address1 || '',
        address2: shippingAddress.address2 || '',
        city: shippingAddress.city || 'Dubai',
        province: shippingAddress.province || 'Dubai',
        country: shippingAddress.country || 'United Arab Emirates',
        zip: shippingAddress.zip || '',
        phone: shippingAddress.phone || rawPhone,
      },
      status: 'pending',
      confirmationToken: tokenInfo.token,
      confirmationTokenHash: tokenInfo.tokenHash,
      confirmationTokenExpiresAt: tokenInfo.expiresAt,
      confirmationUrl,
      customerSms: {
        messageId: null,
        status: 'pending',
        sentAt: null,
        body: null,
        error: null,
      },
      ownerEmailNotification: {
        provider: 'resend',
        status: 'pending',
        resendMessageId: null,
        recipientEmail: config.ownerNotification?.ownerEmail || '',
        sentAt: null,
        error: null,
      },
    };

    const savedRecord = await ShopifyOrderConfirmationStore.create(recordData);

    // 7. Dispatch Customer Confirmation SMS via Twilio Service
    const phoneNorm = smsService.normalizeUaePhone(rawPhone);
    let smsResult = { success: false, error: 'Phone number missing or invalid' };

    if (phoneNorm.valid) {
      const smsBody = this.formatCustomerConfirmationSms({
        customerName,
        orderNumber,
        totalAmount,
        currency,
        confirmationUrl,
      });

      try {
        smsResult = await smsService.sendSms({
          to: phoneNorm.formatted,
          body: smsBody,
          orderReference: orderNumber,
          type: 'customer_order_confirmation_prompt',
        });
      } catch (err) {
        logger.error(`SMS provider failure for order ${orderNumber}: ${err.message}`);
        smsResult = { success: false, error: err.message };
      }
    } else {
      logger.warn(`Cannot send customer SMS for order ${orderNumber}: ${phoneNorm.error || 'No phone provided'}`);
      smsResult = { success: false, error: phoneNorm.error || 'Customer phone missing' };
    }

    // Update record with SMS dispatch telemetry
    const finalSmsStatus = smsResult.success ? (smsResult.status || 'sent') : 'failed';
    await ShopifyOrderConfirmationStore.update(shopifyOrderId, {
      customerSms: {
        messageId: smsResult.messageId || null,
        status: finalSmsStatus,
        sentAt: smsResult.sentAt || new Date(),
        body: smsResult.body || null,
        error: smsResult.error || null,
      },
    });

    return {
      success: true,
      duplicate: false,
      record: await ShopifyOrderConfirmationStore.findByShopifyOrderId(shopifyOrderId),
      smsResult,
    };
  }

  /**
   * Retrieves safe order review info for GET /confirm-shopify-order without mutating state
   * Used to display the customer confirmation review page safely
   */
  async getOrderReviewByToken(token) {
    if (!token) {
      return {
        success: false,
        statusCode: 400,
        code: 'MISSING_TOKEN',
        message: 'Order confirmation token is required.',
      };
    }

    const verification = ShopifyOrderConfirmationStore.verifyToken(token);
    if (!verification.valid) {
      if (verification.reason === 'token_expired') {
        if (verification.shopifyOrderId) {
          await ShopifyOrderConfirmationStore.update(verification.shopifyOrderId, { status: 'expired' });
        }
        return {
          success: false,
          statusCode: 410,
          code: 'TOKEN_EXPIRED',
          message: 'This order confirmation link has expired (30-minute security window).',
          shopifyOrderId: verification.shopifyOrderId,
        };
      }

      return {
        success: false,
        statusCode: 403,
        code: 'INVALID_TOKEN',
        message: 'The confirmation token is invalid or has been tampered with.',
      };
    }

    const record = await ShopifyOrderConfirmationStore.findByShopifyOrderId(verification.shopifyOrderId);
    if (!record) {
      return {
        success: false,
        statusCode: 404,
        code: 'ORDER_NOT_FOUND',
        message: 'Order confirmation record not found.',
      };
    }

    return {
      success: true,
      statusCode: 200,
      alreadyConfirmed: record.status === 'confirmed',
      record,
    };
  }

  /**
   * Confirms a Shopify order using the customer's secure single-use token (Atomic & Idempotent)
   * Prevents duplicate confirmations, enforces 30-min TTL, and notifies store owner via Resend
   */
  async confirmOrderWithToken(token, options = {}) {
    if (!token) {
      return {
        success: false,
        statusCode: 400,
        code: 'MISSING_TOKEN',
        message: 'Order confirmation token is required.',
      };
    }

    // 1. Verify token HMAC signature and TTL
    const verification = ShopifyOrderConfirmationStore.verifyToken(token);
    if (!verification.valid) {
      if (verification.reason === 'token_expired') {
        if (verification.shopifyOrderId) {
          await ShopifyOrderConfirmationStore.update(verification.shopifyOrderId, { status: 'expired' });
        }
        return {
          success: false,
          statusCode: 410,
          code: 'TOKEN_EXPIRED',
          message: 'This order confirmation link has expired (30-minute security window).',
          shopifyOrderId: verification.shopifyOrderId,
        };
      }

      return {
        success: false,
        statusCode: 403,
        code: 'INVALID_TOKEN',
        message: 'The confirmation token is invalid or has been tampered with.',
      };
    }

    // Bind optional orderId / GID strictly to the signed token's order ID
    if (options.orderId !== undefined && options.orderId !== null && String(options.orderId).trim() !== '') {
      const normalizedOrderId = normalizeShopifyOrderIdInput(options.orderId);
      if (!normalizedOrderId || normalizedOrderId !== String(verification.shopifyOrderId)) {
        return {
          success: false,
          statusCode: 403,
          code: 'ORDER_TOKEN_MISMATCH',
          message: 'Order identifier does not match the signed confirmation token.',
        };
      }
    }

    // 2. Locate Pending Confirmation Record
    const record = await ShopifyOrderConfirmationStore.findByShopifyOrderId(verification.shopifyOrderId);
    if (!record) {
      return {
        success: false,
        statusCode: 404,
        code: 'ORDER_NOT_FOUND',
        message: 'Order confirmation record not found.',
      };
    }

    if (options.orderNumber && normalizeOrderNumberInput(options.orderNumber) !== normalizeOrderNumberInput(record.orderNumber)) {
      return {
        success: false,
        statusCode: 403,
        code: 'ORDER_TOKEN_MISMATCH',
        message: 'Order number does not match the signed confirmation token.',
      };
    }

    // 3. Single-Use Defense: Prevent duplicate confirmations and duplicate owner emails
    if (record.status === 'confirmed') {
      logger.info(`Order [${record.shopifyOrderId}] (${record.orderNumber}) was already confirmed on ${record.confirmedAt}. Skipping duplicate email.`);
      return {
        success: true,
        alreadyConfirmed: true,
        statusCode: 200,
        message: 'Order has already been confirmed.',
        record,
      };
    }

    // 4. Atomic Transition: Protects against concurrent confirmation requests
    const confirmedAt = new Date();
    const updatedRecord = await ShopifyOrderConfirmationStore.atomicConfirm(record.shopifyOrderId, confirmedAt);
    if (!updatedRecord) {
      // Handled concurrently by another request
      const freshRecord = await ShopifyOrderConfirmationStore.findByShopifyOrderId(record.shopifyOrderId);
      return {
        success: true,
        alreadyConfirmed: true,
        statusCode: 200,
        message: 'Order has already been confirmed.',
        record: freshRecord,
      };
    }

    // 5. Notify Store Owner with Complete Order Summary via Resend Email API
    const ownerEmailResult = await emailNotificationService.sendConfirmedOrderEmail(updatedRecord);
    await ShopifyOrderConfirmationStore.update(record.shopifyOrderId, {
      ownerEmailNotification: ownerEmailResult,
      ownerNotification: ownerEmailResult,
    });

    logger.info(`Shopify order [${record.shopifyOrderId}] confirmed by customer. Owner Resend status: ${ownerEmailResult.status}`);

    return {
      success: true,
      alreadyConfirmed: false,
      statusCode: 200,
      message: 'Order confirmed successfully. The store owner has been notified via email.',
      record: await ShopifyOrderConfirmationStore.findByShopifyOrderId(record.shopifyOrderId),
      ownerEmailNotification: ownerEmailResult,
    };
  }

  /**
   * Retrieves order status for the customer popup on checkout/Thank You page
   * Validates authorization via token OR customer verification (email/phone)
   */
  async getOrderStatusForCheckout({ orderId, orderNumber, token, email, phone }) {
    if (!orderId && !orderNumber && !token) {
      return {
        success: false,
        statusCode: 400,
        code: 'MISSING_IDENTIFIER',
        message: 'Order identifier or confirmation token is required.',
      };
    }

    let record = null;
    let tokenVerified = false;

    // 1. If token is provided, verify cryptographically
    if (token) {
      const verification = ShopifyOrderConfirmationStore.verifyToken(token);
      if (verification.valid && verification.shopifyOrderId) {
        record = await ShopifyOrderConfirmationStore.findByShopifyOrderId(verification.shopifyOrderId);
        tokenVerified = true;
      } else {
        return {
          success: false,
          statusCode: 403,
          code: 'INVALID_TOKEN',
          message: 'The confirmation token is invalid or has expired.',
        };
      }
    }

    // 2. If record not located yet and orderId / orderNumber supplied
    if (!record && orderId) {
      const normalizedOrderId = normalizeShopifyOrderIdInput(orderId) || String(orderId).trim();
      record = await ShopifyOrderConfirmationStore.findByShopifyOrderId(normalizedOrderId);
    }
    if (!record && orderNumber) {
      record = await ShopifyOrderConfirmationStore.findByOrderNumber(String(orderNumber));
    }

    if (!record) {
      return {
        success: false,
        statusCode: 404,
        code: 'ORDER_NOT_FOUND',
        message: 'Order record not found or still processing.',
      };
    }

    // 3. Customer Authorization: if not validated by token, verify email or phone
    if (!tokenVerified) {
      const emailMatches = email && record.customerEmail && email.trim().toLowerCase() === record.customerEmail.trim().toLowerCase();
      const phoneDigits = (phone || '').replace(/\D/g, '');
      const recordPhoneDigits = (record.customerPhone || '').replace(/\D/g, '');
      const phoneMatches = phoneDigits.length >= 7 && recordPhoneDigits.includes(phoneDigits.slice(-7));

      if (!emailMatches && !phoneMatches) {
        return {
          success: false,
          statusCode: 403,
          code: 'UNAUTHORIZED_ACCESS',
          message: 'Customer verification required to view order confirmation.',
        };
      }
    }

    return {
      success: true,
      statusCode: 200,
      record,
      confirmationStatus: record.status,
    };
  }

  /**
   * Cancels a Shopify order strictly via signed single-use token verification.
   * Rejects tokenless orderId/orderNumber cancellation attempts and binds optional orderId/GID strictly to the token.
   */
  async cancelOrderWithToken(token, reason = 'Customer requested cancellation via popup', options = {}) {
    if (!token || typeof token !== 'string' || !token.trim()) {
      return {
        success: false,
        statusCode: 400,
        code: 'MISSING_TOKEN',
        message: 'A valid signed order confirmation token is required to cancel this order.',
      };
    }

    const verification = ShopifyOrderConfirmationStore.verifyToken(token.trim());
    if (!verification.valid) {
      if (verification.reason === 'token_expired') {
        if (verification.shopifyOrderId) {
          await ShopifyOrderConfirmationStore.update(verification.shopifyOrderId, { status: 'expired' });
        }
        return {
          success: false,
          statusCode: 410,
          code: 'TOKEN_EXPIRED',
          message: 'This cancellation link has expired.',
        };
      }
      return {
        success: false,
        statusCode: 403,
        code: 'INVALID_TOKEN',
        message: 'The confirmation token is invalid or has been tampered with.',
      };
    }

    const shopifyOrderId = String(verification.shopifyOrderId);

    // Ensure supplied orderId / GID (if any) cannot reference another customer's order
    if (options.orderId !== undefined && options.orderId !== null && String(options.orderId).trim() !== '') {
      const normalizedProvidedOrderId = normalizeShopifyOrderIdInput(options.orderId);
      if (!normalizedProvidedOrderId || normalizedProvidedOrderId !== shopifyOrderId) {
        return {
          success: false,
          statusCode: 403,
          code: 'ORDER_TOKEN_MISMATCH',
          message: 'Order identifier does not match the signed confirmation token.',
        };
      }
    }

    const record = await ShopifyOrderConfirmationStore.findByShopifyOrderId(shopifyOrderId);
    if (!record) {
      return {
        success: false,
        statusCode: 404,
        code: 'ORDER_NOT_FOUND',
        message: 'Order confirmation record not found.',
      };
    }

    if (options.orderNumber && normalizeOrderNumberInput(options.orderNumber) !== normalizeOrderNumberInput(record.orderNumber)) {
      return {
        success: false,
        statusCode: 403,
        code: 'ORDER_TOKEN_MISMATCH',
        message: 'Order number does not match the signed confirmation token.',
      };
    }

    // Check if already cancelled
    if (record.status === 'cancelled') {
      logger.info(`Order [${record.shopifyOrderId}] (${record.orderNumber}) was already cancelled. Skipping duplicate cancellation.`);
      return {
        success: true,
        alreadyCancelled: true,
        statusCode: 200,
        message: 'Order has already been cancelled.',
        record,
      };
    }

    // Attempt real Shopify Admin API order cancellation using auto-refreshed expiring token & canonical shop domain
    let isShopifyCancelled = false;
    let cancellationStatus = 'requested';
    let shopifyApiError = null;

    try {
      const targetShop = record.shop || config.shopify.shop;
      const { SessionStore } = require('../models/ShopifySession');
      const shopifyService = require('./shopify.service');
      const session = await SessionStore.findByShop(targetShop);

      if (session && session.accessToken) {
        const accessToken = await shopifyService.getValidAccessToken(targetShop);
        const latestSession = (await SessionStore.findByShop(targetShop)) || session;
        const apiShop = latestSession.canonicalShop || targetShop;
        const numericOrderId = normalizeShopifyOrderIdInput(record.shopifyOrderId) || String(record.shopifyOrderId);
        const cancelUrl = `https://${apiShop}/admin/api/${config.shopify.apiVersion}/orders/${numericOrderId}/cancel.json`;

        const performShopifyCancel = (tokenToUse) => fetch(cancelUrl, {
          method: 'POST',
          headers: {
            'X-Shopify-Access-Token': tokenToUse,
            'Content-Type': 'application/json',
            Accept: 'application/json',
            'User-Agent': 'Abihacart-AI-Support/1.0',
          },
          body: JSON.stringify({ reason: 'customer', email: true }),
        });

        let resp = await performShopifyCancel(accessToken);

        if (resp.status === 401 && latestSession.refreshToken) {
          logger.info(`Shopify cancel returned 401 for order [${numericOrderId}]. Refreshing expiring access token on ${apiShop}.`);
          const refreshed = await shopifyService.refreshAccessToken({
            shop: apiShop,
            refreshToken: latestSession.refreshToken,
          });
          const updated = await shopifyService.persistTokenPair({
            shop: targetShop,
            session: latestSession,
            tokenData: refreshed,
          });
          resp = await performShopifyCancel(updated.accessToken);
        } else if (resp.status === 403 && !latestSession.refreshToken) {
          const forbiddenText = await resp.text().catch(() => '');
          if (/non-expiring access tokens are no longer accepted/i.test(forbiddenText)) {
            const migrated = await shopifyService.migrateToExpiringToken({
              shop: apiShop,
              nonExpiringToken: accessToken,
            });
            const updated = await shopifyService.persistTokenPair({
              shop: targetShop,
              session: latestSession,
              tokenData: migrated,
            });
            resp = await performShopifyCancel(updated.accessToken);
          } else {
            shopifyApiError = `Shopify Admin API error (403): ${forbiddenText.slice(0, 200)}`;
            logger.warn(`Shopify cancellation returned 403 for order [${numericOrderId}]: ${forbiddenText}`);
          }
        } else if (!resp.ok) {
          const errText = await resp.text().catch(() => '');
          shopifyApiError = `Shopify Admin API error (${resp.status})${errText ? `: ${errText.slice(0, 200)}` : ''}`;
          logger.warn(`Shopify cancellation request returned status ${resp.status} for order [${numericOrderId}]: ${errText}`);
        }

        if (resp.ok) {
          isShopifyCancelled = true;
          cancellationStatus = 'shopify_cancelled';
          logger.info(`Successfully cancelled order [${record.shopifyOrderId}] in Shopify Admin API (${apiShop}).`);
        } else if (!shopifyApiError) {
          const errText = await resp.text().catch(() => '');
          shopifyApiError = `Shopify Admin API error (${resp.status})${errText ? `: ${errText.slice(0, 200)}` : ''}`;
          logger.warn(`Shopify cancellation request failed with status ${resp.status} after token retry.`);
        }
      } else {
        shopifyApiError = 'No active Shopify Admin API session found for shop.';
      }
    } catch (apiErr) {
      shopifyApiError = apiErr.message;
      logger.warn(`Shopify Admin API cancellation skipped/failed: ${apiErr.message}. Recording cancellation request.`);
    }

    const cancelledAt = new Date();
    const updatedRecord = await ShopifyOrderConfirmationStore.atomicCancel(record.shopifyOrderId, cancelledAt, reason, cancellationStatus);
    if (!updatedRecord) {
      const freshRecord = await ShopifyOrderConfirmationStore.findByShopifyOrderId(record.shopifyOrderId);
      return {
        success: true,
        alreadyCancelled: freshRecord?.status === 'cancelled',
        statusCode: 200,
        message: 'Order status updated.',
        record: freshRecord,
      };
    }

    // Send Cancellation Notification to Owner via Resend
    let ownerCancelResult = null;
    try {
      ownerCancelResult = await emailNotificationService.sendCancellationEmail(updatedRecord, isShopifyCancelled);
      await ShopifyOrderConfirmationStore.update(record.shopifyOrderId, {
        ownerCancellationEmailNotification: ownerCancelResult,
      });
    } catch (emailErr) {
      logger.error(`Failed to dispatch owner cancellation email: ${emailErr.message}`);
    }

    return {
      success: true,
      alreadyCancelled: false,
      isShopifyCancelled,
      ...(shopifyApiError && !isShopifyCancelled ? { shopifyApiError } : {}),
      statusCode: 200,
      message: isShopifyCancelled
        ? 'Your order has been cancelled successfully.'
        : 'Your cancellation request has been recorded. Our team has been notified.',
      record: await ShopifyOrderConfirmationStore.findByShopifyOrderId(record.shopifyOrderId),
      ownerNotification: ownerCancelResult,
    };
  }
}

module.exports = new OrderConfirmationService();
module.exports.OrderConfirmationService = OrderConfirmationService;
