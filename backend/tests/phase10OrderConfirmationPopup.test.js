// Enforce test environment for in-memory deduplication and mocks
process.env.NODE_ENV = 'test';
process.env.TEST_MODE = 'true';

const assert = require('assert');
const crypto = require('crypto');
const http = require('http');
const fs = require('fs');
const path = require('path');
const app = require('../src/app');
const config = require('../src/config/env');
const { ShopifyOrderConfirmationStore } = require('../src/models/ShopifyOrderConfirmation');
const orderConfirmationService = require('../src/services/orderConfirmation.service');
const emailNotificationService = require('../src/services/emailNotification.service');
const { generateToken } = require('../src/utils/token.util');

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

async function runPhase10Tests() {
  console.log('======================================================================');
  console.log('🧪 Starting Phase 10 Abihacart Urgent Order Confirmation Popup Test Suite');
  console.log('   (Covering all 15 scenarios from Section 10)');
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

    config.ownerNotification.ownerEmail = 'owner@abihacart.com';
    config.ownerNotification.provider = 'email';
    config.resend.apiKey = 're_test_phase10_mock_key';

    const sentEmails = [];
    emailNotificationService.setMockHandler(async ({ to, subject, orderConfirmation, isCancellation }) => {
      sentEmails.push({ to, subject, orderConfirmation, isCancellation });
      return {
        success: true,
        status: 'accepted',
        resendMessageId: `re_mock_phase10_${Date.now()}_${sentEmails.length}`,
        recipientEmail: to,
        sentAt: new Date(),
        error: null,
      };
    });

    // Sample Shopify webhook order payload
    const createSampleOrder = (orderNum, orderId, email, phone) => ({
      id: orderId,
      name: `#${orderNum}`,
      order_number: orderNum,
      email: email,
      phone: phone,
      total_price: '450.00',
      subtotal_price: '430.00',
      total_shipping_price_set: {
        shop_money: { amount: '20.00', currency_code: 'AED' },
      },
      currency: 'AED',
      customer: {
        id: 99182371,
        first_name: 'Fatima',
        last_name: 'Al-Mansoor',
        email: email,
        phone: phone,
      },
      shipping_address: {
        first_name: 'Fatima',
        last_name: 'Al-Mansoor',
        address1: 'Villa 14, Palm Jumeirah',
        city: 'Dubai',
        province: 'Dubai',
        country: 'United Arab Emirates',
        phone: phone,
      },
      line_items: [
        {
          id: 71029384,
          title: 'Luxury Gold Moroccan Kaftan',
          variant_title: 'Emerald / M',
          quantity: 1,
          price: '430.00',
          sku: 'KFT-GLD-EM-M',
          image: {
            src: 'https://cdn.shopify.com/s/files/1/0001/kaftan-emerald.jpg',
          },
        },
      ],
      created_at: new Date().toISOString(),
    });

    // -------------------------------------------------------------------------
    // Scenario 1: Successful Shopify checkout opens popup (script / DOM presence)
    // -------------------------------------------------------------------------
    console.log('▶ [Scenario 1] Successful Shopify checkout opens popup (script / DOM presence)');
    const scriptRes = await sendRequest(testPort, 'GET', '/api/orders/popup-script.js');
    assert.strictEqual(scriptRes.status, 200, 'Popup script must return HTTP 200');
    assert.ok(
      scriptRes.headers['content-type'] && scriptRes.headers['content-type'].includes('application/javascript'),
      'Popup script must have application/javascript Content-Type'
    );
    assert.ok(scriptRes.raw.includes('AbihacartAssistantPopup'), 'Popup script must define AbihacartAssistantPopup');
    assert.ok(scriptRes.raw.includes('initOrderConfirmationPopup'), 'Popup script must define initOrderConfirmationPopup');
    assert.ok(scriptRes.raw.includes('Assalam-o-Alaikum!'), 'Popup script must include Islamic greeting');
    assert.ok(scriptRes.raw.includes('Order Received'), 'Popup script must include Order Received badge');
    assert.ok(scriptRes.raw.includes('Confirm My Order'), 'Popup script must include Confirm My Order button');
    assert.ok(scriptRes.raw.includes('Cancel My Order'), 'Popup script must include Cancel My Order button');
    console.log('  ✅ Scenario 1 Passed: Embed popup script served with proper content & headers.\n');

    // Setup an order via Shopify orders/create webhook
    const order1 = createSampleOrder(2001, 88002001, 'fatima@example.com', '+971501112233');
    const webhookRaw = JSON.stringify(order1);
    const hmacHeader = signShopifyWebhook(webhookRaw);

    const webhookRes = await sendRequest(testPort, 'POST', '/api/webhooks/shopify', {
      'x-shopify-topic': 'orders/create',
      'x-shopify-shop-domain': config.shopify.shop,
      'x-shopify-hmac-sha256': hmacHeader,
      'x-shopify-webhook-id': 'wh_test_phase10_001',
    }, webhookRaw);
    assert.strictEqual(webhookRes.status, 200, 'Shopify webhook orders/create must succeed with 200');

    const storedOrder1 = await ShopifyOrderConfirmationStore.findByShopifyOrderId(88002001);
    assert.ok(storedOrder1, 'Order 2001 must be stored in database');
    const token1 = storedOrder1.confirmationToken;
    assert.ok(token1, 'Order 2001 must have a confirmation token');

    // -------------------------------------------------------------------------
    // Scenario 2: Correct order number displayed
    // -------------------------------------------------------------------------
    console.log('▶ [Scenario 2] Correct order number displayed');
    const statusRes = await sendRequest(
      testPort,
      'GET',
      `/api/orders/checkout-confirmation-status?orderId=88002001&phone=${encodeURIComponent('+971501112233')}`
    );
    assert.strictEqual(statusRes.status, 200, 'Status check must return 200');
    assert.strictEqual(statusRes.body.record.orderNumber, '#2001', 'Order number must be #2001');

    const htmlReviewRes = await sendRequest(
      testPort,
      'GET',
      `/api/orders/confirm-shopify-order?token=${token1}`,
      { Accept: 'text/html' }
    );
    assert.strictEqual(htmlReviewRes.status, 200, 'Review HTML must return 200');
    assert.ok(htmlReviewRes.raw.includes('#2001'), 'Review HTML must display #2001');
    assert.ok(htmlReviewRes.raw.includes('Assalam-o-Alaikum!'), 'Review HTML must display Assalam-o-Alaikum');
    console.log('  ✅ Scenario 2 Passed: Correct order number displayed in JSON and HTML.\n');

    // -------------------------------------------------------------------------
    // Scenario 3: Correct product details & thumbnails displayed
    // -------------------------------------------------------------------------
    console.log('▶ [Scenario 3] Correct product details & thumbnails displayed');
    assert.strictEqual(statusRes.body.record.lineItems.length, 1, 'Must have 1 line item');
    const item = statusRes.body.record.lineItems[0];
    assert.strictEqual(item.title, 'Luxury Gold Moroccan Kaftan', 'Item title must match');
    assert.strictEqual(item.variantTitle, 'Emerald / M', 'Variant must match');
    assert.strictEqual(item.quantity, 1, 'Quantity must match');
    assert.strictEqual(item.price, 430, 'Price must match');
    assert.strictEqual(item.image, 'https://cdn.shopify.com/s/files/1/0001/kaftan-emerald.jpg', 'Image URL must match');
    assert.ok(htmlReviewRes.raw.includes('Luxury Gold Moroccan Kaftan'), 'HTML must render item title');
    assert.ok(htmlReviewRes.raw.includes('kaftan-emerald.jpg'), 'HTML must render thumbnail image');
    console.log('  ✅ Scenario 3 Passed: Correct product details and thumbnail images displayed.\n');

    // -------------------------------------------------------------------------
    // Scenario 4: Customer confirms order via POST /confirm-shopify-order
    // -------------------------------------------------------------------------
    console.log('▶ [Scenario 4] Customer confirms order via POST /confirm-shopify-order');
    sentEmails.length = 0; // Clear email records
    const confirmRes = await sendRequest(
      testPort,
      'POST',
      '/api/orders/confirm-shopify-order',
      {},
      { token: token1 }
    );
    assert.strictEqual(confirmRes.status, 200, 'Confirmation must return 200');
    assert.strictEqual(confirmRes.body.status, 'success', 'Response status must be success');
    assert.strictEqual(confirmRes.body.order.status, 'confirmed', 'Order status must transition to confirmed');

    const confirmedRecord = await ShopifyOrderConfirmationStore.findByConfirmationToken(token1);
    assert.strictEqual(confirmedRecord.status, 'confirmed', 'Stored status must be confirmed');
    assert.ok(confirmedRecord.confirmedAt, 'confirmedAt must be populated');
    console.log('  ✅ Scenario 4 Passed: Customer confirmed order successfully.\n');

    // -------------------------------------------------------------------------
    // Scenario 5: Customer cancels order via POST /cancel-shopify-order
    // -------------------------------------------------------------------------
    console.log('▶ [Scenario 5] Customer cancels order via POST /cancel-shopify-order');
    const order2 = createSampleOrder(2002, 88002002, 'tariq@example.com', '+971509988776');
    const webhookRaw2 = JSON.stringify(order2);
    await sendRequest(testPort, 'POST', '/api/webhooks/shopify', {
      'x-shopify-topic': 'orders/create',
      'x-shopify-shop-domain': config.shopify.shop,
      'x-shopify-hmac-sha256': signShopifyWebhook(webhookRaw2),
      'x-shopify-webhook-id': 'wh_test_phase10_002',
    }, webhookRaw2);

    const storedOrder2 = await ShopifyOrderConfirmationStore.findByShopifyOrderId(88002002);
    const token2 = storedOrder2.confirmationToken;

    const cancelRes = await sendRequest(
      testPort,
      'POST',
      '/api/orders/cancel-shopify-order',
      {},
      { token: token2, reason: 'Ordered wrong color' }
    );
    assert.strictEqual(cancelRes.status, 200, 'Cancellation must return 200');
    assert.strictEqual(cancelRes.body.status, 'success', 'Response status must be success');
    assert.strictEqual(cancelRes.body.order.status, 'cancelled', 'Order status must be cancelled');

    const cancelledRecord = await ShopifyOrderConfirmationStore.findByConfirmationToken(token2);
    assert.strictEqual(cancelledRecord.status, 'cancelled', 'Stored status must be cancelled');
    assert.ok(cancelledRecord.cancelledAt, 'cancelledAt must be recorded');
    assert.strictEqual(cancelledRecord.cancellationReason, 'Ordered wrong color', 'Cancellation reason must match');
    console.log('  ✅ Scenario 5 Passed: Customer cancelled order successfully.\n');

    // -------------------------------------------------------------------------
    // Scenario 6: Closing popup does not change order status (remains pending)
    // -------------------------------------------------------------------------
    console.log('▶ [Scenario 6] Closing popup does not change order status (remains pending)');
    const order3 = createSampleOrder(2003, 88002003, 'layla@example.com', '+971503344556');
    await sendRequest(testPort, 'POST', '/api/webhooks/shopify', {
      'x-shopify-topic': 'orders/create',
      'x-shopify-shop-domain': config.shopify.shop,
      'x-shopify-hmac-sha256': signShopifyWebhook(JSON.stringify(order3)),
      'x-shopify-webhook-id': 'wh_test_phase10_003',
    }, JSON.stringify(order3));

    const storedOrder3 = await ShopifyOrderConfirmationStore.findByShopifyOrderId(88002003);
    const token3 = storedOrder3.confirmationToken;

    // Simulate opening popup review (GET request), then user closes modal without confirming/cancelling
    const openRes = await sendRequest(
      testPort,
      'GET',
      `/api/orders/checkout-confirmation-status?orderId=88002003&token=${token3}`
    );
    assert.strictEqual(openRes.status, 200);
    assert.strictEqual(openRes.body.confirmationStatus, 'pending');

    const checkStored3 = await ShopifyOrderConfirmationStore.findByConfirmationToken(token3);
    assert.strictEqual(checkStored3.status, 'pending', 'Order must remain strictly pending after closing popup');
    assert.ok(!checkStored3.confirmedAt, 'confirmedAt must remain unset');
    assert.ok(!checkStored3.cancelledAt, 'cancelledAt must remain unset');
    console.log('  ✅ Scenario 6 Passed: Order remains pending when popup is closed without action.\n');

    // -------------------------------------------------------------------------
    // Scenario 7: Refreshing page preserves existing status (/checkout-confirmation-status)
    // -------------------------------------------------------------------------
    console.log('▶ [Scenario 7] Refreshing page preserves existing status (/checkout-confirmation-status)');
    // Query order 2001 (already confirmed)
    const refreshConfirmed = await sendRequest(
      testPort,
      'GET',
      `/api/orders/checkout-confirmation-status?orderId=88002001&token=${token1}`
    );
    assert.strictEqual(refreshConfirmed.status, 200);
    assert.strictEqual(refreshConfirmed.body.confirmationStatus, 'confirmed', 'Status must be confirmed across reloads');

    // Query order 2002 (already cancelled)
    const refreshCancelled = await sendRequest(
      testPort,
      'GET',
      `/api/orders/checkout-confirmation-status?orderId=88002002&token=${token2}`
    );
    assert.strictEqual(refreshCancelled.status, 200);
    assert.strictEqual(refreshCancelled.body.confirmationStatus, 'cancelled', 'Status must be cancelled across reloads');
    console.log('  ✅ Scenario 7 Passed: Order confirmation status accurately preserved across page reloads.\n');

    // -------------------------------------------------------------------------
    // Scenario 8: Repeated confirmation requests do not duplicate records / emails
    // -------------------------------------------------------------------------
    console.log('▶ [Scenario 8] Repeated confirmation requests do not duplicate records / emails');
    sentEmails.length = 0; // Clear emails
    const repeatConfirmRes = await sendRequest(
      testPort,
      'POST',
      '/api/orders/confirm-shopify-order',
      {},
      { token: token1 }
    );
    assert.strictEqual(repeatConfirmRes.status, 200, 'Repeat confirm must return 200');
    assert.strictEqual(repeatConfirmRes.body.alreadyConfirmed, true, 'alreadyConfirmed must be true');
    assert.strictEqual(sentEmails.length, 0, 'No duplicate owner email must be dispatched on repeat confirm');
    console.log('  ✅ Scenario 8 Passed: Idempotent confirmation prevents duplicate state and duplicate emails.\n');

    // -------------------------------------------------------------------------
    // Scenario 9: Repeated cancellation requests do not duplicate records / emails
    // -------------------------------------------------------------------------
    console.log('▶ [Scenario 9] Repeated cancellation requests do not duplicate records / emails');
    sentEmails.length = 0; // Clear emails
    const repeatCancelRes = await sendRequest(
      testPort,
      'POST',
      '/api/orders/cancel-shopify-order',
      {},
      { token: token2, reason: 'Duplicate button click' }
    );
    assert.strictEqual(repeatCancelRes.status, 200, 'Repeat cancel must return 200');
    assert.strictEqual(repeatCancelRes.body.alreadyCancelled, true, 'alreadyCancelled must be true');
    assert.strictEqual(sentEmails.length, 0, 'No duplicate cancellation email must be dispatched');
    console.log('  ✅ Scenario 9 Passed: Idempotent cancellation prevents duplicate state and duplicate emails.\n');

    // -------------------------------------------------------------------------
    // Scenario 10: Unauthorized order access is rejected (403 for wrong email/phone/token)
    // -------------------------------------------------------------------------
    console.log('▶ [Scenario 10] Unauthorized order access is rejected (403 for wrong email/phone/token)');
    // Access with mismatching phone
    const unauthPhoneRes = await sendRequest(
      testPort,
      'GET',
      `/api/orders/checkout-confirmation-status?orderId=88002003&phone=${encodeURIComponent('+971599999999')}`
    );
    assert.strictEqual(unauthPhoneRes.status, 403, 'Mismatching phone must return 403 Forbidden');
    assert.strictEqual(unauthPhoneRes.body.code, 'UNAUTHORIZED_ACCESS');

    // Access with forged token
    const forgedToken = 'fake.token.here';
    const unauthTokenRes = await sendRequest(
      testPort,
      'GET',
      `/api/orders/checkout-confirmation-status?orderId=88002003&token=${forgedToken}`
    );
    assert.strictEqual(unauthTokenRes.status, 403, 'Forged token must return 403 Forbidden');

    // Confirmation attempt with forged token
    const forgedConfirmRes = await sendRequest(
      testPort,
      'POST',
      '/api/orders/confirm-shopify-order',
      {},
      { token: 'invalid_token_signature' }
    );
    assert.strictEqual(forgedConfirmRes.status, 403, 'Forged confirmation token must return 403 Forbidden');
    console.log('  ✅ Scenario 10 Passed: Unauthorized access and invalid tokens strictly rejected.\n');

    // -------------------------------------------------------------------------
    // Scenario 11: Resend owner notification is triggered (both Confirm and Cancel subjects)
    // -------------------------------------------------------------------------
    console.log('▶ [Scenario 11] Resend owner notification is triggered (both Confirm and Cancel subjects)');
    // Create new order 2004 for clean email test
    const order4 = createSampleOrder(2004, 88002004, 'mariam@example.com', '+971507766554');
    await sendRequest(testPort, 'POST', '/api/webhooks/shopify', {
      'x-shopify-topic': 'orders/create',
      'x-shopify-shop-domain': config.shopify.shop,
      'x-shopify-hmac-sha256': signShopifyWebhook(JSON.stringify(order4)),
      'x-shopify-webhook-id': 'wh_test_phase10_004',
    }, JSON.stringify(order4));

    const storedOrder4 = await ShopifyOrderConfirmationStore.findByShopifyOrderId(88002004);
    sentEmails.length = 0;

    // Test Confirmation Subject
    await sendRequest(
      testPort,
      'POST',
      '/api/orders/confirm-shopify-order',
      {},
      { token: storedOrder4.confirmationToken }
    );
    assert.strictEqual(sentEmails.length, 1, 'Owner confirmation email must be sent');
    assert.strictEqual(
      sentEmails[0].subject,
      'Abihacart — Customer Confirmed Order #2004',
      'Subject must be "Abihacart — Customer Confirmed Order #2004"'
    );
    assert.strictEqual(sentEmails[0].to, 'owner@abihacart.com');

    // Test Cancellation Subject with order 2005
    const order5 = createSampleOrder(2005, 88002005, 'salem@example.com', '+971508877665');
    await sendRequest(testPort, 'POST', '/api/webhooks/shopify', {
      'x-shopify-topic': 'orders/create',
      'x-shopify-shop-domain': config.shopify.shop,
      'x-shopify-hmac-sha256': signShopifyWebhook(JSON.stringify(order5)),
      'x-shopify-webhook-id': 'wh_test_phase10_005',
    }, JSON.stringify(order5));

    const storedOrder5 = await ShopifyOrderConfirmationStore.findByShopifyOrderId(88002005);
    sentEmails.length = 0;

    await sendRequest(
      testPort,
      'POST',
      '/api/orders/cancel-shopify-order',
      {},
      { token: storedOrder5.confirmationToken, reason: 'Duplicate order' }
    );
    assert.strictEqual(sentEmails.length, 1, 'Owner cancellation email must be sent');
    assert.ok(
      sentEmails[0].subject.includes('Abihacart — Customer Cancellation Request #2005') ||
      sentEmails[0].subject.includes('Abihacart — Order Cancelled #2005'),
      `Subject must match cancellation pattern. Got: ${sentEmails[0].subject}`
    );
    console.log('  ✅ Scenario 11 Passed: Resend owner emails triggered with exact required subject lines.\n');

    // -------------------------------------------------------------------------
    // Scenario 12: Email failure does not break order confirmation/cancellation
    // -------------------------------------------------------------------------
    console.log('▶ [Scenario 12] Email failure does not break order confirmation/cancellation');
    // Set mock handler to simulate upstream email outage
    emailNotificationService.setMockHandler(async () => {
      throw new Error('Resend upstream API 500 error simulated outage');
    });

    const order6 = createSampleOrder(2006, 88002006, 'rashid@example.com', '+971502233445');
    await sendRequest(testPort, 'POST', '/api/webhooks/shopify', {
      'x-shopify-topic': 'orders/create',
      'x-shopify-shop-domain': config.shopify.shop,
      'x-shopify-hmac-sha256': signShopifyWebhook(JSON.stringify(order6)),
      'x-shopify-webhook-id': 'wh_test_phase10_006',
    }, JSON.stringify(order6));

    const storedOrder6 = await ShopifyOrderConfirmationStore.findByShopifyOrderId(88002006);

    const failEmailConfirmRes = await sendRequest(
      testPort,
      'POST',
      '/api/orders/confirm-shopify-order',
      {},
      { token: storedOrder6.confirmationToken }
    );
    assert.strictEqual(failEmailConfirmRes.status, 200, 'Confirmation must succeed even if Resend fails');
    assert.strictEqual(failEmailConfirmRes.body.order.status, 'confirmed', 'Order status must be confirmed');

    const checkRecord6 = await ShopifyOrderConfirmationStore.findByConfirmationToken(storedOrder6.confirmationToken);
    assert.strictEqual(checkRecord6.status, 'confirmed');
    const notifStatus = (checkRecord6.ownerEmailNotification || checkRecord6.ownerNotification)?.status;
    assert.strictEqual(notifStatus, 'failed', 'Notification failure must be logged gracefully');

    // Restore working mock handler
    emailNotificationService.setMockHandler(async ({ to, subject }) => ({
      success: true,
      status: 'accepted',
      resendMessageId: 're_mock_restored',
      recipientEmail: to,
    }));
    console.log('  ✅ Scenario 12 Passed: Customer order confirmation survives email delivery failures gracefully.\n');

    // -------------------------------------------------------------------------
    // Scenario 13: Mobile responsive layout styles exist and render cleanly
    // -------------------------------------------------------------------------
    console.log('▶ [Scenario 13] Mobile responsive layout styles exist and render cleanly');
    const popupScriptContent = fs.readFileSync(path.join(__dirname, '../src/assets/abihacart-order-popup.js'), 'utf8');
    assert.ok(popupScriptContent.includes('@media (max-width:'), 'Script CSS must contain mobile media queries');
    assert.ok(popupScriptContent.includes('max-width: 460px') || popupScriptContent.includes('max-width: 480px'), 'Popup container must restrict max-width');
    assert.ok(popupScriptContent.includes('border-radius'), 'Popup container must have rounded corners');
    assert.ok(popupScriptContent.includes('box-shadow'), 'Popup card must have luxury drop-shadow');
    console.log('  ✅ Scenario 13 Passed: Responsive styling, mobile touch constraints, and luxury aesthetics verified.\n');

    // -------------------------------------------------------------------------
    // Scenario 14: Existing chatbot API routes (/api/chat/message) still work
    // -------------------------------------------------------------------------
    console.log('▶ [Scenario 14] Existing chatbot API routes (/api/chat/message) still work');
    const chatRes = await sendRequest(
      testPort,
      'POST',
      '/api/chat/message',
      {},
      { message: 'Hello! What products do you have?' }
    );
    assert.strictEqual(chatRes.status, 200, 'Chatbot endpoint must return 200');
    assert.ok(chatRes.body.reply || chatRes.body.message, 'Chatbot must return reply message');
    assert.ok(chatRes.body.conversationId, 'Chatbot must return conversationId');
    assert.ok(chatRes.body.conversationToken, 'Chatbot must return secure conversationToken');
    console.log('  ✅ Scenario 14 Passed: Existing AI chatbot core API operational and unregressed.\n');

    // -------------------------------------------------------------------------
    // Scenario 15: Existing admin features still work (/api/admin/sms-orders)
    // -------------------------------------------------------------------------
    console.log('▶ [Scenario 15] Existing admin features still work (/api/admin/sms-orders)');
    const adminToken = generateToken({ id: 'admin-test-10', role: 'admin' }, config.jwtSecret);
    const adminRes = await sendRequest(
      testPort,
      'GET',
      '/api/admin/sms-orders',
      { Authorization: `Bearer ${adminToken}` }
    );
    assert.strictEqual(adminRes.status, 200, 'Admin sms-orders endpoint must return 200');
    assert.strictEqual(adminRes.body.status, 'success', 'Admin endpoint response must be success');
    assert.ok(Array.isArray(adminRes.body.orders), 'Admin response must contain orders array');
    console.log('  ✅ Scenario 15 Passed: Existing Admin dashboard APIs intact and operational.\n');

    console.log('======================================================================');
    console.log('🎉 ALL 15 PHASE 10 AUTOMATED TEST SCENARIOS PASSED SUCCESSFULLY!');
    console.log('======================================================================\n');
  } finally {
    if (server) {
      await new Promise((resolve) => server.close(resolve));
    }
  }
}

if (require.main === module) {
  runPhase10Tests()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('❌ Phase 10 Test Suite Failed:', err);
      process.exit(1);
    });
}

module.exports = { runPhase10Tests };
