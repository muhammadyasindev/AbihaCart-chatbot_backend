const { ShopifyOrderConfirmationStore, maskPhone } = require('../models/ShopifyOrderConfirmation');
const smsService = require('./sms.service');
const emailNotificationService = require('./emailNotification.service');
const config = require('../config/env');
const logger = require('../utils/logger');

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
  async confirmOrderWithToken(token) {
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
      record = await ShopifyOrderConfirmationStore.findByShopifyOrderId(String(orderId));
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

      if (!emailMatches && !phoneMatches && !token) {
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
   * Cancels a Shopify order using the customer's secure single-use token or verified request
   * Atomically transitions status to 'cancelled', records reason & timestamp, and notifies store owner
   */
  async cancelOrderWithToken(token, reason = 'Customer requested cancellation via popup', options = {}) {
    if (!token && !options.orderId) {
      return {
        success: false,
        statusCode: 400,
        code: 'MISSING_TOKEN',
        message: 'Order confirmation token or order ID is required.',
      };
    }

    let shopifyOrderId = null;
    if (token) {
      const verification = ShopifyOrderConfirmationStore.verifyToken(token);
      if (!verification.valid) {
        if (verification.reason === 'token_expired') {
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
      shopifyOrderId = verification.shopifyOrderId;
    } else {
      shopifyOrderId = String(options.orderId);
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

    // Check if Shopify cancellation via Admin API is possible
    let isShopifyCancelled = false;
    let cancellationStatus = 'requested';

    try {
      const { SessionStore } = require('../models/ShopifySession');
      const session = await SessionStore.findByShop(record.shop || config.shopify.shop);
      if (session && session.accessToken) {
        const cancelUrl = `https://${record.shop || config.shopify.shop}/admin/api/${config.shopify.apiVersion}/orders/${record.shopifyOrderId}/cancel.json`;
        const resp = await fetch(cancelUrl, {
          method: 'POST',
          headers: {
            'X-Shopify-Access-Token': session.accessToken,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ reason: 'customer', email: true }),
        });
        if (resp.ok) {
          isShopifyCancelled = true;
          cancellationStatus = 'shopify_cancelled';
          logger.info(`Successfully cancelled order [${record.shopifyOrderId}] in Shopify Admin API.`);
        } else {
          logger.warn(`Shopify cancellation request returned status ${resp.status}. Recording as cancellation request for merchant review.`);
        }
      }
    } catch (apiErr) {
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
