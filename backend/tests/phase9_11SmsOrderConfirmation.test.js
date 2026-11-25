const assert = require('assert');
const http = require('http');
const app = require('../src/app');
const config = require('../src/config/env');
const smsService = require('../src/services/sms.service');
const shopifyService = require('../src/services/shopify.service');
const openaiService = require('../src/services/openai.service');
const { PendingOrderStore, maskPhone } = require('../src/models/PendingOrder');

let server;
let baseUrl;

function makeRequest(method, path, body = null, headers = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, baseUrl);
    const reqHeaders = {
      'Content-Type': 'application/json',
      ...headers,
    };
    const req = http.request(
      url,
      {
        method,
        headers: reqHeaders,
      },
      (res) => {
        let rawData = '';
        res.on('data', (chunk) => {
          rawData += chunk;
        });
        res.on('end', () => {
          let parsed;
          try {
            parsed = JSON.parse(rawData);
          } catch (e) {
            parsed = rawData;
          }
          resolve({ status: res.statusCode, headers: res.headers, body: parsed });
        });
      }
    );
    req.on('error', reject);
    if (body) {
      req.write(typeof body === 'string' ? body : JSON.stringify(body));
    }
    req.end();
  });
}

async function runPhase9_11Tests() {
  console.log('======================================================================');
  console.log('🧪 Starting Phase 9.11 Customer Order Confirmation through SMS Tests');
  console.log('======================================================================\n');

  // Start test server on random port
  await new Promise((resolve) => {
    server = app.listen(0, () => {
      const port = server.address().port;
      baseUrl = `http://localhost:${port}`;
      resolve();
    });
  });

  const shop = config.shopify.shop || 'abihacart.myshopify.com';

  try {
    // -----------------------------------------------------------------
    // Suite 1: UAE Phone Number Normalization & Validation
    // -----------------------------------------------------------------
    console.log('--- Suite 1: UAE Phone Number Normalization & Operator Validation ---');

    // 1.1 Local formats
    const norm1 = smsService.normalizeUaePhone('0501234567');
    assert(norm1.valid === true && norm1.formatted === '+971501234567', 'Must normalize 0501234567 to +971501234567');

    const norm2 = smsService.normalizeUaePhone('529876543');
    assert(norm2.valid === true && norm2.formatted === '+971529876543', 'Must normalize 529876543 to +971529876543');

    const norm3 = smsService.normalizeUaePhone('+971 55 112 2334');
    assert(norm3.valid === true && norm3.formatted === '+971551122334', 'Must normalize spaced +971 55 112 2334');

    const norm4 = smsService.normalizeUaePhone('00971581234567');
    assert(norm4.valid === true && norm4.formatted === '+971581234567', 'Must normalize 00971581234567');

    // 1.2 Invalid numbers
    const invalid1 = smsService.normalizeUaePhone('041234567'); // Landline, not mobile
    assert(invalid1.valid === false, 'Must reject UAE landline for SMS');

    const invalid2 = smsService.normalizeUaePhone('+14155552671'); // USA number
    assert(invalid2.valid === false, 'Must reject foreign numbers for UAE local order SMS');

    // 1.3 Masking
    const masked = maskPhone('+971501234567');
    assert(masked.includes('*** **') && masked.endsWith('67'), `Masked phone format invalid: ${masked}`);

    console.log('✅ Suite 1 Passed: UAE mobile numbers normalized, validated, and masked securely.\n');

    // -----------------------------------------------------------------
    // Suite 2: Single-Use Cryptographic Token Lifecycle & Expiration
    // -----------------------------------------------------------------
    console.log('--- Suite 2: Single-Use Cryptographic Token Security & TTL ---');

    const testRef = `ABH-ORD-${Date.now()}`;
    const tokenInfo = PendingOrderStore.generateToken(testRef, 30);
    assert(tokenInfo.token && tokenInfo.token.split(':').length === 3, 'Token must contain orderRef, expiry, and HMAC signature');

    // 2.1 Valid verification
    const verified = PendingOrderStore.verifyToken(tokenInfo.token);
    assert(verified.valid === true && verified.orderReference === testRef, 'Token verification must succeed for valid token');

    // 2.2 Tampered token rejection
    const tampered = tokenInfo.token.slice(0, -6) + 'abcdef';
    const tamperedRes = PendingOrderStore.verifyToken(tampered);
    assert(tamperedRes.valid === false && tamperedRes.reason === 'invalid_signature', 'Tampered token must be rejected with invalid_signature');

    // 2.3 Expired token rejection
    const expiredTokenInfo = PendingOrderStore.generateToken(testRef, -5); // 5 minutes in past
    const expiredRes = PendingOrderStore.verifyToken(expiredTokenInfo.token);
    assert(expiredRes.valid === false && expiredRes.reason === 'token_expired', 'Expired token must be rejected with token_expired');

    console.log('✅ Suite 2 Passed: Single-use HMAC-SHA256 tokens and 30-minute expiry validated.\n');

    // -----------------------------------------------------------------
    // Suite 3: SMS Templates & Delivery Tracking
    // -----------------------------------------------------------------
    console.log('--- Suite 3: Order Confirmation SMS Templates & Tracking ---');

    const sampleOrder = {
      orderReference: 'ABH-ORD-99112233',
      customerName: 'Fatima Al Mansoori',
      customerPhone: '+971501234567',
      lineItems: [
        { productTitle: 'Abihacart Premium Coffee Maker', quantity: 1, price: 249.00 },
      ],
      subtotal: 249.00,
      deliveryFee: 0.00,
      totalAmount: 249.00,
      deliveryAddress: 'Villa 14, Al Safa 2, Dubai',
      confirmationUrl: 'https://abihacart.myshopify.com/api/orders/confirm-sms?token=test_token_123',
    };

    // 3.1 Initial SMS
    const initialSmsText = smsService.formatOrderConfirmationMessage(sampleOrder);
    assert(initialSmsText.includes('Hello Fatima Al Mansoori,'), 'Must greet customer by name');
    assert(initialSmsText.includes('Order Reference: ABH-ORD-99112233'), 'Must contain Order Reference');
    assert(initialSmsText.includes('Product: Abihacart Premium Coffee Maker'), 'Must contain Product Title');
    assert(initialSmsText.includes('Price: AED 249.00'), 'Must contain Price in AED');
    assert(initialSmsText.includes('Total: AED 249.00'), 'Must contain Total Amount in AED');
    assert(initialSmsText.includes(sampleOrder.confirmationUrl), 'Must contain secure confirmation URL');
    console.log('✅ Test 3.1: Initial Order Confirmation SMS template verified with actual order data.');

    // 3.2 Final SMS
    const finalSmsText = smsService.formatFinalConfirmationMessage({
      shopifyOrderName: '#ABH-1004',
      shopifyOrderId: '1001004',
      productTitle: 'Abihacart Premium Coffee Maker (x1)',
      totalAmount: 249.00,
      deliveryAddress: sampleOrder.deliveryAddress,
    });
    assert(finalSmsText.includes('Your Abihacart order has been confirmed!'), 'Must state order is confirmed');
    assert(finalSmsText.includes('Order ID: #ABH-1004'), 'Must state verified Shopify Order ID');
    assert(finalSmsText.includes('Total: AED 249.00'), 'Must state confirmed Total');
    console.log('✅ Test 3.2: Final Confirmation SMS template verified with official Shopify Order ID.\n');

    // -----------------------------------------------------------------
    // Suite 4: Shopify Draft Order Creation & Completion
    // -----------------------------------------------------------------
    console.log('--- Suite 4: Shopify Draft Order Lifecycle ---');

    const draftRes = await shopifyService.createDraftOrder({
      shop,
      orderData: sampleOrder,
    });
    assert(draftRes.draftOrderId && draftRes.draftOrderId.includes('DraftOrder'), 'Must return valid Draft Order ID');
    assert(draftRes.currencyCode === 'AED', 'Draft order currency must be AED');
    console.log(`✅ Test 4.1: Shopify Draft Order created: ${draftRes.draftOrderName} (${draftRes.draftOrderId})`);

    const completeRes = await shopifyService.completeDraftOrder({
      shop,
      draftOrderId: draftRes.draftOrderId,
      paymentDetails: { totalPrice: 249.00 },
    });
    assert(completeRes.orderId && completeRes.orderId.includes('Order'), 'Must convert to official Shopify Order');
    assert(completeRes.orderName && completeRes.orderName.startsWith('#ABH-'), 'Must assign official store Order Name (#ABH-XXXX)');
    console.log(`✅ Test 4.2: Shopify Draft Order completed to official Order: ${completeRes.orderName} (${completeRes.orderId})\n`);

    // -----------------------------------------------------------------
    // Suite 5: HTTP Endpoints & End-to-End SMS Order Confirmation Flow
    // -----------------------------------------------------------------
    console.log('--- Suite 5: End-to-End API Order Placement & Confirmation Flow ---');

    // 5.1 Place order request via POST /api/orders/place-sms-order
    const placeRes = await makeRequest('POST', '/api/orders/place-sms-order', {
      productHandle: 'abihacart-coffee-maker',
      quantity: 1,
      customerName: 'Fatima Al Mansoori',
      customerPhone: '0501234567',
      deliveryAddress: 'Villa 14, Al Safa 2, Dubai',
      emirate: 'Dubai',
      shop,
    });

    assert(placeRes.status === 201, `Place order must return HTTP 201 Created (got ${placeRes.status})`);
    assert(placeRes.body.status === 'success', 'Response status must be success');
    const createdOrder = placeRes.body.order;
    assert(createdOrder.orderReference.startsWith('ABH-ORD-'), 'Must generate ABH-ORD reference');
    assert(createdOrder.status === 'pending_confirmation', 'Initial status must be pending_confirmation');
    assert(createdOrder.totalAmount === 249.00, 'Total must equal AED 249.00');
    assert(createdOrder.confirmationUrl.includes('token='), 'Confirmation URL must include secure token');
    console.log(`✅ Test 5.1: Order placed via API: ${createdOrder.orderReference}, SMS dispatched to ${createdOrder.maskedPhone}.`);

    // Extract confirmation token from URL
    const confirmationToken = new URL(createdOrder.confirmationUrl).searchParams.get('token');

    // 5.2 Confirm order via GET /api/orders/confirm-sms?token=...
    const confirmRes = await makeRequest('GET', `/api/orders/confirm-sms?token=${encodeURIComponent(confirmationToken)}`, null, {
      Accept: 'application/json',
    });
    assert(confirmRes.status === 200, `Confirm order must return HTTP 200 OK (got ${confirmRes.status})`);
    assert(confirmRes.body.order.status === 'confirmed', 'Order status must be updated to confirmed');
    assert(confirmRes.body.order.shopifyOrderName.startsWith('#ABH-'), 'Must return confirmed Shopify Order Name');
    console.log(`✅ Test 5.2: Customer confirmed order: Official Shopify Order ${confirmRes.body.order.shopifyOrderName} created.`);

    // 5.3 Prevent Duplicate Confirmation (Single-Use Defense)
    const duplicateRes = await makeRequest('GET', `/api/orders/confirm-sms?token=${encodeURIComponent(confirmationToken)}`, null, {
      Accept: 'application/json',
    });
    assert(duplicateRes.status === 200, 'Duplicate check must return HTTP 200 with notice');
    assert(duplicateRes.body.alreadyConfirmed === true, 'Duplicate check must flag alreadyConfirmed=true');
    console.log('✅ Test 5.3: Duplicate confirmation attempt safely handled without re-creating orders.\n');

    // -----------------------------------------------------------------
    // Suite 6: Conversational AI Order Intake in Support Concierge
    // -----------------------------------------------------------------
    console.log('--- Suite 6: Conversational AI Order Intake & Intent Processing ---');

    // 6.1 Order intent without details -> prompts for details
    const chatPromptRes = await openaiService.processSupportMessage({
      userMessage: 'I want to place an order for the coffee maker',
      shop,
    });
    assert(chatPromptRes.reply.includes('Full Name') && chatPromptRes.reply.includes('Mobile Number'), 'AI must request Name, Phone, and Address');
    console.log('✅ Test 6.1: Open order request prompts customer for required delivery details.');

    // 6.2 Order intent with details provided -> creates pending order and sends SMS
    const chatOrderRes = await openaiService.processSupportMessage({
      userMessage: 'My name is Tariq Mansoor, phone 0501234567, delivery to Downtown Dubai, please place order for the coffee maker',
      shop,
    });
    assert(chatOrderRes.reply.includes('Order Request Created') || chatOrderRes.reply.includes('Order Reference'), 'AI must confirm order request created');
    assert(chatOrderRes.reply.includes('SMS Confirmation Sent') || chatOrderRes.reply.includes('SMS'), 'AI must inform customer about confirmation SMS');
    assert(chatOrderRes.orderPlaced === true, 'AI result must set orderPlaced=true');
    console.log('✅ Test 6.2: Complete ordering details in chat generates order request and dispatches SMS.\n');

    // -----------------------------------------------------------------
    // Suite 7: Admin Dashboard SMS Orders API & PII Masking
    // -----------------------------------------------------------------
    console.log('--- Suite 7: Admin Dashboard SMS Orders API & Security ---');

    const adminApiKey = config.agent.adminApiKey || 'abh_admin_secure_auth_token_default';

    // 7.1 Unauthorized access blocked
    const unauthAdmin = await makeRequest('GET', '/api/admin/sms-orders');
    assert(unauthAdmin.status === 401, 'Must reject unauthenticated access to SMS orders with HTTP 401');

    // 7.2 Authorized admin retrieval
    const authAdmin = await makeRequest('GET', '/api/admin/sms-orders', null, {
      'x-admin-key': adminApiKey,
    });
    assert(authAdmin.status === 200, 'Must return HTTP 200 for authorized admin');
    assert(Array.isArray(authAdmin.body.orders) && authAdmin.body.orders.length > 0, 'Must return list of orders');

    // Verify PII masking in admin listing
    for (const ord of authAdmin.body.orders) {
      assert(ord.customerPhone.includes('*** **'), `Customer phone must be masked in admin view: ${ord.customerPhone}`);
      assert(ord.orderReference, 'Order must have order reference');
    }
    console.log(`✅ Test 7.1: Admin successfully retrieved ${authAdmin.body.orders.length} SMS orders with strict PII masking.\n`);

    console.log('======================================================================');
    console.log('🎉 ALL PHASE 9.11 CUSTOMER ORDER SMS CONFIRMATION TESTS PASSED (100%)');
    console.log('======================================================================');
  } finally {
    if (server) {
      server.close();
    }
  }
}

runPhase9_11Tests().catch((err) => {
  console.error('❌ Phase 9.11 Test Failed:', err);
  if (server) server.close();
  process.exit(1);
});
