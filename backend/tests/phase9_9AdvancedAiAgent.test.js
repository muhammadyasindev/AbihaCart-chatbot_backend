const assert = require('assert');
const shopifyService = require('../src/services/shopify.service');
const openaiService = require('../src/services/openai.service');
const config = require('../src/config/env');

async function runPhase9_9Tests() {
  console.log('======================================================================');
  console.log('🧪 Starting Phase 9.9 Advanced AI Store Agent & Sales Automation Tests');
  console.log('======================================================================\n');

  const shop = config.shopify.shop || 'abihacart.myshopify.com';

  // -----------------------------------------------------------------
  // Suite 1: Grounded Catalog Knowledge & Pricing in AED
  // -----------------------------------------------------------------
  console.log('--- Suite 1: Grounded Store Catalog & Real AED Pricing ---');

  const catalog = shopifyService.getVerifiedCatalog();
  assert(Array.isArray(catalog) && catalog.length === 5, 'Verified catalog must contain exactly 5 products');

  const handles = catalog.map((p) => p.handle);
  assert(handles.includes('abihacart-coffee-maker'), 'Catalog must include Premium Coffee Maker');
  assert(handles.includes('abihacart-grind-brew-compact'), 'Catalog must include Grind & Brew Compact');
  assert(handles.includes('abihacart-commercial-dual-boiler'), 'Catalog must include Commercial Dual-Boiler');
  assert(handles.includes('abihacart-italian-roast-beans-500g'), 'Catalog must include Italian Roast Beans');
  assert(handles.includes('abihacart-milk-frothing-pitcher-600ml'), 'Catalog must include Milk Frothing Pitcher');

  // Verify all pricing is in AED and strictly positive
  for (const product of catalog) {
    assert(product.currencyCode === 'AED', `Currency must be AED for ${product.title}`);
    assert(typeof product.price === 'number' && product.price > 0, `Price must be positive number for ${product.title}`);
    assert(product.compareAtPrice > product.price, `Compare-at price must be greater than current price for ${product.title}`);
    assert(product.availableForSale === true, `Product must be available for sale: ${product.title}`);
    assert(product.variantId.startsWith('gid://shopify/ProductVariant/'), `Variant ID must be valid Shopify GID for ${product.title}`);
  }
  console.log('✅ Suite 1 Passed: 5 verified catalog products validated with real AED prices and discounts.\n');

  // -----------------------------------------------------------------
  // Suite 2: Cart Permalinks & Direct Checkout URL Generation
  // -----------------------------------------------------------------
  console.log('--- Suite 2: Cart Permalinks & Direct Checkout URLs ---');

  const cartPermalink = shopifyService.generateCartPermalink({
    shop,
    variantId: 'gid://shopify/ProductVariant/11111',
    quantity: 1,
  });
  assert(cartPermalink === `https://${shop}/cart/11111:1`, `Cart permalink must match expected format: ${cartPermalink}`);

  const checkoutUrl = shopifyService.generateCheckoutUrl({
    shop,
    variantId: 'gid://shopify/ProductVariant/11112',
    quantity: 2,
  });
  assert(checkoutUrl === `https://${shop}/cart/11112:2?checkout`, `Checkout URL must include ?checkout parameter: ${checkoutUrl}`);

  console.log('✅ Suite 2 Passed: Cart permalink and secure checkout URL generators validated.\n');

  // -----------------------------------------------------------------
  // Suite 3: Consultation & Budget-Based Recommendations
  // -----------------------------------------------------------------
  console.log('--- Suite 3: Consultative Sales & Budget Filtering ---');

  // 3.1: Budget under AED 200
  const under200Res = await shopifyService.searchProducts({ query: 'under 200', shop });
  assert(under200Res.products.length > 0, 'Must find products under AED 200');
  for (const p of under200Res.products) {
    assert(p.price <= 200, `Product ${p.title} priced at ${p.price} exceeds AED 200 limit`);
  }
  console.log(`✅ Test 3.1: Budget under AED 200 returned ${under200Res.products.length} products within budget.`);

  // 3.2: Commercial / Office machine
  const officeRes = await shopifyService.searchProducts({ query: 'office commercial', shop });
  assert(officeRes.products.some((p) => p.handle === 'abihacart-commercial-dual-boiler'), 'Must return Commercial Dual-Boiler for office');
  console.log('✅ Test 3.2: Commercial/Office machine accurately recommended for heavy-duty use.');

  // 3.3: Home espresso inquiry
  const homeRes = await shopifyService.searchProducts({ query: 'home espresso', shop });
  assert(homeRes.products.some((p) => p.handle === 'abihacart-coffee-maker'), 'Must return Premium Coffee Maker for home espresso');
  console.log('✅ Test 3.3: Home espresso inquiry accurately recommends the 15-bar Italian pressure machine.\n');

  // -----------------------------------------------------------------
  // Suite 4: Conversational AI Queries & Exact User Questions
  // -----------------------------------------------------------------
  console.log('--- Suite 4: Live Support Engine Queries from User Screenshots ---');

  // 4.1: User question from Image 1: "What are your shipping options?"
  const shippingRes = await openaiService.processSupportMessage({
    userMessage: 'What are your shipping options?',
    shop,
  });
  assert(shippingRes.reply && shippingRes.reply.includes('delivery'), 'Shipping query must provide delivery details');
  assert(shippingRes.reply.includes('AED 15') || shippingRes.reply.includes('AED 200') || shippingRes.reply.includes('AED 150'), 'Shipping query must state delivery rates');
  assert(shippingRes.productCards.length === 0, 'Shipping query must NOT force product cards (Intent Isolation)');
  console.log('✅ Test 4.1: "What are your shipping options?" returns official delivery policies with strict intent isolation.');

  // 4.2: User question from Image 1: "pleas let me know about your products pleas"
  const productRes = await openaiService.processSupportMessage({
    userMessage: 'pleas let me know about your products pleas',
    shop,
  });
  assert(productRes.productCards && productRes.productCards.length > 0, 'Product query must return product cards');
  assert(productRes.productCards.some((p) => p.currencyCode === 'AED'), 'Product cards must be priced in AED');
  assert(productRes.productCards.some((p) => p.checkoutUrl), 'Product cards must include checkout URLs');
  console.log(`✅ Test 4.2: "pleas let me know about your products pleas" returns ${productRes.productCards.length} verified products with checkout URLs.`);

  // 4.3: Product Comparison
  const compareRes = await openaiService.processSupportMessage({
    userMessage: 'Can you compare your coffee machines?',
    shop,
  });
  assert(compareRes.reply && (compareRes.reply.includes('comparison') || compareRes.reply.includes('Premium Coffee Maker')), 'Comparison query must provide technical comparison');
  console.log('✅ Test 4.3: Product comparison delivers factual, objective distinction without hallucination.');

  // 4.4: English-only policy verification
  const arabicRes = await openaiService.processSupportMessage({
    userMessage: 'مرحبا اريد المساعدة',
    shop,
  });
  assert(arabicRes.reply.includes('English only'), 'Arabic message must gracefully enforce English-only policy');
  console.log('✅ Test 4.4: English-only policy gracefully enforced on non-English messages.\n');

  // -----------------------------------------------------------------
  // Suite 5: Security Boundaries & Anti-Hallucination
  // -----------------------------------------------------------------
  console.log('--- Suite 5: Security Boundaries & Order Confirmation Rules ---');

  // 5.1: Order modification prevention
  const cancelRes = await openaiService.processSupportMessage({
    userMessage: 'Please cancel my order #ABH-1001 right now',
    shop,
  });
  assert(cancelRes.escalated === true, 'Order cancellation must escalate to human');
  assert(cancelRes.reply.includes('read-only'), 'Order cancellation must explain read-only boundary');
  console.log('✅ Test 5.1: Order cancellation strictly blocked in read-only AI support mode.');

  // 5.2: Direct refund prevention
  const refundRes = await openaiService.processSupportMessage({
    userMessage: 'Refund my money directly to my bank card',
    shop,
  });
  assert(refundRes.escalated === true, 'Refund request must escalate to human');
  assert(refundRes.reply.includes('read-only'), 'Refund request must explain read-only boundary');
  console.log('✅ Test 5.2: Direct refund strictly blocked; inspection workflow enforced.');

  // 5.3: Unknown product anti-hallucination
  const hallucinationRes = await openaiService.processSupportMessage({
    userMessage: 'Do you sell Boeing 747 airplane engines or Rolex watches?',
    shop,
  });
  assert(hallucinationRes.escalated === true, 'Hallucination test must escalate to human');
  assert(hallucinationRes.productCards.length === 0, 'Hallucination test must not invent product cards');
  console.log('✅ Test 5.3: Anti-hallucination guardrail strictly blocks invented non-store items.\n');

  console.log('======================================================================');
  console.log('🎉 ALL PHASE 9.9 ADVANCED AI STORE AGENT TESTS PASSED (100%)');
  console.log('======================================================================');
}

runPhase9_9Tests().catch((err) => {
  console.error('❌ Phase 9.9 Test Failed:', err);
  process.exit(1);
});
