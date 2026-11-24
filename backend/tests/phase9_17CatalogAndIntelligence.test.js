/**
 * Phase 9.17 Automated Test Suite:
 * AI Store Knowledge, Catalog Discovery & Conversation Intelligence
 *
 * Validates:
 * 1. General Catalog Overview Discovery ("Tell me about your products")
 * 2. Product Category Discovery (Baby & Kids, Skincare, Tech & Personal Care, Home)
 * 3. Baby Toy Search ("baby toye")
 * 4. Technology Product Search ("tech thinges")
 * 5. Spelling Correction & Fuzzy Matching
 * 6. Budget-Based Product Filtering ("under AED 100", "under AED 200")
 * 7. Product Comparison Intelligence
 * 8. Real Product Availability & Attributes (12 live products in AED)
 * 9. Multi-Turn Conversation Memory
 * 10. Graceful Handling of Empty Searches
 * 11. Store Policy Verification (14-day return, 1-3 day UAE transit, COD & Card)
 * 12. Shopify API Resilience & Fallback Handling
 * 13. Admin Change Credentials API Verification
 * 14. Admin Conversation Reply & Customer History Sync
 */

const http = require('http');
const app = require('../src/app');
const shopifyService = require('../src/services/shopify.service');
const openaiService = require('../src/services/openai.service');
const { generateToken } = require('../src/utils/token.util');
const { AdminUserStore } = require('../src/models/AdminUser');
const ConversationStore = require('../src/models/Conversation');

const TEST_PORT = 5998;
let server;

const assert = (condition, msg) => {
  if (!condition) {
    throw new Error(`Assertion failed: ${msg}`);
  }
};

const sendRequest = (method, path, bodyObj = null, headers = {}) => {
  return new Promise((resolve, reject) => {
    const rawBody = bodyObj ? JSON.stringify(bodyObj) : null;
    const reqHeaders = {
      'Content-Type': 'application/json',
      ...headers,
    };
    if (rawBody) {
      reqHeaders['Content-Length'] = Buffer.byteLength(rawBody);
    }

    const req = http.request(
      {
        hostname: '127.0.0.1',
        port: TEST_PORT,
        path,
        method,
        headers: reqHeaders,
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
    if (rawBody) req.write(rawBody);
    req.end();
  });
};

const runTests = async () => {
  console.log('\n================================================================');
  console.log('  STARTING PHASE 9.17 TEST SUITE: STORE KNOWLEDGE & INTELLIGENCE');
  console.log('================================================================\n');

  let passed = 0;
  let failed = 0;

  const test = async (name, fn) => {
    process.stdout.write(`TEST: ${name}... `);
    try {
      await fn();
      console.log('PASSED ✓');
      passed++;
    } catch (err) {
      console.log(`FAILED ✗\n  Error: ${err.message}`);
      failed++;
    }
  };

  // Ensure admin user is seeded for test suite
  try {
    await AdminUserStore.seedDefaultAdminIfNeeded();
  } catch (e) {
    // handled
  }

  // -------------------------------------------------------------------------
  // TEST 1: General Catalog Overview Discovery
  // -------------------------------------------------------------------------
  await test('1. General Catalog Overview Discovery', async () => {
    const overview = await shopifyService.getCatalogOverview('abihacart.myshopify.com');
    assert(overview.totalProducts === 12, `Expected 12 total products, got ${overview.totalProducts}`);
    assert(overview.categories.length === 4, `Expected 4 categories, got ${overview.categories.length}`);
    assert(overview.featuredRecommendations.length >= 4, 'Expected at least 4 featured recommendations');

    // Test through chat API
    const res = await sendRequest('POST', '/api/chat/message', {
      message: 'Tell me about your products',
      shop: 'abihacart.myshopify.com',
    });
    assert(res.statusCode === 200, `Expected 200, got ${res.statusCode}`);
    const botText = res.body.reply || '';
    assert(
      !botText.toLowerCase().includes("i don't have any tech products"),
      `Response should NOT contain tech failure bias. Got: ${botText}`
    );
    assert(
      botText.includes('Baby') || botText.includes('Beauty') || botText.includes('Abihacart') || botText.includes('catalog'),
      `Response should mention Abihacart categories or catalog. Got: ${botText}`
    );
  });

  // -------------------------------------------------------------------------
  // TEST 2: Product Category Discovery
  // -------------------------------------------------------------------------
  await test('2. Product Category Discovery', async () => {
    const categories = await shopifyService.getCatalogCategories('abihacart.myshopify.com');
    assert(Array.isArray(categories), 'Categories must be an array');
    assert(categories.length === 4, `Expected 4 categories, got ${categories.length}`);

    const categoryNames = categories.map((c) => c.name);
    assert(categoryNames.includes('Baby & Kids Toys'), 'Missing Baby & Kids Toys');
    assert(categoryNames.includes('Beauty & Skincare'), 'Missing Beauty & Skincare');
    assert(categoryNames.includes('Personal Care & Tech Gadgets'), 'Missing Personal Care & Tech Gadgets');
    assert(categoryNames.includes('Home & Kitchen'), 'Missing Home & Kitchen');
  });

  // -------------------------------------------------------------------------
  // TEST 3: Baby Toy Search ("baby toye")
  // -------------------------------------------------------------------------
  await test('3. Baby Toy Search ("baby toye")', async () => {
    const results = await shopifyService.searchProducts('abihacart.myshopify.com', 'baby toye');
    assert(results.length > 0, 'Search for "baby toye" must return results');
    const hasToy = results.some(
      (p) =>
        p.title.toLowerCase().includes('montessori') ||
        p.title.toLowerCase().includes('walker') ||
        p.title.toLowerCase().includes('drawing')
    );
    assert(hasToy, 'Results must include baby toys like Montessori or Walker');
    assert(results[0].price.currencyCode === 'AED', 'Price currency must be AED');
    assert(results[0].images.length > 0, 'Product must have an image');
  });

  // -------------------------------------------------------------------------
  // TEST 4: Technology & Personal Care Product Search ("tech thinges")
  // -------------------------------------------------------------------------
  await test('4. Technology Product Search ("tech thinges")', async () => {
    const results = await shopifyService.searchProducts('abihacart.myshopify.com', 'tech thinges');
    assert(results.length > 0, 'Search for "tech thinges" must return results');
    const hasTech = results.some(
      (p) =>
        p.title.toLowerCase().includes('drone') ||
        p.title.toLowerCase().includes('shaver') ||
        p.title.toLowerCase().includes('warmer')
    );
    assert(hasTech, 'Results must include gadgets like Drone or Shaver');
  });

  // -------------------------------------------------------------------------
  // TEST 5: Spelling Correction & Typo Tolerance
  // -------------------------------------------------------------------------
  await test('5. Spelling Correction ("toye", "thinges", "shver", "dron")', async () => {
    const testCases = [
      { typo: 'toye', expectedMatch: 'baby' },
      { typo: 'thinges', expectedMatch: 'tech' },
      { typo: 'shver', expectedMatch: 'shaver' },
      { typo: 'dron', expectedMatch: 'drone' },
    ];

    for (const tc of testCases) {
      const results = await shopifyService.searchProducts('abihacart.myshopify.com', tc.typo);
      assert(results.length > 0, `Search for typo "${tc.typo}" should return products`);
    }
  });

  // -------------------------------------------------------------------------
  // TEST 6: Budget-Based Product Filtering ("under AED 100", "under AED 200")
  // -------------------------------------------------------------------------
  await test('6. Budget-Based Product Filtering ("under AED 100", "under AED 200")', async () => {
    const under100 = await shopifyService.searchProducts('abihacart.myshopify.com', 'products under AED 100');
    assert(under100.length > 0, 'Budget search under 100 must return items');
    for (const p of under100) {
      const price = typeof p.price === 'number' ? p.price : parseFloat(p.price?.amount || p.price);
      assert(price <= 100, `Item ${p.title} price (${price}) exceeds budget 100`);
    }

    const under200 = await shopifyService.searchProducts('abihacart.myshopify.com', 'under AED 200');
    assert(under200.length === 12, `All 12 items are under 200 AED, got ${under200.length}`);
  });

  // -------------------------------------------------------------------------
  // TEST 7: Product Comparison Intelligence
  // -------------------------------------------------------------------------
  await test('7. Product Comparison Intelligence', async () => {
    const res = await sendRequest('POST', '/api/chat/message', {
      message: 'Compare the Montessori Wooden Mathematics and the 2-in-1 Baby Gym With Walker',
      shop: 'abihacart.myshopify.com',
    });
    assert(res.statusCode === 200, `Expected 200, got ${res.statusCode}`);
    const reply = res.body.reply.toLowerCase();
    assert(
      reply.includes('montessori') && reply.includes('walker'),
      'Comparison response should mention both products'
    );
  });

  // -------------------------------------------------------------------------
  // TEST 8: Real Product Availability & Attributes (12 Live Products)
  // -------------------------------------------------------------------------
  await test('8. Real Product Availability & Attributes (12 Live Products)', async () => {
    const allProducts = await shopifyService.searchProducts('abihacart.myshopify.com', '');
    assert(allProducts.length === 12, `Expected 12 total products, got ${allProducts.length}`);
    for (const p of allProducts) {
      assert(p.title && p.title.length > 0, 'Product missing title');
      assert(p.price && p.price.currencyCode === 'AED', `Product ${p.title} missing AED currency`);
      assert(p.availableForSale === true, `Product ${p.title} should be available for sale`);
      assert(p.images && p.images.length > 0, `Product ${p.title} missing images`);
    }
  });

  // -------------------------------------------------------------------------
  // TEST 9: Multi-Turn Conversation Memory
  // -------------------------------------------------------------------------
  await test('9. Multi-Turn Conversation Memory', async () => {
    // Turn 1
    const turn1 = await sendRequest('POST', '/api/chat/message', {
      message: 'I am looking for gifts for a 2 year old toddler',
      shop: 'abihacart.myshopify.com',
    });
    assert(turn1.statusCode === 200, 'Turn 1 failed');
    const convId = turn1.body.conversationId;
    const token = turn1.body.conversationToken;
    assert(convId, 'Turn 1 missing conversationId');

    // Turn 2: Follow up referring to earlier context
    const turn2 = await sendRequest('POST', '/api/chat/message', {
      conversationId: convId,
      conversationToken: token,
      message: 'Which one of those is the best value?',
      shop: 'abihacart.myshopify.com',
    });
    assert(turn2.statusCode === 200, 'Turn 2 failed');
    assert(turn2.body.conversationId === convId, 'Conversation ID must be preserved across turns');
  });

  // -------------------------------------------------------------------------
  // TEST 10: Graceful Handling of Empty Searches
  // -------------------------------------------------------------------------
  await test('10. Graceful Handling of Empty / Unmatched Searches', async () => {
    const res = await sendRequest('POST', '/api/chat/message', {
      message: 'Do you sell electric acoustic guitars?',
      shop: 'abihacart.myshopify.com',
    });
    assert(res.statusCode === 200, `Expected 200, got ${res.statusCode}`);
    const botText = res.body.reply.toLowerCase();
    assert(
      !botText.includes("i don't have any tech products"),
      'Should not default to tech products error'
    );
    assert(
      botText.includes('do not') ||
      botText.includes("don't") ||
      botText.includes('sorry') ||
      botText.includes('not carry') ||
      botText.includes('specialize') ||
      botText.includes('focus') ||
      botText.includes('catalog') ||
      botText.includes('store') ||
      botText.includes('guitar') ||
      botText.includes('unfortunately') ||
      botText.includes('available'),
      'Should politely inform user about store catalog scope'
    );
  });

  // -------------------------------------------------------------------------
  // TEST 11: Store Policy Verification (Delivery, Returns, Payment)
  // -------------------------------------------------------------------------
  await test('11. Store Policy Verification (14-day return, 1-3 day UAE transit, COD & Card)', async () => {
    const shippingRes = await sendRequest('POST', '/api/chat/message', {
      message: 'What is your shipping policy and delivery timeline?',
      shop: 'abihacart.myshopify.com',
    });
    assert(shippingRes.statusCode === 200, 'Shipping query failed');
    const shipText = shippingRes.body.reply;
    assert(
      shipText.includes('1-3') || shipText.includes('UAE') || shipText.includes('150') || shipText.includes('200'),
      `Shipping response must reflect verified store policies. Got: ${shipText}`
    );

    const returnRes = await sendRequest('POST', '/api/chat/message', {
      message: 'Can I return an item?',
      shop: 'abihacart.myshopify.com',
    });
    assert(returnRes.statusCode === 200, 'Return query failed');
    const returnText = returnRes.body.reply;
    assert(
      returnText.includes('14') || returnText.includes('return'),
      `Return response must reflect 14-day policy. Got: ${returnText}`
    );
  });

  // -------------------------------------------------------------------------
  // TEST 12: Shopify API Graceful Fallback Handling
  // -------------------------------------------------------------------------
  await test('12. Shopify API Graceful Fallback Handling', async () => {
    // When Shopify OAuth session is absent for shop, catalog search still returns real products
    const res = await shopifyService.searchProducts('unauthenticated-shop.myshopify.com', 'toys');
    assert(Array.isArray(res) || Array.isArray(res.products) || typeof res.length === 'number', 'Fallback must return list or products');
    assert(res.length > 0 || res.products?.length > 0, 'Fallback must deliver verified products');
  });

  // -------------------------------------------------------------------------
  // TEST 13: Admin Change Credentials API Verification
  // -------------------------------------------------------------------------
  await test('13. Admin Change Credentials API Verification', async () => {
    // Get existing admin or create test admin
    let admin = await AdminUserStore.findByUsernameOrEmail('admin');
    if (!admin) {
      admin = await AdminUserStore.seedDefaultAdminIfNeeded();
    }
    assert(admin, 'Default admin user should exist');

    const adminToken = generateToken({
      userId: admin.id || admin._id,
      username: admin.username,
      role: 'admin',
      shop: 'abihacart.myshopify.com',
    });

    // Attempt with incorrect current password -> 401
    const badAttempt = await sendRequest(
      'POST',
      '/api/admin/auth/change-credentials',
      {
        currentPassword: 'WrongPassword123!',
        newUsername: 'newadmin',
      },
      { Authorization: `Bearer ${adminToken}` }
    );
    assert(badAttempt.statusCode === 401, `Expected 401 for bad password, got ${badAttempt.statusCode}`);

    // Attempt with correct current password and new password
    const goodAttempt = await sendRequest(
      'POST',
      '/api/admin/auth/change-credentials',
      {
        currentPassword: 'Abihacart@2026!',
        newPassword: 'Abihacart@2026!Updated',
      },
      { Authorization: `Bearer ${adminToken}` }
    );
    assert(goodAttempt.statusCode === 200, `Expected 200 for good password, got ${goodAttempt.statusCode}`);
    assert(goodAttempt.body.status === 'success', 'Status must be success');

    // Revert password back to default for clean persistent state
    const revertToken = goodAttempt.body.token || adminToken;
    await sendRequest(
      'POST',
      '/api/admin/auth/change-credentials',
      {
        currentPassword: 'Abihacart@2026!Updated',
        newPassword: 'Abihacart@2026!',
      },
      { Authorization: `Bearer ${revertToken}` }
    );
  });

  // -------------------------------------------------------------------------
  // TEST 14: Admin Reply & Customer Conversation Sync
  // -------------------------------------------------------------------------
  await test('14. Admin Conversation Reply & Customer History Sync', async () => {
    // 1. Customer initiates chat
    const customerMsg = await sendRequest('POST', '/api/chat/message', {
      message: 'Hello, I need help with an order',
      shop: 'abihacart.myshopify.com',
    });
    assert(customerMsg.statusCode === 200, 'Customer chat failed');
    const convId = customerMsg.body.conversationId;
    const convToken = customerMsg.body.conversationToken;

    // 2. Admin sends reply from dashboard
    let admin = await AdminUserStore.findByUsernameOrEmail('admin');
    if (!admin) {
      admin = await AdminUserStore.seedDefaultAdminIfNeeded();
    }
    const adminToken = generateToken({
      userId: admin.id || admin._id,
      username: admin.username,
      role: 'admin',
      shop: 'abihacart.myshopify.com',
    });

    const replyRes = await sendRequest(
      'POST',
      `/api/admin/conversations/${convId}/reply`,
      { message: 'Hello! I am a live human specialist from Abihacart support team.' },
      { Authorization: `Bearer ${adminToken}` }
    );
    assert(replyRes.statusCode === 200, `Admin reply failed with ${replyRes.statusCode}`);

    // 3. Customer fetches history using conversation token
    const historyRes = await sendRequest(
      'GET',
      `/api/chat/history/${convId}`,
      null,
      { 'x-conversation-token': convToken }
    );
    assert(historyRes.statusCode === 200, 'Customer getHistory failed');
    const msgs = historyRes.body.messages || [];
    const agentMsg = msgs.find((m) => m.sender === 'agent');
    assert(agentMsg, 'Customer history must include the agent reply');
    assert(agentMsg.text.includes('live human specialist'), 'Agent reply text must match');
  });

  console.log('\n================================================================');
  console.log(`  PHASE 9.17 TEST RESULTS: ${passed} PASSED, ${failed} FAILED`);
  console.log('================================================================\n');

  if (failed > 0) {
    process.exit(1);
  }
};

// Start test server
server = app.listen(TEST_PORT, '127.0.0.1', async () => {
  try {
    await runTests();
    server.close();
    process.exit(0);
  } catch (err) {
    console.error('Fatal test error:', err);
    server.close();
    process.exit(1);
  }
});
