const config = require('../config/env');
const logger = require('../utils/logger');

let ResendClient;
try {
  ResendClient = require('resend').Resend;
} catch (e) {
  ResendClient = null;
}

class EmailNotificationService {
  constructor() {
    this.mockHandler = null;
    this.mockMode = false;
    this.sentEmails = [];
  }

  /**
   * Sets a custom mock handler for isolated unit testing
   */
  setMockHandler(handler) {
    this.mockHandler = handler;
  }

  /**
   * Enables or disables mock mode for offline testing
   */
  setMockMode(enabled) {
    this.mockMode = Boolean(enabled);
  }

  clearHistory() {
    this.sentEmails = [];
    this.mockHandler = null;
  }

  /**
   * Validates standard email address format
   */
  isValidEmail(email) {
    if (!email || typeof email !== 'string') return false;
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());
  }

  /**
   * Formats plain-text fallback content for the store owner email
   * Strictly excludes payment card numbers and CVV
   */
  formatPlainTextEmail(record) {
    const items = (record.lineItems || []).map((item) => {
      const variant = item.variantTitle ? ` (Variant: ${item.variantTitle})` : '';
      const sku = item.sku ? ` [SKU: ${item.sku}]` : '';
      const unit = Number(item.price).toFixed(2);
      const total = Number(item.price * item.quantity).toFixed(2);
      return `• ${item.title}${variant}${sku}\n  Qty: ${item.quantity} | Unit Price: ${record.currency} ${unit} | Line Total: ${record.currency} ${total}`;
    }).join('\n\n') || '• No line items listed';

    const addr = record.shippingAddress || {};
    const addressStr = [
      addr.name,
      addr.address1,
      addr.address2,
      addr.city,
      addr.province,
      addr.country,
      addr.zip,
    ].filter(Boolean).join(', ') || 'Address not provided';

    const confirmTime = record.confirmedAt
      ? new Date(record.confirmedAt).toISOString()
      : new Date().toISOString();

    return `=======================================================
ABIHACART — NEW CONFIRMED SHOPIFY ORDER
=======================================================

ORDER INFORMATION
-----------------
Shopify Order Number: ${record.orderNumber}
Shopify Order ID:     ${record.shopifyOrderId}
Confirmation Status:  CONFIRMED
Confirmation Time:    ${confirmTime}

CUSTOMER INFORMATION
--------------------
Customer Name:  ${record.customerName}
Customer Phone: ${record.customerPhone || 'Not provided'}
Customer Email: ${record.customerEmail || 'Not provided'}

ORDERED PRODUCTS
----------------
${items}

FINANCIAL SUMMARY
-----------------
Subtotal:         ${record.currency} ${Number(record.subtotal).toFixed(2)}
Shipping Charges: ${record.currency} ${Number(record.shippingCharges).toFixed(2)}
Total Amount:     ${record.currency} ${Number(record.totalAmount).toFixed(2)}

SHIPPING ADDRESS
----------------
${addressStr}

=======================================================
CONFIRMED BY CUSTOMER VIA VERIFIED SMS TOKEN
=======================================================`;
  }

  /**
   * Formats a luxury responsive HTML email for the store owner
   * Uses Abihacart's dark obsidian and champagne-gold branding
   */
  formatHtmlEmail(record) {
    const itemsRows = (record.lineItems || []).map((item) => {
      const variant = item.variantTitle ? `<br/><span style="color: #8c8c8c; font-size: 12px;">Variant: ${item.variantTitle}</span>` : '';
      const sku = item.sku ? `<span style="color: #8c8c8c; font-size: 11px;"> • SKU: ${item.sku}</span>` : '';
      const unit = Number(item.price).toFixed(2);
      const total = Number(item.price * item.quantity).toFixed(2);
      return `
        <tr style="border-bottom: 1px solid #2a2a2a;">
          <td style="padding: 12px 8px; text-align: left; color: #f0f0f0;">
            <strong>${item.title}</strong>${variant}${sku}
          </td>
          <td style="padding: 12px 8px; text-align: center; color: #d0d0d0;">${item.quantity}</td>
          <td style="padding: 12px 8px; text-align: right; color: #d0d0d0;">${record.currency} ${unit}</td>
          <td style="padding: 12px 8px; text-align: right; color: #b89a63; font-weight: 600;">${record.currency} ${total}</td>
        </tr>
      `;
    }).join('') || '<tr><td colspan="4" style="padding: 12px; color: #888;">No items listed</td></tr>';

    const addr = record.shippingAddress || {};
    const confirmTime = record.confirmedAt
      ? new Date(record.confirmedAt).toISOString()
      : new Date().toISOString();

    return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>New Confirmed Order ${record.orderNumber}</title>
</head>
<body style="margin: 0; padding: 0; background-color: #0d0d0d; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; color: #e0e0e0;">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background-color: #0d0d0d; padding: 30px 10px;">
    <tr>
      <td align="center">
        <table role="presentation" width="100%" style="max-width: 600px; background-color: #161616; border: 1px solid #2d2d2d; border-radius: 12px; overflow: hidden; box-shadow: 0 10px 30px rgba(0,0,0,0.5);">
          
          <!-- Header Banner -->
          <tr>
            <td style="background: linear-gradient(135deg, #1c1c1c 0%, #121212 100%); padding: 25px 30px; border-bottom: 2px solid #b89a63;">
              <table width="100%">
                <tr>
                  <td>
                    <h1 style="margin: 0; font-size: 20px; font-weight: 700; color: #f5f5f5; letter-spacing: 0.5px;">ABIHACART STORE ALERT</h1>
                    <p style="margin: 4px 0 0 0; font-size: 13px; color: #b89a63;">Customer Confirmed Order Notification</p>
                  </td>
                  <td align="right">
                    <span style="display: inline-block; padding: 6px 14px; background-color: rgba(184, 154, 99, 0.15); border: 1px solid #b89a63; color: #b89a63; font-size: 11px; font-weight: 700; border-radius: 20px; letter-spacing: 0.5px;">CONFIRMED</span>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- Order & Customer Meta -->
          <tr>
            <td style="padding: 25px 30px 15px 30px;">
              <table width="100%" style="background-color: #1f1f1f; border-radius: 8px; padding: 16px; border: 1px solid #2a2a2a;">
                <tr>
                  <td width="50%" style="vertical-align: top; padding: 6px;">
                    <span style="font-size: 11px; color: #888; text-transform: uppercase;">Shopify Order</span><br/>
                    <strong style="font-size: 16px; color: #f5f5f5;">${record.orderNumber}</strong><br/>
                    <span style="font-size: 11px; color: #666;">ID: ${record.shopifyOrderId}</span>
                  </td>
                  <td width="50%" style="vertical-align: top; padding: 6px;">
                    <span style="font-size: 11px; color: #888; text-transform: uppercase;">Customer Name</span><br/>
                    <strong style="font-size: 15px; color: #f5f5f5;">${record.customerName}</strong><br/>
                    <span style="font-size: 12px; color: #aaa;">${record.customerPhone || 'No phone'}</span>
                  </td>
                </tr>
                <tr>
                  <td colspan="2" style="padding: 8px 6px 2px 6px; border-top: 1px solid #2a2a2a; margin-top: 8px;">
                    <span style="font-size: 11px; color: #888;">Email:</span> <span style="font-size: 12px; color: #ccc;">${record.customerEmail || 'Not provided'}</span> • 
                    <span style="font-size: 11px; color: #888;">Confirmed At:</span> <span style="font-size: 12px; color: #b89a63;">${confirmTime}</span>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- Ordered Products Table -->
          <tr>
            <td style="padding: 10px 30px;">
              <h3 style="margin: 0 0 12px 0; font-size: 14px; color: #b89a63; text-transform: uppercase; letter-spacing: 0.5px;">Ordered Line Items</h3>
              <table width="100%" cellspacing="0" cellpadding="0" style="border-collapse: collapse; font-size: 13px;">
                <thead>
                  <tr style="border-bottom: 2px solid #2a2a2a; color: #888; font-size: 11px; text-transform: uppercase;">
                    <th style="padding: 8px; text-align: left;">Product</th>
                    <th style="padding: 8px; text-align: center;">Qty</th>
                    <th style="padding: 8px; text-align: right;">Unit</th>
                    <th style="padding: 8px; text-align: right;">Total</th>
                  </tr>
                </thead>
                <tbody>
                  ${itemsRows}
                </tbody>
              </table>
            </td>
          </tr>

          <!-- Financial Summary -->
          <tr>
            <td style="padding: 15px 30px;">
              <table width="100%" style="font-size: 13px; color: #ccc;">
                <tr>
                  <td style="padding: 4px 0;">Subtotal:</td>
                  <td style="padding: 4px 0; text-align: right;">${record.currency} ${Number(record.subtotal).toFixed(2)}</td>
                </tr>
                <tr>
                  <td style="padding: 4px 0;">Shipping Charges:</td>
                  <td style="padding: 4px 0; text-align: right;">${record.currency} ${Number(record.shippingCharges).toFixed(2)}</td>
                </tr>
                <tr style="border-top: 1px solid #2d2d2d; font-size: 16px; font-weight: 700; color: #f5f5f5;">
                  <td style="padding: 10px 0;">Order Total:</td>
                  <td style="padding: 10px 0; text-align: right; color: #b89a63;">${record.currency} ${Number(record.totalAmount).toFixed(2)}</td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- Shipping Address -->
          <tr>
            <td style="padding: 10px 30px 25px 30px;">
              <div style="background-color: #1a1a1a; border-left: 3px solid #b89a63; padding: 14px 18px; border-radius: 4px;">
                <h4 style="margin: 0 0 6px 0; font-size: 12px; color: #b89a63; text-transform: uppercase;">Delivery Address</h4>
                <p style="margin: 0; font-size: 13px; color: #ddd; line-height: 1.5;">
                  ${addr.name ? `<strong>${addr.name}</strong><br/>` : ''}
                  ${addr.address1 || ''}${addr.address2 ? `, ${addr.address2}` : ''}<br/>
                  ${addr.city || 'Dubai'}, ${addr.province || 'Dubai'}, ${addr.country || 'UAE'} ${addr.zip || ''}
                </p>
              </div>
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td style="background-color: #111111; padding: 18px 30px; text-align: center; border-top: 1px solid #222222; font-size: 11px; color: #666;">
              <p style="margin: 0;">Automated notification generated by Abihacart Order Confirmation Engine.</p>
              <p style="margin: 4px 0 0 0;">Customer verified through secure single-use SMS link. No payment card details are stored or transmitted.</p>
            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
  }

  /**
   * Sends the complete confirmed order summary email to the store owner via Resend
   * @param {Object} orderConfirmation - The confirmed ShopifyOrderConfirmation document
   * @returns {Promise<Object>} Delivery telemetry result
   */
  async sendConfirmedOrderEmail(orderConfirmation) {
    if (!orderConfirmation) {
      throw new Error('Order confirmation document is required to send notification email.');
    }

    const ownerEmail = (config.ownerNotification?.ownerEmail || process.env.OWNER_EMAIL || '').trim();
    const apiKey = (config.resend?.apiKey !== undefined ? config.resend.apiKey : (process.env.RESEND_API_KEY || config.ownerNotification?.resendApiKey || '')).trim();
    const fromAddress = (config.resend?.from || config.ownerNotification?.emailFrom || process.env.EMAIL_FROM || 'Abihacart Orders <orders@abihacart.com>').trim();

    // 1. Validate Owner Email
    if (!this.isValidEmail(ownerEmail)) {
      const err = `Invalid or missing OWNER_EMAIL: "${ownerEmail}". Please configure a valid email address.`;
      logger.error(`[Email Notification] ${err}`);
      return {
        success: false,
        status: 'failed',
        error: err,
        resendMessageId: null,
      };
    }

    const cleanOrderNumber = (orderConfirmation.orderNumber || `#${orderConfirmation.shopifyOrderId}`).replace(/^#/, '');
    const orderNumber = `#${cleanOrderNumber}`;
    const subject = `Abihacart — Customer Confirmed Order ${orderNumber}`;
    const htmlContent = this.formatHtmlEmail(orderConfirmation);
    const textContent = this.formatPlainTextEmail(orderConfirmation);

    // 2. Mock handler support for isolated testing without live external network calls
    if (this.mockHandler && typeof this.mockHandler === 'function') {
      try {
        const mockResult = await this.mockHandler({
          from: fromAddress,
          to: ownerEmail,
          subject,
          html: htmlContent,
          text: textContent,
          orderConfirmation,
        });
        this.sentEmails.push({ to: ownerEmail, subject, status: mockResult.status, id: mockResult.resendMessageId });
        return mockResult;
      } catch (mockErr) {
        logger.error(`[Email Notification] Failed to send email via Resend for order ${orderNumber}: ${mockErr.message}`);
        return {
          success: false,
          status: 'failed',
          resendMessageId: null,
          recipientEmail: ownerEmail,
          sentAt: null,
          error: mockErr.message,
        };
      }
    }

    // 3. Validate Resend API Key
    if (!apiKey) {
      const err = 'RESEND_API_KEY is not configured in environment. Owner email dispatch paused.';
      logger.warn(`[Email Notification] ${err}`);
      return {
        success: false,
        status: 'failed',
        error: err,
        resendMessageId: null,
      };
    }

    logger.info(`[Email Notification] Dispatching confirmed order email to ${ownerEmail} for order ${orderNumber} via Resend...`);

    // 4. Dispatch via Resend (SDK or REST API)
    try {
      let resendMessageId = null;

      if (ResendClient) {
        const resend = new ResendClient(apiKey);
        const { data, error } = await resend.emails.send({
          from: fromAddress,
          to: [ownerEmail],
          subject,
          html: htmlContent,
          text: textContent,
        });

        if (error) {
          throw new Error(error.message || 'Resend SDK dispatch error');
        }
        resendMessageId = data?.id || null;
      } else {
        // Direct Resend REST API fallback via native fetch
        const res = await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            from: fromAddress,
            to: [ownerEmail],
            subject,
            html: htmlContent,
            text: textContent,
          }),
        });

        const data = await res.json();
        if (!res.ok) {
          throw new Error(data.message || `Resend HTTP error ${res.status}`);
        }
        resendMessageId = data.id || null;
      }

      logger.info(`[Email Notification] Resend accepted order confirmation email for ${orderNumber}. Message ID: ${resendMessageId}`);

      const record = {
        success: true,
        status: 'accepted', // Distinguish 'accepted' vs 'delivered' (delivered requires webhook verification)
        resendMessageId,
        recipientEmail: ownerEmail,
        sentAt: new Date(),
        error: null,
      };
      this.sentEmails.push(record);
      return record;
    } catch (err) {
      logger.error(`[Email Notification] Failed to send order confirmation email via Resend for order ${orderNumber}: ${err.message}`);
      return {
        success: false,
        status: 'failed',
        resendMessageId: null,
        recipientEmail: ownerEmail,
        sentAt: null,
        error: err.message,
      };
    }
  }

  /**
   * Formats plain-text fallback content for order cancellation notification
   */
  formatCancellationPlainTextEmail(record, isShopifyCancelled = false) {
    const items = (record.lineItems || []).map((item) => {
      const variant = item.variantTitle ? ` (Variant: ${item.variantTitle})` : '';
      const sku = item.sku ? ` [SKU: ${item.sku}]` : '';
      const unit = Number(item.price).toFixed(2);
      const total = Number(item.price * item.quantity).toFixed(2);
      return `• ${item.title}${variant}${sku}\n  Qty: ${item.quantity} | Unit Price: ${record.currency} ${unit} | Line Total: ${record.currency} ${total}`;
    }).join('\n\n') || '• No line items listed';

    const cancelType = isShopifyCancelled
      ? 'SHOPIFY ORDER CANCELLED AUTOMATICALLY'
      : 'CUSTOMER CANCELLATION REQUEST (Awaiting Store Owner Review)';

    const cancelTime = record.cancelledAt
      ? new Date(record.cancelledAt).toISOString()
      : new Date().toISOString();

    return `=======================================================
ABIHACART — ${cancelType}
=======================================================

ORDER INFORMATION
-----------------
Shopify Order Number: ${record.orderNumber}
Shopify Order ID:     ${record.shopifyOrderId}
Status:               ${isShopifyCancelled ? 'CANCELLED IN SHOPIFY' : 'CANCELLATION REQUESTED'}
Cancellation Reason:  ${record.cancellationReason || 'Customer requested cancellation via popup'}
Timestamp:            ${cancelTime}

CUSTOMER INFORMATION
--------------------
Customer Name:  ${record.customerName || 'Valued Customer'}
Customer Phone: ${record.customerPhone || 'Not provided'}
Customer Email: ${record.customerEmail || 'Not provided'}

ORDERED PRODUCTS
----------------
${items}

FINANCIAL SUMMARY
-----------------
Subtotal:         ${record.currency} ${Number(record.subtotal || record.totalAmount).toFixed(2)}
Shipping Charges: ${record.currency} ${Number(record.shippingCharges || 0).toFixed(2)}
Total Amount:     ${record.currency} ${Number(record.totalAmount).toFixed(2)}

=======================================================
ACTION NOTICE: ${isShopifyCancelled ? 'Order was cancelled directly in Shopify.' : 'Please review this cancellation request in Shopify Admin.'}
=======================================================`;
  }

  /**
   * Formats a luxury responsive HTML email for order cancellation
   */
  formatCancellationHtmlEmail(record, isShopifyCancelled = false) {
    const itemsRows = (record.lineItems || []).map((item) => {
      const variant = item.variantTitle ? `<br/><span style="color: #8c8c8c; font-size: 12px;">Variant: ${item.variantTitle}</span>` : '';
      const sku = item.sku ? `<span style="color: #8c8c8c; font-size: 11px;"> • SKU: ${item.sku}</span>` : '';
      const unit = Number(item.price).toFixed(2);
      const total = Number(item.price * item.quantity).toFixed(2);
      return `
        <tr style="border-bottom: 1px solid #2a2a2a;">
          <td style="padding: 12px 8px; text-align: left; color: #f0f0f0;">
            <strong>${item.title}</strong>${variant}${sku}
          </td>
          <td style="padding: 12px 8px; text-align: center; color: #d0d0d0;">${item.quantity}</td>
          <td style="padding: 12px 8px; text-align: right; color: #d0d0d0;">${record.currency} ${unit}</td>
          <td style="padding: 12px 8px; text-align: right; color: #ef4444; font-weight: 600;">${record.currency} ${total}</td>
        </tr>
      `;
    }).join('') || '<tr><td colspan="4" style="padding: 12px; color: #888;">No items listed</td></tr>';

    const cancelTitle = isShopifyCancelled
      ? 'Order Cancelled in Shopify'
      : 'Customer Cancellation Request';
    const badgeText = isShopifyCancelled ? 'CANCELLED' : 'CANCELLATION REQUESTED';
    const badgeColor = '#ef4444';
    const badgeBg = 'rgba(239, 68, 68, 0.15)';

    const cancelTime = record.cancelledAt
      ? new Date(record.cancelledAt).toISOString()
      : new Date().toISOString();

    return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${cancelTitle} ${record.orderNumber}</title>
</head>
<body style="margin: 0; padding: 0; background-color: #0d0d0d; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; color: #e0e0e0;">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background-color: #0d0d0d; padding: 30px 10px;">
    <tr>
      <td align="center">
        <table role="presentation" width="100%" style="max-width: 600px; background-color: #161616; border: 1px solid #2d2d2d; border-radius: 12px; overflow: hidden; box-shadow: 0 10px 30px rgba(0,0,0,0.5);">
          
          <!-- Header Banner -->
          <tr>
            <td style="background: linear-gradient(135deg, #1f1414 0%, #121212 100%); padding: 25px 30px; border-bottom: 2px solid #ef4444;">
              <table width="100%">
                <tr>
                  <td>
                    <h1 style="margin: 0; font-size: 20px; font-weight: 700; color: #f5f5f5; letter-spacing: 0.5px;">ABIHACART STORE ALERT</h1>
                    <p style="margin: 4px 0 0 0; font-size: 13px; color: #ef4444;">${cancelTitle}</p>
                  </td>
                  <td align="right">
                    <span style="display: inline-block; padding: 6px 14px; background-color: ${badgeBg}; border: 1px solid ${badgeColor}; color: ${badgeColor}; font-size: 11px; font-weight: 700; border-radius: 20px; letter-spacing: 0.5px;">${badgeText}</span>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- Order & Customer Meta -->
          <tr>
            <td style="padding: 25px 30px 15px 30px;">
              <table width="100%" style="background-color: #1f1f1f; border-radius: 8px; padding: 16px; border: 1px solid #2a2a2a;">
                <tr>
                  <td width="50%" style="vertical-align: top; padding: 6px;">
                    <span style="font-size: 11px; color: #888; text-transform: uppercase;">Shopify Order</span><br/>
                    <strong style="font-size: 16px; color: #f5f5f5;">${record.orderNumber}</strong><br/>
                    <span style="font-size: 11px; color: #666;">ID: ${record.shopifyOrderId}</span>
                  </td>
                  <td width="50%" style="vertical-align: top; padding: 6px;">
                    <span style="font-size: 11px; color: #888; text-transform: uppercase;">Customer Name</span><br/>
                    <strong style="font-size: 15px; color: #f5f5f5;">${record.customerName || 'Valued Customer'}</strong><br/>
                    <span style="font-size: 12px; color: #aaa;">${record.customerPhone || 'No phone'}</span>
                  </td>
                </tr>
                <tr>
                  <td colspan="2" style="padding: 8px 6px 2px 6px; border-top: 1px solid #2a2a2a; margin-top: 8px;">
                    <span style="font-size: 11px; color: #888;">Reason:</span> <span style="font-size: 12px; color: #ff8888;">${record.cancellationReason || 'Customer requested via confirmation popup'}</span><br/>
                    <span style="font-size: 11px; color: #888;">Timestamp:</span> <span style="font-size: 12px; color: #ddd;">${cancelTime}</span>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- Ordered Products Table -->
          <tr>
            <td style="padding: 10px 30px;">
              <h3 style="margin: 0 0 12px 0; font-size: 14px; color: #b89a63; text-transform: uppercase; letter-spacing: 0.5px;">Cancelled Items</h3>
              <table width="100%" cellspacing="0" cellpadding="0" style="border-collapse: collapse; font-size: 13px;">
                <thead>
                  <tr style="border-bottom: 2px solid #2a2a2a; color: #888; font-size: 11px; text-transform: uppercase;">
                    <th style="padding: 8px; text-align: left;">Product</th>
                    <th style="padding: 8px; text-align: center;">Qty</th>
                    <th style="padding: 8px; text-align: right;">Unit</th>
                    <th style="padding: 8px; text-align: right;">Total</th>
                  </tr>
                </thead>
                <tbody>
                  ${itemsRows}
                </tbody>
              </table>
            </td>
          </tr>

          <!-- Financial Summary -->
          <tr>
            <td style="padding: 15px 30px;">
              <table width="100%" style="font-size: 13px; color: #ccc;">
                <tr style="font-size: 16px; font-weight: 700; color: #f5f5f5;">
                  <td style="padding: 6px 0;">Order Total:</td>
                  <td style="padding: 6px 0; text-align: right; color: #ef4444;">${record.currency} ${Number(record.totalAmount).toFixed(2)}</td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- Action Notice -->
          <tr>
            <td style="padding: 10px 30px 25px 30px;">
              <div style="background-color: #1a1a1a; border-left: 3px solid #ef4444; padding: 14px 18px; border-radius: 4px;">
                <h4 style="margin: 0 0 6px 0; font-size: 12px; color: #ef4444; text-transform: uppercase;">
                  ${isShopifyCancelled ? 'Status: Cancelled in Shopify' : 'Action Required: Owner Review'}
                </h4>
                <p style="margin: 0; font-size: 13px; color: #ddd; line-height: 1.5;">
                  ${isShopifyCancelled 
                    ? 'This order has been automatically cancelled in Shopify Admin.'
                    : 'The customer requested cancellation through the Abihacart Assistant popup. Please review this order in your Shopify Admin.'}
                </p>
              </div>
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td style="background-color: #111111; padding: 18px 30px; text-align: center; border-top: 1px solid #222222; font-size: 11px; color: #666;">
              <p style="margin: 0;">Automated notification generated by Abihacart Order Confirmation Engine.</p>
            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
  }

  /**
   * Sends order cancellation email to the store owner via Resend
   */
  async sendCancellationEmail(orderConfirmation, isShopifyCancelled = false) {
    if (!orderConfirmation) {
      throw new Error('Order confirmation document is required to send cancellation email.');
    }

    const ownerEmail = (config.ownerNotification?.ownerEmail || process.env.OWNER_EMAIL || '').trim();
    const apiKey = (config.resend?.apiKey !== undefined ? config.resend.apiKey : (process.env.RESEND_API_KEY || config.ownerNotification?.resendApiKey || '')).trim();
    const fromAddress = (config.resend?.from || config.ownerNotification?.emailFrom || process.env.EMAIL_FROM || 'Abihacart Orders <orders@abihacart.com>').trim();

    if (!this.isValidEmail(ownerEmail)) {
      const err = `Invalid or missing OWNER_EMAIL: "${ownerEmail}". Please configure a valid email address.`;
      logger.error(`[Email Notification] ${err}`);
      return { success: false, status: 'failed', error: err, resendMessageId: null };
    }

    const cleanOrderNumber = (orderConfirmation.orderNumber || `#${orderConfirmation.shopifyOrderId}`).replace(/^#/, '');
    const orderNumber = `#${cleanOrderNumber}`;
    const subject = isShopifyCancelled
      ? `Abihacart — Order Cancelled ${orderNumber}`
      : `Abihacart — Customer Cancellation Request ${orderNumber}`;

    const htmlContent = this.formatCancellationHtmlEmail(orderConfirmation, isShopifyCancelled);
    const textContent = this.formatCancellationPlainTextEmail(orderConfirmation, isShopifyCancelled);

    if (this.mockHandler && typeof this.mockHandler === 'function') {
      try {
        const mockResult = await this.mockHandler({
          from: fromAddress,
          to: ownerEmail,
          subject,
          html: htmlContent,
          text: textContent,
          orderConfirmation,
          isCancellation: true,
          isShopifyCancelled,
        });
        this.sentEmails.push({ to: ownerEmail, subject, status: mockResult.status, id: mockResult.resendMessageId });
        return mockResult;
      } catch (mockErr) {
        logger.error(`[Email Notification] Mock failed for cancellation ${orderNumber}: ${mockErr.message}`);
        return { success: false, status: 'failed', resendMessageId: null, recipientEmail: ownerEmail, error: mockErr.message };
      }
    }

    if (!apiKey) {
      const err = 'RESEND_API_KEY is not configured in environment. Cancellation email dispatch paused.';
      logger.warn(`[Email Notification] ${err}`);
      return { success: false, status: 'failed', error: err, resendMessageId: null };
    }

    logger.info(`[Email Notification] Dispatching cancellation email to ${ownerEmail} for order ${orderNumber} via Resend...`);

    try {
      let resendMessageId = null;

      if (ResendClient) {
        const resend = new ResendClient(apiKey);
        const { data, error } = await resend.emails.send({
          from: fromAddress,
          to: [ownerEmail],
          subject,
          html: htmlContent,
          text: textContent,
        });

        if (error) throw new Error(error.message || 'Resend SDK dispatch error');
        resendMessageId = data?.id || null;
      } else {
        const res = await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            from: fromAddress,
            to: [ownerEmail],
            subject,
            html: htmlContent,
            text: textContent,
          }),
        });

        const data = await res.json();
        if (!res.ok) throw new Error(data.message || `Resend HTTP error ${res.status}`);
        resendMessageId = data.id || null;
      }

      logger.info(`[Email Notification] Resend accepted cancellation email for ${orderNumber}. Message ID: ${resendMessageId}`);

      const record = {
        success: true,
        status: 'accepted',
        resendMessageId,
        recipientEmail: ownerEmail,
        sentAt: new Date(),
        error: null,
      };
      this.sentEmails.push(record);
      return record;
    } catch (err) {
      logger.error(`[Email Notification] Failed to send cancellation email via Resend for order ${orderNumber}: ${err.message}`);
      return {
        success: false,
        status: 'failed',
        resendMessageId: null,
        recipientEmail: ownerEmail,
        sentAt: null,
        error: err.message,
      };
    }
  }
}

module.exports = new EmailNotificationService();
module.exports.EmailNotificationService = EmailNotificationService;
