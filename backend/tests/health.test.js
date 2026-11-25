/**
 * Automated Health Check and App Smoke Test
 */
const http = require('http');
const app = require('../src/app');

const testPort = 5999;
let server;

const runTests = async () => {
  console.log('--- Starting Automated Health Check Test ---');

  server = app.listen(testPort, async () => {
    try {
      // Test 1: GET /
      const rootRes = await fetchJSON(`http://localhost:${testPort}/`);
      assert(rootRes.statusCode === 200, 'GET / should return 200');
      assert(rootRes.body.message.includes('operational'), 'GET / should report operational');
      console.log('✅ Test 1 Passed: GET / returned 200 OK with operational message');

      // Test 2: GET /api/health
      const healthRes = await fetchJSON(`http://localhost:${testPort}/api/health`);
      assert(healthRes.statusCode === 200, 'GET /api/health should return 200');
      assert(healthRes.body.status === 'ok', 'GET /api/health should return status ok');
      assert(healthRes.body.service === 'abihacart-support-backend', 'Service name should match');
      assert(healthRes.body.components !== undefined, 'Components object should exist');
      console.log('✅ Test 2 Passed: GET /api/health returned 200 OK with health status');
      console.log('   Components state:', JSON.stringify(healthRes.body.components));

      // Test 3: GET /non-existent (404 check)
      const notFoundRes = await fetchJSON(`http://localhost:${testPort}/api/non-existent-endpoint`);
      assert(notFoundRes.statusCode === 404, '404 endpoint should return 404');
      assert(notFoundRes.body.status === 'fail', '404 should return status fail');
      console.log('✅ Test 3 Passed: 404 handler works as expected');

      // Test 4: GET /api/health/ready (Readiness probe check)
      const readyRes = await fetchJSON(`http://localhost:${testPort}/api/health/ready`);
      assert(readyRes.statusCode === 200, 'GET /api/health/ready should return 200');
      assert(readyRes.body.status === 'ready', 'Readiness probe should report ready');
      assert(readyRes.body.checks !== undefined, 'Checks object should exist in readiness response');
      console.log('✅ Test 4 Passed: GET /api/health/ready returned 200 OK with readiness status');
      console.log('   Readiness checks:', JSON.stringify(readyRes.body.checks));

      console.log('\n--- ALL PHASE 1 HEALTH TESTS PASSED ---');
      server.close(() => process.exit(0));
    } catch (err) {
      console.error('❌ Test Failed:', err.message);
      if (server) server.close();
      process.exit(1);
    }
  });
};

const fetchJSON = (url) => {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
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

const assert = (condition, msg) => {
  if (!condition) throw new Error(msg);
};

runTests();
