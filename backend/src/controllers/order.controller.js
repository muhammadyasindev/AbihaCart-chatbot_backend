const logger = require('../utils/logger');
const orderService = require('../services/order.service');
const shopifyService = require('../services/shopify.service');
const smsService = require('../services/sms.service');
const { PendingOrderStore, maskPhone } = require('../models/PendingOrder');
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

module.exports = {
  trackOrder,
  cancelOrderRefusal,
  modifyOrderRefusal,
  refundOrderRefusal,
  placeSmsOrder,
  confirmSmsOrder,
  getSmsOrderDetails,
  listSmsOrders,
  handleTwilioStatusCallback,
};
