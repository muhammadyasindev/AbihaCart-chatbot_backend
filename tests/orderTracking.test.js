/**
 * Phase 6 Automated Test Suite: Order Confirmation, Tracking & Two-Field Customer Verification
 */
const http = require('http');
const app = require('../src/app');
const orderService = require('../src/services/order.service');
const shopifyService = require('../src/services/shopify.service');
const logger = require('../src/utils/logger');

const testPort = 5998;
let server;

const assert = (condition, msg) => {
  if (!condition) {
    throw new Error(`Assertion failed: ${msg}`);
  }
};

const sendPost = (url, bodyObj, headers = {}) => {
  return new Promise((resolve, reject) => {
    const rawBody = JSON.stringify(bodyObj);
    const parsed = new URL(url);

    const req = http.request(
      {
        hostname: parsed.hostname,
        port: parsed.port,
        path: parsed.pathname,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(rawBody),
          ...headers,
        },
      },
      (res) => {
        let data = '';
        res.on('data', (c) => { data += c; });
        res.on('end', () => {
          try {
            resolve({ statusCode: res.statusCode, body: JSON.parse(data) });
          } catch (e) {
            resolve({ statusCode: res.statusCode, data });
          }
        });
      }
    );
    req.on('error', reject);
    req.write(rawBody);
    req.end();
  });
};

const runPhase6Tests = async () => {
  console.log('======================================================================');
  console.log('🧪 Starting Phase 6 Order Confirmation & Tracking Tests (Audit Hardening)');
  console.log('======================================================================\n');

  // Reset any cached failed attempts before starting
  orderService.clearAllTracking();

  // -----------------------------------------------------------------
  // Suite 1: Shopify GraphQL Order Query & Scopes Verification
  // -----------------------------------------------------------------
  console.log('--- Suite 1: GraphQL Query Construction & Scopes Audit ---');

  // 1.1: Verify read-only query method exists on shopifyService
  assert(typeof shopifyService.getOrderByNameOrNumber === 'function', 'shopifyService must define getOrderByNameOrNumber');
  console.log('✅ Test 1.1: getOrderByNameOrNumber defined on ShopifyService.');

  // 1.2: Verify zero mutations exist on orderService
  const orderMethods = Object.getOwnPropertyNames(Object.getPrototypeOf(orderService));
  const hasMutations = orderMethods.some((m) => m.startsWith('create') || m.startsWith('update') || m.startsWith('delete'));
  assert(!hasMutations, 'orderService must not contain create/update/delete mutations');
  console.log('✅ Test 1.2: orderService confirmed strictly read-only.');

  // 1.3: Verify explicit mutation blockers throw errors
  let cancelBlocked = false;
  try {
    await orderService.cancelOrder();
  } catch (e) {
    cancelBlocked = e.message.includes('strictly prohibited');
  }
  assert(cancelBlocked, 'cancelOrder must throw prohibited error');

  let modifyBlocked = false;
  try {
    await orderService.modifyOrder();
  } catch (e) {
    modifyBlocked = e.message.includes('strictly prohibited');
  }
  assert(modifyBlocked, 'modifyOrder must throw prohibited error');

  let refundBlocked = false;
  try {
    await orderService.refundOrder();
  } catch (e) {
    refundBlocked = e.message.includes('strictly prohibited');
  }
  assert(refundBlocked, 'refundOrder must throw prohibited error');
  console.log('✅ Test 1.3: Mutation methods (cancel, modify, refund) throw strict refusal errors.');

  // -----------------------------------------------------------------
  // Suite 2: Two-Field Customer Verification & Exact Order Matching
  // -----------------------------------------------------------------
  console.log('\n--- Suite 2: Two-Field Customer Verification & Exact Order Matching ---');

  // 2.1: Phone normalization for UAE numbers
  assert(orderService.normalizePhone('+971501234567') === '501234567', '+971 format normalized');
  assert(orderService.normalizePhone('0501234567') === '501234567', '050 format normalized');
  assert(orderService.normalizePhone('00971501234567') === '501234567', '00971 format normalized');
  assert(orderService.normalizePhone('+971 50 123 4567') === '501234567', 'Spaced format normalized');
  console.log('✅ Test 2.1: UAE phone normalization handles +971, 00971, 05, and spaces.');

  // 2.2: Two-Field Match: Verified with Email
  const verifiedEmail = await orderService.verifyAndGetOrder({
    orderNumber: '#ABH-1001',
    email: 'customer@example.com',
  });
  assert(verifiedEmail.verified === true, 'Valid email must verify');
  assert(verifiedEmail.orderNumber === '#ABH-1001', 'Order number must match');
  assert(verifiedEmail.financialStatus.includes('Paid'), 'Financial status must be Paid');
  assert(verifiedEmail.fulfillmentStatus.includes('Dubai') || verifiedEmail.fulfillmentStatus.includes('Processing'), 'Fulfillment status must reflect packing');
  assert(verifiedEmail.totalAmount.includes('AED 249'), 'Total must be AED 249');
  assert(verifiedEmail.lineItems.length > 0, 'Must include line items');
  console.log('✅ Test 2.2: Order #ABH-1001 verified with email (Financial: Paid, Total: AED 249).');

  // 2.3: Two-Field Match: Verified with Phone
  const verifiedPhone = await orderService.verifyAndGetOrder({
    orderNumber: '#ABH-1002',
    phone: '0501234567',
  });
  assert(verifiedPhone.verified === true, 'Valid phone must verify');
  assert(verifiedPhone.carrier === 'Emirates Post', 'Carrier must be Emirates Post');
  assert(verifiedPhone.trackingNumber === 'EP971002456AE', 'Tracking number must match EP971002456AE');
  assert(typeof verifiedPhone.trackingUrl === 'string', 'Tracking URL must be present');
  console.log('✅ Test 2.3: Order #ABH-1002 verified with phone (Carrier: Emirates Post, Tracking: EP971002456AE).');

  // 2.4: Phone Matching with International Format
  const verifiedIntlPhone = await orderService.verifyAndGetOrder({
    orderNumber: '#ABH-1002',
    contact: '+971 50 123 4567',
  });
  assert(verifiedIntlPhone.verified === true, 'International phone format must verify');
  console.log('✅ Test 2.4: International phone format (+971 50 123 4567) matched against stored phone.');

  // 2.5: Case-Insensitive Order Number & Email Matching
  const verifiedCaseInsensitive = await orderService.verifyAndGetOrder({
    orderNumber: 'abh-1001',
    email: 'CUSTOMER@EXAMPLE.COM',
  });
  assert(verifiedCaseInsensitive.verified === true, 'Case-insensitive order and email must match');
  console.log('✅ Test 2.5: Case-insensitive order number and email matched safely.');

  // 2.6: Exact Order-Number Matching: #ABH-100 must NOT match #ABH-1001 or #ABH-1002
  const partialPrefixMatch = await orderService.verifyAndGetOrder({
    orderNumber: '#ABH-100',
    email: 'customer@example.com',
  });
  assert(partialPrefixMatch.verified === false, 'Partial prefix #ABH-100 must NOT match #ABH-1001');
  assert(partialPrefixMatch.code === 'SHOPIFY_AUTH_PENDING' || partialPrefixMatch.code === 'ORDER_NOT_FOUND', 'Partial prefix must be treated as non-existent');

  const partialSuffixMatch = await orderService.verifyAndGetOrder({
    orderNumber: '#ABH-10010',
    email: 'customer@example.com',
  });
  assert(partialSuffixMatch.verified === false, '#ABH-10010 must NOT match #ABH-1001');
  console.log('✅ Test 2.6: Exact order-number matching verified: #ABH-100 and #ABH-10010 do NOT match #ABH-1001.');

  // 2.7: IDOR & Security Protection: Attacker with Wrong Contact Rejected
  const wrongContact = await orderService.verifyAndGetOrder({
    orderNumber: '#ABH-1001',
    email: 'attacker@malicious.com',
    clientId: 'test-client-idor',
  });
  assert(wrongContact.verified === false, 'Mismatched email must be rejected');
  assert(wrongContact.code === 'VERIFICATION_FAILED', 'Must return VERIFICATION_FAILED');
  assert(!wrongContact.lineItems, 'Must NOT leak line items to unauthorized contact');
  assert(!wrongContact.trackingNumber, 'Must NOT leak tracking number to unauthorized contact');
  orderService.resetFailedAttempts('test-client-idor:#ABH-1001');
  orderService.resetFailedAttempts('#ABH-1001');
  console.log('✅ Test 2.7: IDOR Protection: Unauthorized contact rejected without leaking order data.');

  // 2.8: Missing Verification Contact
  const missingContact = await orderService.verifyAndGetOrder({
    orderNumber: '#ABH-1001',
  });
  assert(missingContact.verified === false, 'Missing contact must be rejected');
  assert(missingContact.code === 'MISSING_VERIFICATION_CONTACT', 'Must prompt for verification contact');
  console.log('✅ Test 2.8: Missing contact prompts for email or phone.');

  // 2.9: Missing Order Number
  const missingOrderNum = await orderService.verifyAndGetOrder({
    email: 'customer@example.com',
  });
  assert(missingOrderNum.verified === false, 'Missing order number must be rejected');
  assert(missingOrderNum.code === 'MISSING_ORDER_NUMBER', 'Must require order reference');
  console.log('✅ Test 2.9: Missing order number rejected with clear prompt.');

  // -----------------------------------------------------------------
  // Suite 3: Input Validation & Sanitization (Malformed Inputs)
  // -----------------------------------------------------------------
  console.log('\n--- Suite 3: Input Validation & Malformed Input Handling ---');

  // 3.1: Non-string order number (object injection)
  const objOrderNum = await orderService.verifyAndGetOrder({
    orderNumber: { $gt: '' },
    email: 'customer@example.com',
  });
  assert(objOrderNum.verified === false, 'Object injection order number must be rejected');
  assert(objOrderNum.code === 'INVALID_INPUT', 'Must return INVALID_INPUT code');
  console.log('✅ Test 3.1: Non-string object injection in orderNumber rejected with INVALID_INPUT.');

  // 3.2: Extremely long order number (> 50 chars)
  const longOrderNum = await orderService.verifyAndGetOrder({
    orderNumber: 'A'.repeat(150),
    email: 'customer@example.com',
  });
  assert(longOrderNum.verified === false, 'Overlength order number must be rejected');
  assert(longOrderNum.code === 'INVALID_INPUT', 'Must return INVALID_INPUT code');
  console.log('✅ Test 3.2: Overlength order number (>50 characters) rejected with INVALID_INPUT.');

  // 3.3: Dangerous injection characters in order number
  const scriptOrderNum = await orderService.verifyAndGetOrder({
    orderNumber: '<script>alert(1)</script>',
    email: 'customer@example.com',
  });
  assert(scriptOrderNum.verified === false, 'Script injection in order number must be rejected');
  assert(scriptOrderNum.code === 'INVALID_INPUT', 'Must return INVALID_INPUT code');
  console.log('✅ Test 3.3: Injection pattern (<script>) in order number rejected safely.');

  // 3.4: Malformed email input (invalid format / non-string)
  const malformedEmail = await orderService.verifyAndGetOrder({
    orderNumber: '#ABH-1001',
    email: 'invalid-email-without-at',
  });
  assert(malformedEmail.verified === false, 'Malformed email format must be rejected');
  assert(malformedEmail.code === 'INVALID_INPUT', 'Must return INVALID_INPUT');
  console.log('✅ Test 3.4: Malformed customer email rejected with INVALID_INPUT.');

  // 3.5: Malformed phone input (invalid characters)
  const malformedPhone = await orderService.verifyAndGetOrder({
    orderNumber: '#ABH-1001',
    phone: 'DROP TABLE orders;--',
  });
  assert(malformedPhone.verified === false, 'SQL injection in phone must be rejected');
  assert(malformedPhone.code === 'INVALID_INPUT', 'Must return INVALID_INPUT');
  console.log('✅ Test 3.5: SQL injection pattern in phone number rejected safely.');

  // -----------------------------------------------------------------
  // Suite 4: Repeated Failed Attempt Suspension & AI Tool Rate Limiting
  // -----------------------------------------------------------------
  console.log('\n--- Suite 4: Failed Attempt Suspension & AI Tool Rate Limiting ---');

  const testTrackerClient = 'client-brute-force-tester';
  orderService.resetFailedAttempts(`${testTrackerClient}:#ABH-1001`);

  // 4.1: Simulate 5 consecutive failed verification attempts
  for (let attempt = 1; attempt <= 4; attempt++) {
    const failRes = await orderService.verifyAndGetOrder({
      orderNumber: '#ABH-1001',
      email: `wrong-${attempt}@example.com`,
      clientId: testTrackerClient,
    });
    assert(failRes.verified === false, `Attempt ${attempt} must fail`);
    assert(failRes.code === 'VERIFICATION_FAILED', `Attempt ${attempt} must return VERIFICATION_FAILED`);
  }

  // 5th failed attempt triggers the lockout
  const fifthFailRes = await orderService.verifyAndGetOrder({
    orderNumber: '#ABH-1001',
    email: 'wrong-5@example.com',
    clientId: testTrackerClient,
  });
  assert(fifthFailRes.verified === false, '5th attempt must fail');
  assert(fifthFailRes.code === 'TOO_MANY_FAILED_ATTEMPTS', '5th failed attempt must trigger TOO_MANY_FAILED_ATTEMPTS');
  console.log('✅ Test 4.1: 5 consecutive failed verification attempts triggered temporary lockout.');

  // 6th attempt is blocked immediately by lockout
  const sixthFailRes = await orderService.verifyAndGetOrder({
    orderNumber: '#ABH-1001',
    email: 'customer@example.com', // Even valid credentials blocked during lockout
    clientId: testTrackerClient,
  });
  assert(sixthFailRes.verified === false, '6th attempt must be blocked by lockout');
  assert(sixthFailRes.code === 'TOO_MANY_FAILED_ATTEMPTS', 'Must return TOO_MANY_FAILED_ATTEMPTS');
  console.log('✅ Test 4.2: In-lockout request blocked immediately with TOO_MANY_FAILED_ATTEMPTS.');

  // Clean up test tracker
  orderService.resetFailedAttempts(`${testTrackerClient}:#ABH-1001`);
  orderService.resetFailedAttempts('#ABH-1001');

  // 4.3: AI Tool-Based Rate Limiting
  const aiSession = 'ai-session-rate-limit-test';
  for (let i = 0; i < 10; i++) {
    const check = orderService.checkAiToolRateLimit(aiSession);
    assert(check.allowed === true, `Call ${i + 1} should be allowed`);
  }
  const exceededCheck = orderService.checkAiToolRateLimit(aiSession);
  assert(exceededCheck.allowed === false, '11th call must exceed limit');
  assert(exceededCheck.code === 'AI_TOOL_RATE_LIMITED', 'Must return AI_TOOL_RATE_LIMITED');
  console.log('✅ Test 4.3: AI chatbot tool rate limiting enforced (capped at 10 requests per session).');

  // -----------------------------------------------------------------
  // Suite 5: Customer PII Masking & Privacy/Logger Audit
  // -----------------------------------------------------------------
  console.log('\n--- Suite 5: Customer PII Masking & Logger Audit ---');

  // 5.1: Payload Masking
  assert(verifiedEmail.maskedEmail === 'c***r@example.com', `Masked email must match (found: ${verifiedEmail.maskedEmail})`);
  assert(verifiedEmail.maskedPhone.includes('***'), 'Masked phone must obscure middle digits');
  assert(!JSON.stringify(verifiedEmail).includes('customer@example.com'), 'Raw email must not appear in verified payload');
  console.log('✅ Test 5.1: Customer email and phone masked to protect customer privacy.');

  // 5.2: Logger Privacy Audit: Verify zero raw customer PII leakage in logger calls
  const loggedMessages = [];
  const originalInfo = logger.info;
  const originalWarn = logger.warn;
  const originalError = logger.error;

  logger.info = (msg, meta) => { loggedMessages.push(String(msg) + ' ' + JSON.stringify(meta || {})); originalInfo.call(logger, msg, meta); };
  logger.warn = (msg, meta) => { loggedMessages.push(String(msg) + ' ' + JSON.stringify(meta || {})); originalWarn.call(logger, msg, meta); };
  logger.error = (msg, meta) => { loggedMessages.push(String(msg) + ' ' + JSON.stringify(meta || {})); originalError.call(logger, msg, meta); };

  try {
    await orderService.verifyAndGetOrder({
      orderNumber: '#ABH-1002',
      email: 'customer@example.com',
      phone: '+971501234567',
    });

    const fullLogText = loggedMessages.join('\n');
    assert(!fullLogText.includes('customer@example.com'), 'Logger must NOT contain raw customer email');
    assert(!fullLogText.includes('+971501234567'), 'Logger must NOT contain raw customer phone');
    assert(!fullLogText.includes('EP971002456AE'), 'Logger must NOT contain raw courier tracking number');
    console.log('✅ Test 5.2: Logger privacy audit verified: zero unmasked customer PII or tracking numbers in application logs.');
  } finally {
    logger.info = originalInfo;
    logger.warn = originalWarn;
    logger.error = originalError;
  }

  // -----------------------------------------------------------------
  // Suite 6: REST API Endpoint & Mutation Rejection
  // -----------------------------------------------------------------
  console.log('\n--- Suite 6: REST API Endpoint & Mutation Rejection ---');

  server = app.listen(testPort, async () => {
    try {
      // 6.1: Track order with valid email via HTTP POST
      const apiTrackRes = await sendPost(`http://localhost:${testPort}/api/orders/track`, {
        orderNumber: '#ABH-1001',
        email: 'customer@example.com',
      });
      assert(apiTrackRes.statusCode === 200, 'Track order API must return 200');
      assert(apiTrackRes.body.data.verified === true, 'Response data must be verified');
      assert(apiTrackRes.body.data.totalAmount === 'AED 249.00', 'Amount must be AED 249.00');
      console.log('✅ Test 6.1: POST /api/orders/track returned verified order details (HTTP 200).');

      // 6.2: Track order with missing contact (HTTP 400)
      const apiMissingContact = await sendPost(`http://localhost:${testPort}/api/orders/track`, {
        orderNumber: '#ABH-1001',
      });
      assert(apiMissingContact.statusCode === 400, 'Missing contact must return HTTP 400');
      assert(apiMissingContact.body.code === 'MISSING_VERIFICATION_CONTACT', 'Code must match MISSING_VERIFICATION_CONTACT');
      console.log('✅ Test 6.2: POST /api/orders/track with missing contact rejected with HTTP 400.');

      // 6.3: Track order with wrong contact (HTTP 401)
      const apiWrongContact = await sendPost(`http://localhost:${testPort}/api/orders/track`, {
        orderNumber: '#ABH-1001',
        email: 'attacker@test.com',
      });
      assert(apiWrongContact.statusCode === 401, 'Unauthorized contact must return HTTP 401');
      assert(apiWrongContact.body.code === 'VERIFICATION_FAILED', 'Code must match VERIFICATION_FAILED');
      orderService.resetFailedAttempts('#ABH-1001');
      console.log('✅ Test 6.3: POST /api/orders/track with mismatched contact rejected with HTTP 401.');

      // 6.4: Track order with malformed input (non-string order number, HTTP 400)
      const apiMalformedInput = await sendPost(`http://localhost:${testPort}/api/orders/track`, {
        orderNumber: { $gt: '' },
        email: 'customer@example.com',
      });
      assert(apiMalformedInput.statusCode === 400, 'Malformed object order number must return HTTP 400');
      assert(apiMalformedInput.body.code === 'INVALID_INPUT', 'Code must match INVALID_INPUT');
      console.log('✅ Test 6.4: POST /api/orders/track with malformed object input rejected with HTTP 400.');

      // 6.5: Prohibited mutation: POST /api/orders/cancel blocked with HTTP 403
      const cancelRes = await sendPost(`http://localhost:${testPort}/api/orders/cancel`, {
        orderNumber: '#ABH-1001',
      });
      assert(cancelRes.statusCode === 403, 'Cancel endpoint must return HTTP 403');
      assert(cancelRes.body.code === 'READ_ONLY_MODE', 'Code must match READ_ONLY_MODE');
      console.log('✅ Test 6.5: POST /api/orders/cancel blocked with HTTP 403 (Read-Only Mode).');

      // 6.6: Prohibited mutation: POST /api/orders/modify blocked with HTTP 403
      const modifyRes = await sendPost(`http://localhost:${testPort}/api/orders/modify`, {
        orderNumber: '#ABH-1001',
      });
      assert(modifyRes.statusCode === 403, 'Modify endpoint must return HTTP 403');
      assert(modifyRes.body.code === 'READ_ONLY_MODE', 'Code must match READ_ONLY_MODE');
      console.log('✅ Test 6.6: POST /api/orders/modify blocked with HTTP 403 (Read-Only Mode).');

      // 6.7: Prohibited mutation: POST /api/orders/refund blocked with HTTP 403
      const refundRes = await sendPost(`http://localhost:${testPort}/api/orders/refund`, {
        orderNumber: '#ABH-1001',
      });
      assert(refundRes.statusCode === 403, 'Refund endpoint must return HTTP 403');
      assert(refundRes.body.code === 'READ_ONLY_MODE', 'Code must match READ_ONLY_MODE');
      console.log('✅ Test 6.7: POST /api/orders/refund blocked with HTTP 403 (Read-Only Mode).');

      console.log('\n======================================================================');
      console.log('🎉 ALL PHASE 6 FINAL SECURITY AUDIT TESTS PASSED (100%)');
      console.log('======================================================================\n');

      server.close(() => process.exit(0));
    } catch (err) {
      console.error('\n❌ Phase 6 Test Failure:', err.message);
      if (server) server.close();
      process.exit(1);
    }
  });
};

runPhase6Tests();
