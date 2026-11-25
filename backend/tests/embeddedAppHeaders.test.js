/**
 * Security Header & Shopify Embedded App Framing Verification Tests
 */
const assert = require('assert');
const http = require('http');

process.env.NODE_ENV = 'test';
process.env.TEST_MODE = 'true';

const app = require('../src/app');

function sendGet(port, path, headers = {}) {
  return new Promise((resolve, reject) => {
    http.get(
      {
        hostname: '127.0.0.1',
        port,
        path,
        headers,
      },
      (res) => {
        let body = '';
        res.on('data', (chunk) => { body += chunk; });
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
      }
    ).on('error', reject);
  });
}

async function run() {
  console.log('====================================================');
  console.log('🧪 Starting Embedded App CSP & Frame Header Tests');
  console.log('====================================================\n');

  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  const { port } = server.address();

  try {
    // 1. Embedded Shopify Admin request to GET /
    const embeddedRes = await sendGet(
      port,
      '/?embedded=1&shop=abihacart.myshopify.com&host=YWRtaW4uc2hvcGlmeS5jb20vc3RvcmUvYWJpaGFjYXJ0',
      { Accept: 'text/html,application/xhtml+xml' }
    );
    assert.strictEqual(embeddedRes.status, 200, 'Embedded app root must return 200 OK');
    assert.ok(
      embeddedRes.headers['content-type'] && embeddedRes.headers['content-type'].includes('text/html'),
      'Embedded app request must return HTML document'
    );
    assert.strictEqual(
      embeddedRes.headers['x-frame-options'],
      undefined,
      'X-Frame-Options must be removed on embedded app document route'
    );
    const csp = embeddedRes.headers['content-security-policy'] || '';
    assert.ok(
      csp.includes('frame-ancestors https://abihacart.myshopify.com https://admin.shopify.com'),
      `CSP must specify exact Shopify frame-ancestors, got: ${csp}`
    );
    assert.ok(
      !csp.includes('frame-ancestors *') && !csp.includes('*.myshopify.com') && !csp.includes("frame-ancestors 'self'"),
      `CSP frame-ancestors must not use wildcards or 'self', got: ${csp}`
    );
    assert.ok(embeddedRes.body.includes('Abihacart AI Customer Support'), 'Embedded HTML must render app container');
    console.log('✅ Test 1 Passed: Embedded app route (GET /?embedded=1...) allows Shopify framing cleanly.');

    // 2. Programmatic API ping to GET / (preserving existing health.test.js contract)
    const jsonPingRes = await sendGet(port, '/');
    assert.strictEqual(jsonPingRes.status, 200);
    const parsedPing = JSON.parse(jsonPingRes.body);
    assert.ok(parsedPing.message.includes('operational'), 'JSON root ping must preserve operational message');
    assert.strictEqual(jsonPingRes.headers['x-frame-options'], undefined);
    console.log('✅ Test 2 Passed: JSON API ping on GET / preserved for automated monitors.');

    // 3. Unrelated API routes keep strict X-Frame-Options: SAMEORIGIN and frame-ancestors 'self'
    const healthRes = await sendGet(port, '/api/health');
    assert.strictEqual(healthRes.status, 200);
    assert.strictEqual(
      healthRes.headers['x-frame-options'],
      'SAMEORIGIN',
      '/api/health must retain X-Frame-Options: SAMEORIGIN'
    );
    assert.ok(
      (healthRes.headers['content-security-policy'] || '').includes("frame-ancestors 'self'"),
      '/api/health must retain default CSP frame-ancestors \'self\''
    );

    const shopifyTestRes = await sendGet(port, '/api/shopify/test-connection');
    assert.strictEqual(shopifyTestRes.status, 200);
    assert.strictEqual(
      shopifyTestRes.headers['x-frame-options'],
      'SAMEORIGIN',
      '/api/shopify/test-connection must retain X-Frame-Options: SAMEORIGIN'
    );
    assert.ok(
      (shopifyTestRes.headers['content-security-policy'] || '').includes("frame-ancestors 'self'"),
      '/api/shopify/test-connection must retain frame-ancestors \'self\''
    );

    const notFoundRes = await sendGet(port, '/api/non-existent-route');
    assert.strictEqual(notFoundRes.status, 404);
    assert.strictEqual(notFoundRes.headers['x-frame-options'], 'SAMEORIGIN');
    assert.ok((notFoundRes.headers['content-security-policy'] || '').includes("frame-ancestors 'self'"));
    console.log('✅ Test 3 Passed: Unrelated API and 404 routes preserve Helmet SAMEORIGIN and frame-ancestors \'self\'.');

    console.log('\n🎉 ALL EMBEDDED APP SECURITY HEADER TESTS PASSED (100%)\n');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

run().catch((err) => {
  console.error('❌ Test failed:', err);
  process.exit(1);
});
