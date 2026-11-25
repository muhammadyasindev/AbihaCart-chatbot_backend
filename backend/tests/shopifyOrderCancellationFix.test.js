/**
 * Regression Tests: Shopify Order Cancellation Scoped CORS, Signed-Token Auth,
 * GID Normalization Safety, Token Auto-Refresh & Canonical Store Routing
 */
const assert = require('assert');
const http = require('http');
const vm = require('vm');

process.env.NODE_ENV = 'test';
process.env.TEST_MODE = 'true';

const app = require('../src/app');
const config = require('../src/config/env');
const { SessionStore } = require('../src/models/ShopifySession');
const { ShopifyOrderConfirmationStore } = require('../src/models/ShopifyOrderConfirmation');
const shopifyService = require('../src/services/shopify.service');
const emailNotificationService = require('../src/services/emailNotification.service');

function sendRequest(port, method, path, headers = {}, bodyObj = null) {
  return new Promise((resolve, reject) => {
    const payload = bodyObj !== null ? JSON.stringify(bodyObj) : null;
    const reqHeaders = { ...headers };
    if (payload !== null && !reqHeaders['Content-Type']) {
      reqHeaders['Content-Type'] = 'application/json';
      reqHeaders['Content-Length'] = Buffer.byteLength(payload);
    }

    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path,
        method,
        headers: reqHeaders,
      },
      (res) => {
        let raw = '';
        res.on('data', (chunk) => { raw += chunk; });
        res.on('end', () => {
          let json = null;
          try {
            json = raw ? JSON.parse(raw) : null;
          } catch (e) {
            json = null;
          }
          resolve({
            status: res.statusCode,
            headers: res.headers,
            raw,
            json,
          });
        });
      }
    );

    req.on('error', reject);
    if (payload !== null) {
      req.write(payload);
    }
    req.end();
  });
}

async function run() {
  console.log('====================================================');
  console.log('🧪 Starting Shopify Order Cancellation Production Tests');
  console.log('====================================================\n');

  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  const { port } = server.address();

  const origFetch = global.fetch;
  const origClientId = config.shopify.clientId;
  const origClientSecret = config.shopify.clientSecret;
  const origServiceClientId = shopifyService.clientId;
  const origServiceClientSecret = shopifyService.clientSecret;

  try {
    config.shopify.clientId = 'test_client_id';
    config.shopify.clientSecret = 'test_client_secret';
    shopifyService.clientId = 'test_client_id';
    shopifyService.clientSecret = 'test_client_secret';

    // -----------------------------------------------------------------------
    // 1. Scoped CORS Preflight (OPTIONS) & Origin Validation
    // -----------------------------------------------------------------------
    console.log('--- Suite 1: Scoped CORS for Customer Confirmation & Cancellation ---');

    const allowedCustomerOrigins = [
      'https://extensions.shopifycdn.com',
      'https://shopify.com',
      'https://checkout.shopify.com',
      'https://shop.app',
      'https://abihacart.myshopify.com',
    ];

    const customerCorsEndpoints = [
      '/api/orders/cancel-shopify-order',
      '/api/orders/confirm-shopify-order',
      '/api/orders/checkout-confirmation-status',
    ];

    for (const endpoint of customerCorsEndpoints) {
      for (const origin of allowedCustomerOrigins) {
        const preflight = await sendRequest(port, 'OPTIONS', endpoint, {
          Origin: origin,
          'Access-Control-Request-Method': 'POST',
          'Access-Control-Request-Headers': 'Content-Type',
        });

        assert.strictEqual(preflight.status, 204, `OPTIONS ${endpoint} for ${origin} must return 204, got ${preflight.status}`);
        assert.strictEqual(
          preflight.headers['access-control-allow-origin'],
          origin,
          `OPTIONS ${endpoint} must echo allowed origin ${origin}`
        );
        assert.ok(
          (preflight.headers['access-control-allow-methods'] || '').includes('POST'),
          `OPTIONS ${endpoint} must advertise POST method`
        );
      }

      // Sandboxed iframe/worker Origin: null must be allowed ONLY without credentials on customer confirmation routes
      const nullPreflight = await sendRequest(port, 'OPTIONS', endpoint, {
        Origin: 'null',
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': 'Content-Type',
      });
      assert.strictEqual(nullPreflight.status, 204, `OPTIONS ${endpoint} for Origin: null must return 204`);
      assert.strictEqual(
        nullPreflight.headers['access-control-allow-origin'],
        'null',
        `OPTIONS ${endpoint} must return Access-Control-Allow-Origin: null for sandboxed checkout origin`
      );
      assert.notStrictEqual(
        nullPreflight.headers['access-control-allow-credentials'],
        'true',
        `OPTIONS ${endpoint} for Origin: null must NOT set Access-Control-Allow-Credentials: true`
      );
    }

    // Unauthorized origin must return 403 (never 500) with no ACAO header
    const blockedPreflight = await sendRequest(port, 'OPTIONS', '/api/orders/cancel-shopify-order', {
      Origin: 'https://evil-attacker.example',
      'Access-Control-Request-Method': 'POST',
    });
    assert.strictEqual(blockedPreflight.status, 403, `Unauthorized preflight must return 403, got ${blockedPreflight.status}`);
    assert.strictEqual(blockedPreflight.headers['access-control-allow-origin'], undefined);

    const blockedPost = await sendRequest(
      port,
      'POST',
      '/api/orders/cancel-shopify-order',
      { Origin: 'https://evil-attacker.example' },
      { token: 'ignored' }
    );
    assert.strictEqual(blockedPost.status, 403, `Unauthorized POST must return 403, got ${blockedPost.status}`);
    assert.strictEqual(blockedPost.headers['access-control-allow-origin'], undefined);

    // Non-confirmation routes must strictly block Origin: null and extension CDN origins
    for (const restrictedRoute of ['/api/admin/overview', '/api/chat/message', '/api/shopify/test-connection']) {
      const restrictedNull = await sendRequest(port, 'OPTIONS', restrictedRoute, {
        Origin: 'null',
        'Access-Control-Request-Method': 'POST',
      });
      assert.strictEqual(
        restrictedNull.status,
        403,
        `Origin: null must be blocked (403) on ${restrictedRoute}, got ${restrictedNull.status}`
      );
    }

    const restrictedExtensionRoute = await sendRequest(port, 'OPTIONS', '/api/admin/overview', {
      Origin: 'https://extensions.shopifycdn.com',
      'Access-Control-Request-Method': 'GET',
    });
    assert.strictEqual(
      restrictedExtensionRoute.status,
      403,
      `Checkout extension CDN origin must NOT bypass CORS on /api/admin/overview`
    );

    console.log('✅ Suite 1 Passed: Scoped CORS preflight and origin isolation verified.');

    // -----------------------------------------------------------------------
    // 2. Signed Token Enforcement & GID Normalization Safety
    // -----------------------------------------------------------------------
    console.log('\n--- Suite 2: Token Auth & Order GID Binding Safety ---');

    await ShopifyOrderConfirmationStore.clear();
    SessionStore.clearMemory();
    emailNotificationService.clearHistory();
    const sentEmails = [];
    emailNotificationService.setMockHandler(async (payload) => {
      sentEmails.push(payload);
      return { success: true, status: 'sent', resendMessageId: `email_${sentEmails.length}` };
    });

    const tokenA = ShopifyOrderConfirmationStore.generateToken('987654321001', 60);
    await ShopifyOrderConfirmationStore.create({
      shopifyOrderId: '987654321001',
      orderNumber: '#9001',
      shop: 'abihacart.myshopify.com',
      customerName: 'Alice Test',
      customerEmail: 'alice@example.com',
      customerPhone: '+971500000001',
      totalPrice: '150.00',
      currency: 'AED',
      lineItems: [{ title: 'Leather Tote', quantity: 1, price: '150.00' }],
      confirmationToken: tokenA.token,
      confirmationTokenHash: tokenA.tokenHash,
      tokenExpiresAt: tokenA.expiresAt,
      status: 'pending',
    });

    const tokenB = ShopifyOrderConfirmationStore.generateToken('987654321002', 60);
    await ShopifyOrderConfirmationStore.create({
      shopifyOrderId: '987654321002',
      orderNumber: '#9002',
      shop: 'abihacart.myshopify.com',
      customerName: 'Bob Test',
      customerEmail: 'bob@example.com',
      customerPhone: '+971500000002',
      totalPrice: '200.00',
      currency: 'AED',
      lineItems: [{ title: 'Silk Scarf', quantity: 1, price: '200.00' }],
      confirmationTokenHash: tokenB.tokenHash,
      tokenExpiresAt: tokenB.expiresAt,
      status: 'pending',
    });

    // Missing token even when valid orderId & orderNumber supplied -> MUST FAIL 400
    const missingTokenRes = await sendRequest(
      port,
      'POST',
      '/api/orders/cancel-shopify-order',
      { Origin: 'https://extensions.shopifycdn.com' },
      { orderId: 'gid://shopify/Order/987654321001', orderNumber: '#9001', reason: 'customer' }
    );
    assert.strictEqual(missingTokenRes.status, 400, `Missing token must fail 400, got ${missingTokenRes.status}`);
    assert.strictEqual(missingTokenRes.json.code, 'MISSING_TOKEN');
    assert.strictEqual(
      missingTokenRes.headers['access-control-allow-origin'],
      'https://extensions.shopifycdn.com',
      'Allowed CORS header must still be present on 400 response'
    );

    // Tampered token -> MUST FAIL 403
    const badTokenRes = await sendRequest(
      port,
      'POST',
      '/api/orders/cancel-shopify-order',
      { Origin: 'https://extensions.shopifycdn.com' },
      { token: `${tokenA.token.slice(0, -4)}0000`, orderId: '987654321001' }
    );
    assert.strictEqual(badTokenRes.status, 403, `Tampered token must fail 403, got ${badTokenRes.status}`);

    // Expired token -> MUST FAIL 403
    const expiredToken = ShopifyOrderConfirmationStore.generateToken('987654321099', -5);
    await ShopifyOrderConfirmationStore.create({
      shopifyOrderId: '987654321099',
      orderNumber: '#9099',
      shop: 'abihacart.myshopify.com',
      customerName: 'Expired User',
      customerEmail: 'expired@example.com',
      totalPrice: '50.00',
      currency: 'AED',
      confirmationTokenHash: expiredToken.tokenHash,
      tokenExpiresAt: expiredToken.expiresAt,
      status: 'pending',
    });
    const expiredRes = await sendRequest(
      port,
      'POST',
      '/api/orders/cancel-shopify-order',
      { Origin: 'https://checkout.shopify.com' },
      { token: expiredToken.token }
    );
    assert.strictEqual(expiredRes.status, 410, `Expired token must fail 410, got ${expiredRes.status}`);
    assert.strictEqual(expiredRes.json.code, 'TOKEN_EXPIRED');

    // Cross-order GID attack: tokenA + Order B GID -> MUST FAIL 403 ORDER_TOKEN_MISMATCH
    const mismatchGidRes = await sendRequest(
      port,
      'POST',
      '/api/orders/cancel-shopify-order',
      { Origin: 'https://shopify.com' },
      { token: tokenA.token, orderId: 'gid://shopify/Order/987654321002' }
    );
    assert.strictEqual(mismatchGidRes.status, 403, `Mismatched GID orderId must fail 403, got ${mismatchGidRes.status}`);
    assert.strictEqual(mismatchGidRes.json.code, 'ORDER_TOKEN_MISMATCH');

    // Mismatched orderNumber attack: tokenA + matching orderId + Order B orderNumber -> MUST FAIL 403
    const mismatchNumRes = await sendRequest(
      port,
      'POST',
      '/api/orders/cancel-shopify-order',
      { Origin: 'https://shop.app' },
      { token: tokenA.token, orderId: 'gid://shopify/Order/987654321001', orderNumber: '#9002' }
    );
    assert.strictEqual(mismatchNumRes.status, 403, `Mismatched orderNumber must fail 403, got ${mismatchNumRes.status}`);
    assert.strictEqual(mismatchNumRes.json.code, 'ORDER_TOKEN_MISMATCH');

    // Wrong customer on checkout-confirmation-status with Order GID -> MUST FAIL 403
    const wrongCustomerStatus = await sendRequest(
      port,
      'GET',
      `/api/orders/checkout-confirmation-status?orderId=${encodeURIComponent('gid://shopify/Order/987654321001')}&email=${encodeURIComponent('intruder@example.com')}`,
      { Origin: 'https://extensions.shopifycdn.com' }
    );
    assert.strictEqual(wrongCustomerStatus.status, 403, `Wrong customer email must fail 403 on status endpoint, got ${wrongCustomerStatus.status}`);

    // Legitimate customer status lookup with Shopify OrderIdentity GID returns token & status
    const okCustomerStatus = await sendRequest(
      port,
      'GET',
      `/api/orders/checkout-confirmation-status?orderId=${encodeURIComponent('gid://shopify/OrderIdentity/987654321001')}&email=${encodeURIComponent('alice@example.com')}`,
      { Origin: 'null' }
    );
    assert.strictEqual(okCustomerStatus.status, 200, `Valid checkout status with GID must return 200, got ${okCustomerStatus.status} (${okCustomerStatus.raw})`);
    assert.strictEqual(okCustomerStatus.headers['access-control-allow-origin'], 'null');
    assert.notStrictEqual(okCustomerStatus.headers['access-control-allow-credentials'], 'true');
    assert.ok(okCustomerStatus.json.record && okCustomerStatus.json.record.confirmationToken, 'Verified customer status response must provide signed token');

    // Ensure Order A & Order B remain pending after all failed attacks
    const checkA = await ShopifyOrderConfirmationStore.findByShopifyOrderId('987654321001');
    const checkB = await ShopifyOrderConfirmationStore.findByShopifyOrderId('987654321002');
    assert.strictEqual(checkA.status, 'pending', 'Order A must remain pending after rejected attempts');
    assert.strictEqual(checkB.status, 'pending', 'Order B must remain pending after cross-order attack');

    console.log('✅ Suite 2 Passed: Token authentication and cross-order GID defenses verified.');

    // -----------------------------------------------------------------------
    // 3. Expired Token Auto-Refresh & Canonical Shop Cancel Call
    // -----------------------------------------------------------------------
    console.log('\n--- Suite 3: Token Auto-Refresh & Canonical Shopify Cancel Call ---');

    const fetchCalls = [];
    global.fetch = async (url, init = {}) => {
      fetchCalls.push({ url, method: init.method, headers: init.headers, body: init.body });

      if (url.includes('/admin/oauth/access_token')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            access_token: 'shpua_refreshed_cancel_token',
            expires_in: 3599,
            refresh_token: 'shprt_rotated_cancel_refresh',
            refresh_token_expires_in: 5184000,
            scope: 'read_products,write_orders',
          }),
        };
      }

      if (url.includes('/admin/api/') && url.endsWith('/orders/987654321001/cancel.json')) {
        assert.ok(
          url.startsWith('https://dwpaps-9q.myshopify.com/'),
          `Shopify cancel request must target canonical store domain dwpaps-9q.myshopify.com, got: ${url}`
        );
        assert.strictEqual(
          init.headers['X-Shopify-Access-Token'],
          'shpua_refreshed_cancel_token',
          'Shopify cancel request must use auto-refreshed access token, not expired session token'
        );
        return {
          ok: true,
          status: 200,
          json: async () => ({ order: { id: 987654321001, cancelled_at: '2026-11-25T10:00:00Z' } }),
          text: async () => JSON.stringify({ order: { id: 987654321001 } }),
        };
      }

      throw new Error(`Unexpected external fetch URL: ${url}`);
    };

    // Populate alias session (abihacart.myshopify.com -> canonical dwpaps-9q.myshopify.com) with expired token
    await SessionStore.upsertSession('dwpaps-9q.myshopify.com', {
      canonicalShop: 'dwpaps-9q.myshopify.com',
      accessToken: 'shpua_expired_token_old',
      refreshToken: 'shprt_valid_refresh_token',
      expiresAt: new Date(Date.now() - 120000),
      scope: 'read_products,write_orders',
      isOnline: false,
    });
    await SessionStore.upsertSession('abihacart.myshopify.com', {
      canonicalShop: 'dwpaps-9q.myshopify.com',
      accessToken: 'shpua_expired_token_old',
      refreshToken: 'shprt_valid_refresh_token',
      expiresAt: new Date(Date.now() - 120000),
      scope: 'read_products,write_orders',
      isOnline: false,
    });

    const cancelOkRes = await sendRequest(
      port,
      'POST',
      '/api/orders/cancel-shopify-order',
      { Origin: 'https://extensions.shopifycdn.com' },
      {
        token: okCustomerStatus.json.record.confirmationToken,
        orderId: 'gid://shopify/Order/987654321001',
        orderNumber: '#9001',
        reason: 'customer_changed_mind',
      }
    );

    assert.strictEqual(cancelOkRes.status, 200, `Valid cancellation must return 200, got ${cancelOkRes.status} (${cancelOkRes.raw})`);
    assert.strictEqual(cancelOkRes.json.status, 'success');
    assert.strictEqual(cancelOkRes.json.isShopifyCancelled, true);
    assert.strictEqual(cancelOkRes.json.alreadyCancelled, false);
    assert.strictEqual(cancelOkRes.json.order.status, 'cancelled');
    assert.strictEqual(
      cancelOkRes.headers['access-control-allow-origin'],
      'https://extensions.shopifycdn.com'
    );
    assert.ok(
      fetchCalls.some((c) => c.url === 'https://dwpaps-9q.myshopify.com/admin/oauth/access_token'),
      'Token refresh must hit canonical shop OAuth endpoint'
    );
    assert.ok(
      fetchCalls.some((c) => c.url.includes('https://dwpaps-9q.myshopify.com/admin/api/') && c.url.endsWith('/orders/987654321001/cancel.json')),
      'Shopify cancel.json POST must use canonical domain dwpaps-9q.myshopify.com'
    );

    const updatedA = await ShopifyOrderConfirmationStore.findByShopifyOrderId('987654321001');
    assert.strictEqual(updatedA.status, 'cancelled');
    assert.ok(sentEmails.some((e) => e.isCancellation && e.orderConfirmation && e.orderConfirmation.orderNumber === '#9001'));

    // Also test valid confirmation with Order B via GID + Origin: null
    const confirmBRes = await sendRequest(
      port,
      'POST',
      '/api/orders/confirm-shopify-order',
      { Origin: 'null' },
      {
        token: tokenB.token,
        orderId: 'gid://shopify/Order/987654321002',
      }
    );
    assert.strictEqual(confirmBRes.status, 200, `Confirm with matching GID must succeed, got ${confirmBRes.status} (${confirmBRes.raw})`);
    assert.strictEqual(confirmBRes.json.status, 'success');
    assert.strictEqual(confirmBRes.json.order.status, 'confirmed');
    assert.strictEqual(confirmBRes.headers['access-control-allow-origin'], 'null');

    console.log('✅ Suite 3 Passed: Auto-refresh, canonical domain cancel call, and confirm flow verified.');

    // -----------------------------------------------------------------------
    // 4. Popup Script Asset Configuration Safety
    // -----------------------------------------------------------------------
    console.log('\n--- Suite 4: Popup Asset Backend URL & Error Parsing Check ---');
    const popupRes = await sendRequest(port, 'GET', '/api/orders/popup-script.js');
    assert.strictEqual(popupRes.status, 200, 'Popup JS asset must return 200');
    assert.ok(
      popupRes.raw.includes('https://abihacart-chatbot-backend.onrender.com'),
      'Popup JS must default to deployed Render backend'
    );
    assert.ok(
      !popupRes.raw.includes('http://localhost:5000'),
      'Popup JS must not contain hardcoded http://localhost:5000'
    );
    assert.ok(
      popupRes.raw.includes('parseJsonApiResponse') && popupRes.raw.includes('ok: res.ok'),
      'Popup JS must validate HTTP status before treating response as success'
    );

    console.log('✅ Suite 4 Passed: Popup script asset verified.');

    // -----------------------------------------------------------------------
    // 5. Executed Popup Script (VM DOM) Token Retrieval, Duplicate & Error Flows
    // -----------------------------------------------------------------------
    console.log('\n--- Suite 5: Popup Script Execution (Token Retrieval, Payload & Error Flows) ---');

    const createPopupDomHarness = ({ checkoutObj, fetchHandler }) => {
      const elementsById = new Map();

      class MockElement {
        constructor(tagName = 'div') {
          this.tagName = tagName.toUpperCase();
          this.id = '';
          this.className = '';
          this.style = { cssText: '' };
          this.dataset = { backendUrl: `http://127.0.0.1:${port}` };
          this.disabled = false;
          this.children = [];
          this.listeners = {};
          this.attributes = {};
          this._innerHTML = '';
          this._textContent = '';
          this.classList = {
            _set: new Set(),
            add: (...cls) => cls.forEach((c) => this.classList._set.add(c)),
            remove: (...cls) => cls.forEach((c) => this.classList._set.delete(c)),
            contains: (c) => this.classList._set.has(c),
          };
        }

        set innerHTML(html) {
          this._innerHTML = String(html || '');
          const idMatches = [...this._innerHTML.matchAll(/id=["']([^"']+)["']/g)];
          for (const m of idMatches) {
            const child = new MockElement('div');
            child.id = m[1];
            child._parent = this;
            elementsById.set(child.id, child);
          }
        }

        get innerHTML() {
          return this._innerHTML;
        }

        set textContent(val) {
          this._textContent = String(val || '');
        }

        get textContent() {
          return this._textContent;
        }

        setAttribute(k, v) {
          this.attributes[k] = v;
        }

        appendChild(child) {
          if (child && child.id) elementsById.set(child.id, child);
          this.children.push(child);
          return child;
        }

        prepend(child) {
          if (child && child.id) elementsById.set(child.id, child);
          this.children.unshift(child);
          return child;
        }

        remove() {
          if (this.id) elementsById.delete(this.id);
        }

        querySelector(sel) {
          if (sel && sel.startsWith('#')) {
            return elementsById.get(sel.slice(1)) || null;
          }
          return null;
        }

        addEventListener(type, fn) {
          if (!this.listeners[type]) this.listeners[type] = [];
          this.listeners[type].push(fn);
        }

        async clickAsync() {
          const handlers = this.listeners.click || [];
          for (const fn of handlers) {
            await fn({ target: this, preventDefault: () => {} });
          }
        }
      }

      const rootEl = new MockElement('div');
      rootEl.id = 'abihacart-order-confirmation-root';
      elementsById.set(rootEl.id, rootEl);

      const mockDocument = {
        readyState: 'complete',
        head: new MockElement('head'),
        body: new MockElement('body'),
        currentScript: null,
        getElementById: (id) => elementsById.get(id) || null,
        createElement: (tag) => new MockElement(tag),
        addEventListener: () => {},
      };

      const mockWindow = {
        location: { search: '' },
        Shopify: { checkout: checkoutObj },
        document: mockDocument,
        ABIHACART_CONFIG: { backendUrl: `http://127.0.0.1:${port}` },
      };

      const sandbox = {
        window: mockWindow,
        document: mockDocument,
        fetch: fetchHandler,
        URL,
        URLSearchParams,
        requestAnimationFrame: (fn) => fn(),
        console,
      };
      mockWindow.window = mockWindow;

      vm.runInNewContext(popupRes.raw, sandbox);
      return { elementsById, mockWindow };
    };

    const proxyToTestServerFetch = (recorder) => async (url, init = {}) => {
      recorder.push({ url, method: init.method || 'GET', body: init.body ? JSON.parse(init.body) : null });
      const parsed = new URL(url);
      const res = await sendRequest(
        port,
        init.method || 'GET',
        `${parsed.pathname}${parsed.search}`,
        init.headers || {},
        init.body ? JSON.parse(init.body) : null
      );
      return {
        ok: res.status >= 200 && res.status < 300,
        status: res.status,
        json: async () => res.json,
        text: async () => res.raw,
      };
    };

    // 5a. Cancel via popup with Shopify co.token present + duplicate double-click prevention
    const tokenC = ShopifyOrderConfirmationStore.generateToken('987654321003', 60);
    await ShopifyOrderConfirmationStore.create({
      shopifyOrderId: '987654321003',
      orderNumber: '#9003',
      shop: 'abihacart.myshopify.com',
      customerName: 'Charlie Test',
      customerEmail: 'charlie@example.com',
      customerPhone: '+971500000003',
      totalPrice: '310.00',
      currency: 'AED',
      lineItems: [{ title: 'Desert Oud', quantity: 1, price: '310.00' }],
      confirmationToken: tokenC.token,
      confirmationTokenHash: tokenC.tokenHash,
      tokenExpiresAt: tokenC.expiresAt,
      status: 'pending',
    });

    const cancelPopupCalls = [];
    const harnessCancel = createPopupDomHarness({
      checkoutObj: {
        order_id: 'gid://shopify/Order/987654321003',
        order_number: 9003,
        email: 'charlie@example.com',
        token: 'shopify_checkout_token_not_abihacart_999',
      },
      fetchHandler: proxyToTestServerFetch(cancelPopupCalls),
    });

    await new Promise((r) => setTimeout(r, 30));

    assert.strictEqual(cancelPopupCalls.length, 1, 'Init must call status endpoint once');
    assert.ok(
      cancelPopupCalls[0].url.includes('/api/orders/checkout-confirmation-status') &&
      !cancelPopupCalls[0].url.includes('shopify_checkout_token_not_abihacart_999'),
      'Status query must NOT send Shopify checkout.token as Abihacart confirmation token'
    );

    const openCancelBtn = harnessCancel.elementsById.get('abh-cancel-btn');
    assert.ok(openCancelBtn, 'Popup cancel button must render when status returns status=success');
    await openCancelBtn.clickAsync();

    const confirmCancelBtn = harnessCancel.elementsById.get('abh-confirm-cancel-btn');
    assert.ok(confirmCancelBtn, 'Confirmation safeguard cancel button must render');

    // Trigger rapid duplicate clicks simultaneously
    await Promise.all([
      confirmCancelBtn.clickAsync(),
      confirmCancelBtn.clickAsync(),
    ]);

    const postCancelCalls = cancelPopupCalls.filter((c) => c.url.endsWith('/api/orders/cancel-shopify-order'));
    assert.strictEqual(postCancelCalls.length, 1, 'Duplicate clicks must send exactly ONE cancellation POST request');
    assert.strictEqual(postCancelCalls[0].body.token, tokenC.token, 'Cancel POST must send signed confirmationToken');
    assert.strictEqual(postCancelCalls[0].body.orderId, '987654321003', 'Cancel POST must include orderId');
    assert.ok(postCancelCalls[0].body.reason, 'Cancel POST must include reason');

    const checkC = await ShopifyOrderConfirmationStore.findByShopifyOrderId('987654321003');
    assert.strictEqual(checkC.status, 'cancelled', 'Order 987654321003 must be cancelled via popup');

    // 5b. Confirm via popup with duplicate protection + exact payload
    const tokenD = ShopifyOrderConfirmationStore.generateToken('987654321004', 60);
    await ShopifyOrderConfirmationStore.create({
      shopifyOrderId: '987654321004',
      orderNumber: '#9004',
      shop: 'abihacart.myshopify.com',
      customerName: 'Dana Test',
      customerEmail: 'dana@example.com',
      customerPhone: '+971500000004',
      totalPrice: '420.00',
      currency: 'AED',
      lineItems: [{ title: 'Silk Abaya', quantity: 1, price: '420.00' }],
      confirmationToken: tokenD.token,
      confirmationTokenHash: tokenD.tokenHash,
      tokenExpiresAt: tokenD.expiresAt,
      status: 'pending',
    });

    const confirmPopupCalls = [];
    const harnessConfirm = createPopupDomHarness({
      checkoutObj: {
        order_id: 'gid://shopify/Order/987654321004',
        order_number: 9004,
        email: 'dana@example.com',
      },
      fetchHandler: proxyToTestServerFetch(confirmPopupCalls),
    });
    await new Promise((r) => setTimeout(r, 30));

    const confirmBtnD = harnessConfirm.elementsById.get('abh-confirm-btn');
    await Promise.all([
      confirmBtnD.clickAsync(),
      confirmBtnD.clickAsync(),
    ]);

    const postConfirmCalls = confirmPopupCalls.filter((c) => c.url.endsWith('/api/orders/confirm-shopify-order'));
    assert.strictEqual(postConfirmCalls.length, 1, 'Duplicate confirm clicks must send exactly ONE POST request');
    assert.strictEqual(postConfirmCalls[0].body.token, tokenD.token);
    assert.strictEqual(postConfirmCalls[0].body.orderId, '987654321004');
    const checkD = await ShopifyOrderConfirmationStore.findByShopifyOrderId('987654321004');
    assert.strictEqual(checkD.status, 'confirmed');

    // 5c. Missing token prevents POST submission completely & shows clear message
    const missingTokenCalls = [];
    const harnessMissing = createPopupDomHarness({
      checkoutObj: {
        order_id: 'gid://shopify/Order/987654321005',
        order_number: 9005,
        email: 'missing@example.com',
      },
      fetchHandler: async (url, init = {}) => {
        missingTokenCalls.push({ url, method: init.method || 'GET' });
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify({
            status: 'success',
            confirmationStatus: 'pending',
            record: {
              shopifyOrderId: '987654321005',
              orderNumber: '#9005',
              status: 'pending',
            },
          }),
        };
      },
    });
    await new Promise((r) => setTimeout(r, 30));
    await harnessMissing.elementsById.get('abh-cancel-btn').clickAsync();
    await harnessMissing.elementsById.get('abh-confirm-cancel-btn').clickAsync();

    assert.strictEqual(
      missingTokenCalls.filter((c) => c.method === 'POST').length,
      0,
      'Missing confirmationToken must prevent POST cancellation submission'
    );
    const missingBanner = harnessMissing.elementsById.get('abh-error-banner');
    assert.ok(
      missingBanner && /confirmation token/i.test(missingBanner.textContent),
      'Missing token must surface clear customer-facing banner message'
    );

    // 5d. Expired token response from backend shows clear expired message
    const expiredPopupCalls = [];
    const harnessExpired = createPopupDomHarness({
      checkoutObj: {
        order_id: 'gid://shopify/Order/987654321099',
        order_number: 9099,
        email: 'expired@example.com',
      },
      fetchHandler: async (url, init = {}) => {
        expiredPopupCalls.push({ url, method: init.method || 'GET' });
        if (url.includes('/checkout-confirmation-status')) {
          return {
            ok: true,
            status: 200,
            text: async () => JSON.stringify({
              status: 'success',
              confirmationStatus: 'pending',
              record: {
                shopifyOrderId: '987654321099',
                orderNumber: '#9099',
                status: 'pending',
                confirmationToken: expiredToken.token,
              },
            }),
          };
        }
        return proxyToTestServerFetch([])(url, init);
      },
    });
    await new Promise((r) => setTimeout(r, 30));
    await harnessExpired.elementsById.get('abh-cancel-btn').clickAsync();
    await harnessExpired.elementsById.get('abh-confirm-cancel-btn').clickAsync();
    const expiredBanner = harnessExpired.elementsById.get('abh-error-banner');
    assert.ok(
      expiredBanner && /expired/i.test(expiredBanner.textContent),
      'Expired token rejection must display clear expired-token message'
    );

    // 5e. Confirm missing token direct API guard returns "Confirmation token is required."
    const missingConfirmDirect = await sendRequest(
      port,
      'POST',
      '/api/orders/confirm-shopify-order',
      { Origin: 'https://extensions.shopifycdn.com' },
      { orderId: 'gid://shopify/Order/987654321004', orderNumber: '#9004' }
    );
    assert.strictEqual(missingConfirmDirect.status, 400);
    assert.strictEqual(missingConfirmDirect.json.code, 'MISSING_TOKEN');
    assert.strictEqual(missingConfirmDirect.json.message, 'Confirmation token is required.');

    console.log('✅ Suite 5 Passed: Executed popup script token extraction, duplicate prevention, and error flows.');
    console.log('\n====================================================');
    console.log('🎉 ALL SHOPIFY CANCELLATION FIX TESTS PASSED');
    console.log('====================================================\n');
  } finally {
    global.fetch = origFetch;
    config.shopify.clientId = origClientId;
    config.shopify.clientSecret = origClientSecret;
    shopifyService.clientId = origServiceClientId;
    shopifyService.clientSecret = origServiceClientSecret;
    emailNotificationService.clearHistory();
    SessionStore.clearMemory();
    await ShopifyOrderConfirmationStore.clear();
    server.close();
  }
}

run().catch((err) => {
  console.error('\n❌ Shopify Cancellation Fix Test Failure:', err);
  process.exit(1);
});
