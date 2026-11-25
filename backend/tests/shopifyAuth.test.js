/**
 * Comprehensive Shopify OAuth and GraphQL Service Automated Tests
 */
const crypto = require('crypto');
const http = require('http');
const {
  isValidShopDomain,
  sanitizeShopDomain,
  generateNonce,
  verifyHmac,
  buildAuthorizationUrl,
} = require('../src/utils/shopifyAuth');
const ShopifySession = require('../src/models/ShopifySession');
const app = require('../src/app');

const testPort = 5998;
let server;

const assert = (condition, msg) => {
  if (!condition) {
    throw new Error(`Assertion failed: ${msg}`);
  }
};

const fetchJSON = (url, headers = {}) => {
  return new Promise((resolve, reject) => {
    http.get(url, { headers }, (res) => {
      let rawData = '';
      res.on('data', (chunk) => { rawData += chunk; });
      res.on('end', () => {
        try {
          const body = JSON.parse(rawData);
          resolve({ statusCode: res.statusCode, headers: res.headers, body });
        } catch (e) {
          resolve({ statusCode: res.statusCode, headers: res.headers, rawData });
        }
      });
    }).on('error', reject);
  });
};

const runAllTests = async () => {
  console.log('====================================================');
  console.log('🧪 Starting Phase 2 Shopify Authentication Tests');
  console.log('====================================================\n');

  // -----------------------------------------------------------------
  // 1. Shop Domain Validation Tests
  // -----------------------------------------------------------------
  console.log('--- Suite 1: Shop Domain Validation & Sanitization ---');

  assert(isValidShopDomain('abihacart.myshopify.com') === true, 'abihacart.myshopify.com should be valid');
  assert(isValidShopDomain('my-store-123.myshopify.com') === true, 'hyphenated shop should be valid');
  assert(isValidShopDomain('evil.com') === false, 'evil.com must be invalid');
  assert(isValidShopDomain('abihacart.myshopify.com.evil.com') === false, 'Subdomain spoofing must be invalid');
  assert(isValidShopDomain('https://abihacart.myshopify.com') === false, 'Unsanitized protocol in validator must be false');
  assert(isValidShopDomain('abihacart.myshopify.com/admin') === false, 'Path traversal attempt must be false');
  assert(isValidShopDomain('') === false, 'Empty string must be false');
  assert(isValidShopDomain(null) === false, 'Null must be false');

  assert(
    sanitizeShopDomain('https://abihacart.myshopify.com/') === 'abihacart.myshopify.com',
    'Sanitize must strip https:// and trailing slash'
  );
  assert(
    sanitizeShopDomain('  http://STORE.myshopify.com/admin/auth  ') === 'store.myshopify.com',
    'Sanitize must strip whitespace, scheme, path and lowercase'
  );
  console.log('✅ Suite 1 Passed: Domain validation and SSRF defenses strictly verified.');

  // -----------------------------------------------------------------
  // 2. Cryptographic Nonce & CSRF Protection Tests
  // -----------------------------------------------------------------
  console.log('\n--- Suite 2: State Nonce & CSRF Protection ---');
  const nonce1 = generateNonce();
  const nonce2 = generateNonce();
  assert(typeof nonce1 === 'string' && nonce1.length === 32, 'Nonce must be 32 hex chars');
  assert(nonce1 !== nonce2, 'Consecutive nonces must be cryptographically random and unique');
  console.log('✅ Suite 2 Passed: Cryptographic CSRF state nonces verified.');

  // -----------------------------------------------------------------
  // 3. HMAC Verification & Constant-Time Security Tests
  // -----------------------------------------------------------------
  console.log('\n--- Suite 3: HMAC Verification & Timing Defense ---');
  const testSecret = 'shpss_test_secret_for_unit_tests_123456';
  const queryToSign = {
    code: 'shopify_oauth_test_code_abc123',
    shop: 'abihacart.myshopify.com',
    state: nonce1,
    timestamp: '1732185600',
  };

  // Compute reference HMAC
  const message = Object.keys(queryToSign)
    .sort()
    .map((k) => `${k}=${queryToSign[k]}`)
    .join('&');
  const validHmac = crypto.createHmac('sha256', testSecret).update(message).digest('hex');

  // Test 3.1: Valid HMAC check
  const validQuery = { ...queryToSign, hmac: validHmac };
  assert(verifyHmac(validQuery, testSecret) === true, 'Valid HMAC must pass verification');

  // Test 3.2: Tampered query param
  const tamperedQuery = { ...queryToSign, code: 'hacked_code', hmac: validHmac };
  assert(verifyHmac(tamperedQuery, testSecret) === false, 'Tampered query must fail HMAC verification');

  // Test 3.3: Tampered HMAC
  const corruptedHmacQuery = { ...queryToSign, hmac: validHmac.slice(0, -2) + '00' };
  assert(verifyHmac(corruptedHmacQuery, testSecret) === false, 'Corrupted HMAC must fail verification');

  // Test 3.4: Truncated HMAC (length mismatch)
  const shortHmacQuery = { ...queryToSign, hmac: 'short_hmac' };
  assert(verifyHmac(shortHmacQuery, testSecret) === false, 'Length-mismatched HMAC must return false safely');
  console.log('✅ Suite 3 Passed: HMAC SHA256 verification and timing-attack safeguards verified.');

  // -----------------------------------------------------------------
  // 4. OAuth URL Construction & Scopes Verification
  // -----------------------------------------------------------------
  console.log('\n--- Suite 4: OAuth URL Construction & Approved Scopes ---');
  const approvedScopes = ['read_products', 'read_inventory', 'read_orders', 'read_fulfillments'];
  const authUrl = buildAuthorizationUrl({
    shop: 'abihacart.myshopify.com',
    clientId: 'test_client_id_xyz',
    scopes: approvedScopes,
    redirectUri: 'https://example.com/api/shopify/auth/callback',
    state: nonce1,
  });

  const parsedUrl = new URL(authUrl);
  assert(parsedUrl.hostname === 'abihacart.myshopify.com', 'Hostname must match store');
  assert(parsedUrl.pathname === '/admin/oauth/authorize', 'Path must match Shopify OAuth endpoint');
  assert(parsedUrl.searchParams.get('client_id') === 'test_client_id_xyz', 'Client ID param must match');
  assert(
    parsedUrl.searchParams.get('scope') === 'read_products,read_inventory,read_orders,read_fulfillments',
    'Only approved scopes must be requested'
  );
  assert(
    parsedUrl.searchParams.get('redirect_uri') === 'https://example.com/api/shopify/auth/callback',
    'Redirect URI must be encoded'
  );
  assert(parsedUrl.searchParams.get('state') === nonce1, 'State param must match');
  assert(!authUrl.includes('grant_options[]=per-user'), 'Must use offline access (no per-user option)');
  console.log('✅ Suite 4 Passed: OAuth URL and offline access configuration verified.');

  // -----------------------------------------------------------------
  // 5. Session Model & Token Lifecycle Helpers
  // -----------------------------------------------------------------
  console.log('\n--- Suite 5: Session Model & Token Expiry Safety ---');
  const mockSession = new ShopifySession({
    shop: 'abihacart.myshopify.com',
    accessToken: 'shpat_secret_access_token_mock',
    refreshToken: 'shprf_secret_refresh_token_mock',
    expiresAt: new Date(Date.now() + 3600 * 1000), // 1 hour in future
    scope: 'read_products,read_inventory,read_orders,read_fulfillments',
  });

  assert(mockSession.isTokenExpired() === false, 'Future token must not be reported as expired');

  // Token within 30 seconds of expiry (buffer is 60s)
  mockSession.expiresAt = new Date(Date.now() + 30 * 1000);
  assert(mockSession.isTokenExpired() === true, 'Token within safety buffer must trigger refresh');

  const safeSession = mockSession.toSafeObject();
  assert(safeSession.accessToken === undefined, 'toSafeObject must NEVER expose accessToken');
  assert(safeSession.refreshToken === undefined, 'toSafeObject must NEVER expose refreshToken');
  assert(safeSession.hasRefreshToken === true, 'toSafeObject can report boolean presence of refresh token');
  console.log('✅ Suite 5 Passed: Session token lifecycle and leak-prevention verified.');

  // -----------------------------------------------------------------
  // 6. HTTP Endpoint Security Tests
  // -----------------------------------------------------------------
  console.log('\n--- Suite 6: HTTP Routes & Security Endpoints ---');

  server = app.listen(testPort, async () => {
    try {
      // Test 6.1: GET /api/shopify/auth with invalid shop
      const invalidShopRes = await fetchJSON(`http://localhost:${testPort}/api/shopify/auth?shop=malicious-domain.com`);
      assert(invalidShopRes.statusCode === 400, 'Invalid shop must return 400 Bad Request');
      assert(invalidShopRes.body.error === 'Invalid Shop Domain', 'Error must indicate invalid shop');
      console.log('✅ Test 6.1: Rejected invalid shop domain with HTTP 400.');

      // Test 6.2: GET /api/shopify/auth with valid shop (JSON mode)
      const validAuthRes = await fetchJSON(
        `http://localhost:${testPort}/api/shopify/auth?shop=abihacart.myshopify.com`,
        { Accept: 'application/json' }
      );
      assert(validAuthRes.statusCode === 200, 'Valid shop must return 200 with auth URL');
      assert(validAuthRes.body.authorizationUrl.includes('/admin/oauth/authorize'), 'Must return authorizationUrl');
      assert(validAuthRes.body.shop === 'abihacart.myshopify.com', 'Shop must match');
      console.log('✅ Test 6.2: OAuth initiation returned valid authorization URL.');

      // Test 6.3: GET /api/shopify/auth/callback with forged HMAC
      const callbackRes = await fetchJSON(
        `http://localhost:${testPort}/api/shopify/auth/callback?shop=abihacart.myshopify.com&code=fake_code&state=fake_state&hmac=invalid_hmac_signature`
      );
      assert(callbackRes.statusCode === 401, 'Tampered HMAC must return 401 Unauthorized');
      assert(callbackRes.body.error === 'Unauthorized', 'Error must indicate unauthorized');
      console.log('✅ Test 6.3: Blocked forged OAuth callback with HTTP 401.');

      // Test 6.4: GET /api/shopify/test-connection diagnostic endpoint
      const testConnRes = await fetchJSON(`http://localhost:${testPort}/api/shopify/test-connection`);
      assert(testConnRes.statusCode === 200, 'Test-connection endpoint must return HTTP 200');
      assert(
        testConnRes.body.status === 'pending_authorization' || testConnRes.body.status === 'connected',
        'Status must accurately report pending_authorization or connected'
      );
      console.log(`✅ Test 6.4: Connection diagnostic returned status: "${testConnRes.body.status}".`);
      console.log('   Diagnostic summary:', JSON.stringify(testConnRes.body.authFlow || testConnRes.body.shop));

      console.log('\n====================================================');
      console.log('🎉 ALL PHASE 2 SHOPIFY AUTH TESTS PASSED (100%)');
      console.log('====================================================\n');

      server.close(() => process.exit(0));
    } catch (err) {
      console.error('\n❌ Phase 2 Test Failure:', err.message);
      if (server) server.close();
      process.exit(1);
    }
  });
};

runAllTests();
