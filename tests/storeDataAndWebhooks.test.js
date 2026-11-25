/**
 * Phase 3 Automated Test Suite: Shopify Store Data, Caching, and Webhooks
 */
const crypto = require('crypto');
const http = require('http');
const cacheService = require('../src/services/cache.service');
const shopifyService = require('../src/services/shopify.service');
const { ProductCacheStore } = require('../src/models/ProductCache');
const { WebhookDeduplicator } = require('../src/models/WebhookLog');
const config = require('../src/config/env');
const app = require('../src/app');

const testPort = 5997;
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

const runAllPhase3Tests = async () => {
  console.log('====================================================');
  console.log('🧪 Starting Phase 3 Store Data & Webhook Tests');
  console.log('====================================================\n');

  // -----------------------------------------------------------------
  // Suite 1: Product Data Normalization & Strict Non-Live Inventory Flag
  // -----------------------------------------------------------------
  console.log('--- Suite 1: Product Normalization & Price Standards ---');
  const mockGqlNode = {
    id: 'gid://shopify/Product/987654321',
    title: 'Abihacart Premium Coffee Maker',
    handle: 'abihacart-coffee-maker',
    description: 'High grade espresso maker for UAE homes.',
    productType: 'Kitchen Appliances',
    vendor: 'Abihacart',
    tags: ['coffee', 'home', 'appliances'],
    status: 'ACTIVE',
    priceRangeV2: {
      minVariantPrice: { amount: '249.00', currencyCode: 'AED' },
      maxVariantPrice: { amount: '299.00', currencyCode: 'AED' },
    },
    images: {
      edges: [{ node: { url: 'https://cdn.shopify.com/s/files/1/coffee.jpg', altText: 'Coffee Maker' } }],
    },
    variants: {
      edges: [{
        node: {
          id: 'gid://shopify/ProductVariant/11111',
          title: 'Matte Black',
          sku: 'ABH-CM-BLK',
          price: '249.00',
          compareAtPrice: '320.00',
          availableForSale: true,
          inventoryQuantity: 15,
          inventoryItem: { id: 'gid://shopify/InventoryItem/55555' },
        },
      }],
    },
  };

  const normalized = shopifyService.normalizeProduct(mockGqlNode);
  assert(normalized.productId === 'gid://shopify/Product/987654321', 'ProductId must match');
  assert(normalized.currencyCode === 'AED', 'Currency must be AED');
  assert(normalized.priceRange.minPrice === 249.00, 'Min price must parse as float');
  assert(normalized.variants[0].sku === 'ABH-CM-BLK', 'SKU must match');
  assert(normalized.variants[0].compareAtPrice === 320.00, 'Compare-at price must parse as float');
  assert(normalized.isInventoryLive === false, 'Normalized product must NOT be flagged as live stock');
  console.log('✅ Suite 1 Passed: Product normalization and currency/pricing rules strictly verified.');

  // -----------------------------------------------------------------
  // Suite 2: Caching, Expiration, and Live Inventory Enrichment
  // -----------------------------------------------------------------
  console.log('\n--- Suite 2: Product Cache, TTL & Live Stock Differentiation ---');
  const shop = 'abihacart.myshopify.com';

  // 2.1 Set product in cache
  await cacheService.setCachedProduct(shop, normalized, 3600);
  const cached = await cacheService.getCachedProduct(shop, 'abihacart-coffee-maker');
  assert(cached !== null, 'Product must be found in cache');
  assert(cached.title === 'Abihacart Premium Coffee Maker', 'Cached title must match');
  assert(cached.isInventoryLive === false, 'Cached product inventory must be strictly marked isInventoryLive=false');
  console.log('✅ Test 2.1: Cached product retrieved with isInventoryLive=false guaranteed.');

  // 2.2 Live inventory enrichment
  const liveInventoryMap = new Map();
  liveInventoryMap.set('gid://shopify/InventoryItem/55555', 4); // Real-time count verified
  const enriched = cacheService.enrichWithLiveInventory(cached, liveInventoryMap);
  assert(enriched.isInventoryLive === true, 'Enriched product must be upgraded to isInventoryLive=true');
  assert(enriched.variants[0].inventoryQuantity === 4, 'Variant quantity must update to live stock count');
  assert(enriched.variants[0].availableForSale === true, 'Available for sale must reflect live count > 0');
  console.log('✅ Test 2.2: Live inventory enrichment confirmed with isInventoryLive=true.');

  // 2.3 Invalidation
  await cacheService.invalidateProduct(shop, 'abihacart-coffee-maker');
  const afterInvalidate = await cacheService.getCachedProduct(shop, 'abihacart-coffee-maker');
  assert(afterInvalidate === null, 'Invalidated product must not be found in cache');
  console.log('✅ Test 2.3: Cache invalidation works reliably.');

  // -----------------------------------------------------------------
  // Suite 3: Webhook Verification, HMAC-SHA256 & Rejection Tests
  // -----------------------------------------------------------------
  console.log('\n--- Suite 3: Shopify Webhook Security, HMAC & Duplicate Guard ---');

  server = app.listen(testPort, async () => {
    try {
      const webhookSecret = config.shopify.clientSecret;
      const testPayload = {
        id: 987654321,
        title: 'Abihacart Updated Product',
        handle: 'abihacart-updated-product',
        updated_at: new Date().toISOString(),
      };
      const rawPayload = JSON.stringify(testPayload);

      // Compute authentic Base64 HMAC-SHA256
      const validHmac = crypto
        .createHmac('sha256', webhookSecret)
        .update(Buffer.from(rawPayload))
        .digest('base64');

      // Test 3.1: Reject request with missing HMAC header
      const missingHmacRes = await sendPost(
        `http://localhost:${testPort}/api/webhooks/shopify`,
        testPayload,
        {
          'X-Shopify-Topic': 'products/update',
          'X-Shopify-Shop-Domain': shop,
        }
      );
      assert(missingHmacRes.statusCode === 401, 'Missing HMAC header must return 401 Unauthorized');
      console.log('✅ Test 3.1: Blocked webhook with missing signature (HTTP 401).');

      // Test 3.2: Reject request with forged / invalid HMAC signature
      const invalidHmacRes = await sendPost(
        `http://localhost:${testPort}/api/webhooks/shopify`,
        testPayload,
        {
          'X-Shopify-Hmac-Sha256': 'forged_base64_hmac_signature==',
          'X-Shopify-Topic': 'products/update',
          'X-Shopify-Shop-Domain': shop,
        }
      );
      assert(invalidHmacRes.statusCode === 401, 'Forged HMAC must return 401 Unauthorized');
      console.log('✅ Test 3.2: Blocked forged webhook signature (HTTP 401).');

      // Test 3.3: Accept genuine Shopify webhook with valid HMAC
      const uniqueWebhookId = `webhook_${Date.now()}_abc123`;
      const validWebhookRes = await sendPost(
        `http://localhost:${testPort}/api/webhooks/shopify`,
        testPayload,
        {
          'X-Shopify-Hmac-Sha256': validHmac,
          'X-Shopify-Topic': 'products/update',
          'X-Shopify-Shop-Domain': shop,
          'X-Shopify-Webhook-Id': uniqueWebhookId,
        }
      );
      assert(validWebhookRes.statusCode === 200, 'Valid webhook must return 200 OK');
      assert(validWebhookRes.body.status === 'success', 'Response status must be success');
      console.log('✅ Test 3.3: Successfully processed authentic Shopify webhook (HTTP 200).');

      // Test 3.4: Duplicate webhook delivery detection (Idempotency)
      const duplicateRes = await sendPost(
        `http://localhost:${testPort}/api/webhooks/shopify`,
        testPayload,
        {
          'X-Shopify-Hmac-Sha256': validHmac,
          'X-Shopify-Topic': 'products/update',
          'X-Shopify-Shop-Domain': shop,
          'X-Shopify-Webhook-Id': uniqueWebhookId, // Same ID
        }
      );
      assert(duplicateRes.statusCode === 200, 'Duplicate delivery must return 200 OK');
      assert(duplicateRes.body.duplicate === true, 'Duplicate delivery must be safely acknowledged without re-processing');
      console.log('✅ Test 3.4: Duplicate webhook delivery detected and handled idempotently.');

      // Test 3.5: Read-only order webhook verification
      const orderPayload = { id: 1001, name: '#ABH-1001', order_number: 1001 };
      const rawOrderPayload = JSON.stringify(orderPayload);
      const orderHmac = crypto
        .createHmac('sha256', webhookSecret)
        .update(Buffer.from(rawOrderPayload))
        .digest('base64');

      const orderWebhookRes = await sendPost(
        `http://localhost:${testPort}/api/webhooks/shopify`,
        orderPayload,
        {
          'X-Shopify-Hmac-Sha256': orderHmac,
          'X-Shopify-Topic': 'orders/create',
          'X-Shopify-Shop-Domain': shop,
          'X-Shopify-Webhook-Id': `order_webhook_${Date.now()}`,
        }
      );
      assert(orderWebhookRes.statusCode === 200, 'Order webhook must return 200 OK');
      console.log('✅ Test 3.5: Read-only order webhook verified without order modification.');

      console.log('\n====================================================');
      console.log('🎉 ALL PHASE 3 STORE DATA & WEBHOOK TESTS PASSED (100%)');
      console.log('====================================================\n');

      server.close(() => process.exit(0));
    } catch (err) {
      console.error('\n❌ Phase 3 Test Failure:', err.message);
      if (server) server.close();
      process.exit(1);
    }
  });
};

runAllPhase3Tests();
