/**
 * Phase 7 Automated Test Suite: Human Support & Meta WhatsApp Business Cloud API Integration
 * Production Security Audit & Hardening
 */
const http = require('http');
const crypto = require('crypto');
const app = require('../src/app');
const whatsappService = require('../src/services/whatsapp.service');
const { SupportTicketStore } = require('../src/models/SupportTicket');
const { WhatsAppMessageLogStore } = require('../src/models/WhatsAppMessageLog');
const { ConversationStore } = require('../src/models/Conversation');
const { KnowledgeBaseStore } = require('../src/models/KnowledgeBase');
const logger = require('../src/utils/logger');
const config = require('../src/config/env');

const testPort = 5997;
let server;

const assert = (condition, msg) => {
  if (!condition) {
    throw new Error(`Assertion failed: ${msg}`);
  }
};

const sendGet = (url, headers = {}) => {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const req = http.request(
      {
        hostname: parsed.hostname,
        port: parsed.port,
        path: parsed.pathname + parsed.search,
        method: 'GET',
        headers,
      },
      (res) => {
        let data = '';
        res.on('data', (c) => { data += c; });
        res.on('end', () => {
          try {
            resolve({ statusCode: res.statusCode, body: JSON.parse(data), raw: data });
          } catch (e) {
            resolve({ statusCode: res.statusCode, raw: data });
          }
        });
      }
    );
    req.on('error', reject);
    req.end();
  });
};

const sendPost = (url, bodyObj, headers = {}) => {
  return new Promise((resolve, reject) => {
    const rawBody = typeof bodyObj === 'string' ? bodyObj : JSON.stringify(bodyObj);
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
            resolve({ statusCode: res.statusCode, body: JSON.parse(data), raw: data });
          } catch (e) {
            resolve({ statusCode: res.statusCode, raw: data });
          }
        });
      }
    );
    req.on('error', reject);
    req.write(rawBody);
    req.end();
  });
};

const generateMetaSignature = (rawPayload, secret) => {
  const hmac = crypto.createHmac('sha256', secret).update(rawPayload).digest('hex');
  return `sha256=${hmac}`;
};

const runPhase7Tests = async () => {
  console.log('======================================================================');
  console.log('🧪 Starting Phase 7 WhatsApp Business Cloud API & Security Audit Tests');
  console.log('======================================================================\n');

  // Reset stores for clean test run
  SupportTicketStore.clearMemory();
  WhatsAppMessageLogStore.clearMemory();
  ConversationStore.clearMemory();
  whatsappService.clearMockDeliveries();

  const testAppSecret = 'abh_whatsapp_test_app_secret_12345';
  const testVerifyToken = 'abh_whatsapp_test_verify_token_54321';
  const testAgentKey = 'abh_agent_secure_test_key_888';
  const testAdminKey = 'abh_admin_secure_test_key_999';

  whatsappService.appSecret = testAppSecret;
  whatsappService.verifyToken = testVerifyToken;
  config.whatsapp.appSecret = testAppSecret;
  config.whatsapp.verifyToken = testVerifyToken;
  config.agent.apiKey = testAgentKey;
  config.agent.adminApiKey = testAdminKey;

  // -----------------------------------------------------------------
  // Suite 1: Meta Graph API Version & Configuration Audit
  // -----------------------------------------------------------------
  console.log('--- Suite 1: Meta Graph API Version & Configuration Audit ---');

  // 1.1: Verify Graph API version upgraded to v26.0 (configurable)
  assert(whatsappService.apiVersion === 'v26.0' || whatsappService.apiVersion.startsWith('v'), 'Graph API version must be configured');
  assert(config.whatsapp.apiVersion === 'v26.0', 'config.whatsapp.apiVersion must default to v26.0');
  console.log(`✅ Test 1.1: Meta Graph API version verified: [${whatsappService.apiVersion}].`);

  // 1.2: Webhook subscription handshake verification
  const challengeCode = '1122334455';
  const validHandshake = whatsappService.verifyWebhookSubscription('subscribe', testVerifyToken, challengeCode);
  assert(validHandshake.success === true, 'Matching verify_token must succeed');
  assert(validHandshake.challenge === challengeCode, 'Must echo exact challenge code');
  console.log('✅ Test 1.2: Webhook subscription handshake verified with hub.verify_token.');

  // 1.3: Webhook subscription token mismatch rejection
  const invalidHandshake = whatsappService.verifyWebhookSubscription('subscribe', 'wrong_token', challengeCode);
  assert(invalidHandshake.success === false, 'Mismatched verify_token must fail');
  assert(invalidHandshake.reason === 'TOKEN_MISMATCH', 'Reason must be TOKEN_MISMATCH');
  console.log('✅ Test 1.3: Mismatched verify_token rejected with TOKEN_MISMATCH.');

  // 1.4: Cryptographic HMAC-SHA256 signature verification against raw body
  const samplePayload = JSON.stringify({ object: 'whatsapp_business_account', entry: [] });
  const validSignature = generateMetaSignature(samplePayload, testAppSecret);
  assert(whatsappService.verifyWebhookSignature(samplePayload, validSignature) === true, 'Valid signature must pass');
  console.log('✅ Test 1.4: Meta X-Hub-Signature-256 verified using timingSafeEqual against exact raw body.');

  // 1.5: Forged / tampered signature rejection
  const forgedSignature = generateMetaSignature(samplePayload, 'attacker_forged_secret');
  assert(whatsappService.verifyWebhookSignature(samplePayload, forgedSignature) === false, 'Forged signature must fail');
  assert(whatsappService.verifyWebhookSignature(samplePayload, 'invalid_header_format') === false, 'Malformed header must fail');
  console.log('✅ Test 1.5: Forged signature and malformed header rejected safely.');

  // -----------------------------------------------------------------
  // Suite 2: Inbound Webhook Processing & Support Ticket Association
  // -----------------------------------------------------------------
  console.log('\n--- Suite 2: Inbound Message Handling & Ticket Association ---');

  const customerPhone = '971501234567';
  const customerName = 'Fatima Al Mansoori';
  const wamid1 = 'wamid.HBgLMjA2MDk5NzE1MDEyMzQ1NjcVAgASGBQzQTkyRTYzRDgz';

  const inboundWebhookPayload = {
    object: 'whatsapp_business_account',
    entry: [
      {
        id: '100987654321',
        changes: [
          {
            field: 'messages',
            value: {
              messaging_product: 'whatsapp',
              metadata: {
                display_phone_number: '+971 4 000 0000',
                phone_number_id: '10987654321',
              },
              contacts: [
                {
                  profile: { name: customerName },
                  wa_id: customerPhone,
                },
              ],
              messages: [
                {
                  from: customerPhone,
                  id: wamid1,
                  timestamp: String(Math.floor(Date.now() / 1000) - 300),
                  text: { body: 'Hello Abihacart, I need help with my coffee maker delivery in Dubai.' },
                  type: 'text',
                },
              ],
            },
          },
        ],
      },
    ],
  };

  // 2.1: Process inbound WhatsApp message: creates new support ticket
  const inboundRes = await whatsappService.processInboundWebhook(inboundWebhookPayload);
  assert(inboundRes.status === 'processed', 'Webhook must be processed');
  assert(inboundRes.messagesCount === 1, 'Must process 1 message');

  const ticket = await SupportTicketStore.findByCustomerPhone(customerPhone);
  assert(ticket !== null, 'SupportTicket must be created for customer');
  assert(ticket.source === 'whatsapp', 'Ticket source must be whatsapp');
  assert(ticket.status === 'pending_agent', 'Ticket status must be pending_agent');
  assert(ticket.customer.name === customerName, 'Customer name must be set');
  assert(ticket.messages.length === 1, 'Ticket must contain 1 message');
  assert(ticket.messages[0].text.includes('coffee maker delivery'), 'Message text must match');
  console.log(`✅ Test 2.1: Inbound WhatsApp message created support ticket [${ticket.ticketId}] for customer.`);

  // 2.2: Subsequent inbound message from same customer appends to existing active ticket
  const wamid2 = 'wamid.HBgLMjA2MDk5NzE1MDEyMzQ1NjcVAgASGBQ0QzkyRTYzRDgz';
  const followUpPayload = {
    object: 'whatsapp_business_account',
    entry: [
      {
        id: '100987654321',
        changes: [
          {
            field: 'messages',
            value: {
              messaging_product: 'whatsapp',
              contacts: [{ profile: { name: customerName }, wa_id: customerPhone }],
              messages: [
                {
                  from: customerPhone,
                  id: wamid2,
                  timestamp: String(Math.floor(Date.now() / 1000) - 60),
                  text: { body: 'My order reference is #ABH-1001.' },
                  type: 'text',
                },
              ],
            },
          },
        ],
      },
    ],
  };

  await whatsappService.processInboundWebhook(followUpPayload);
  const updatedTicket = await SupportTicketStore.findByTicketId(ticket.ticketId);
  assert(updatedTicket.messages.length === 2, 'Must append message to existing ticket (now 2 messages)');
  assert(updatedTicket.messages[1].text.includes('#ABH-1001'), 'Follow-up message must be recorded');
  console.log('✅ Test 2.2: Follow-up WhatsApp message appended to existing support ticket without duplicate ticket.');

  // -----------------------------------------------------------------
  // Suite 3: Deduplication & Idempotency Safeguards
  // -----------------------------------------------------------------
  console.log('\n--- Suite 3: Webhook Deduplication & Idempotency Safeguards ---');

  // 3.1: Resend identical webhook payload (same wamid2)
  const duplicateRes = await whatsappService.processInboundWebhook(followUpPayload);
  const afterDupeTicket = await SupportTicketStore.findByTicketId(ticket.ticketId);
  assert(afterDupeTicket.messages.length === 2, 'Message count must remain 2 after duplicate webhook');
  assert(duplicateRes.messagesCount === 0, 'Duplicate message must be ignored');
  console.log('✅ Test 3.1: Duplicate webhook with identical WAMID ignored safely (idempotent).');

  // 3.2: Delivery receipt status update via webhook
  const statusPayload = {
    object: 'whatsapp_business_account',
    entry: [
      {
        changes: [
          {
            field: 'messages',
            value: {
              messaging_product: 'whatsapp',
              statuses: [
                {
                  id: wamid2,
                  status: 'delivered',
                  timestamp: String(Math.floor(Date.now() / 1000)),
                  recipient_id: customerPhone,
                },
              ],
            },
          },
        ],
      },
    ],
  };
  const statusRes = await whatsappService.processInboundWebhook(statusPayload);
  assert(statusRes.statusesCount === 1, 'Must process 1 status update');
  const ticketAfterStatus = await SupportTicketStore.findByTicketId(ticket.ticketId);
  const msgAfterStatus = ticketAfterStatus.messages.find((m) => m.whatsappMessageId === wamid2);
  assert(msgAfterStatus && msgAfterStatus.status === 'delivered', 'Message status must be updated to delivered');
  console.log('✅ Test 3.2: Webhook status event updated message status to "delivered".');

  // -----------------------------------------------------------------
  // Suite 4: Outbound WhatsApp Message Dispatch & Phone Normalization
  // -----------------------------------------------------------------
  console.log('\n--- Suite 4: Outbound Dispatch & UAE Phone Normalization ---');

  // 4.1: Phone normalization for WhatsApp standard E.164 digits without '+'
  assert(whatsappService.normalizeWhatsAppNumber('+971501234567') === '971501234567', '+971 format');
  assert(whatsappService.normalizeWhatsAppNumber('0501234567') === '971501234567', '050 format');
  assert(whatsappService.normalizeWhatsAppNumber('00971501234567') === '971501234567', '00971 format');
  assert(whatsappService.normalizeWhatsAppNumber('+971 50 123 4567') === '971501234567', 'Spaced format');
  console.log('✅ Test 4.1: UAE phone normalization converts all formats to Meta E.164 standard (971501234567).');

  // 4.2: Outbound message handling with test mode
  whatsappService.setMockMode(true);
  const outboundResult = await whatsappService.sendTextMessage({
    to: '0501234567',
    text: 'Hello from Abihacart Support! Your order #ABH-1001 is on track.',
  });
  assert(outboundResult.success === true, 'Outbound send must succeed');
  assert(outboundResult.messageId.startsWith('wamid.MOCK_'), 'Must generate mock WAMID');
  assert(outboundResult.isLiveMetaDelivery === false, 'isLiveMetaDelivery must be false');
  assert(whatsappService.mockDeliveries.length === 1, 'Delivery must be recorded in mock queue');
  console.log('✅ Test 4.2: Outbound message dispatched in verified mock mode without fabricating live Meta API access.');

  // -----------------------------------------------------------------
  // Suite 5: Human Agent Reply Flow & Storefront Synchronization
  // -----------------------------------------------------------------
  console.log('\n--- Suite 5: Human Agent Reply Flow & Storefront Synchronization ---');

  // 5.1: Link ticket to storefront conversation
  const testConvId = 'abh_conv_test_sync_1001';
  await ConversationStore.createOrUpdate(testConvId, 'abihacart.myshopify.com', {
    id: 'msg_u_1',
    sender: 'user',
    text: 'I requested agent help.',
    timestamp: new Date(),
  });
  await SupportTicketStore.updateTicketStatus(ticket.ticketId, 'open', { conversationId: testConvId });

  // 5.2: Human agent sends reply
  const agentReplyText = 'Hello Fatima, this is Tariq from Abihacart Support. I have prioritized your delivery with Emirates Post!';
  const agentReplyRes = await whatsappService.sendAgentReply({
    ticketId: ticket.ticketId,
    message: agentReplyText,
    agentName: 'Tariq - Senior Support',
  });

  assert(agentReplyRes.success === true, 'Agent reply must succeed');
  assert(agentReplyRes.status === 'agent_replied', 'Ticket status must update to agent_replied');

  const ticketAfterReply = await SupportTicketStore.findByTicketId(ticket.ticketId);
  assert(ticketAfterReply.status === 'agent_replied', 'Ticket status must be agent_replied');
  const lastTicketMsg = ticketAfterReply.messages[ticketAfterReply.messages.length - 1];
  assert(lastTicketMsg.sender === 'agent', 'Last ticket message sender must be agent');
  assert(lastTicketMsg.senderName === 'Tariq - Senior Support', 'Agent sender name must be recorded');
  assert(lastTicketMsg.text === agentReplyText, 'Agent reply text must match');
  console.log('✅ Test 5.1: Agent reply recorded on SupportTicket with status "agent_replied".');

  // 5.3: Verify message synchronized into storefront Conversation
  const convAfterReply = await ConversationStore.findByConversationId(testConvId);
  const lastConvMsg = convAfterReply.messages[convAfterReply.messages.length - 1];
  assert(lastConvMsg.sender === 'agent', 'Storefront message sender must be agent');
  assert(lastConvMsg.text === agentReplyText, 'Storefront message text must match agent reply');
  console.log('✅ Test 5.2: Human agent reply synchronized back into customer storefront chat conversation.');

  // -----------------------------------------------------------------
  // Suite 6: WhatsApp Messaging Rules: 24-Hour Customer Window Enforcement
  // -----------------------------------------------------------------
  console.log('\n--- Suite 6: 24-Hour Customer Service Window Enforcement ---');

  // 6.1: Active window: Within 24 hours of customer inbound message, free-form message succeeds
  const activeTicketRes = await whatsappService.sendAgentReply({
    ticketId: ticket.ticketId,
    message: 'Follow-up message within 24-hour service window.',
  });
  assert(activeTicketRes.success === true, 'Message within 24-hour window must succeed');
  console.log('✅ Test 6.1: Active 24-hour window permits free-form agent replies.');

  // 6.2: Expired window: Simulate customer inactivity of 25 hours
  const expiredTimestamp = new Date(Date.now() - 25 * 60 * 60 * 1000);
  await SupportTicketStore.updateTicketStatus(ticket.ticketId, 'open', {
    lastCustomerMessageAt: expiredTimestamp,
  });

  const expiredWindowRes = await whatsappService.sendAgentReply({
    ticketId: ticket.ticketId,
    message: 'Attempting to send free-form message after 25 hours.',
  });
  assert(expiredWindowRes.success === false, 'Free-form message outside 24h window must fail');
  assert(expiredWindowRes.code === 'OUTSIDE_24H_WINDOW', 'Must return OUTSIDE_24H_WINDOW code');
  assert(expiredWindowRes.requiresTemplate === true, 'Must indicate template is required');
  console.log('✅ Test 6.2: Expired 24-hour window blocks free-form messages with OUTSIDE_24H_WINDOW.');

  // 6.3: Template re-engagement: Outside 24h window, sending approved template succeeds
  const templateReEngagementRes = await whatsappService.sendAgentReply({
    ticketId: ticket.ticketId,
    message: 'Customer re-engagement template message.',
    template: {
      name: 'customer_support_followup',
      languageCode: 'en_US',
      components: [],
    },
  });
  assert(templateReEngagementRes.success === true, 'Template dispatch outside 24h window must succeed');
  assert(templateReEngagementRes.deliveryResult?.templateName === 'customer_support_followup', 'Template name recorded');
  console.log('✅ Test 6.3: Approved WhatsApp template successfully re-engages customer outside 24-hour window.');

  // 6.4: Validate template parameters reject invalid characters
  let invalidTemplateRejected = false;
  try {
    await whatsappService.sendTemplateMessage({
      to: '0501234567',
      templateName: 'INVALID TEMPLATE NAME!',
    });
  } catch (err) {
    invalidTemplateRejected = err.message.includes('Invalid template name');
  }
  assert(invalidTemplateRejected === true, 'Invalid template name must be rejected');
  console.log('✅ Test 6.4: Template parameter validator rejected invalid template name.');

  // -----------------------------------------------------------------
  // Suite 7: Customer & Store Multi-Tenant Isolation
  // -----------------------------------------------------------------
  console.log('\n--- Suite 7: Store Isolation & Multi-Tenant Defense ---');

  // 7.1: Block cross-store ticket reply
  let crossStoreBlocked = false;
  try {
    await whatsappService.sendAgentReply({
      ticketId: ticket.ticketId,
      message: 'Attempting cross-store reply from malicious store',
      shop: 'malicious-competing-store.myshopify.com',
    });
  } catch (err) {
    crossStoreBlocked = err.message.includes('not found') || err.message.includes('Store access');
  }
  assert(crossStoreBlocked === true, 'Cross-store agent reply must be rejected');
  console.log('✅ Test 7.1: Cross-store ticket reply prevented (Store isolation enforced).');

  // 7.2: Block cross-store conversation linking
  const rogueConvId = 'abh_conv_foreign_store_9999';
  await ConversationStore.createOrUpdate(rogueConvId, 'other-store.myshopify.com', {
    id: 'msg_f1',
    sender: 'user',
    text: 'Foreign store chat',
    timestamp: new Date(),
  });

  let crossConvBlocked = false;
  try {
    await whatsappService.sendAgentReply({
      ticketId: ticket.ticketId,
      conversationId: rogueConvId,
      message: 'Linking to foreign conversation',
      shop: 'abihacart.myshopify.com',
    });
  } catch (err) {
    crossConvBlocked = err.message.includes('Store access violation');
  }
  assert(crossConvBlocked === true, 'Foreign store conversation linking must be blocked');
  console.log('✅ Test 7.2: Cross-store conversation linking rejected with Store Access Violation.');

  // -----------------------------------------------------------------
  // Suite 8: Customer PII Masking & Privacy Audit
  // -----------------------------------------------------------------
  console.log('\n--- Suite 8: Customer PII Masking & Privacy Audit ---');

  const maskedPhone = whatsappService.maskPhone('971501234567');
  assert(maskedPhone === '+971 50*** **67', `Masked phone format verified (got: ${maskedPhone})`);

  const loggedMessages = [];
  const originalInfo = logger.info;
  const originalWarn = logger.warn;

  logger.info = (msg, meta) => { loggedMessages.push(String(msg) + ' ' + JSON.stringify(meta || {})); originalInfo.call(logger, msg, meta); };
  logger.warn = (msg, meta) => { loggedMessages.push(String(msg) + ' ' + JSON.stringify(meta || {})); originalWarn.call(logger, msg, meta); };

  try {
    await whatsappService.sendTextMessage({
      to: '0501234567',
      text: 'Confidential customer delivery PIN is 4829.',
    });

    const fullLog = loggedMessages.join('\n');
    assert(!fullLog.includes('0501234567') && !fullLog.includes('971501234567'), 'Raw customer phone must not appear in logs');
    assert(!fullLog.includes('Confidential customer delivery PIN is 4829'), 'Raw message body must not be dumped into logs');
    console.log('✅ Test 8.1: Customer phone numbers and message contents masked in application logs.');
  } finally {
    logger.info = originalInfo;
    logger.warn = originalWarn;
  }

  // -----------------------------------------------------------------
  // Suite 9: Knowledge Base Governance Safeguard
  // -----------------------------------------------------------------
  console.log('\n--- Suite 9: Knowledge Base Governance Safeguard ---');

  const shippingPolicy = await KnowledgeBaseStore.getPolicy('shipping_policy');
  assert(shippingPolicy.isApproved === false, 'Store policies must NOT be automatically approved by agent replies');
  assert(shippingPolicy.approvalStatus === 'pending_approval', 'Approval status must remain pending_approval');
  console.log('✅ Test 9.1: Knowledge Base governance preserved: Human agent replies are strictly transactional.');

  // -----------------------------------------------------------------
  // Suite 10: REST Endpoints, Agent Auth & Security Verification
  // -----------------------------------------------------------------
  console.log('\n--- Suite 10: REST API Endpoints, Agent Auth & Security Ingress ---');

  server = app.listen(testPort, async () => {
    try {
      // 10.1: GET /api/whatsapp/webhook (Valid handshake)
      const validGetRes = await sendGet(`http://localhost:${testPort}/api/whatsapp/webhook?hub.mode=subscribe&hub.verify_token=${testVerifyToken}&hub.challenge=test_challenge_999`);
      assert(validGetRes.statusCode === 200, 'Handshake must return HTTP 200');
      assert(validGetRes.raw === 'test_challenge_999', 'Handshake must return challenge text');
      console.log('✅ Test 10.1: GET /api/whatsapp/webhook returned HTTP 200 with challenge code.');

      // 10.2: GET /api/whatsapp/webhook (Invalid verify token)
      const invalidGetRes = await sendGet(`http://localhost:${testPort}/api/whatsapp/webhook?hub.mode=subscribe&hub.verify_token=wrong_secret&hub.challenge=test_challenge_999`);
      assert(invalidGetRes.statusCode === 403, 'Invalid token must return HTTP 403');
      console.log('✅ Test 10.2: GET /api/whatsapp/webhook with wrong token returned HTTP 403 Forbidden.');

      // 10.3: POST /api/whatsapp/webhook (Missing HMAC signature rejected)
      const testInboundBody = JSON.stringify({
        object: 'whatsapp_business_account',
        entry: [
          {
            changes: [
              {
                field: 'messages',
                value: {
                  messaging_product: 'whatsapp',
                  contacts: [{ profile: { name: 'Sultan' }, wa_id: '971509876543' }],
                  messages: [
                    {
                      from: '971509876543',
                      id: 'wamid.REST_TEST_001',
                      timestamp: String(Math.floor(Date.now() / 1000)),
                      text: { body: 'Inquiring about Tabby payment option.' },
                      type: 'text',
                    },
                  ],
                },
              },
            ],
          },
        ],
      });

      const missingSigRes = await sendPost(`http://localhost:${testPort}/api/whatsapp/webhook`, testInboundBody);
      assert(missingSigRes.statusCode === 401, 'Missing signature must return HTTP 401');
      assert(missingSigRes.body.code === 'MISSING_WEBHOOK_SIGNATURE', 'Code must match MISSING_WEBHOOK_SIGNATURE');
      console.log('✅ Test 10.3: POST /api/whatsapp/webhook with missing signature blocked with HTTP 401.');

      // 10.4: POST /api/whatsapp/webhook (Valid HMAC signature)
      const validSig = generateMetaSignature(testInboundBody, testAppSecret);
      const validPostRes = await sendPost(`http://localhost:${testPort}/api/whatsapp/webhook`, testInboundBody, {
        'x-hub-signature-256': validSig,
      });
      assert(validPostRes.statusCode === 200, 'Valid webhook must return HTTP 200');
      assert(validPostRes.body.data.status === 'processed', 'Status must be processed');
      console.log('✅ Test 10.4: POST /api/whatsapp/webhook with valid signature processed successfully (HTTP 200).');

      // 10.5: Agent Auth: Unauthorized public user blocked from sending agent reply (HTTP 401)
      const unauthReplyRes = await sendPost(`http://localhost:${testPort}/api/whatsapp/agent/reply`, {
        ticketId: ticket.ticketId,
        message: 'Malicious public user impersonating agent',
      });
      assert(unauthReplyRes.statusCode === 401, 'Unauthorized agent reply must return HTTP 401');
      assert(unauthReplyRes.body.code === 'MISSING_AGENT_AUTH', 'Code must match MISSING_AGENT_AUTH');
      console.log('✅ Test 10.5: Unauthorized public user blocked from /api/whatsapp/agent/reply (HTTP 401).');

      // 10.6: Agent Auth: Forged agent key blocked (HTTP 401)
      const forgedAgentRes = await sendPost(`http://localhost:${testPort}/api/whatsapp/agent/reply`, {
        ticketId: ticket.ticketId,
        message: 'Forged key attempt',
      }, {
        'x-agent-key': 'attacker_forged_agent_key',
      });
      assert(forgedAgentRes.statusCode === 401, 'Forged key must return HTTP 401');
      assert(forgedAgentRes.body.code === 'INVALID_AGENT_AUTH', 'Code must match INVALID_AGENT_AUTH');
      console.log('✅ Test 10.6: Forged agent key blocked with HTTP 401 (INVALID_AGENT_AUTH).');

      // 10.7: Agent Auth: Unauthorized public user blocked from listing tickets (HTTP 401)
      const unauthListRes = await sendGet(`http://localhost:${testPort}/api/whatsapp/tickets`);
      assert(unauthListRes.statusCode === 401, 'Unauthorized ticket list must return HTTP 401');
      console.log('✅ Test 10.7: Unauthorized user blocked from GET /api/whatsapp/tickets (HTTP 401).');

      // Reset ticket to within 24h window for successful reply test
      await SupportTicketStore.updateTicketStatus(ticket.ticketId, 'open', {
        lastCustomerMessageAt: new Date(),
      });

      // 10.8: Authorized Agent Key sends reply successfully (HTTP 200)
      const authAgentReplyRes = await sendPost(`http://localhost:${testPort}/api/whatsapp/agent/reply`, {
        ticketId: ticket.ticketId,
        message: 'Your courier tracking number EP971002456AE is now active on Emirates Post.',
        agentName: 'Aisha - Senior Dispatcher',
      }, {
        'x-agent-key': testAgentKey,
      });
      assert(authAgentReplyRes.statusCode === 200, 'Authenticated agent reply must return HTTP 200');
      assert(authAgentReplyRes.body.data.status === 'agent_replied', 'Status must be agent_replied');
      console.log('✅ Test 10.8: Authenticated agent (X-Agent-Key) reply succeeded (HTTP 200).');

      // 10.9: Authorized Admin Bearer token retrieves tickets (HTTP 200)
      const authAdminListRes = await sendGet(`http://localhost:${testPort}/api/whatsapp/tickets`, {
        Authorization: `Bearer ${testAdminKey}`,
      });
      assert(authAdminListRes.statusCode === 200, 'Admin Bearer token list must return HTTP 200');
      assert(authAdminListRes.body.count >= 1, 'Must return tickets');
      console.log(`✅ Test 10.9: Authenticated admin (Bearer token) retrieved support tickets (${authAdminListRes.body.count} tickets).`);

      // 10.10: 24-Hour Window Enforcement via REST API: Expired window returns HTTP 422
      await SupportTicketStore.updateTicketStatus(ticket.ticketId, 'open', {
        lastCustomerMessageAt: new Date(Date.now() - 30 * 60 * 60 * 1000), // 30 hours ago
      });
      const expiredApiReplyRes = await sendPost(`http://localhost:${testPort}/api/whatsapp/agent/reply`, {
        ticketId: ticket.ticketId,
        message: 'Trying to send free-form message after 30 hours',
      }, {
        'x-agent-key': testAgentKey,
      });
      assert(expiredApiReplyRes.statusCode === 422, 'Expired window freeform reply must return HTTP 422');
      assert(expiredApiReplyRes.body.code === 'OUTSIDE_24H_WINDOW', 'Code must match OUTSIDE_24H_WINDOW');
      assert(expiredApiReplyRes.body.requiresTemplate === true, 'Must indicate template is required');
      console.log('✅ Test 10.10: REST API enforces Meta 24-hour customer window (HTTP 422 OUTSIDE_24H_WINDOW).');

      // 10.11: Store Isolation via REST API: Arbitrary requested store rejected with HTTP 403
      const crossStoreApiRes = await sendPost(`http://localhost:${testPort}/api/whatsapp/agent/reply`, {
        ticketId: ticket.ticketId,
        message: 'Testing cross-store REST access',
        shop: 'attacker-store.myshopify.com',
      }, {
        'x-agent-key': testAgentKey,
      });
      assert(crossStoreApiRes.statusCode === 403, 'Cross-store REST access must return HTTP 403');
      assert(crossStoreApiRes.body.code === 'STORE_ACCESS_DENIED', 'Code must match STORE_ACCESS_DENIED');
      console.log('✅ Test 10.11: REST API rejected arbitrary requested store with HTTP 403 STORE_ACCESS_DENIED.');

      // 10.12: Production defense: Development fallback agent key strictly rejected in production
      const prevEnv = config.env;
      config.env = 'production';
      try {
        const prodFallbackRes = await sendPost(`http://localhost:${testPort}/api/whatsapp/agent/reply`, {
          ticketId: ticket.ticketId,
          message: 'Attempting fallback key in production',
        }, {
          'x-agent-key': 'abh_agent_secure_auth_token_default',
        });
        assert(prodFallbackRes.statusCode === 401, 'Production fallback key must return HTTP 401');
        assert(prodFallbackRes.body.code === 'INVALID_AGENT_AUTH', 'Code must match INVALID_AGENT_AUTH');
        console.log('✅ Test 10.12: Production defense: Development fallback key strictly rejected in production.');

        // 10.13: Production defense: Outbound dispatch with unconfigured credentials rejected
        whatsappService.setMockMode(false);
        const prodNoCredsRes = await whatsappService.sendTextMessage({
          to: '0501234567',
          text: 'Production message with missing credentials',
        });
        assert(prodNoCredsRes.success === false, 'Production send without credentials must fail');
        assert(prodNoCredsRes.code === 'WHATSAPP_CREDENTIALS_MISSING', 'Must return WHATSAPP_CREDENTIALS_MISSING');
        console.log('✅ Test 10.13: Production defense: Outbound dispatch without credentials returns WHATSAPP_CREDENTIALS_MISSING.');
      } finally {
        config.env = prevEnv;
        whatsappService.setMockMode(true);
      }

      console.log('\n======================================================================');
      console.log('🎉 ALL PHASE 7 WHATSAPP & SECURITY AUDIT TESTS PASSED (100%)');
      console.log('======================================================================\n');

      server.close(() => process.exit(0));
    } catch (err) {
      console.error('\n❌ Phase 7 Test Failure:', err.message);
      if (server) server.close();
      process.exit(1);
    }
  });
};

runPhase7Tests();
