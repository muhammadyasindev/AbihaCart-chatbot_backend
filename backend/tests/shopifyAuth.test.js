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
  createSignedStateCookieValue,
  verifySignedStateCookieValue,
} = require('../src/utils/shopifyAuth');
const ShopifySession = require('../src/models/ShopifySession');
const { SessionStore } = require('../src/models/ShopifySession');
const config = require('../src/config/env');
const shopifyService = require('../src/services/shopify.service');
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

      // -----------------------------------------------------------------
      // 7. OAuth State Persistence, Concurrency & Signed Cookie Resilience
      // -----------------------------------------------------------------
      console.log('\n--- Suite 7: OAuth State Persistence, Trailing Slash & CSRF ---');
      SessionStore.clearMemory();

      // Test 7.1: Ensure trailing slash on backendUrl does not leak into redirect_uri
      const origBackendUrl = config.urls.backendUrl;
      const origClientId = config.shopify.clientId;
      const origClientSecret = config.shopify.clientSecret;
      config.shopify.clientId = config.shopify.clientId || 'test_client_id_oauth';
      config.shopify.clientSecret = config.shopify.clientSecret || testSecret;
      config.urls.backendUrl = 'https://abihacart-chatbot-backend.onrender.com';

      const signShopifyQuery = (params, secret) => {
        const sortedMsg = Object.keys(params)
          .sort()
          .map((k) => `${k}=${params[k]}`)
          .join('&');
        const hmacSig = crypto.createHmac('sha256', secret).update(sortedMsg).digest('hex');
        return new URLSearchParams({ ...params, hmac: hmacSig }).toString();
      };

      // Initiate two OAuth flows consecutively (simulating prefetch or double-click)
      const auth1 = await fetchJSON(
        `http://localhost:${testPort}/api/shopify/auth?shop=abihacart.myshopify.com`,
        { Accept: 'application/json' }
      );
      const state1 = new URL(auth1.body.authorizationUrl).searchParams.get('state');
      const redirectUri1 = new URL(auth1.body.authorizationUrl).searchParams.get('redirect_uri');
      assert(
        redirectUri1 === 'https://abihacart-chatbot-backend.onrender.com/api/shopify/auth/callback',
        `Expected single-slash redirect_uri, got ${redirectUri1}`
      );
      assert(auth1.headers['cache-control']?.includes('no-store'), 'OAuth initiation must set no-store');
      const setCookieHeader = Array.isArray(auth1.headers['set-cookie'])
        ? auth1.headers['set-cookie'].join('; ')
        : String(auth1.headers['set-cookie'] || '');
      assert(
        setCookieHeader.includes('abihacart_oauth_state=') &&
        setCookieHeader.includes('HttpOnly') &&
        setCookieHeader.includes('SameSite=Lax'),
        'OAuth initiation must set HttpOnly SameSite=Lax state cookie'
      );

      const auth2 = await fetchJSON(
        `http://localhost:${testPort}/api/shopify/auth?shop=abihacart.myshopify.com`,
        { Accept: 'application/json' }
      );
      const state2 = new URL(auth2.body.authorizationUrl).searchParams.get('state');
      assert(state1 && state2 && state1 !== state2, 'Sequential OAuth nonces must remain distinct');

      // Test 7.2: Forged state nonce with valid HMAC must still fail with 403
      const forgedQs = signShopifyQuery({
        code: 'oauth_code_forged',
        shop: 'abihacart.myshopify.com',
        state: 'forged_state_nonce_000000',
        timestamp: String(Math.floor(Date.now() / 1000)),
      }, config.shopify.clientSecret);
      const forgedStateRes = await fetchJSON(`http://localhost:${testPort}/api/shopify/auth/callback?${forgedQs}`);
      assert(forgedStateRes.statusCode === 403, `Forged state must return 403, got ${forgedStateRes.statusCode}`);
      assert(
        forgedStateRes.body.message === 'Invalid state nonce. CSRF validation failed.' &&
        forgedStateRes.body.diagnostics &&
        typeof forgedStateRes.body.diagnostics.dbConnected === 'boolean' &&
        typeof forgedStateRes.body.diagnostics.hasStateCookie === 'boolean' &&
        Boolean(forgedStateRes.body.restartAuthUrl),
        'Forged state must fail CSRF validation with safe diagnostics and restart URL'
      );
      console.log('✅ Test 7.1-7.2 Passed: Redirect URI normalization and forged-state 403 defense verified.');

      // Test 7.3: First OAuth tab's state remains valid after second OAuth initiation
      const origExchange = shopifyService.exchangeCodeForToken.bind(shopifyService);
      shopifyService.exchangeCodeForToken = async () => ({
        accessToken: 'shpat_mock_verified_token',
        scope: 'read_products,read_orders',
        expiresIn: null,
        refreshToken: null,
      });

      try {
        const validQs1 = signShopifyQuery({
          code: 'oauth_code_tab1',
          shop: 'abihacart.myshopify.com',
          state: state1,
          timestamp: String(Math.floor(Date.now() / 1000)),
        }, config.shopify.clientSecret);
        const cb1Res = await fetchJSON(`http://localhost:${testPort}/api/shopify/auth/callback?${validQs1}`);
        assert(cb1Res.statusCode === 200 && cb1Res.body.status === 'success', 'Earlier active state must succeed on callback');

        // Single-use: replaying state1 after completion must be rejected
        const replayRes = await fetchJSON(`http://localhost:${testPort}/api/shopify/auth/callback?${validQs1}`);
        assert(replayRes.statusCode === 403, 'Replayed callback state must return 403');
        console.log('✅ Test 7.3 Passed: Concurrent OAuth initiation preserved earlier state and cleared nonces after exchange.');

        // Test 7.4: Signed HttpOnly cookie backup succeeds when DB state was cleared/split-brained
        SessionStore.clearMemory();
        const fallbackNonce = generateNonce();
        const cookieToken = createSignedStateCookieValue(
          {
            shop: 'abihacart.myshopify.com',
            state: fallbackNonce,
            expiresAtMs: Date.now() + 60000,
          },
          config.shopify.clientSecret
        );
        const verifiedCookie = verifySignedStateCookieValue(cookieToken, config.shopify.clientSecret);
        assert(verifiedCookie.valid && verifiedCookie.state === fallbackNonce, 'Signed cookie helper must validate');

        const cookieQs = signShopifyQuery({
          code: 'oauth_code_cookie_backup',
          shop: 'abihacart.myshopify.com',
          state: fallbackNonce,
          timestamp: String(Math.floor(Date.now() / 1000)),
        }, config.shopify.clientSecret);
        const cbCookieRes = await fetchJSON(
          `http://localhost:${testPort}/api/shopify/auth/callback?${cookieQs}`,
          { Cookie: `abihacart_oauth_state=${encodeURIComponent(cookieToken)}` }
        );
        assert(cbCookieRes.statusCode === 200 && cbCookieRes.body.status === 'success', 'Signed cookie fallback must succeed');
        const clearCookieHeader = Array.isArray(cbCookieRes.headers['set-cookie'])
          ? cbCookieRes.headers['set-cookie'].join('; ')
          : String(cbCookieRes.headers['set-cookie'] || '');
        assert(clearCookieHeader.includes('Max-Age=0'), 'Callback must clear OAuth state cookie');
        console.log('✅ Test 7.4 Passed: Signed HttpOnly OAuth state cookie resilience verified.');

        // Test 7.5: Expired state must return 403 expired message
        await SessionStore.registerAuthState(
          'abihacart.myshopify.com',
          'expired_state_1234',
          new Date(Date.now() - 5000)
        );
        const expiredQs = signShopifyQuery({
          code: 'oauth_code_expired',
          shop: 'abihacart.myshopify.com',
          state: 'expired_state_1234',
          timestamp: String(Math.floor(Date.now() / 1000)),
        }, config.shopify.clientSecret);
        const expiredRes = await fetchJSON(`http://localhost:${testPort}/api/shopify/auth/callback?${expiredQs}`);
        assert(expiredRes.statusCode === 403, 'Expired state must return 403');
        assert(expiredRes.body.message.includes('expired'), 'Expired state error message must report expiration');
        console.log('✅ Test 7.5 Passed: Expired OAuth state rejected cleanly.');

        // Test 7.6: env.js strips trailing slashes from BACKEND_URL
        const prevEnvBackend = process.env.BACKEND_URL;
        const envPath = require.resolve('../src/config/env');
        const prevCachedEnv = require.cache[envPath];
        try {
          process.env.BACKEND_URL = 'https://abihacart-chatbot-backend.onrender.com/// ';
          delete require.cache[envPath];
          const freshConfig = require('../src/config/env');
          assert(
            freshConfig.urls.backendUrl === 'https://abihacart-chatbot-backend.onrender.com',
            `env.js must strip trailing slashes, got ${freshConfig.urls.backendUrl}`
          );
          console.log('✅ Test 7.6 Passed: env.js normalizes trailing slashes in BACKEND_URL.');
        } finally {
          if (prevEnvBackend === undefined) delete process.env.BACKEND_URL;
          else process.env.BACKEND_URL = prevEnvBackend;
          require.cache[envPath] = prevCachedEnv;
        }

        // Test 7.7: Canonical shop domain alias (abihacart.myshopify.com -> dwpaps-9q.myshopify.com)
        SessionStore.clearMemory();
        const aliasAuth = await fetchJSON(
          `http://localhost:${testPort}/api/shopify/auth?shop=abihacart.myshopify.com`,
          { Accept: 'application/json' }
        );
        const aliasState = new URL(aliasAuth.body.authorizationUrl).searchParams.get('state');
        const aliasCookies = Array.isArray(aliasAuth.headers['set-cookie'])
          ? aliasAuth.headers['set-cookie'][0].split(';')[0]
          : '';
        const canonicalCallbackQs = signShopifyQuery({
          code: 'oauth_code_canonical',
          shop: 'dwpaps-9q.myshopify.com',
          state: aliasState,
          timestamp: String(Math.floor(Date.now() / 1000)),
        }, config.shopify.clientSecret);
        const aliasCbRes = await fetchJSON(
          `http://localhost:${testPort}/api/shopify/auth/callback?${canonicalCallbackQs}`,
          { Cookie: aliasCookies }
        );
        assert(
          aliasCbRes.statusCode === 200 &&
          aliasCbRes.body.status === 'success' &&
          aliasCbRes.body.canonicalShop === 'dwpaps-9q.myshopify.com',
          `Canonical shop redirect callback must succeed, got ${aliasCbRes.statusCode}`
        );
        const savedCanonical = await SessionStore.findByShop('dwpaps-9q.myshopify.com');
        const savedAlias = await SessionStore.findByShop('abihacart.myshopify.com');
        assert(
          savedCanonical?.accessToken === 'shpat_mock_verified_token' &&
          savedAlias?.accessToken === 'shpat_mock_verified_token' &&
          savedAlias?.canonicalShop === 'dwpaps-9q.myshopify.com',
          'Access token session must sync to both canonical domain and alias store domain'
        );
        console.log('✅ Test 7.7 Passed: Canonical store domain redirect (abihacart -> dwpaps-9q) synced cleanly.');

        // Test 7.8: Canonical alias fallback works via DB/memory state even without browser cookies
        SessionStore.clearMemory();
        const noCookieAliasAuth = await fetchJSON(
          `http://localhost:${testPort}/api/shopify/auth?shop=abihacart.myshopify.com`,
          { Accept: 'application/json' }
        );
        const noCookieState = new URL(noCookieAliasAuth.body.authorizationUrl).searchParams.get('state');
        const noCookieCbQs = signShopifyQuery({
          code: 'oauth_code_canonical_nocookie',
          shop: 'dwpaps-9q.myshopify.com',
          state: noCookieState,
          timestamp: String(Math.floor(Date.now() / 1000)),
        }, config.shopify.clientSecret);
        const noCookieCbRes = await fetchJSON(
          `http://localhost:${testPort}/api/shopify/auth/callback?${noCookieCbQs}`
        );
        assert(
          noCookieCbRes.statusCode === 200 && noCookieCbRes.body.status === 'success',
          `Cookie-less canonical domain alias callback must succeed via fallbackShops, got ${noCookieCbRes.statusCode}`
        );
        console.log('✅ Test 7.8 Passed: Cookie-less canonical alias lookup verified.');

        // Test 7.9: Shopify 403/401 error redacts tokens and surfaces safe diagnostics in /test-connection
        const origFetch = global.fetch;
        global.fetch = async () => ({
          ok: false,
          status: 403,
          text: async () => JSON.stringify({ errors: 'Requires read_products scope; secret shpat_leak_123' }),
        });
        try {
          const failConnRes = await fetchJSON(`http://localhost:${testPort}/api/shopify/test-connection?shop=abihacart.myshopify.com`);
          assert(failConnRes.statusCode === 502, `Expected 502 on Shopify 403, got ${failConnRes.statusCode}`);
          assert(
            failConnRes.body.message.includes('Requires read_products scope') &&
            !failConnRes.body.message.includes('shpat_leak_123') &&
            failConnRes.body.message.includes('[REDACTED]') &&
            failConnRes.body.session &&
            failConnRes.body.session.accessToken === undefined &&
            failConnRes.body.canonicalShop === 'dwpaps-9q.myshopify.com',
            'test-connection 502 must include safe Shopify reason & session metadata without token leaks'
          );
          console.log('✅ Test 7.9 Passed: Sanitized 403 diagnostics and token redaction verified.');
        } finally {
          global.fetch = origFetch;
        }
      } finally {
        shopifyService.exchangeCodeForToken = origExchange;
        SessionStore.clearMemory();
        config.urls.backendUrl = origBackendUrl;
        config.shopify.clientId = origClientId;
        config.shopify.clientSecret = origClientSecret;
      }

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
