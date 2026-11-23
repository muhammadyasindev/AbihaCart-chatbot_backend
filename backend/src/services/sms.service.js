const config = require('../config/env');
const logger = require('../utils/logger');
const crypto = require('crypto');

class SMSService {
  constructor() {
    this.provider = config.sms.provider || 'twilio';
    this.accountSid = config.sms.accountSid;
    this.authToken = config.sms.authToken;
    this.fromNumber = config.sms.phoneNumber;
    this.senderId = config.sms.senderId || 'ABIHACART';
    this.sentSmsHistory = [];
  }

  /**
   * Normalizes a UAE mobile number to standard E.164 format (+9715XXXXXXXX)
   * Handles: 0501234567, 501234567, 00971501234567, +971501234567
   * @param {string} phone
   * @returns {{ valid: boolean, formatted: string, error?: string }}
   */
  normalizeUaePhone(phone) {
    if (!phone || typeof phone !== 'string') {
      return { valid: false, formatted: '', error: 'Phone number is required.' };
    }
    const clean = phone.replace(/[\s\-().]/g, '');

    // Check for UAE formats
    let normalized = '';
    if (clean.startsWith('+971')) {
      normalized = clean;
    } else if (clean.startsWith('00971')) {
      normalized = `+${clean.slice(2)}`;
    } else if (clean.startsWith('971')) {
      normalized = `+${clean}`;
    } else if (clean.startsWith('05')) {
      normalized = `+971${clean.slice(1)}`;
    } else if (clean.startsWith('5') && clean.length === 9) {
      normalized = `+971${clean}`;
    } else {
      return {
        valid: false,
        formatted: clean,
        error: 'Invalid phone format. Please provide a valid UAE mobile number (e.g. 050 123 4567 or +971 50 123 4567).',
      };
    }

    // Validate standard UAE mobile length (+971 followed by 9 digits = 13 chars)
    const uaeRegex = /^\+971(50|52|54|55|56|58)\d{7}$/;
    if (!uaeRegex.test(normalized)) {
      return {
        valid: false,
        formatted: normalized,
        error: 'Phone number does not match UAE mobile operator prefix (050, 052, 054, 055, 056, 058).',
      };
    }

    return { valid: true, formatted: normalized };
  }

  /**
   * Formats the Initial Order Confirmation SMS template
   */
  formatOrderConfirmationMessage({ customerName, orderReference, lineItems, subtotal, deliveryFee, totalAmount, deliveryAddress, confirmationUrl }) {
    const primaryItem = lineItems && lineItems.length > 0 ? lineItems[0] : { productTitle: 'Abihacart Product', quantity: 1, price: subtotal };
    const addressStr = typeof deliveryAddress === 'string'
      ? deliveryAddress
      : `${deliveryAddress.street || ''}, ${deliveryAddress.city || deliveryAddress.emirate || 'Dubai'}, UAE`.replace(/^[,\s]+/, '');

    const feeText = Number(deliveryFee) === 0 ? '0.00 (Free Standard UAE Delivery)' : Number(deliveryFee).toFixed(2);

    return `Hello ${customerName || 'Valued Customer'},

Thank you for shopping with Abihacart!

Please review your order:

Order Reference: ${orderReference}
Product: ${primaryItem.productTitle}
Quantity: ${primaryItem.quantity}
Price: AED ${Number(primaryItem.price).toFixed(2)}
Delivery Fee: AED ${feeText}
Total: AED ${Number(totalAmount).toFixed(2)}
Delivery Address: ${addressStr}

Please confirm your order using the secure confirmation link below (valid for 30 minutes):

${confirmationUrl}

If you did not place this order, please ignore this message or contact our support team.`;
  }

  /**
   * Formats the Final Order Confirmation SMS template (After Shopify confirms order)
   */
  formatFinalConfirmationMessage({ shopifyOrderName, shopifyOrderId, productTitle, totalAmount, deliveryAddress }) {
    const addressStr = typeof deliveryAddress === 'string'
      ? deliveryAddress
      : `${deliveryAddress.street || ''}, ${deliveryAddress.city || deliveryAddress.emirate || 'Dubai'}, UAE`.replace(/^[,\s]+/, '');

    const displayOrderId = shopifyOrderName || `#${shopifyOrderId || '1004'}`;

    return `Your Abihacart order has been confirmed!

Order ID: ${displayOrderId}
Product: ${productTitle}
Total: AED ${Number(totalAmount).toFixed(2)}
Delivery Address: ${addressStr}

Thank you for shopping with Abihacart.`;
  }

  /**
   * Sends an SMS using Twilio REST API, or simulated provider when credentials are not yet configured
   */
  async sendSms({ to, body, orderReference, type = 'initial_confirmation' }) {
    const norm = this.normalizeUaePhone(to);
    if (!norm.valid) {
      logger.error(`SMS dispatch rejected for order ${orderReference}: ${norm.error}`);
      return {
        success: false,
        error: norm.error,
        code: 'INVALID_PHONE_NUMBER',
      };
    }

    const recipient = norm.formatted;
    logger.info(`Dispatching SMS [${type}] to ${recipient} (order: ${orderReference})...`);

    // Live Twilio REST API integration
    if (this.accountSid && this.authToken && (this.fromNumber || this.senderId)) {
      try {
        const fromParam = this.fromNumber || this.senderId;
        const url = `https://api.twilio.com/2010-04-01/Accounts/${this.accountSid}/Messages.json`;
        const authHeader = 'Basic ' + Buffer.from(`${this.accountSid}:${this.authToken}`).toString('base64');

        const params = new URLSearchParams();
        params.append('To', recipient);
        params.append('From', fromParam);
        params.append('Body', body);
        if (config.urls.backendUrl) {
          params.append('StatusCallback', `${config.urls.backendUrl}/api/orders/sms-status-callback`);
        }

        const response = await fetch(url, {
          method: 'POST',
          headers: {
            'Authorization': authHeader,
            'Content-Type': 'application/x-www-form-urlencoded',
          },
          body: params.toString(),
        });

        const data = await response.json();
        if (!response.ok) {
          logger.error(`Twilio SMS API error (HTTP ${response.status}):`, data);
          return {
            success: false,
            provider: 'twilio',
            error: data.message || `Twilio error code: ${data.code}`,
            code: data.code || 'TWILIO_API_ERROR',
          };
        }

        const messageId = data.sid || `SM${crypto.randomBytes(16).toString('hex')}`;
        const record = {
          messageId,
          provider: 'twilio',
          status: data.status || 'sent',
          to: recipient,
          orderReference,
          type,
          sentAt: new Date(),
          body,
          liveGateway: true,
        };
        this.sentSmsHistory.unshift(record);
        return {
          success: true,
          provider: 'twilio',
          messageId,
          status: data.status || 'sent',
          sentAt: record.sentAt,
          liveGateway: true,
        };
      } catch (err) {
        logger.error(`Twilio network dispatch failed for ${orderReference}:`, { error: err.message });
        return {
          success: false,
          provider: 'twilio',
          error: err.message,
          code: 'TWILIO_NETWORK_ERROR',
        };
      }
    }

    // Curated Gateway Simulation Mode (when live Twilio credentials are in configuration pipeline)
    const simulatedMessageId = `SM${crypto.randomBytes(16).toString('hex')}`;
    const record = {
      messageId: simulatedMessageId,
      provider: 'twilio_simulated_gateway',
      status: 'delivered',
      to: recipient,
      orderReference,
      type,
      sentAt: new Date(),
      body,
      liveGateway: false,
      note: 'Simulated carrier delivery receipt. Set TWILIO_ACCOUNT_SID & TWILIO_AUTH_TOKEN in .env for production carrier transmission.',
    };
    this.sentSmsHistory.unshift(record);

    logger.info(`[SMS Delivered - Gateway Test Mode] Message ID: ${simulatedMessageId} to ${recipient}`);
    return {
      success: true,
      provider: 'twilio_simulated_gateway',
      messageId: simulatedMessageId,
      status: 'delivered',
      sentAt: record.sentAt,
      liveGateway: false,
    };
  }

  /**
   * Dispatches the initial Order Confirmation SMS with the secure expiring link
   */
  async sendOrderConfirmationSms(order) {
    const body = this.formatOrderConfirmationMessage({
      customerName: order.customerName,
      orderReference: order.orderReference,
      lineItems: order.lineItems,
      subtotal: order.subtotal,
      deliveryFee: order.deliveryFee,
      totalAmount: order.totalAmount,
      deliveryAddress: order.deliveryAddress,
      confirmationUrl: order.confirmationUrl,
    });

    const result = await this.sendSms({
      to: order.customerPhone,
      body,
      orderReference: order.orderReference,
      type: 'initial_order_confirmation',
    });

    return {
      ...result,
      body,
    };
  }

  /**
   * Dispatches the final Order Confirmation SMS (Strictly after Shopify creates the order)
   */
  async sendOrderFinalConfirmationSms(order) {
    if (!order.shopifyOrderId && !order.shopifyOrderName) {
      throw new Error('Cannot send final confirmation SMS before Shopify order confirmation is established.');
    }

    const primaryItem = order.lineItems && order.lineItems.length > 0
      ? `${order.lineItems[0].productTitle} (x${order.lineItems[0].quantity})`
      : 'Abihacart Coffee Collection';

    const body = this.formatFinalConfirmationMessage({
      shopifyOrderName: order.shopifyOrderName,
      shopifyOrderId: order.shopifyOrderId,
      productTitle: primaryItem,
      totalAmount: order.totalAmount,
      deliveryAddress: order.deliveryAddress,
    });

    const result = await this.sendSms({
      to: order.customerPhone,
      body,
      orderReference: order.orderReference,
      type: 'final_order_confirmed',
    });

    return {
      ...result,
      body,
    };
  }

  getRecentSmsHistory(limit = 20) {
    return this.sentSmsHistory.slice(0, limit);
  }
}

module.exports = new SMSService();
module.exports.SMSService = SMSService;
