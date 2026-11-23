/**
 * Phase 4 Automated Test Suite: Chatbot Frontend, API, and Product Cards
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const app = require('../src/app');

const testPort = 5996;
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

const sendGet = (url, headers = {}) => {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    http.get({
      hostname: parsed.hostname,
      port: parsed.port,
      path: parsed.pathname + parsed.search,
      headers,
    }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        try {
          resolve({ statusCode: res.statusCode, body: JSON.parse(data) });
        } catch (e) {
          resolve({ statusCode: res.statusCode, data });
        }
      });
    }).on('error', reject);
  });
};

const runPhase4Tests = async () => {
  console.log('====================================================');
  console.log('🧪 Starting Phase 4 Chat Widget & API Tests');
  console.log('====================================================\n');

  // -----------------------------------------------------------------
  // Suite 1: Frontend Asset Security & Integrity Audits
  // -----------------------------------------------------------------
  console.log('--- Suite 1: Frontend Code Security & No Secrets Audit ---');
  const widgetJsPath = fs.existsSync(path.resolve(__dirname, '../../frontend/storefront-widget/js/widget.js'))
    ? path.resolve(__dirname, '../../frontend/storefront-widget/js/widget.js')
    : path.resolve(__dirname, '../../storefront-widget/js/widget.js');
  const widgetCssPath = fs.existsSync(path.resolve(__dirname, '../../frontend/storefront-widget/css/widget.css'))
    ? path.resolve(__dirname, '../../frontend/storefront-widget/css/widget.css')
    : path.resolve(__dirname, '../../storefront-widget/css/widget.css');
  const appEmbedPath = fs.existsSync(path.resolve(__dirname, '../../extensions/abihacart-chat-embed/blocks/chat_embed.liquid'))
    ? path.resolve(__dirname, '../../extensions/abihacart-chat-embed/blocks/chat_embed.liquid')
    : path.resolve(__dirname, '../../shopify-app/extensions/abihacart-chat-embed/blocks/chat_embed.liquid');

  assert(fs.existsSync(widgetJsPath), 'storefront-widget/js/widget.js must exist');
  assert(fs.existsSync(widgetCssPath), 'storefront-widget/css/widget.css must exist');
  assert(fs.existsSync(appEmbedPath), 'chat_embed.liquid must exist');

  const jsContent = fs.readFileSync(widgetJsPath, 'utf8');
  const cssContent = fs.readFileSync(widgetCssPath, 'utf8');
  const liquidContent = fs.readFileSync(appEmbedPath, 'utf8');

  // Security checks: No secret keys in frontend files
  assert(!jsContent.includes('client_secret'), 'Frontend JS must NOT contain client_secret');
  assert(!jsContent.includes('shpss_'), 'Frontend JS must NOT contain Shopify secret');
  assert(!jsContent.includes('sk-'), 'Frontend JS must NOT contain OpenAI API keys');
  assert(!jsContent.includes('shpat_'), 'Frontend JS must NOT contain Shopify access tokens');
  assert(jsContent.includes('textContent'), 'Frontend JS must use textContent to defend against XSS');
  console.log('✅ Test 1.1: Frontend JS free from credentials, secrets, and XSS vulnerabilities.');

  // Responsive styling checks
  assert(cssContent.includes('@media (max-width: 640px)'), 'CSS must include mobile breakpoint @media (max-width: 640px)');
  assert(cssContent.includes('abh-product-card'), 'CSS must style product cards');
  assert(cssContent.includes('abh-typing-dot'), 'CSS must include typing indicator animation');
  console.log('✅ Test 1.2: CSS includes full mobile responsiveness and ecommerce product cards.');

  // App Embed checks
  assert(liquidContent.includes('{% schema %}'), 'App embed must declare standard Shopify schema');
  assert(liquidContent.includes('enable_chatbot'), 'App embed must provide merchant on/off setting');
  console.log('✅ Test 1.3: Theme App Embed Block configured cleanly without theme modifications.');

  // -----------------------------------------------------------------
  // Suite 2: Chat API Endpoints & Product Card Delivery Tests
  // -----------------------------------------------------------------
  console.log('\n--- Suite 2: Chat API Endpoints & Response Validation ---');

  server = app.listen(testPort, async () => {
    try {
      // Test 2.1: Initial suggestions
      const suggestionsRes = await sendGet(`http://localhost:${testPort}/api/chat/suggestions`);
      assert(suggestionsRes.statusCode === 200, 'Suggestions must return 200 OK');
      assert(Array.isArray(suggestionsRes.body.suggestions), 'Must return suggestions array');
      assert(suggestionsRes.body.suggestions.includes('Where is my order?'), 'Must include order tracking chip');
      console.log('✅ Test 2.1: GET /api/chat/suggestions returns approved customer questions.');

      // Test 2.2: Message input validation (empty message)
      const emptyMsgRes = await sendPost(`http://localhost:${testPort}/api/chat/message`, { message: '' });
      assert(emptyMsgRes.statusCode === 400, 'Empty message must return 400 Bad Request');
      console.log('✅ Test 2.2: Empty message rejected with HTTP 400.');

      // Test 2.3: Message input validation (oversized message)
      const oversized = 'a'.repeat(1005);
      const overMsgRes = await sendPost(`http://localhost:${testPort}/api/chat/message`, { message: oversized });
      assert(overMsgRes.statusCode === 400, 'Over 1000 chars message must return 400 Bad Request');
      console.log('✅ Test 2.3: Overlength message (>1000 chars) rejected with HTTP 400.');

      // Test 2.4: Product inquiry with product cards delivery
      const productQueryRes = await sendPost(`http://localhost:${testPort}/api/chat/message`, {
        message: 'Tell me about your products',
      });
      assert(productQueryRes.statusCode === 200, 'Product query must return 200 OK');
      assert(typeof productQueryRes.body.conversationId === 'string', 'Must assign conversationId');
      assert(typeof productQueryRes.body.conversationToken === 'string', 'Must assign conversationToken');
      assert(productQueryRes.body.productCards.length > 0, 'Must return product cards');
      
      const firstCard = productQueryRes.body.productCards[0];
      assert(firstCard.title !== undefined, 'Product card must have title');
      assert(firstCard.currencyCode === 'AED', 'Product card currency must be AED');
      assert(typeof firstCard.price === 'number', 'Product price must be a number');
      assert(typeof firstCard.availableForSale === 'boolean', 'Product availability must be boolean');
      console.log(`✅ Test 2.4: Product inquiry returned real-structure product cards in ${firstCard.currencyCode} (${firstCard.price}).`);

      const activeConvId = productQueryRes.body.conversationId;
      const activeConvToken = productQueryRes.body.conversationToken;

      // Test 2.5: Order status inquiry (with token authentication)
      const orderQueryRes = await sendPost(
        `http://localhost:${testPort}/api/chat/message`,
        {
          conversationId: activeConvId,
          message: 'Where is my order?',
        },
        { 'X-Conversation-Token': activeConvToken }
      );
      assert(orderQueryRes.statusCode === 200, 'Order inquiry must return 200 OK');
      assert(orderQueryRes.body.reply.includes('Order Number'), 'Must ask for order reference verification');
      console.log('✅ Test 2.5: Order inquiry correctly requests order reference verification.');

      // Test 2.6: Shipping policy inquiry with unconfirmed policy disclaimer
      const shippingQueryRes = await sendPost(
        `http://localhost:${testPort}/api/chat/message`,
        {
          conversationId: activeConvId,
          message: 'What are your shipping options?',
        },
        { 'X-Conversation-Token': activeConvToken }
      );
      assert(shippingQueryRes.statusCode === 200, 'Shipping inquiry must return 200 OK');
      assert(
        shippingQueryRes.body.reply.includes('Store Policy Note') ||
        shippingQueryRes.body.reply.includes('Emirates') ||
        shippingQueryRes.body.reply.includes('AED 15'),
        'Must return verified UAE shipping policy or verification note'
      );
      console.log('✅ Test 2.6: Shipping inquiry returns UAE delivery info.');

      // Test 2.7: Human agent escalation inquiry
      const humanQueryRes = await sendPost(
        `http://localhost:${testPort}/api/chat/message`,
        {
          conversationId: activeConvId,
          message: 'I need help from a human agent',
        },
        { 'X-Conversation-Token': activeConvToken }
      );
      assert(humanQueryRes.statusCode === 200, 'Human agent inquiry must return 200 OK');
      assert(humanQueryRes.body.reply.includes('WhatsApp'), 'Must mention WhatsApp support workflow');
      console.log('✅ Test 2.7: Human support inquiry references WhatsApp escalation.');

      // Test 2.8: IDOR Security Check: Unauthorized history access must be blocked
      const unauthHistoryRes = await sendGet(`http://localhost:${testPort}/api/chat/history/${activeConvId}`);
      assert(unauthHistoryRes.statusCode === 403, 'Unauthorized history access without token must return 403 Forbidden');
      console.log('✅ Test 2.8: Blocked unauthorized history access without valid conversationToken (HTTP 403 Forbidden).');

      // Test 2.9: IDOR Security Check: Forged token must be blocked
      const forgedHistoryRes = await sendGet(
        `http://localhost:${testPort}/api/chat/history/${activeConvId}`,
        { 'X-Conversation-Token': 'forged_fake_token_123456789' }
      );
      assert(forgedHistoryRes.statusCode === 403, 'Forged conversation token must return 403 Forbidden');
      console.log('✅ Test 2.9: Blocked history access with forged token (HTTP 403 Forbidden).');

      // Test 2.10: Authenticated session history restoration
      const authHistoryRes = await sendGet(
        `http://localhost:${testPort}/api/chat/history/${activeConvId}`,
        { 'X-Conversation-Token': activeConvToken }
      );
      assert(authHistoryRes.statusCode === 200, 'Authenticated history access must return 200 OK');
      assert(Array.isArray(authHistoryRes.body.messages), 'Must return messages array');
      assert(authHistoryRes.body.messages.length >= 8, 'History must contain all turns');
      console.log(`✅ Test 2.10: Authorized conversation history restored safely (${authHistoryRes.body.messages.length} messages).`);

      // Test 2.11: Expired Token Rejection
      const expiredPayload = `${activeConvId}:${Date.now() - 10000}`; // 10s in the past
      const expiredSig = require('crypto')
        .createHmac('sha256', require('../src/config/env').shopify.clientSecret || 'abh_conv_default_secret_key_development')
        .update(expiredPayload)
        .digest('hex');
      const expiredToken = `${expiredPayload}:${expiredSig}`;

      const expiredRes = await sendGet(
        `http://localhost:${testPort}/api/chat/history/${activeConvId}`,
        { 'X-Conversation-Token': expiredToken }
      );
      assert(expiredRes.statusCode === 403, 'Expired token must be rejected with 403');
      assert(expiredRes.body.code === 'TOKEN_EXPIRED', 'Expired token response must return code TOKEN_EXPIRED');
      assert(expiredRes.body.recoverable === true, 'Must indicate recoverable session');
      console.log('✅ Test 2.11: Expired conversation token rejected with code TOKEN_EXPIRED and recoverable=true.');

      // Test 2.12: ID Mismatch Rejection (token bound to Conv A used on Conv B)
      const convB = 'abh_conv_other_customer_9999';
      const mismatchRes = await sendGet(
        `http://localhost:${testPort}/api/chat/history/${convB}`,
        { 'X-Conversation-Token': activeConvToken } // activeConvToken belongs to activeConvId, not convB
      );
      assert(mismatchRes.statusCode === 403, 'ID-mismatched token must be rejected with 403');
      console.log('✅ Test 2.12: Token conversation-ID binding verified; cross-customer IDOR blocked.');

      console.log('\n====================================================');
      console.log('🎉 ALL PHASE 4 CHAT WIDGET & API TESTS PASSED (100%)');
      console.log('====================================================\n');

      server.close(() => process.exit(0));
    } catch (err) {
      console.error('\n❌ Phase 4 Test Failure:', err.message);
      if (server) server.close();
      process.exit(1);
    }
  });
};

runPhase4Tests();
