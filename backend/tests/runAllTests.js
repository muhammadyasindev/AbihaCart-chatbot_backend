/**
 * Comprehensive Test Suite Runner for Abihacart AI Support Backend
 * Executes all 15 regression test suites across Linux/macOS/Windows
 */
const { spawnSync } = require('child_process');
const path = require('path');

const testSuites = [
  'health.test.js',
  'server.test.js',
  'shopifyAuth.test.js',
  'storeDataAndWebhooks.test.js',
  'inventoryPagination.test.js',
  'chatAndWidget.test.js',
  'aiSupportQuestions.test.js',
  'orderTracking.test.js',
  'whatsappIntegration.test.js',
  'adminDashboard.test.js',
  'phase9FinalQa.test.js',
  'phase9_9AdvancedAiAgent.test.js',
  'phase9_11SmsOrderConfirmation.test.js',
  'phase9_12IndependentLiveVerification.test.js',
  'phase9_14ConcurrencyAndFailure.test.js',
  'phase9_17CatalogAndIntelligence.test.js',
  'phase9_19OrderConfirmationMvp.test.js',
  'phase10OrderConfirmationPopup.test.js',
];

console.log('======================================================================');
console.log('🧪 Starting Abihacart Chatbot Master Regression Test Suite');
console.log(`📋 Total Test Suites: ${testSuites.length}`);
console.log('======================================================================\n');

let passed = 0;
let failed = 0;
const results = [];
const startTime = Date.now();

for (const suite of testSuites) {
  const suitePath = path.resolve(__dirname, suite);
  process.stdout.write(`⏳ Running [${suite}]... `);

  const startSuite = Date.now();
  const res = spawnSync(process.execPath, [suitePath], {
    stdio: 'inherit',
    env: { ...process.env, NODE_ENV: 'test', TEST_MODE: 'true' },
  });
  const duration = ((Date.now() - startSuite) / 1000).toFixed(2);

  if (res.status === 0) {
    passed++;
    results.push({ suite, status: 'PASSED', duration: `${duration}s` });
    console.log(`\n✅ ${suite} PASSED (${duration}s)\n`);
  } else {
    failed++;
    results.push({ suite, status: 'FAILED', duration: `${duration}s` });
    console.error(`\n❌ ${suite} FAILED (${duration}s)\n`);
  }
}

const totalDuration = ((Date.now() - startTime) / 1000).toFixed(2);

console.log('\n======================================================================');
console.log('📊 MASTER TEST SUITE EXECUTION SUMMARY');
console.log('======================================================================');
results.forEach((r, idx) => {
  const icon = r.status === 'PASSED' ? '✅' : '❌';
  console.log(`${icon} [${idx + 1}/${results.length}] ${r.suite.padEnd(42)} ${r.status.padEnd(8)} ${r.duration}`);
});
console.log('----------------------------------------------------------------------');
console.log(`Total Suites: ${testSuites.length} | Passed: ${passed} | Failed: ${failed} | Duration: ${totalDuration}s`);
console.log('======================================================================\n');

if (failed > 0) {
  process.exit(1);
} else {
  process.exit(0);
}
