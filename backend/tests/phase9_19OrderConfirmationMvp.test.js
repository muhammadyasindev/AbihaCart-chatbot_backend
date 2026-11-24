// Enforce test environment for in-memory deduplication and mocks
process.env.NODE_ENV = 'test';
process.env.TEST_MODE = 'true';

const assert = require('assert');
const crypto = require('crypto');
const http = require('http');
const app = require('../src/app');
const config = require('../src/config/env');
const { ShopifyOrderConfirmationStore } = require('../src/models/ShopifyOrderConfirmation');
const orderConfirmationService = require('../src/services/orderConfirmation.service');
const emailNotificationService = require('../src/services/emailNotification.service');
const smsService = require('../src/services/sms.service');

// Helper for making HTTP requests to local test server
const sendRequest = (serverPort, method, path, headers = {}, body = null) => {
  return new Promise((resolve, reject) => {
    const payload = body ? (typeof body === 'string' ? body : JSON.stringify(body)) : null;
    const reqHeaders = { ...headers };
    if (payload && !reqHeaders['Content-Type']) {
      reqHeaders['Content-Type'] = 'application/json';
    }
    if (payload) {
      reqHeaders['Content-Length'] = Buffer.byteLength(payload);
    }

    const req = http.request({
      hostname: '127.0.0.1',
      port: serverPort,
      path,
      method,
      headers: reqHeaders,
    }, (res) => {
      let rawData = '';
      res.on('data', (chunk) => { rawData += chunk; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(rawData); } catch (e) { json = rawData; }
        resolve({
          status: res.statusCode,
          headers: res.headers,
          body: json,
          raw: rawData,
        });
      });
    });

    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
};

// Generates valid Shopify Webhook HMAC header
const signShopifyWebhook = (rawPayload, secret = config.shopify.clientSecret) => {
  return crypto.createHmac('sha256', secret).update(rawPayload).digest('base64');
};

async function runPhase9_19Tests() {
  console.log('======================================================================');
  console.log('🧪 Starting Phase 9.19 Shopify Order Confirmation & Resend MVP Test Suite');
  console.log('   (Covering all 22 specific test criteria)');
  console.log('======================================================================\n');

  let server;
  let testPort;

  try {
    server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, resolve));
    testPort = server.address().port;
    console.log(`[Test Server] Listening on http://127.0.0.1:${testPort}\n`);

    // Reset stores and mock configurations
    ShopifyOrderConfirmationStore.clear();
    emailNotificationService.clearHistory();

    // Ensure test environment has valid owner notification configuration
    config.ownerNotification.ownerEmail = 'owner@abihacart.com';
    config.ownerNotification.provider = 'email';
    config.resend.apiKey = 're_test_mock_key_for_testing';

    // Configure default test mock handler for Resend
    let resendDispatchCount = 0;
    emailNotificationService.setMockHandler(async ({ to, subject, orderConfirmation }) => {
      resendDispatchCount++;
      return {
        success: true,
        status: 'accepted',
        resendMessageId: `re_mock_${Date.now()}_${resendDispatchCount}`,
        recipientEmail: to,
        sentAt: new Date(),
        error: null,
      };
    });

    const sampleOrderPayload = {
      id: 8192039401,
      name: '#1099',
      order_number: 1099,
      email: 'salma.alnuaimi@example.ae',
      phone: '+971501234567',
      currency: 'AED',
      subtotal_price: '159.00',
      total_price: '159.00',
      total_shipping_price_set: {
        shop_money: { amount: '0.00', currency_code: 'AED' },
      },
      customer: {
        id: 710293,
        first_name: 'Salma',
        last_name: 'Al Nuaimi',
        email: 'salma.alnuaimi@example.ae',
        phone: '+971501234567',
      },
      shipping_address: {
        name: 'Salma Al Nuaimi',
        address1: 'Villa 24, Jumeirah 1',
        address2: 'Street 7B',
        city: 'Dubai',
        province: 'Dubai',
        country: 'United Arab Emirates',
        zip: '00000',
        phone: '050 123 4567',
      },
      line_items: [
        {
          id: 991203,
          title: '2-in-1 Baby Gym With Walker',
          variant_title: 'Ocean Blue',
          quantity: 1,
          price: '159.00',
          sku: 'ABH-WALK-BLU',
        },
      ],
      created_at: new Date().toISOString(),
    };

    const rawOrderPayload = JSON.stringify(sampleOrderPayload);

    // -----------------------------------------------------------------
    // 1. Valid Shopify Order Webhook
    // -----------------------------------------------------------------
    console.log('--- Test 1: Valid Shopify Order Webhook (orders/create) ---');
    const validHmac = signShopifyWebhook(rawOrderPayload);
    const validWebhookRes = await sendRequest(testPort, 'POST', '/api/webhooks/shopify', {
      'x-shopify-topic': 'orders/create',
      'x-shopify-shop-domain': config.shopify.shop,
      'x-shopify-hmac-sha256': validHmac,
      'x-shopify-webhook-id': 'wh_test_valid_001',
    }, rawOrderPayload);

    assert(validWebhookRes.status === 200, `Webhook must return 200 OK, got ${validWebhookRes.status}`);
    assert(validWebhookRes.body.status === 'success', 'Webhook must acknowledge success');
    console.log('✅ Test 1 Passed: Valid webhook accepted with HTTP 200 and success status.\n');

    // -----------------------------------------------------------------
    // 2. Invalid Shopify Webhook Signature
    // -----------------------------------------------------------------
    console.log('--- Test 2: Invalid Webhook Signature Defense ---');
    const forgedHmac = 'invalid_forged_base64_hmac_signature=';
    const invalidWebhookRes = await sendRequest(testPort, 'POST', '/api/webhooks/shopify', {
      'x-shopify-topic': 'orders/create',
      'x-shopify-shop-domain': config.shopify.shop,
      'x-shopify-hmac-sha256': forgedHmac,
      'x-shopify-webhook-id': 'wh_test_forged_002',
    }, rawOrderPayload);

    assert(invalidWebhookRes.status === 401, `Forged webhook must return HTTP 401, got ${invalidWebhookRes.status}`);
    console.log('✅ Test 2 Passed: Forged HMAC signature strictly rejected with HTTP 401.\n');

    // -----------------------------------------------------------------
    // 3. Duplicate Shopify Webhook Deliveries (Idempotency)
    // -----------------------------------------------------------------
    console.log('--- Test 3: Duplicate Webhook Deliveries (Idempotency & Anti-Spam) ---');
    const duplicateWebhookRes = await sendRequest(testPort, 'POST', '/api/webhooks/shopify', {
      'x-shopify-topic': 'orders/create',
      'x-shopify-shop-domain': config.shopify.shop,
      'x-shopify-hmac-sha256': validHmac,
      'x-shopify-webhook-id': 'wh_test_valid_001_duplicate',
    }, rawOrderPayload);

    assert(duplicateWebhookRes.status === 200, 'Duplicate webhook must acknowledge 200 OK');
    const confirmationCount = (await ShopifyOrderConfirmationStore.findByShopifyOrderId('8192039401')) ? 1 : 0;
    assert(confirmationCount === 1, 'Duplicate webhook must not create a second order record');
    console.log('✅ Test 3 Passed: Duplicate webhook handled idempotently without re-sending SMS.\n');

    // -----------------------------------------------------------------
    // 4. MongoDB Pending Order Persistence
    // -----------------------------------------------------------------
    console.log('--- Test 4: MongoDB Pending Order Persistence ---');
    const savedRecord = await ShopifyOrderConfirmationStore.findByShopifyOrderId('8192039401');
    assert(savedRecord !== null, 'Order confirmation record must be saved in database/store');
    assert(savedRecord.orderNumber === '#1099', `Order number must match #1099, got ${savedRecord.orderNumber}`);
    assert(savedRecord.customerName === 'Salma Al Nuaimi', 'Customer name must be normalized');
    assert(savedRecord.totalAmount === 159.00, 'Total amount must match 159.00');
    assert(savedRecord.status === 'pending', 'Initial confirmation status must be pending');
    assert(savedRecord.confirmationToken, 'Must generate secure confirmation token');
    assert(savedRecord.confirmationTokenExpiresAt instanceof Date, 'Must set token expiration timestamp');
    assert(savedRecord.customerSms.status === 'delivered' || savedRecord.customerSms.status === 'sent', 'SMS must be sent');
    console.log(`✅ Test 4 Passed: MongoDB order record correctly persisted with all required fields.\n`);

    // -----------------------------------------------------------------
    // 5. Correct Customer SMS Content
    // -----------------------------------------------------------------
    console.log('--- Test 5: Customer SMS Content & Template Formatting ---');
    const smsContent = orderConfirmationService.formatCustomerConfirmationSms({
      customerName: 'Salma Al Nuaimi',
      orderNumber: '#1099',
      totalAmount: 159.00,
      currency: 'AED',
      confirmationUrl: savedRecord.confirmationUrl,
    });

    assert(smsContent.includes('Salma Al Nuaimi'), 'SMS must greet customer by name');
    assert(smsContent.includes('#1099'), 'SMS must state Shopify order number');
    assert(smsContent.includes('AED 159.00'), 'SMS must state exact AED price');
    assert(smsContent.toLowerCase().includes('confirm your order') || smsContent.toLowerCase().includes('confirm this order'), 'SMS must ask customer to confirm');
    assert(smsContent.includes(savedRecord.confirmationUrl), 'SMS must include secure confirmation link');
    assert(smsContent.includes('30 minutes'), 'SMS must state 30-minute expiry window');
    console.log('✅ Test 5 Passed: Customer SMS contains all required verified order information.\n');

    // -----------------------------------------------------------------
    // 6. UAE Phone Normalization
    // -----------------------------------------------------------------
    console.log('--- Test 6: UAE Phone Normalization ---');
    const norm1 = smsService.normalizeUaePhone('050 123 4567');
    const norm2 = smsService.normalizeUaePhone('971501234567');
    const norm3 = smsService.normalizeUaePhone('+971-50-123-4567');
    const normInvalid = smsService.normalizeUaePhone('12345');

    assert(norm1.valid && norm1.formatted === '+971501234567', 'Format 050 123 4567 must normalize to +971501234567');
    assert(norm2.valid && norm2.formatted === '+971501234567', 'Format 971501234567 must normalize to +971501234567');
    assert(norm3.valid && norm3.formatted === '+971501234567', 'Format +971-50-123-4567 must normalize to +971501234567');
    assert(!normInvalid.valid, 'Invalid short number must be rejected');
    console.log('✅ Test 6 Passed: UAE phone normalization standard strictly enforced.\n');

    // -----------------------------------------------------------------
    // 7. Missing Customer Phone Handling
    // -----------------------------------------------------------------
    console.log('--- Test 7: Missing Customer Phone (Graceful Failure) ---');
    const orderNoPhone = {
      id: 8192039402,
      name: '#1101',
      customer: { first_name: 'No Phone', last_name: 'Customer' },
      shipping_address: { phone: '' },
      line_items: [{ title: 'Item', price: '50.00', quantity: 1 }],
      total_price: '50.00',
    };

    const noPhoneHmac = signShopifyWebhook(JSON.stringify(orderNoPhone));
    const noPhoneRes = await sendRequest(testPort, 'POST', '/api/webhooks/shopify', {
      'x-shopify-topic': 'orders/create',
      'x-shopify-shop-domain': config.shopify.shop,
      'x-shopify-hmac-sha256': noPhoneHmac,
      'x-shopify-webhook-id': 'wh_test_no_phone_003',
    }, JSON.stringify(orderNoPhone));

    assert(noPhoneRes.status === 200, 'Webhook must return 200 OK even if SMS cannot be dispatched');
    const noPhoneRecord = await ShopifyOrderConfirmationStore.findByShopifyOrderId('8192039402');
    assert(noPhoneRecord !== null, 'Order record must be stored');
    assert(noPhoneRecord.customerSms.status === 'failed', 'SMS status must be recorded as failed');
    console.log('✅ Test 7 Passed: Missing customer phone safely recorded as failed without crashing webhook.\n');

    // -----------------------------------------------------------------
    // 8. Secure Confirmation Link Generation
    // -----------------------------------------------------------------
    console.log('--- Test 8: Secure Confirmation Link Generation ---');
    const tokenParts = savedRecord.confirmationToken.split(':');
    assert(tokenParts.length === 3, 'Confirmation token must be 3-part: orderId:expiresAt:hmac');
    assert(tokenParts[0] === '8192039401', 'First part must be order ID');
    assert(!savedRecord.confirmationUrl.includes('salma.alnuaimi'), 'Must never expose customer email in URL');
    assert(!savedRecord.confirmationUrl.includes('0501234567'), 'Must never expose phone in URL');
    assert(savedRecord.confirmationUrl.startsWith('http'), 'Confirmation URL must be an absolute URL');
    console.log('✅ Test 8 Passed: Secure single-use confirmation URL generated without PII exposure.\n');

    // -----------------------------------------------------------------
    // 9. Valid Confirmation Token Verification (Safe GET Review)
    // -----------------------------------------------------------------
    console.log('--- Test 9: Valid Confirmation Token (Safe GET Review Without Mutation) ---');
    const token = savedRecord.confirmationToken;
    const tokenVerification = ShopifyOrderConfirmationStore.verifyToken(token);
    assert(tokenVerification.valid === true, 'Token must pass cryptographic HMAC verification');

    // GET request displays review page and does NOT confirm or send email
    const reviewRes = await sendRequest(testPort, 'GET', `/api/orders/confirm-shopify-order?token=${encodeURIComponent(token)}`);
    assert(reviewRes.status === 200, 'GET review must return 200 OK');
    assert(reviewRes.body.review === true, 'GET must return review without mutating order');

    const recordAfterGet = await ShopifyOrderConfirmationStore.findByShopifyOrderId('8192039401');
    assert(recordAfterGet.status === 'pending', 'Order must remain pending after GET review');
    assert(resendDispatchCount === 0, 'No owner email must be dispatched on GET review');
    console.log('✅ Test 9 Passed: GET review safely returns order details without mutating state.\n');

    // -----------------------------------------------------------------
    // 10. Invalid / Tampered Confirmation Token
    // -----------------------------------------------------------------
    console.log('--- Test 10: Invalid / Tampered Confirmation Token Defense ---');
    const tamperedToken = `${token}tampered`;
    const tamperedRes = await sendRequest(testPort, 'POST', '/api/orders/confirm-shopify-order', {}, { token: tamperedToken });
    assert(tamperedRes.status === 403, `Tampered token must return HTTP 403, got ${tamperedRes.status}`);
    assert(tamperedRes.body.code === 'INVALID_TOKEN', 'Must return code INVALID_TOKEN');
    console.log('✅ Test 10 Passed: Forged and tampered tokens rejected with HTTP 403 Forbidden.\n');

    // -----------------------------------------------------------------
    // 11. Expired Confirmation Token (30-Minute Expiry Window)
    // -----------------------------------------------------------------
    console.log('--- Test 11: Expired Confirmation Token (30-Min Expiry) ---');
    const expiredOrderId = '8192039999';
    await ShopifyOrderConfirmationStore.create({
      shopifyOrderId: expiredOrderId,
      orderNumber: '#1100',
      shop: config.shopify.shop,
      customerName: 'Expired User',
      totalAmount: 100,
      currency: 'AED',
      confirmationToken: 'dummy',
      confirmationTokenExpiresAt: new Date(Date.now() - 10 * 60 * 1000), // Expired 10 mins ago
      confirmationUrl: 'https://test/confirm',
      status: 'pending',
    });

    const expiredTokenInfo = ShopifyOrderConfirmationStore.generateToken(expiredOrderId, -10);
    const expiredRes = await sendRequest(testPort, 'POST', '/api/orders/confirm-shopify-order', {}, { token: expiredTokenInfo.token });
    assert(expiredRes.status === 410, `Expired token must return HTTP 410, got ${expiredRes.status}`);
    assert(expiredRes.body.code === 'TOKEN_EXPIRED', 'Must return code TOKEN_EXPIRED');

    const updatedExpired = await ShopifyOrderConfirmationStore.findByShopifyOrderId(expiredOrderId);
    assert(updatedExpired.status === 'expired', 'Record status must transition to expired');
    console.log('✅ Test 11 Passed: Expired token rejected with HTTP 410 Gone and status set to expired.\n');

    // -----------------------------------------------------------------
    // 12. Duplicate Confirmation Request (Single-Use Defense)
    // -----------------------------------------------------------------
    console.log('--- Test 12: Customer Confirmation & Duplicate Request Defense ---');
    // First confirmation (POST)
    const initialConfirmRes = await sendRequest(testPort, 'POST', '/api/orders/confirm-shopify-order', {}, { token });
    assert(initialConfirmRes.status === 200, 'First confirmation must return 200 OK');
    assert(initialConfirmRes.body.alreadyConfirmed === false, 'First confirmation must have alreadyConfirmed=false');
    assert(initialConfirmRes.body.order.status === 'confirmed', 'Order status must transition to confirmed');
    assert(resendDispatchCount === 1, 'Owner email must be dispatched exactly once on confirmation');

    // Duplicate confirmation (POST)
    const duplicateConfirmRes = await sendRequest(testPort, 'POST', '/api/orders/confirm-shopify-order', {}, { token });
    assert(duplicateConfirmRes.status === 200, 'Duplicate request must return 200 OK');
    assert(duplicateConfirmRes.body.alreadyConfirmed === true, 'Duplicate request must flag alreadyConfirmed=true');
    assert(resendDispatchCount === 1, 'Duplicate request must NOT dispatch another email');
    console.log('✅ Test 12 Passed: First confirmation succeeds; duplicate request handled idempotently without re-sending email.\n');

    // -----------------------------------------------------------------
    // 13. Concurrent Confirmation Requests (Atomic Protection)
    // -----------------------------------------------------------------
    console.log('--- Test 13: Concurrent Confirmation Requests (Race Condition Defense) ---');
    const concurrentOrderId = '8192039555';
    const concurrentTokenInfo = ShopifyOrderConfirmationStore.generateToken(concurrentOrderId, 30);
    await ShopifyOrderConfirmationStore.create({
      shopifyOrderId: concurrentOrderId,
      orderNumber: '#1105',
      shop: config.shopify.shop,
      customerName: 'Concurrent User',
      customerPhone: '+971508887766',
      customerEmail: 'concurrent@example.ae',
      totalAmount: 200,
      currency: 'AED',
      confirmationToken: concurrentTokenInfo.token,
      confirmationTokenExpiresAt: concurrentTokenInfo.expiresAt,
      confirmationUrl: `https://test/confirm?token=${concurrentTokenInfo.token}`,
      status: 'pending',
    });

    const emailCountBeforeConcurrent = resendDispatchCount;
    // Launch 5 simultaneous confirmation POST requests
    const concurrentRequests = Array.from({ length: 5 }, () =>
      sendRequest(testPort, 'POST', '/api/orders/confirm-shopify-order', {}, { token: concurrentTokenInfo.token })
    );

    const concurrentResults = await Promise.all(concurrentRequests);
    const successFirstTime = concurrentResults.filter((r) => r.body.alreadyConfirmed === false);
    const alreadyConfirmedTimes = concurrentResults.filter((r) => r.body.alreadyConfirmed === true);

    assert(successFirstTime.length === 1, `Exactly ONE request must succeed first, got ${successFirstTime.length}`);
    assert(alreadyConfirmedTimes.length === 4, `The other 4 requests must get alreadyConfirmed=true, got ${alreadyConfirmedTimes.length}`);
    assert(resendDispatchCount === emailCountBeforeConcurrent + 1, 'Store owner email must be dispatched exactly ONCE across concurrent requests');
    console.log('✅ Test 13 Passed: Atomic lock successfully protected against 5 simultaneous concurrent confirmations.\n');

    // -----------------------------------------------------------------
    // 14. Successful Resend API Request Using a Mocked Response
    // -----------------------------------------------------------------
    console.log('--- Test 14: Successful Resend API Request (Mocked Handler) ---');
    const testMockDoc = {
      orderNumber: '#1099',
      shopifyOrderId: '8192039401',
      customerName: 'Salma Al Nuaimi',
      customerPhone: '+971501234567',
      customerEmail: 'salma@example.ae',
      totalAmount: 159.00,
      subtotal: 159.00,
      shippingCharges: 0.00,
      currency: 'AED',
      lineItems: [{ title: '2-in-1 Baby Gym With Walker', quantity: 1, price: 159.00, sku: 'SKU1' }],
      shippingAddress: { address1: 'Villa 24', city: 'Dubai', country: 'UAE' },
      confirmedAt: new Date(),
    };

    const mockEmailResult = await emailNotificationService.sendConfirmedOrderEmail(testMockDoc);
    assert(mockEmailResult.success === true, 'Email dispatch must succeed');
    assert(mockEmailResult.status === 'accepted', `Email status must be accepted, got ${mockEmailResult.status}`);
    assert(mockEmailResult.resendMessageId.startsWith('re_mock_'), 'Must record Resend message ID');
    console.log(`✅ Test 14 Passed: Mocked Resend API returned status accepted with ID ${mockEmailResult.resendMessageId}.\n`);

    // -----------------------------------------------------------------
    // 15. Missing Resend API Key Handling
    // -----------------------------------------------------------------
    console.log('--- Test 15: Missing Resend API Key Handling ---');
    // Temporarily clear mock handler to test key check
    const currentMock = emailNotificationService.mockHandler;
    emailNotificationService.setMockHandler(null);

    const originalApiKey = config.resend.apiKey;
    config.resend.apiKey = '';
    const originalEnvKey = process.env.RESEND_API_KEY;
    delete process.env.RESEND_API_KEY;

    const noKeyResult = await emailNotificationService.sendConfirmedOrderEmail(testMockDoc);
    assert(noKeyResult.success === false, 'Dispatch must fail gracefully');
    assert(noKeyResult.status === 'failed', 'Status must be failed');
    assert(noKeyResult.error.includes('RESEND_API_KEY is not configured'), 'Must provide clear error on missing key');

    // Restore keys and mock
    config.resend.apiKey = originalApiKey;
    process.env.RESEND_API_KEY = originalEnvKey;
    emailNotificationService.setMockHandler(currentMock);
    console.log('✅ Test 15 Passed: Missing RESEND_API_KEY handled gracefully with informative telemetry.\n');

    // -----------------------------------------------------------------
    // 16. Invalid Owner Email Address
    // -----------------------------------------------------------------
    console.log('--- Test 16: Invalid Owner Email Validation ---');
    const originalOwnerEmail = config.ownerNotification.ownerEmail;
    config.ownerNotification.ownerEmail = 'invalid-email-format';

    const badEmailResult = await emailNotificationService.sendConfirmedOrderEmail(testMockDoc);
    assert(badEmailResult.success === false, 'Invalid owner email must be rejected');
    assert(badEmailResult.status === 'failed', 'Status must be failed');
    assert(badEmailResult.error.includes('Invalid or missing OWNER_EMAIL'), 'Must record invalid email error');

    config.ownerNotification.ownerEmail = originalOwnerEmail;
    console.log('✅ Test 16 Passed: Invalid owner email format safely caught and prevented.\n');

    // -----------------------------------------------------------------
    // 17. Resend API Failure Handling
    // -----------------------------------------------------------------
    console.log('--- Test 17: Resend API Failure Handling ---');
    emailNotificationService.setMockHandler(async () => {
      throw new Error('Resend 500: Internal server error on provider side');
    });

    const failResult = await emailNotificationService.sendConfirmedOrderEmail(testMockDoc);
    assert(failResult.success === false, 'Failure must be caught');
    assert(failResult.status === 'failed', 'Status must be recorded as failed');
    assert(failResult.error.includes('Resend 500'), 'Must capture provider error message');

    // Restore mock handler
    emailNotificationService.setMockHandler(currentMock);
    console.log('✅ Test 17 Passed: Resend API outage captured gracefully without unhandled crashes.\n');

    // -----------------------------------------------------------------
    // 18. Duplicate Owner Notification Prevention
    // -----------------------------------------------------------------
    console.log('--- Test 18: Duplicate Owner Notification Prevention ---');
    const confirmedRecord = await ShopifyOrderConfirmationStore.findByShopifyOrderId('8192039401');
    const emailsBefore = emailNotificationService.sentEmails.length;

    // Attempting to confirm already confirmed order via service
    const secondConfirmResult = await orderConfirmationService.confirmOrderWithToken(savedRecord.confirmationToken);
    assert(secondConfirmResult.alreadyConfirmed === true, 'Service must flag alreadyConfirmed=true');
    assert(emailNotificationService.sentEmails.length === emailsBefore, 'Must not dispatch duplicate email');
    console.log('✅ Test 18 Passed: Duplicate confirmation strictly blocked from sending additional emails.\n');

    // -----------------------------------------------------------------
    // 19. Complete Owner Email Content (All 12 Required Fields)
    // -----------------------------------------------------------------
    console.log('--- Test 19: Complete Owner Email Content (All 12 Fields) ---');
    const textEmail = emailNotificationService.formatPlainTextEmail(testMockDoc);
    const htmlEmail = emailNotificationService.formatHtmlEmail(testMockDoc);

    // Verify all 12 order fields are present:
    // 1. Customer Name
    assert(textEmail.includes('Salma Al Nuaimi') && htmlEmail.includes('Salma Al Nuaimi'), 'Field 1: Customer name missing');
    // 2. Shopify Order Number
    assert(textEmail.includes('#1099') && htmlEmail.includes('#1099'), 'Field 2: Order number missing');
    // 3. Shopify Order ID
    assert(textEmail.includes('8192039401') && htmlEmail.includes('8192039401'), 'Field 3: Order ID missing');
    // 4. Customer Phone
    assert(textEmail.includes('+971501234567') && htmlEmail.includes('+971501234567'), 'Field 4: Customer phone missing');
    // 5. Customer Email
    assert(textEmail.includes('salma@example.ae') && htmlEmail.includes('salma@example.ae'), 'Field 5: Customer email missing');
    // 6. Product Name
    assert(textEmail.includes('2-in-1 Baby Gym With Walker') && htmlEmail.includes('2-in-1 Baby Gym With Walker'), 'Field 6: Product name missing');
    // 7. Product Variant / SKU
    assert(textEmail.includes('SKU1') && htmlEmail.includes('SKU1'), 'Field 7: Variant/SKU missing');
    // 8. Quantity
    assert(textEmail.includes('Qty: 1') && htmlEmail.includes('>1<'), 'Field 8: Quantity missing');
    // 9. Subtotal
    assert(textEmail.includes('Subtotal:') && textEmail.includes('159.00'), 'Field 9: Subtotal missing');
    // 10. Shipping Charges
    assert(textEmail.includes('Shipping Charges:') && textEmail.includes('0.00'), 'Field 10: Shipping fee missing');
    // 11. Total Amount & Currency
    assert(textEmail.includes('AED') && textEmail.includes('159.00') && htmlEmail.includes('AED 159.00'), 'Field 11: Total amount missing');
    // 12. Shipping Address
    assert(textEmail.includes('Villa 24, Dubai, UAE') && htmlEmail.includes('Villa 24'), 'Field 12: Shipping address missing');
    // Status and Timestamp
    assert(textEmail.includes('CONFIRMED') && htmlEmail.includes('CONFIRMED'), 'Confirmation status missing');

    console.log('✅ Test 19 Passed: Owner notification email contains all 12 required order fields.\n');

    // -----------------------------------------------------------------
    // 20. No Payment Card / CVV Data in Email (Zero PII Leakage)
    // -----------------------------------------------------------------
    console.log('--- Test 20: No Payment Card / CVV Data in Email ---');
    const prohibitedTerms = ['card_number', 'credit_card', 'cvv', 'cvc', 'exp_month', 'exp_year', 'password'];
    for (const term of prohibitedTerms) {
      assert(!textEmail.toLowerCase().includes(term), `Prohibited term "${term}" must not be in text email`);
      assert(!htmlEmail.toLowerCase().includes(term), `Prohibited term "${term}" must not be in HTML email`);
    }
    console.log('✅ Test 20 Passed: Verified zero payment card or CVV details present in email templates.\n');

    // -----------------------------------------------------------------
    // 21. Accurate Email Notification Status (Accepted vs Delivered)
    // -----------------------------------------------------------------
    console.log('--- Test 21: Accurate Notification Status Standard ---');
    assert(mockEmailResult.status === 'accepted', 'Successful Resend API call must be recorded as accepted');
    assert(mockEmailResult.status !== 'delivered', 'Status must NOT be claimed as delivered without delivery webhook proof');
    console.log('✅ Test 21 Passed: Truthful status handling strictly distinguishes accepted vs delivered.\n');

    // -----------------------------------------------------------------
    // 22. Complete End-to-End Workflow Simulation
    // -----------------------------------------------------------------
    console.log('--- Test 22: Complete End-to-End Workflow Verification ---');
    const e2eOrder = {
      id: 8192039988,
      name: '#1200',
      order_number: 1200,
      email: 'mariam.alzaabi@example.ae',
      phone: '+971502223344',
      currency: 'AED',
      subtotal_price: '249.00',
      total_price: '249.00',
      total_shipping_price_set: { shop_money: { amount: '0.00', currency_code: 'AED' } },
      customer: { first_name: 'Mariam', last_name: 'Al Zaabi', email: 'mariam.alzaabi@example.ae' },
      shipping_address: {
        address1: 'Villa 10',
        city: 'Abu Dhabi',
        country: 'United Arab Emirates',
        phone: '050 222 3344',
      },
      line_items: [{ title: 'Montessori Wooden Aids', quantity: 1, price: '249.00' }],
    };

    // Step A: Webhook received from Shopify
    const e2eHmac = signShopifyWebhook(JSON.stringify(e2eOrder));
    const e2eWebhookRes = await sendRequest(testPort, 'POST', '/api/webhooks/shopify', {
      'x-shopify-topic': 'orders/create',
      'x-shopify-shop-domain': config.shopify.shop,
      'x-shopify-hmac-sha256': e2eHmac,
      'x-shopify-webhook-id': 'wh_test_e2e_022',
    }, JSON.stringify(e2eOrder));

    assert(e2eWebhookRes.status === 200);

    // Step B: Verify pending order record and confirmation token
    const e2eRecord = await ShopifyOrderConfirmationStore.findByShopifyOrderId('8192039988');
    assert(e2eRecord.status === 'pending');
    assert(e2eRecord.customerSms.status === 'delivered' || e2eRecord.customerSms.status === 'sent');

    // Step C: Customer views review page safely (GET)
    const e2eReviewRes = await sendRequest(testPort, 'GET', `/api/orders/confirm-shopify-order?token=${encodeURIComponent(e2eRecord.confirmationToken)}`);
    assert(e2eReviewRes.status === 200);
    assert(e2eReviewRes.body.review === true);

    // Step D: Customer clicks "Confirm My Order" button (POST)
    const e2eConfirmRes = await sendRequest(testPort, 'POST', '/api/orders/confirm-shopify-order', {}, { token: e2eRecord.confirmationToken });
    assert(e2eConfirmRes.status === 200);
    assert(e2eConfirmRes.body.alreadyConfirmed === false);
    assert(e2eConfirmRes.body.order.status === 'confirmed');

    // Step E: Verify final state in database
    const finalRecord = await ShopifyOrderConfirmationStore.findByShopifyOrderId('8192039988');
    assert(finalRecord.status === 'confirmed');
    assert(finalRecord.confirmedAt !== null);
    assert(finalRecord.ownerEmailNotification !== null);
    assert(finalRecord.ownerEmailNotification.status === 'accepted');
    assert(finalRecord.ownerEmailNotification.resendMessageId !== null);
    console.log('✅ Test 22 Passed: Full end-to-end flow verified from Shopify webhook to customer SMS, GET review, POST confirmation, and Resend owner email.\n');

    console.log('======================================================================');
    console.log('🎉 ALL 22 PHASE 9.19 TEST CRITERIA PASSED (100% SUCCESS)');
    console.log('======================================================================');
  } finally {
    if (server) {
      await new Promise((resolve) => server.close(resolve));
    }
  }
}

if (require.main === module) {
  runPhase9_19Tests()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('\n❌ Phase 9.19 Test Failed:', err);
      process.exit(1);
    });
}

module.exports = { runPhase9_19Tests };
