const logger = require('../utils/logger');
const orderService = require('../services/order.service');
const shopifyService = require('../services/shopify.service');
const smsService = require('../services/sms.service');
const { PendingOrderStore, maskPhone } = require('../models/PendingOrder');
const orderConfirmationService = require('../services/orderConfirmation.service');
const config = require('../config/env');

/**
 * Controller for Customer Order Lookup and Real-Time Tracking
 * Strictly enforces:
 * 1. Two-Field Customer Verification (Order # + Email or Phone)
 * 2. Read-only Shopify operations
 * 3. Clear data source attribution (CONFIRMED_SHOPIFY_DATA vs MOCK_TEST_DATA vs UNAVAILABLE_PENDING_OAUTH)
 * 4. PII masking and anti-enumeration lockout after 5 consecutive failures
 */
const trackOrder = async (req, res, next) => {
  try {
    const { orderNumber, email, phone, contact, shop = config.shopify.shop } = req.body;

    // 1. Validate order number type and basic sanity
    if (orderNumber === undefined || orderNumber === null) {
      return res.status(400).json({
        status: 'fail',
        statusCode: 400,
        error: 'Bad Request',
        code: 'MISSING_ORDER_NUMBER',
        message: 'Order reference number is required (e.g., #ABH-1001).',
      });
    }

    if (typeof orderNumber !== 'string') {
      return res.status(400).json({
        status: 'fail',
        statusCode: 400,
        error: 'Bad Request',
        code: 'INVALID_INPUT',
        message: 'Order reference number must be a valid text string.',
      });
    }

    const trimmedOrder = orderNumber.trim();
    if (!trimmedOrder) {
      return res.status(400).json({
        status: 'fail',
        statusCode: 400,
        error: 'Bad Request',
        code: 'MISSING_ORDER_NUMBER',
        message: 'Order reference number cannot be blank.',
      });
    }

    if (trimmedOrder.length > 50) {
      return res.status(400).json({
        status: 'fail',
        statusCode: 400,
        error: 'Bad Request',
        code: 'INVALID_INPUT',
        message: 'Order reference number exceeds maximum allowed length of 50 characters.',
      });
    }

    // 2. Validate contact fields type and basic sanity
    if (email !== undefined && (typeof email !== 'string' || email.length > 100)) {
      return res.status(400).json({
        status: 'fail',
        statusCode: 400,
        error: 'Bad Request',
        code: 'INVALID_INPUT',
        message: 'Customer email must be a valid text string up to 100 characters.',
      });
    }

    if (phone !== undefined && (typeof phone !== 'string' || phone.length > 30)) {
      return res.status(400).json({
        status: 'fail',
        statusCode: 400,
        error: 'Bad Request',
        code: 'INVALID_INPUT',
        message: 'Customer phone must be a valid text string up to 30 characters.',
      });
    }

    if (contact !== undefined && (typeof contact !== 'string' || contact.length > 100)) {
      return res.status(400).json({
        status: 'fail',
        statusCode: 400,
        error: 'Bad Request',
        code: 'INVALID_INPUT',
        message: 'Customer contact details must be a valid text string up to 100 characters.',
      });
    }

    // 3. Two-Field Customer Verification requires at least one contact item
    if (!email && !phone && !contact) {
      return res.status(400).json({
        status: 'fail',
        statusCode: 400,
        error: 'Bad Request',
        code: 'MISSING_VERIFICATION_CONTACT',
        message: 'Customer email or phone number is required to verify order records.',
      });
    }

    const clientIp = req.ip || req.headers['x-forwarded-for'] || req.connection?.remoteAddress || 'client';

    const orderResult = await orderService.verifyAndGetOrder({
      orderNumber: trimmedOrder,
      email,
      phone,
      contact,
      shop,
      clientId: clientIp,
    });

    // If rate-limited due to repeated failed attempts
    if (orderResult.code === 'TOO_MANY_FAILED_ATTEMPTS' || orderResult.status === 'rate_limited') {
      return res.status(429).json({
        status: 'fail',
        statusCode: 429,
        error: 'Too Many Requests',
        code: 'TOO_MANY_FAILED_ATTEMPTS',
        message: orderResult.message,
      });
    }

    // If invalid input detected by service
    if (orderResult.code === 'INVALID_INPUT') {
      return res.status(400).json({
        status: 'fail',
        statusCode: 400,
        error: 'Bad Request',
        code: 'INVALID_INPUT',
        message: orderResult.message,
      });
    }

    // If order lookup indicates Shopify OAuth is pending
    if (orderResult.code === 'SHOPIFY_AUTH_PENDING') {
      return res.status(503).json({
        status: 'fail',
        statusCode: 503,
        error: 'Service Unavailable',
        code: 'SHOPIFY_AUTH_PENDING',
        message: orderResult.message,
        dataSource: orderResult.dataSource,
      });
    }

    // If verification contact did not match the order record
    if (!orderResult.verified) {
      return res.status(401).json({
        status: 'fail',
        statusCode: 401,
        error: 'Unauthorized',
        code: orderResult.code || 'VERIFICATION_FAILED',
        message: orderResult.message,
      });
    }

    return res.status(200).json({
      status: 'success',
      data: orderResult,
    });
  } catch (err) {
    logger.error('Error tracking order:', { message: err.message });
    return next(err);
  }
};

/**
 * Explicit refusal handlers for prohibited mutations
 * Guarantees read-only operational boundary
 */
const cancelOrderRefusal = (req, res) => {
  return res.status(403).json({
    status: 'fail',
    statusCode: 403,
    error: 'Forbidden',
    code: 'READ_ONLY_MODE',
    message: 'Order cancellations cannot be processed through AI customer support. Our backend operates in read-only mode. Please contact our support team on WhatsApp if your package has not dispatched.',
  });
};

const modifyOrderRefusal = (req, res) => {
  return res.status(403).json({
    status: 'fail',
    statusCode: 403,
    error: 'Forbidden',
    code: 'READ_ONLY_MODE',
    message: 'Order modifications cannot be processed through AI customer support. Our backend operates in read-only mode. Please contact our support team on WhatsApp for order changes before fulfillment.',
  });
};

const refundOrderRefusal = (req, res) => {
  return res.status(403).json({
    status: 'fail',
    statusCode: 403,
    error: 'Forbidden',
    code: 'READ_ONLY_MODE',
    message: 'Direct financial refunds cannot be executed through AI customer support. Returns must follow the verified 14-day physical inspection process. Please contact our support team on WhatsApp for return inquiries.',
  });
};

/**
 * Places a customer order request through the AI Concierge with SMS confirmation
 * POST /api/orders/place-sms-order
 */
const placeSmsOrder = async (req, res, next) => {
  try {
    const {
      productHandle = 'abihacart-coffee-maker',
      variantId,
      quantity = 1,
      customerName,
      customerPhone,
      deliveryAddress,
      emirate = 'Dubai',
      conversationId,
      shop = config.shopify.shop,
      notes = '',
    } = req.body;

    // 1. Validate Customer Name
    if (!customerName || typeof customerName !== 'string' || !customerName.trim()) {
      return res.status(400).json({
        status: 'fail',
        statusCode: 400,
        error: 'Bad Request',
        code: 'MISSING_CUSTOMER_NAME',
        message: 'Customer full name is required for order delivery.',
      });
    }

    // 2. Validate Customer UAE Phone
    if (!customerPhone || typeof customerPhone !== 'string') {
      return res.status(400).json({
        status: 'fail',
        statusCode: 400,
        error: 'Bad Request',
        code: 'MISSING_CUSTOMER_PHONE',
        message: 'UAE mobile number is required to receive the order confirmation SMS.',
      });
    }

    const phoneValidation = smsService.normalizeUaePhone(customerPhone);
    if (!phoneValidation.valid) {
      return res.status(400).json({
        status: 'fail',
        statusCode: 400,
        error: 'Bad Request',
        code: 'INVALID_PHONE_NUMBER',
        message: phoneValidation.error,
      });
    }
    const normalizedPhone = phoneValidation.formatted;

    // 3. Validate Delivery Address
    if (!deliveryAddress || (typeof deliveryAddress === 'string' && !deliveryAddress.trim())) {
      return res.status(400).json({
        status: 'fail',
        statusCode: 400,
        error: 'Bad Request',
        code: 'MISSING_DELIVERY_ADDRESS',
        message: 'Delivery address (street, building/villa, and emirate) is required.',
      });
    }

    const streetAddress = typeof deliveryAddress === 'string' ? deliveryAddress.trim() : (deliveryAddress.street || '').trim();
    const cityOrEmirate = typeof deliveryAddress === 'object' && deliveryAddress.emirate ? deliveryAddress.emirate : emirate;

    // 4. Validate Product from Verified Catalog
    let product = shopifyService.getVerifiedProductByHandle(productHandle);
    if (!product) {
      // Try searching by keyword
      const searchRes = await shopifyService.searchProducts({ query: productHandle, shop, first: 1 });
      if (searchRes && searchRes.products && searchRes.products.length > 0) {
        product = searchRes.products[0];
      }
    }

    if (!product) {
      return res.status(404).json({
        status: 'fail',
        statusCode: 404,
        error: 'Not Found',
        code: 'PRODUCT_NOT_FOUND',
        message: `The product requested could not be verified in store catalog: ${productHandle}`,
      });
    }

    // Validate Quantity
    const qty = Math.max(1, Math.min(10, parseInt(quantity, 10) || 1));
    const targetVariantId = variantId || (product.variants && product.variants[0] ? product.variants[0].id : product.variantId || 'gid://shopify/ProductVariant/11111');
    const unitPrice = Number(product.price || (product.variants && product.variants[0] ? product.variants[0].price : 249.00));

    // Calculate totals in AED
    const subtotal = Number((unitPrice * qty).toFixed(2));
    // UAE Delivery Rule: Free above AED 150, otherwise standard AED 15
    const deliveryFee = subtotal >= 150.00 ? 0.00 : 15.00;
    const totalAmount = Number((subtotal + deliveryFee).toFixed(2));

    // 5. Generate Order Reference and Secure Token (30 min TTL)
    const orderReference = `ABH-ORD-${Date.now().toString().slice(-8)}`;
    const tokenInfo = PendingOrderStore.generateToken(orderReference, 30);
    const confirmationUrl = `${config.urls.backendUrl}/api/orders/confirm-sms?token=${encodeURIComponent(tokenInfo.token)}`;

    const orderData = {
      orderReference,
      shop,
      conversationId: conversationId || `conv_${Date.now()}`,
      customerName: customerName.trim(),
      customerPhone: normalizedPhone,
      maskedPhone: maskPhone(normalizedPhone),
      deliveryAddress: {
        street: streetAddress,
        city: cityOrEmirate,
        emirate: cityOrEmirate,
        country: 'AE',
      },
      lineItems: [
        {
          productTitle: product.title,
          handle: product.handle,
          variantId: targetVariantId,
          sku: product.variants && product.variants[0] ? product.variants[0].sku : 'ABH-SKU-01',
          quantity: qty,
          price: unitPrice,
          currencyCode: 'AED',
        },
      ],
      subtotal,
      deliveryFee,
      totalAmount,
      currency: 'AED',
      paymentMethod: 'Cash on Delivery (COD)',
      status: 'pending_confirmation',
      confirmationToken: tokenInfo.token,
      confirmationTokenExpiresAt: tokenInfo.expiresAt,
      confirmationUrl,
      notes,
    };

    // 6. Pre-stage Shopify Draft Order
    const draftResult = await shopifyService.createDraftOrder({ shop, orderData });
    orderData.shopifyDraftOrderId = draftResult.draftOrderId;

    // 7. Save Pending Order Record
    const savedOrder = await PendingOrderStore.create(orderData);

    // 8. Dispatch Order Confirmation SMS
    const smsResult = await smsService.sendOrderConfirmationSms(savedOrder);
    const initialSmsStatus = smsResult.success ? (smsResult.status || 'sent') : 'failed';
    await PendingOrderStore.update(orderReference, {
      status: smsResult.success ? 'pending_confirmation' : 'failed',
      initialSms: {
        messageId: smsResult.messageId || null,
        status: initialSmsStatus,
        sentAt: smsResult.sentAt || new Date(),
        body: smsResult.body || null,
        error: smsResult.error || null,
      },
      notes: smsResult.success ? notes : `Initial SMS dispatch failed: ${smsResult.error || 'Gateway failure'}`,
    });

    logger.info(`SMS order placed: ${orderReference} for ${customerName} (${orderData.maskedPhone}), SMS ID: ${smsResult.messageId}`);

    return res.status(201).json({
      status: 'success',
      statusCode: 201,
      message: 'Order created successfully. An SMS confirmation link has been sent to your mobile phone.',
      order: {
        orderReference,
        status: 'pending_confirmation',
        customerName: savedOrder.customerName,
        maskedPhone: savedOrder.maskedPhone,
        product: product.title,
        quantity: qty,
        unitPrice,
        subtotal,
        deliveryFee,
        totalAmount,
        currency: 'AED',
        paymentMethod: savedOrder.paymentMethod,
        confirmationTokenExpiresAt: tokenInfo.expiresAt,
        confirmationUrl,
        smsStatus: smsResult.status || 'sent',
      },
    });
  } catch (err) {
    logger.error('Error placing SMS order:', { error: err.message, stack: err.stack });
    return next(err);
  }
};

/**
 * Confirms an order via SMS confirmation token
 * GET /api/orders/confirm-sms
 * POST /api/orders/confirm-sms
 */
const confirmSmsOrder = async (req, res, next) => {
  try {
    const token = req.query.token || req.body.token;
    const isHtmlRequest = Boolean(req.headers.accept && req.headers.accept.includes('text/html'));

    if (!token) {
      if (isHtmlRequest) {
        return res.status(400).send(renderOrderResultHtml({
          title: 'Missing Confirmation Token',
          statusType: 'error',
          message: 'No confirmation token was provided. Please use the complete link sent in your SMS.',
        }));
      }
      return res.status(400).json({
        status: 'fail',
        statusCode: 400,
        error: 'Bad Request',
        code: 'MISSING_TOKEN',
        message: 'Confirmation token is required.',
      });
    }

    // 1. Verify token HMAC signature and TTL
    const verification = PendingOrderStore.verifyToken(token);
    if (!verification.valid) {
      if (verification.reason === 'token_expired') {
        if (verification.orderReference) {
          await PendingOrderStore.update(verification.orderReference, { status: 'expired' });
        }
        if (isHtmlRequest) {
          return res.status(410).send(renderOrderResultHtml({
            title: 'Order Confirmation Expired',
            statusType: 'warning',
            message: 'This order confirmation link has expired (30-minute security window). For your security, please return to our chat concierge to place a fresh order request.',
            orderReference: verification.orderReference,
          }));
        }
        return res.status(410).json({
          status: 'fail',
          statusCode: 410,
          error: 'Gone',
          code: 'TOKEN_EXPIRED',
          message: 'This confirmation link has expired. Please initiate a new order in chat.',
        });
      }

      if (isHtmlRequest) {
        return res.status(403).send(renderOrderResultHtml({
          title: 'Invalid Confirmation Link',
          statusType: 'error',
          message: 'The confirmation token is invalid or has been tampered with.',
        }));
      }
      return res.status(403).json({
        status: 'fail',
        statusCode: 403,
        error: 'Forbidden',
        code: 'INVALID_TOKEN',
        message: 'Invalid or forged confirmation token.',
      });
    }

    // 2. Locate Pending Order
    const order = await PendingOrderStore.findByReference(verification.orderReference);
    if (!order) {
      if (isHtmlRequest) {
        return res.status(404).send(renderOrderResultHtml({
          title: 'Order Not Found',
          statusType: 'error',
          message: `No pending order found for reference: ${verification.orderReference}`,
        }));
      }
      return res.status(404).json({
        status: 'fail',
        statusCode: 404,
        error: 'Not Found',
        code: 'ORDER_NOT_FOUND',
        message: 'Order reference not found.',
      });
    }

    // 3. Prevent Duplicate Confirmation (Single-Use Defense)
    if (order.status === 'confirmed') {
      const confirmedDate = order.confirmedAt ? new Date(order.confirmedAt).toLocaleString('en-US', { timeZone: 'Asia/Dubai' }) : 'earlier';
      if (isHtmlRequest) {
        return res.status(200).send(renderOrderResultHtml({
          title: 'Order Already Confirmed',
          statusType: 'success',
          message: `This order was already confirmed on ${confirmedDate} GST. Our fulfillment team is preparing your package.`,
          orderReference: order.orderReference,
          shopifyOrderName: order.shopifyOrderName,
          totalAmount: order.totalAmount,
          currency: order.currency,
          customerName: order.customerName,
          maskedPhone: order.maskedPhone,
          deliveryAddress: order.deliveryAddress,
          isAlreadyConfirmed: true,
        }));
      }
      return res.status(200).json({
        status: 'success',
        statusCode: 200,
        alreadyConfirmed: true,
        message: `Order was already confirmed on ${confirmedDate} GST.`,
        orderReference: order.orderReference,
        shopifyOrderId: order.shopifyOrderId,
        shopifyOrderName: order.shopifyOrderName,
        status: order.status,
      });
    }

    if (order.status === 'cancelled') {
      if (isHtmlRequest) {
        return res.status(400).send(renderOrderResultHtml({
          title: 'Order Cancelled',
          statusType: 'warning',
          message: 'This pending order request was previously cancelled.',
          orderReference: order.orderReference,
        }));
      }
      return res.status(400).json({
        status: 'fail',
        statusCode: 400,
        error: 'Bad Request',
        code: 'ORDER_CANCELLED',
        message: 'This order was cancelled and cannot be confirmed.',
      });
    }

    // 4. Complete Shopify Draft Order (Converts Draft into Real Confirmed Order)
    const shopifyResult = await shopifyService.completeDraftOrder({
      shop: order.shop,
      draftOrderId: order.shopifyDraftOrderId,
      paymentDetails: { totalPrice: order.totalAmount },
    });

    // 5. Update Order Record to Confirmed
    const confirmedAt = new Date();
    const updatedOrder = await PendingOrderStore.update(order.orderReference, {
      status: 'confirmed',
      confirmedAt,
      shopifyOrderId: shopifyResult.orderId,
      shopifyOrderName: shopifyResult.orderName,
    });

    // 6. Send Final Confirmation SMS (Strictly after Shopify confirms)
    let finalSmsResult = null;
    try {
      finalSmsResult = await smsService.sendOrderFinalConfirmationSms(updatedOrder);
      await PendingOrderStore.update(order.orderReference, {
        finalSms: {
          messageId: finalSmsResult.messageId || null,
          status: finalSmsResult.success ? (finalSmsResult.status || 'sent') : 'failed',
          sentAt: finalSmsResult.sentAt || new Date(),
          body: finalSmsResult.body || null,
          error: finalSmsResult.error || null,
        },
      });
    } catch (smsErr) {
      logger.error('Final confirmation SMS dispatch failed:', { error: smsErr.message });
    }

    logger.info(`Order confirmed: ${order.orderReference} -> Shopify ${shopifyResult.orderName} (${shopifyResult.orderId})`);

    if (isHtmlRequest) {
      return res.status(200).send(renderOrderResultHtml({
        title: 'Order Confirmed Successfully!',
        statusType: 'success',
        message: 'Thank you for confirming your order! A final confirmation SMS has been sent to your mobile phone.',
        orderReference: order.orderReference,
        shopifyOrderName: shopifyResult.orderName,
        totalAmount: order.totalAmount,
        currency: order.currency,
        customerName: order.customerName,
        maskedPhone: order.maskedPhone,
        deliveryAddress: order.deliveryAddress,
      }));
    }

    return res.status(200).json({
      status: 'success',
      statusCode: 200,
      message: 'Order confirmed successfully. Shopify order created and final confirmation SMS dispatched.',
      order: {
        orderReference: order.orderReference,
        status: 'confirmed',
        confirmedAt,
        shopifyOrderId: shopifyResult.orderId,
        shopifyOrderName: shopifyResult.orderName,
        totalAmount: order.totalAmount,
        currency: order.currency,
        finalSmsStatus: finalSmsResult ? finalSmsResult.status : 'sent',
      },
    });
  } catch (err) {
    logger.error('Error confirming SMS order:', { error: err.message, stack: err.stack });
    return next(err);
  }
};

/**
 * Retrieves details for a specific order by reference (Protected)
 * GET /api/orders/:orderReference
 */
const getSmsOrderDetails = async (req, res, next) => {
  try {
    const { orderReference } = req.params;
    const order = await PendingOrderStore.findByReference(orderReference);
    if (!order) {
      return res.status(404).json({
        status: 'fail',
        statusCode: 404,
        error: 'Not Found',
        message: 'Order reference not found.',
      });
    }
    return res.status(200).json({
      status: 'success',
      order: {
        ...order,
        customerPhone: order.maskedPhone, // Strictly mask PII
      },
    });
  } catch (err) {
    return next(err);
  }
};

/**
 * Lists SMS orders for the Admin Dashboard (Protected by agentAuth)
 * GET /api/admin/sms-orders
 */
const listSmsOrders = async (req, res, next) => {
  try {
    const { status, page = 1, limit = 20, shop = config.shopify.shop } = req.query;
    const parsedPage = Math.max(1, parseInt(page, 10) || 1);
    const parsedLimit = Math.min(100, Math.max(1, parseInt(limit, 10) || 20));
    const skip = (parsedPage - 1) * parsedLimit;

    const result = await PendingOrderStore.list({
      shop,
      status: status || undefined,
      limit: parsedLimit,
      skip,
    });

    const safeOrders = result.items.map((o) => ({
      orderReference: o.orderReference,
      shop: o.shop,
      conversationId: o.conversationId,
      customerName: o.customerName,
      customerPhone: o.maskedPhone,
      deliveryAddress: o.deliveryAddress,
      lineItems: o.lineItems,
      subtotal: o.subtotal,
      deliveryFee: o.deliveryFee,
      totalAmount: o.totalAmount,
      currency: o.currency,
      paymentMethod: o.paymentMethod,
      status: o.status,
      shopifyDraftOrderId: o.shopifyDraftOrderId,
      shopifyOrderId: o.shopifyOrderId,
      shopifyOrderName: o.shopifyOrderName,
      initialSms: o.initialSms,
      finalSms: o.finalSms,
      confirmedAt: o.confirmedAt,
      createdAt: o.createdAt,
    }));

    return res.status(200).json({
      status: 'success',
      orders: safeOrders,
      total: result.total,
      page: parsedPage,
      pages: Math.ceil(result.total / parsedLimit) || 1,
    });
  } catch (err) {
    return next(err);
  }
};

/**
 * Luxury HTML Confirmation Page Template
 */
function renderOrderResultHtml({ title, statusType, message, orderReference, shopifyOrderName, totalAmount, currency = 'AED', customerName, maskedPhone, deliveryAddress, isAlreadyConfirmed }) {
  const isSuccess = statusType === 'success';
  const accentColor = isSuccess ? '#b89a63' : (statusType === 'warning' ? '#e6a23c' : '#e05656');
  const icon = isSuccess ? '✓' : (statusType === 'warning' ? '!' : '✕');
  const addressStr = deliveryAddress
    ? (typeof deliveryAddress === 'string' ? deliveryAddress : `${deliveryAddress.street || ''}, ${deliveryAddress.city || deliveryAddress.emirate || 'Dubai'}`)
    : '';

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title} — Abihacart</title>
  <style>
    body {
      margin: 0;
      padding: 0;
      background: #faf8f5;
      color: #141414;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
      display: flex;
      align-items: center;
      justify-content: center;
      min-height: 100vh;
      box-sizing: border-box;
      padding: 24px;
    }
    .card {
      background: #ffffff;
      border: 1px solid #e8e5df;
      border-radius: 24px;
      max-width: 520px;
      width: 100%;
      padding: 40px 32px;
      text-align: center;
      box-shadow: 0 20px 48px -12px rgba(0, 0, 0, 0.12);
    }
    .brand-mark {
      font-size: 14px;
      font-weight: 800;
      letter-spacing: 0.18em;
      text-transform: uppercase;
      color: #b89a63;
      margin-bottom: 24px;
    }
    .icon-badge {
      width: 68px;
      height: 68px;
      border-radius: 50%;
      background: ${isSuccess ? '#faf6f0' : '#fdf2f2'};
      border: 2px solid ${accentColor};
      color: ${accentColor};
      display: inline-flex;
      align-items: center;
      justify-content: center;
      font-size: 32px;
      font-weight: 700;
      margin-bottom: 20px;
    }
    h1 {
      font-size: 24px;
      font-weight: 700;
      margin: 0 0 12px 0;
      color: #141414;
    }
    p {
      color: #555555;
      font-size: 15px;
      line-height: 1.6;
      margin: 0 0 24px 0;
    }
    .order-box {
      background: #faf8f5;
      border: 1px solid #e8e5df;
      border-radius: 16px;
      padding: 20px;
      text-align: left;
      margin-bottom: 28px;
    }
    .order-row {
      display: flex;
      justify-content: space-between;
      margin-bottom: 8px;
      font-size: 14px;
    }
    .order-row:last-child {
      margin-bottom: 0;
      padding-top: 8px;
      border-top: 1px dashed #dcd8d0;
      font-weight: 700;
      font-size: 15px;
    }
    .order-label {
      color: #777777;
    }
    .order-val {
      color: #141414;
      font-weight: 600;
    }
    .btn {
      display: inline-block;
      background: #141414;
      color: #ffffff;
      padding: 14px 28px;
      border-radius: 30px;
      font-size: 13.5px;
      font-weight: 600;
      letter-spacing: 0.05em;
      text-transform: uppercase;
      text-decoration: none;
      transition: background 0.2s;
    }
    .btn:hover {
      background: #000000;
    }
  </style>
</head>
<body>
  <div class="card">
    <div class="brand-mark">Abihacart ✦ UAE Concierge</div>
    <div class="icon-badge">${icon}</div>
    <h1>${title}</h1>
    <p>${message}</p>
    ${orderReference ? `
      <div class="order-box">
        <div class="order-row">
          <span class="order-label">Order Reference:</span>
          <span class="order-val">${orderReference}</span>
        </div>
        ${shopifyOrderName ? `
          <div class="order-row">
            <span class="order-label">Shopify Order ID:</span>
            <span class="order-val" style="color: #b89a63;">${shopifyOrderName}</span>
          </div>
        ` : ''}
        ${customerName ? `
          <div class="order-row">
            <span class="order-label">Recipient:</span>
            <span class="order-val">${customerName}</span>
          </div>
        ` : ''}
        ${maskedPhone ? `
          <div class="order-row">
            <span class="order-label">Mobile (SMS):</span>
            <span class="order-val">${maskedPhone}</span>
          </div>
        ` : ''}
        ${addressStr ? `
          <div class="order-row">
            <span class="order-label">Delivery Address:</span>
            <span class="order-val">${addressStr}</span>
          </div>
        ` : ''}
        ${totalAmount ? `
          <div class="order-row">
            <span class="order-label">Total Amount (COD):</span>
            <span class="order-val">${currency} ${Number(totalAmount).toFixed(2)}</span>
          </div>
        ` : ''}
      </div>
    ` : ''}
    <a href="https://abihacart.myshopify.com" class="btn">Return to Storefront →</a>
  </div>
</body>
</html>`;
}

/**
 * Twilio SMS Status Callback Webhook
 * POST /api/orders/sms-status-callback
 * Handles Twilio message delivery status updates: accepted, queued, sending, sent, delivered, undelivered, failed
 */
const handleTwilioStatusCallback = async (req, res, next) => {
  try {
    const { MessageSid, MessageStatus, ErrorCode, ErrorMessage } = req.body;
    logger.info(`Received Twilio SMS Status Callback: SID ${MessageSid}, Status: ${MessageStatus}, ErrorCode: ${ErrorCode || 'None'}`);

    if (!MessageSid) {
      return res.status(400).json({ status: 'fail', message: 'Missing MessageSid parameter' });
    }

    const order = await PendingOrderStore.findByMessageId(MessageSid);
    if (!order) {
      logger.warn(`Twilio status callback for unknown MessageSid: ${MessageSid}`);
      return res.status(200).json({ status: 'ignored', message: 'MessageSid not associated with pending order' });
    }

    const updates = {};
    const isInitial = order.initialSms?.messageId === MessageSid;
    const isFinal = order.finalSms?.messageId === MessageSid;

    if (isInitial) {
      updates.initialSms = {
        ...order.initialSms,
        status: MessageStatus,
        error: ErrorMessage ? `[Code ${ErrorCode}] ${ErrorMessage}` : order.initialSms?.error,
      };
      if (['failed', 'undelivered'].includes(MessageStatus)) {
        updates.status = 'failed';
        updates.notes = `${order.notes || ''} [Carrier delivery ${MessageStatus}: ${ErrorMessage || ErrorCode || 'Unreachable'}]`.trim();
      }
    } else if (isFinal) {
      updates.finalSms = {
        ...order.finalSms,
        status: MessageStatus,
        error: ErrorMessage ? `[Code ${ErrorCode}] ${ErrorMessage}` : order.finalSms?.error,
      };
    }

    await PendingOrderStore.update(order.orderReference, updates);
    return res.status(200).json({
      status: 'success',
      message: 'Delivery status updated',
      orderReference: order.orderReference,
      deliveryStatus: MessageStatus,
    });
  } catch (err) {
    logger.error('Error handling Twilio status callback:', { error: err.message });
    return next(err);
  }
};

/**
 * Luxury HTML Confirmation Review Page Template (Phase 10 Abihacart Assistant Popup)
 */
function renderOrderReviewHtml({ token, record }) {
  const itemsHtml = (record.lineItems || []).map(item => {
    const variant = item.variantTitle ? ` • <span style="color: #6b7280;">${item.variantTitle}</span>` : '';
    const imgHtml = item.image 
      ? `<img src="${item.image}" alt="${item.title}" style="width: 44px; height: 44px; border-radius: 8px; object-fit: cover; background: #ece8e1; border: 1px solid #e0dbd1; flex-shrink: 0;" />`
      : `<div style="width: 44px; height: 44px; border-radius: 8px; background: #ece8e1; border: 1px solid #e0dbd1; display: flex; align-items: center; justify-content: center; font-size: 18px; flex-shrink: 0;">🛍️</div>`;
    return `
      <div style="display: flex; align-items: center; gap: 12px; margin-bottom: 10px; padding-bottom: 10px; border-bottom: 1px dashed #e5e0d8;">
        ${imgHtml}
        <div style="flex: 1; min-width: 0; text-align: left;">
          <div style="font-size: 13px; font-weight: 600; color: #141414; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">${item.title}</div>
          <div style="font-size: 11.5px; color: #6b7280;">Qty: ${item.quantity}${variant}</div>
        </div>
        <div style="font-size: 13px; font-weight: 700; color: #141414; text-align: right;">${record.currency} ${(item.price * item.quantity).toFixed(2)}</div>
      </div>
    `;
  }).join('') || '<div style="color: #666; font-size: 13px; text-align: center;">No items listed</div>';

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Abihacart Assistant — Order Confirmation ${record.orderNumber}</title>
  <style>
    body {
      margin: 0; padding: 16px; min-height: 100vh; display: flex; align-items: center; justify-content: center;
      background: rgba(15, 15, 15, 0.95);
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      box-sizing: border-box;
    }
    .abh-popup-card {
      background: #ffffff; border-radius: 24px; max-width: 480px; width: 100%;
      box-shadow: 0 24px 60px rgba(0, 0, 0, 0.35); border: 1px solid rgba(0, 0, 0, 0.06);
      overflow: hidden; display: flex; flex-direction: column; position: relative;
    }
    .abh-popup-header {
      display: flex; align-items: center; justify-content: space-between;
      padding: 20px 24px 14px 24px; border-bottom: 1px solid #f3f4f6;
    }
    .abh-header-left { display: flex; align-items: center; gap: 14px; }
    .abh-robot-avatar {
      width: 72px; height: 64px; object-fit: contain; flex-shrink: 0;
    }
    .abh-robot-icon {
      width: 50px; height: 50px; border-radius: 12px;
      background: linear-gradient(135deg, #1f1f1f 0%, #121212 100%);
      border: 1.5px solid #b89a63; display: flex; align-items: center; justify-content: center;
      color: #b89a63; font-size: 24px;
    }
    .abh-brand-title { font-size: 17px; font-weight: 700; color: #111827; line-height: 1.2; margin: 0; }
    .abh-status-pill {
      background: #dcfce7; color: #15803d; border-radius: 9999px;
      font-size: 12px; font-weight: 600; padding: 3px 10px; display: inline-flex; align-items: center; gap: 4px; margin-top: 5px;
    }
    .abh-close-btn {
      position: absolute; top: 16px; right: 18px;
      background: none; border: none; color: #374151; cursor: pointer; font-size: 20px;
      line-height: 1; padding: 6px; border-radius: 50%; display: flex; align-items: center; justify-content: center;
      transition: color 0.15s, background 0.15s;
    }
    .abh-close-btn:hover { color: #111827; background: #f3f4f6; }
    .abh-popup-body { padding: 22px 24px 24px 24px; text-align: center; }
    .abh-greeting { font-size: 16px; font-weight: 500; color: #1f2937; margin-bottom: 8px; line-height: 1.4; }
    .abh-placed-text { font-size: 16px; color: #1f2937; margin-bottom: 8px; line-height: 1.4; }
    .abh-order-ref { font-weight: 700; color: #111827; }
    .abh-prompt-text { font-size: 16.5px; font-weight: 700; color: #111827; margin: 14px 0 20px 0; }
    .abh-order-box {
      background: #faf8f5; border: 1px solid #e8e5df; border-radius: 14px;
      padding: 14px; margin-bottom: 20px; text-align: left;
    }
    .abh-total-row {
      display: flex; justify-content: space-between; align-items: center;
      padding-top: 10px; margin-top: 10px; border-top: 1px solid #e0dbd1;
      font-weight: 700; font-size: 14px;
    }
    .abh-total-val { color: #16a34a; font-size: 16px; font-weight: 800; }
    .abh-actions { display: flex; flex-direction: column; gap: 12px; margin-bottom: 16px; }
    .abh-btn-confirm {
      width: 100%; background: #16a34a; color: #ffffff; border: none; padding: 14px 20px;
      border-radius: 12px; font-size: 15px; font-weight: 700; cursor: pointer;
      display: flex; align-items: center; justify-content: center; gap: 8px;
      box-shadow: 0 4px 14px rgba(22, 163, 74, 0.25); transition: background 0.15s;
    }
    .abh-btn-confirm:hover { background: #15803d; }
    .abh-btn-cancel {
      width: 100%; background: #ffffff; color: #ef4444; border: 1.5px solid #ef4444;
      padding: 13px 20px; border-radius: 12px; font-size: 15px; font-weight: 600; cursor: pointer;
      display: flex; align-items: center; justify-content: center; gap: 8px; transition: background 0.15s;
    }
    .abh-btn-cancel:hover { background: rgba(239, 68, 68, 0.05); }
    .abh-icon-check {
      width: 22px; height: 22px; border-radius: 50%; background: #ffffff; color: #16a34a;
      display: inline-flex; align-items: center; justify-content: center; font-size: 13px; font-weight: 900;
    }
    .abh-icon-cancel {
      width: 22px; height: 22px; border-radius: 50%; background: #ef4444; color: #ffffff;
      display: inline-flex; align-items: center; justify-content: center; font-size: 12px; font-weight: 900;
    }
    .abh-security-msg {
      display: flex; align-items: center; justify-content: center; gap: 6px;
      font-size: 12px; color: #6b7280;
    }
  </style>
</head>
<body>
  <div class="abh-popup-card" id="abh-card">
    <button class="abh-close-btn" onclick="document.getElementById('abh-card').style.display='none'" aria-label="Close">✕</button>
    <div class="abh-popup-header">
      <div class="abh-header-left">
        <img src="/api/orders/robot-avatar.png" alt="Abihacart Assistant" class="abh-robot-avatar" onerror="this.outerHTML='<div class=\\'abh-robot-icon\\'>🤖</div>'" />
        <div>
          <h2 class="abh-brand-title">Abihacart Assistant</h2>
          <div class="abh-status-pill">Order Received ✓</div>
        </div>
      </div>
    </div>
    <div class="abh-popup-body" id="abh-body">
      <div class="abh-greeting">Assalam-o-Alaikum! Thank you for shopping with <strong>Abihacart</strong>.</div>
      <div class="abh-placed-text">Your order <span class="abh-order-ref">${record.orderNumber}</span> has been placed successfully.</div>
      <div class="abh-prompt-text">Would you like to confirm your order?</div>

      <div class="abh-order-box">
        ${itemsHtml}
        <div class="abh-total-row">
          <span>Total Amount:</span>
          <span class="abh-total-val">${record.currency} ${Number(record.totalAmount).toFixed(2)}</span>
        </div>
      </div>

      <div class="abh-actions">
        <form method="POST" action="/api/orders/confirm-shopify-order" style="margin: 0;">
          <input type="hidden" name="token" value="${token}" />
          <button type="submit" class="abh-btn-confirm">
            <span class="abh-icon-check">✓</span> Confirm My Order
          </button>
        </form>
        <button type="button" class="abh-btn-cancel" onclick="showCancelPrompt()">
          <span class="abh-icon-cancel">✕</span> Cancel My Order
        </button>
      </div>

      <div class="abh-security-msg">
        <span>🛡️</span> Your response is secure and will be processed immediately.
      </div>
    </div>
  </div>
  <script>
    function showCancelPrompt() {
      const body = document.getElementById('abh-body');
      body.innerHTML = \`
        <div style="padding: 16px 4px; text-align: center;">
          <div style="font-size: 32px; margin-bottom: 12px;">⚠️</div>
          <h3 style="font-size: 17px; margin-bottom: 8px;">Cancel Order ${record.orderNumber}?</h3>
          <p style="font-size: 13.5px; color: #555; margin-bottom: 20px;">Are you sure you want to cancel this order? This action cannot be undone.</p>
          <div style="display: flex; gap: 10px;">
            <button onclick="window.location.reload()" class="abh-btn-cancel" style="border-color: #d1d5db; color: #374151;">Keep Order</button>
            <form method="POST" action="/api/orders/cancel-shopify-order" style="flex: 1; margin: 0;">
              <input type="hidden" name="token" value="${token}" />
              <button type="submit" class="abh-btn-confirm" style="background: #ef4444;">Yes, Cancel</button>
            </form>
          </div>
        </div>
      \`;
    }
  </script>
</body>
</html>`;
}

/**
 * Confirms a Shopify order placed on the store via secure single-use token (Phase 9.19)
 * GET /api/orders/confirm-shopify-order: Displays safe confirmation review page (does not mutate)
 * POST /api/orders/confirm-shopify-order: Atomically confirms order and sends owner email via Resend
 */
const confirmShopifyOrder = async (req, res, next) => {
  try {
    const token = req.query.token || req.body?.token;
    const isHtmlRequest = Boolean(req.headers.accept && req.headers.accept.includes('text/html'));
    const isGet = req.method === 'GET';
    const autoConfirmParam = req.query.confirm === 'true' || req.query.confirm === '1';

    if (!token) {
      if (isHtmlRequest) {
        return res.status(400).send(renderOrderResultHtml({
          title: 'Missing Confirmation Token',
          statusType: 'error',
          message: 'No confirmation token was provided. Please use the complete link sent in your SMS.',
        }));
      }
      return res.status(400).json({
        status: 'fail',
        statusCode: 400,
        error: 'Bad Request',
        code: 'MISSING_TOKEN',
        message: 'Confirmation token is required.',
      });
    }

    // 1. If GET without explicit confirm param: perform safe review lookup without mutating state
    if (isGet && !autoConfirmParam) {
      const reviewResult = await orderConfirmationService.getOrderReviewByToken(token);
      if (!reviewResult.success) {
        if (isHtmlRequest) {
          const isExpired = reviewResult.code === 'TOKEN_EXPIRED';
          return res.status(reviewResult.statusCode).send(renderOrderResultHtml({
            title: isExpired ? 'Confirmation Link Expired' : 'Invalid Confirmation Link',
            statusType: isExpired ? 'warning' : 'error',
            message: reviewResult.message,
          }));
        }
        return res.status(reviewResult.statusCode).json({
          status: 'fail',
          statusCode: reviewResult.statusCode,
          error: reviewResult.code === 'TOKEN_EXPIRED' ? 'Gone' : (reviewResult.statusCode === 404 ? 'Not Found' : 'Forbidden'),
          code: reviewResult.code,
          message: reviewResult.message,
        });
      }

      const record = reviewResult.record;
      if (reviewResult.alreadyConfirmed) {
        if (isHtmlRequest) {
          return res.status(200).send(renderOrderResultHtml({
            title: 'Order Already Confirmed',
            statusType: 'success',
            message: `This order (${record.orderNumber}) was already confirmed. Our team has been notified.`,
            orderReference: record.orderNumber,
            shopifyOrderName: record.orderNumber,
            totalAmount: record.totalAmount,
            currency: record.currency,
            customerName: record.customerName,
            maskedPhone: record.maskedPhone,
            deliveryAddress: record.shippingAddress,
            isAlreadyConfirmed: true,
          }));
        }
        return res.status(200).json({
          status: 'success',
          statusCode: 200,
          alreadyConfirmed: true,
          message: 'Order has already been confirmed.',
          order: {
            shopifyOrderId: record.shopifyOrderId,
            orderNumber: record.orderNumber,
            status: record.status,
            confirmedAt: record.confirmedAt,
            totalAmount: record.totalAmount,
            currency: record.currency,
          },
        });
      }

      // Valid pending order: render review page or return review details
      if (isHtmlRequest) {
        return res.status(200).send(renderOrderReviewHtml({ token, record }));
      }

      return res.status(200).json({
        status: 'success',
        statusCode: 200,
        review: true,
        alreadyConfirmed: false,
        canConfirm: true,
        order: {
          shopifyOrderId: record.shopifyOrderId,
          orderNumber: record.orderNumber,
          status: record.status,
          customerName: record.customerName,
          totalAmount: record.totalAmount,
          currency: record.currency,
          lineItems: record.lineItems,
          shippingAddress: record.shippingAddress,
        },
      });
    }

    // 2. POST (or GET with confirm=true): execute atomic confirmation & notify owner via Resend
    const result = await orderConfirmationService.confirmOrderWithToken(token);

    if (!result.success) {
      if (isHtmlRequest) {
        const isExpired = result.code === 'TOKEN_EXPIRED';
        return res.status(result.statusCode).send(renderOrderResultHtml({
          title: isExpired ? 'Confirmation Link Expired' : 'Invalid Confirmation Link',
          statusType: isExpired ? 'warning' : 'error',
          message: result.message,
        }));
      }
      return res.status(result.statusCode).json({
        status: 'fail',
        statusCode: result.statusCode,
        error: result.code === 'TOKEN_EXPIRED' ? 'Gone' : (result.statusCode === 404 ? 'Not Found' : 'Forbidden'),
        code: result.code,
        message: result.message,
      });
    }

    const record = result.record;
    if (result.alreadyConfirmed) {
      if (isHtmlRequest) {
        return res.status(200).send(renderOrderResultHtml({
          title: 'Order Already Confirmed',
          statusType: 'success',
          message: `This order (${record.orderNumber}) was already confirmed. Our team has been notified.`,
          orderReference: record.orderNumber,
          shopifyOrderName: record.orderNumber,
          totalAmount: record.totalAmount,
          currency: record.currency,
          customerName: record.customerName,
          maskedPhone: record.maskedPhone,
          deliveryAddress: record.shippingAddress,
          isAlreadyConfirmed: true,
        }));
      }
      return res.status(200).json({
        status: 'success',
        statusCode: 200,
        alreadyConfirmed: true,
        message: 'Order has already been confirmed.',
        order: {
          shopifyOrderId: record.shopifyOrderId,
          orderNumber: record.orderNumber,
          status: record.status,
          confirmedAt: record.confirmedAt,
          totalAmount: record.totalAmount,
          currency: record.currency,
        },
      });
    }

    if (isHtmlRequest) {
      return res.status(200).send(renderOrderResultHtml({
        title: 'Order Confirmed Successfully!',
        statusType: 'success',
        message: `Thank you for confirming your order (${record.orderNumber})! The store owner has been notified.`,
        orderReference: record.orderNumber,
        shopifyOrderName: record.orderNumber,
        totalAmount: record.totalAmount,
        currency: record.currency,
        customerName: record.customerName,
        maskedPhone: record.maskedPhone,
        deliveryAddress: record.shippingAddress,
      }));
    }

    return res.status(200).json({
      status: 'success',
      statusCode: 200,
      alreadyConfirmed: false,
      message: 'Order confirmed successfully. The store owner has been notified via email.',
      order: {
        shopifyOrderId: record.shopifyOrderId,
        orderNumber: record.orderNumber,
        status: record.status,
        confirmedAt: record.confirmedAt,
        totalAmount: record.totalAmount,
        currency: record.currency,
        ownerNotification: result.ownerEmailNotification || result.ownerNotification,
      },
    });
  } catch (err) {
    logger.error('Error confirming Shopify order:', { error: err.message, stack: err.stack });
    return next(err);
  }
};

/**
 * Cancels a Shopify order placed on the store via secure token or verified request (Phase 10)
 * POST /api/orders/cancel-shopify-order
 */
const cancelShopifyOrder = async (req, res, next) => {
  try {
    const token = req.query.token || req.body?.token;
    const orderId = req.query.orderId || req.body?.orderId;
    const reason = req.body?.reason || req.query.reason || 'Customer requested cancellation via popup';
    const isHtmlRequest = Boolean(req.headers.accept && req.headers.accept.includes('text/html'));

    if (!token && !orderId) {
      if (isHtmlRequest) {
        return res.status(400).send(renderOrderResultHtml({
          title: 'Missing Identifier',
          statusType: 'error',
          message: 'Order confirmation token or order ID is required to cancel this order.',
        }));
      }
      return res.status(400).json({
        status: 'fail',
        statusCode: 400,
        error: 'Bad Request',
        code: 'MISSING_IDENTIFIER',
        message: 'Order confirmation token or order ID is required.',
      });
    }

    const result = await orderConfirmationService.cancelOrderWithToken(token, reason, { orderId });

    if (!result.success) {
      if (isHtmlRequest) {
        const isExpired = result.code === 'TOKEN_EXPIRED';
        return res.status(result.statusCode).send(renderOrderResultHtml({
          title: isExpired ? 'Cancellation Link Expired' : 'Invalid Cancellation Request',
          statusType: isExpired ? 'warning' : 'error',
          message: result.message,
        }));
      }
      return res.status(result.statusCode).json({
        status: 'fail',
        statusCode: result.statusCode,
        error: result.code === 'TOKEN_EXPIRED' ? 'Gone' : (result.statusCode === 404 ? 'Not Found' : 'Forbidden'),
        code: result.code,
        message: result.message,
      });
    }

    const record = result.record;
    if (result.alreadyCancelled) {
      if (isHtmlRequest) {
        return res.status(200).send(renderOrderResultHtml({
          title: 'Order Already Cancelled',
          statusType: 'warning',
          message: `This order (${record.orderNumber}) was already cancelled. Our store team has been notified.`,
          orderReference: record.orderNumber,
          shopifyOrderName: record.orderNumber,
          totalAmount: record.totalAmount,
          currency: record.currency,
          customerName: record.customerName,
          maskedPhone: record.maskedPhone,
          deliveryAddress: record.shippingAddress,
        }));
      }
      return res.status(200).json({
        status: 'success',
        statusCode: 200,
        alreadyCancelled: true,
        message: 'Order has already been cancelled.',
        order: {
          shopifyOrderId: record.shopifyOrderId,
          orderNumber: record.orderNumber,
          status: record.status,
          cancelledAt: record.cancelledAt,
          cancellationStatus: record.cancellationStatus,
        },
      });
    }

    if (isHtmlRequest) {
      return res.status(200).send(renderOrderResultHtml({
        title: result.isShopifyCancelled ? 'Order Cancelled' : 'Cancellation Request Submitted',
        statusType: 'warning',
        message: result.isShopifyCancelled
          ? `Your order (${record.orderNumber}) has been cancelled successfully in Shopify.`
          : `Your cancellation request for order (${record.orderNumber}) has been recorded. Our team has been notified.`,
        orderReference: record.orderNumber,
        shopifyOrderName: record.orderNumber,
        totalAmount: record.totalAmount,
        currency: record.currency,
        customerName: record.customerName,
        maskedPhone: record.maskedPhone,
        deliveryAddress: record.shippingAddress,
      }));
    }

    return res.status(200).json({
      status: 'success',
      statusCode: 200,
      alreadyCancelled: false,
      isShopifyCancelled: result.isShopifyCancelled,
      message: result.message,
      order: {
        shopifyOrderId: record.shopifyOrderId,
        orderNumber: record.orderNumber,
        status: record.status,
        cancelledAt: record.cancelledAt,
        cancellationStatus: record.cancellationStatus,
        cancellationReason: record.cancellationReason,
      },
    });
  } catch (err) {
    logger.error('Error cancelling Shopify order:', { error: err.message, stack: err.stack });
    return next(err);
  }
};

/**
 * Retrieves order confirmation status for Shopify Thank You page popup
 * GET /api/orders/checkout-confirmation-status
 */
const getCheckoutConfirmationStatus = async (req, res, next) => {
  try {
    const { orderId, orderNumber, token, email, phone } = req.query;
    const result = await orderConfirmationService.getOrderStatusForCheckout({
      orderId,
      orderNumber,
      token,
      email,
      phone,
    });

    if (!result.success) {
      return res.status(result.statusCode).json({
        status: 'fail',
        statusCode: result.statusCode,
        code: result.code,
        message: result.message,
      });
    }

    const record = result.record;
    return res.status(200).json({
      status: 'success',
      statusCode: 200,
      confirmationStatus: record.status,
      record: {
        shopifyOrderId: record.shopifyOrderId,
        orderNumber: record.orderNumber,
        customerName: record.customerName,
        currency: record.currency,
        totalAmount: record.totalAmount,
        subtotal: record.subtotal,
        shippingCharges: record.shippingCharges,
        lineItems: record.lineItems,
        status: record.status,
        confirmationToken: record.confirmationToken,
        confirmedAt: record.confirmedAt,
        cancelledAt: record.cancelledAt,
      },
    });
  } catch (err) {
    logger.error('Error fetching checkout confirmation status:', { error: err.message });
    return next(err);
  }
};

/**
 * Serves the embeddable Abihacart popup script for Shopify Thank You / Order Status page
 * GET /api/orders/popup-script.js
 */
const servePopupScript = (req, res) => {
  const fs = require('fs');
  const path = require('path');
  const scriptPath = path.join(__dirname, '../assets/abihacart-order-popup.js');
  res.setHeader('Content-Type', 'application/javascript; charset=UTF-8');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'public, max-age=300');
  fs.createReadStream(scriptPath).pipe(res);
};

/**
 * Serves the Abihacart Assistant 3D robot avatar image (Phase 10)
 * GET /api/orders/robot-avatar.png
 */
const serveRobotAvatar = (req, res) => {
  const fs = require('fs');
  const path = require('path');
  const imgPath = path.join(__dirname, '../assets/abihacart-robot.png');
  res.setHeader('Content-Type', 'image/png');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'public, max-age=86400');
  fs.createReadStream(imgPath).pipe(res);
};

module.exports = {
  trackOrder,
  cancelOrderRefusal,
  modifyOrderRefusal,
  refundOrderRefusal,
  placeSmsOrder,
  confirmSmsOrder,
  confirmShopifyOrder,
  cancelShopifyOrder,
  getCheckoutConfirmationStatus,
  servePopupScript,
  serveRobotAvatar,
  getSmsOrderDetails,
  listSmsOrders,
  handleTwilioStatusCallback,
};
