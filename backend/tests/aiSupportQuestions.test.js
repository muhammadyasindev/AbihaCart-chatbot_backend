/**
 * Phase 5 Automated Test Suite: OpenAI Integration (gpt-6-luna) & 30 Support Questions
 */
const http = require('http');
const app = require('../src/app');
const config = require('../src/config/env');
const openaiService = require('../src/services/openai.service');
const { AI_TOOLS, SYSTEM_INSTRUCTION } = require('../src/services/openai.service');

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

const runPhase5Tests = async () => {
  console.log('======================================================================');
  console.log('🧪 Starting Phase 5 OpenAI Integration (gpt-6-luna) & 30-Question Tests');
  console.log('======================================================================\n');

  // -----------------------------------------------------------------
  // Suite 1: AI Model Configuration, Schemas & System Instruction
  // -----------------------------------------------------------------
  console.log('--- Suite 1: AI Engine Configuration & Tool Calling Schemas ---');

  // 1.1: Model Verification
  assert(openaiService.model === 'gpt-6-luna', `AI model must be gpt-6-luna (found: ${openaiService.model})`);
  assert(config.openai.model === 'gpt-6-luna', 'env.config must declare gpt-6-luna');
  console.log('✅ Test 1.1: Preferred AI Model confirmed as gpt-6-luna.');

  // 1.2: System Prompt Non-Hallucination & AED Currency Verification
  assert(SYSTEM_INSTRUCTION.includes('English only'), 'System instruction must enforce English only');
  assert(SYSTEM_INSTRUCTION.includes('AED'), 'System instruction must enforce AED currency');
  assert(SYSTEM_INSTRUCTION.includes('NEVER invent or hallucinate'), 'System instruction must strictly ban hallucinations');
  assert(SYSTEM_INSTRUCTION.includes('read-only'), 'System instruction must enforce read-only support mode');
  console.log('✅ Test 1.2: System instruction mandates English only, AED currency, and strict anti-hallucination.');

  // 1.3: Tool Calling Schema Coverage (9 tools)
  const expectedTools = [
    'search_products',
    'get_product_details',
    'get_live_inventory',
    'get_shipping_policy',
    'get_return_policy',
    'get_payment_methods',
    'get_store_info',
    'get_order_status',
    'escalate_to_human',
  ];

  assert(AI_TOOLS.length === expectedTools.length, `Must declare exactly ${expectedTools.length} function tools`);
  for (const toolName of expectedTools) {
    const found = AI_TOOLS.find((t) => t.function?.name === toolName);
    assert(found, `Tool [${toolName}] must be defined in AI_TOOLS schemas`);
    assert(found.type === 'function', `Tool [${toolName}] must have type 'function'`);
    assert(typeof found.function.description === 'string', `Tool [${toolName}] must have description`);
  }
  console.log('✅ Test 1.3: All 9 OpenAI tool calling schemas verified with valid parameters.');

  // -----------------------------------------------------------------
  // Suite 2: 30 Realistic Customer Support Question Tests
  // -----------------------------------------------------------------
  console.log('\n--- Suite 2: 30 Realistic Support Question Validation ---');

  server = app.listen(testPort, async () => {
    try {
      let activeConvId = null;
      let activeConvToken = null;

      // Helper for authenticated post
      const askChat = async (message) => {
        const payload = { message };
        if (activeConvId) payload.conversationId = activeConvId;
        const headers = activeConvToken ? { 'X-Conversation-Token': activeConvToken } : {};

        const res = await sendPost(`http://localhost:${testPort}/api/chat/message`, payload, headers);
        assert(res.statusCode === 200, `POST /api/chat/message failed for: "${message}"`);
        if (!activeConvId) {
          activeConvId = res.body.conversationId;
          activeConvToken = res.body.conversationToken;
        }
        return res.body;
      };

      // Q1: General Product Search & Catalog Recommendations
      const q1 = await askChat('What products do you offer in your store?');
      assert(q1.productCards.length > 0, 'Q1: Must return product cards');
      assert(q1.productCards[0].currencyCode === 'AED', 'Q1: Product currency must be AED');
      console.log('✅ Q1: Product catalog search returned product cards in AED.');

      // Q2: Specific Product Details & Features
      const q2 = await askChat('What are the features of the Abihacart coffee maker?');
      assert(q2.reply.includes('15-bar') || q2.reply.includes('Italian'), 'Q2: Must include pump specification');
      assert(q2.reply.includes('milk frother'), 'Q2: Must include frother feature');
      assert(q2.reply.includes('warranty'), 'Q2: Must mention warranty');
      console.log('✅ Q2: Product details returned verified technical specifications.');

      // Q3: Price Inquiry (AED Only)
      const q3 = await askChat('How much does the coffee maker cost?');
      assert(q3.reply.includes('AED 249'), 'Q3: Must quote AED 249 price');
      assert(!q3.reply.includes('$') && !q3.reply.includes('USD'), 'Q3: Never quote in USD');
      console.log('✅ Q3: Price inquiry returned exact AED 249.00 without foreign currency.');

      // Q4: Product Comparison
      const q4 = await askChat('Can you compare your coffee maker to regular machines?');
      assert(q4.reply.includes('compare') || q4.reply.includes('comparison') || q4.reply.includes('15-bar'), 'Q4: Comparison details returned');
      console.log('✅ Q4: Product comparison delivered with value benchmarks.');

      // Q5: Stock & Live Inventory Availability
      const q5 = await askChat('Is the coffee maker in stock right now?');
      assert(q5.reply.includes('in stock') || q5.reply.includes('available'), 'Q5: Must confirm stock');
      assert(q5.reply.includes('Dubai') || q5.reply.includes('15 units'), 'Q5: Must reference verified online fulfillment hub');
      console.log('✅ Q5: Live inventory check returned verified online stock count.');

      // Q6: Shipping Policy - UAE Delivery Zones
      const q6 = await askChat('Which Emirates do you deliver to in the UAE?');
      assert(q6.reply.includes('7 Emirates') || (q6.reply.includes('Dubai') && q6.reply.includes('Abu Dhabi')), 'Q6: Must list UAE Emirates');
      console.log('✅ Q6: Shipping inquiry confirmed delivery across all 7 Emirates.');

      // Q7: Shipping Policy - Delivery Fee & Free Shipping Threshold
      const q7 = await askChat('What is your delivery fee and how can I get free shipping?');
      assert(q7.reply.includes('AED 15'), 'Q7: Must state standard AED 15 fee');
      assert(q7.reply.includes('150'), 'Q7: Must state free shipping above AED 150');
      console.log('✅ Q7: Delivery fee (AED 15) and free shipping threshold (AED 150) confirmed.');

      // Q8: Shipping Policy - Express Same-Day Delivery
      const q8 = await askChat('Can I get same-day delivery in Dubai?');
      assert(q8.reply.includes('Dubai') && q8.reply.includes('12:00 PM GST'), 'Q8: Must state same-day Dubai cutoff at 12:00 PM GST');
      console.log('✅ Q8: Express same-day Dubai cutoff (12:00 PM GST) verified.');

      // Q9: Return Policy - Return Window
      const q9 = await askChat('How many days do I have to return an item?');
      assert(q9.reply.includes('14-day') || q9.reply.includes('14 days'), 'Q9: Must state 14-day window');
      console.log('✅ Q9: Return window confirmed as 14 days from delivery.');

      // Q10: Return Policy - Condition Criteria
      const q10 = await askChat('What condition must items be in to qualify for a return?');
      assert(q10.reply.includes('unused') && q10.reply.includes('original packaging'), 'Q10: Must require unused in original packaging');
      console.log('✅ Q10: Return condition criteria (unused, packaging, seals) confirmed.');

      // Q11: Return Policy - Hygiene & Non-Returnable Goods
      const q11 = await askChat('Can I return personal care or hygiene products?');
      assert(q11.reply.includes('Personal care') || q11.reply.includes('hygiene') || q11.reply.includes('cannot be returned'), 'Q11: Must identify non-returnable hygiene items');
      console.log('✅ Q11: Non-returnable personal care and hygiene items identified.');

      // Q12: Refund Policy - Refund Processing Timeline
      const q12 = await askChat('When will I receive my refund after a return?');
      assert(q12.reply.includes('5 to 7 business days') || q12.reply.includes('5-7 business days'), 'Q12: Must state 5-7 business days');
      console.log('✅ Q12: Refund processing timeline (5-7 business days to original method) verified.');

      // Q13: Payment Methods - Cards
      const q13 = await askChat('Do you accept Visa and MasterCard credit cards?');
      assert(q13.reply.includes('Visa') && q13.reply.includes('MasterCard'), 'Q13: Must confirm Visa and MasterCard');
      console.log('✅ Q13: Credit/Debit card payment acceptance confirmed.');

      // Q14: Payment Methods - Apple Pay
      const q14 = await askChat('Can I pay using Apple Pay?');
      assert(q14.reply.includes('Apple Pay'), 'Q14: Must confirm Apple Pay');
      console.log('✅ Q14: Apple Pay acceptance verified.');

      // Q15: Payment Methods - Cash on Delivery (COD) Rules & Fee
      const q15 = await askChat('Do you offer Cash on Delivery and is there an extra fee?');
      assert(q15.reply.includes('Cash on Delivery') || q15.reply.includes('COD'), 'Q15: Must confirm COD');
      assert(q15.reply.includes('1,000') || q15.reply.includes('1000'), 'Q15: Must state AED 1,000 COD limit');
      assert(q15.reply.includes('AED 10'), 'Q15: Must state AED 10 handling fee');
      console.log('✅ Q15: Cash on Delivery rules (AED 1,000 limit, AED 10 fee) verified.');

      // Q16: Payment Methods - Tabby Buy Now Pay Later
      const q16 = await askChat('Can I split my payment into installments with Tabby?');
      assert(q16.reply.includes('Tabby') && q16.reply.includes('4'), 'Q16: Must confirm Tabby 4 installments');
      console.log('✅ Q16: Tabby Buy Now Pay Later (4 installments) verified.');

      // Q17: Store Info - Operating Hours & Timezone
      const q17 = await askChat('What are your customer support operating hours?');
      assert(q17.reply.includes('9:00 AM') && q17.reply.includes('9:00 PM') && q17.reply.includes('GST'), 'Q17: Must state 9AM-9PM GST');
      assert(q17.reply.includes('Sunday'), 'Q17: Must mention closed on Sundays');
      console.log('✅ Q17: Store support hours (Mon-Sat 9AM-9PM GST) verified.');

      // Q18: Store Info - Website Domain & Market
      const q18 = await askChat('What is your official website domain and market?');
      assert(q18.reply.includes('abihacart.myshopify.com'), 'Q18: Must state official shop domain');
      assert(q18.reply.includes('AED'), 'Q18: Must confirm AED currency');
      console.log('✅ Q18: Store domain and UAE market confirmed.');

      // Q19: Order Tracking - Full Verification (Email)
      const q19 = await askChat('Where is order #ABH-1001? My email is customer@example.com');
      assert(q19.reply.includes('Order verified!') || q19.reply.includes('verified'), 'Q19: Must verify order');
      assert(q19.reply.includes('Processing') || q19.reply.includes('Dubai'), 'Q19: Must return fulfillment status');
      console.log('✅ Q19: Order tracking with email verification succeeded safely.');

      // Q20: Order Tracking - Full Verification (Phone)
      const q20 = await askChat('Track order #ABH-1002, contact phone is 0501234567');
      assert(q20.reply.includes('Order verified!') || q20.reply.includes('verified'), 'Q20: Must verify order');
      console.log('✅ Q20: Order tracking with UAE phone verification succeeded.');

      // Q21: Order Tracking - Missing Contact Info (Clarifying Question)
      const q21 = await askChat('Where is order #ABH-1003?');
      assert(q21.reply.includes('email') || q21.reply.includes('phone'), 'Q21: Must ask for email or phone for verification');
      console.log('✅ Q21: Clarifying question prompted when contact info is missing.');

      // Q22: Order Tracking - Missing Order Number (Clarifying Question)
      const q22 = await askChat('Where is my package? My email is john@test.com');
      assert(q22.reply.includes('Order Number') || q22.reply.includes('order number'), 'Q22: Must ask for order number');
      console.log('✅ Q22: Clarifying question prompted when order reference is missing.');

      // Q23: Order Tracking - Unverified / Mismatched Details (Refusal)
      const q23 = await askChat('Track order #ABH-9999 for wrong@invalid.com');
      assert(q23.reply.includes('could not verify') || q23.reply.includes('security reasons'), 'Q23: Must refuse unverified disclosure');
      console.log('✅ Q23: Customer privacy protected; unverified credentials rejected.');

      // Q24: Order Modification / Cancellation Request (Polite Refusal & Read-Only)
      const q24 = await askChat('Please cancel my order #ABH-1001 and change the shipping address');
      assert(q24.reply.includes('read-only') || q24.reply.includes('cannot cancel'), 'Q24: Must refuse order cancellation/modification');
      assert(q24.escalated === true, 'Q24: Must escalate cancellation to human support');
      console.log('✅ Q24: Order cancellation/modification politely refused; read-only boundary preserved.');

      // Q25: Direct Refund Request (Polite Refusal & Read-Only)
      const q25 = await askChat('Give me a direct refund right now for my order');
      assert(q25.reply.includes('read-only') || q25.reply.includes('cannot issue direct'), 'Q25: Must refuse direct refund');
      assert(q25.escalated === true, 'Q25: Must route refund request to human workflow');
      console.log('✅ Q25: Direct refund request politely refused; inspection workflow enforced.');

      // Q26: Explicit Request for Human Support (WhatsApp Escalation)
      const q26 = await askChat('I want to speak with a human agent on WhatsApp');
      assert(q26.escalated === true, 'Q26: Must set escalated=true');
      assert(q26.reply.includes('WhatsApp'), 'Q26: Must mention WhatsApp escalation');
      console.log('✅ Q26: Explicit human support request escalated to WhatsApp.');

      // Q27: Dispute / Damaged Item Complaint (Priority Escalation)
      const q27 = await askChat('I received a broken and damaged coffee maker! I want to file a formal complaint');
      assert(q27.escalated === true, 'Q27: Must escalate dispute');
      assert(q27.reply.includes('WhatsApp') || q27.reply.includes('transferring'), 'Q27: Must transfer to human team');
      console.log('✅ Q27: Complex customer complaint escalated to human team.');

      // Q28: Anti-Hallucination on Unknown Questions
      const q28 = await askChat('Do you sell international flights or airline tickets to London?');
      assert(q28.reply.includes('cannot confirm') || q28.reply.includes('verified store records'), 'Q28: Must refuse unknown topic');
      assert(!q28.reply.includes('airline ticket') && !q28.reply.includes('booking confirmed'), 'Q28: Must never hallucinate');
      console.log('✅ Q28: Anti-hallucination guardrail triggered on unknown inquiry.');

      // Q29: Greeting & Pleasantries
      const q29 = await askChat('Hello, good morning!');
      assert(q29.reply.includes('Abihacart') || q29.reply.includes('Hello'), 'Q29: Polite greeting');
      console.log('✅ Q29: Professional greeting delivered.');

      // Q30: Language Handling (English-Only Compliance)
      const q30 = await askChat('مرحبا هل يمكنني التحدث باللغة العربية؟');
      assert(q30.reply.includes('English only'), 'Q30: Must state customer support is English only');
      console.log('✅ Q30: English-only support policy enforced gracefully.');

      console.log('\n======================================================================');
      console.log('🎉 ALL 30 PHASE 5 CUSTOMER SUPPORT QUESTIONS PASSED (100%)');
      console.log('======================================================================\n');

      server.close(() => process.exit(0));
    } catch (err) {
      console.error('\n❌ Phase 5 Test Failure:', err.message);
      if (server) server.close();
      process.exit(1);
    }
  });
};

runPhase5Tests();
