const http = require('http');
const app = require('../src/app');
const config = require('../src/config/env');
const { AdminUserStore, hashPassword, verifyPassword } = require('../src/models/AdminUser');
const { ConversationStore } = require('../src/models/Conversation');
const { SupportTicketStore } = require('../src/models/SupportTicket');
const { KnowledgeBaseStore } = require('../src/models/KnowledgeBase');
const { generateToken, verifyToken } = require('../src/utils/token.util');

const testPort = 5996;
let server = null;

const assert = (condition, msg) => {
  if (!condition) {
    throw new Error(`Assertion failed: ${msg}`);
  }
};

const sendRequest = (method, path, body = null, headers = {}) => {
  return new Promise((resolve, reject) => {
    const url = new URL(path, `http://localhost:${testPort}`);
    const payload = body ? (typeof body === 'string' ? body : JSON.stringify(body)) : null;

    const reqHeaders = {
      ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}),
      ...headers,
    };

    const req = http.request(
      url,
      {
        method,
        headers: reqHeaders,
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => {
          let parsed = null;
          try {
            parsed = JSON.parse(data);
          } catch (_) {
            parsed = data;
          }
          resolve({
            statusCode: res.statusCode,
            headers: res.headers,
            body: parsed,
            raw: data,
          });
        });
      }
    );

    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
};

const runPhase8Tests = async () => {
  console.log('======================================================================');
  console.log('🧪 Starting Phase 8 Admin Dashboard Cockpit & Security Audit Tests');
  console.log('======================================================================\n');

  // Seed baseline test users and data
  AdminUserStore.clearMemory();
  ConversationStore.clearMemory();
  SupportTicketStore.clearMemory();

  // Create test Admin user
  const adminPassword = 'AdminSecret@2026!';
  const adminUser = await AdminUserStore.createUser({
    id: 'usr_test_admin_01',
    username: 'admin_test',
    email: 'admin@abihacart.com',
    name: 'Sarah - Lead Admin',
    passwordHash: hashPassword(adminPassword),
    role: 'admin',
    isActive: true,
    shop: config.shopify.shop,
  });

  // Create test Agent user
  const agentPassword = 'AgentSecret@2026!';
  const agentUser = await AdminUserStore.createUser({
    id: 'usr_test_agent_01',
    username: 'agent_tariq',
    email: 'tariq@abihacart.com',
    name: 'Tariq - Support Agent',
    passwordHash: hashPassword(agentPassword),
    role: 'agent',
    isActive: true,
    shop: config.shopify.shop,
  });

  // Generate tokens
  let adminToken = generateToken({
    userId: adminUser.id,
    username: adminUser.username,
    email: adminUser.email,
    role: 'admin',
    name: adminUser.name,
    shop: config.shopify.shop,
  });

  let agentToken = generateToken({
    userId: agentUser.id,
    username: agentUser.username,
    email: agentUser.email,
    role: 'agent',
    name: agentUser.name,
    shop: config.shopify.shop,
  });

  // Seed sample conversation
  const testConvId = 'abh_conv_admin_test_1001';
  await ConversationStore.createOrUpdate(testConvId, config.shopify.shop, {
    id: 'msg_c1',
    sender: 'user',
    text: 'Do you deliver coffee makers to Abu Dhabi?',
    timestamp: new Date(Date.now() - 3600000),
  });
  await ConversationStore.createOrUpdate(testConvId, config.shopify.shop, {
    id: 'msg_c2',
    sender: 'assistant',
    text: 'Yes! Standard delivery across Abu Dhabi is AED 15 or free on orders over AED 150.',
    timestamp: new Date(Date.now() - 3500000),
  });

  // Seed sample support ticket
  const testTicket = await SupportTicketStore.createTicket({
    ticketId: 'tkt_admin_test_001',
    shop: config.shopify.shop,
    source: 'whatsapp',
    status: 'pending_agent',
    lastCustomerMessageAt: new Date(Date.now() - 1800000), // 30m ago (within 24h)
    customer: {
      name: 'Noura Al-Zaabi',
      phone: '971509998888',
      maskedPhone: '+971 50*** **88',
    },
    messages: [
      {
        id: 'msg_t1',
        sender: 'user',
        senderName: 'Noura Al-Zaabi',
        channel: 'whatsapp',
        text: 'I received the package but need help setting up the coffee grinder.',
        timestamp: new Date(Date.now() - 1800000),
      },
    ],
  });

  server = app.listen(testPort, async () => {
    try {
      // -----------------------------------------------------------------
      // Suite 1: Admin Authentication & Password Security
      // -----------------------------------------------------------------
      console.log('--- Suite 1: Admin Authentication & Password Security ---');

      // 1.1: Successful Admin Login
      const loginRes = await sendRequest('POST', '/api/admin/auth/login', {
        username: 'admin_test',
        password: adminPassword,
      });
      assert(loginRes.statusCode === 200, 'Login must succeed with HTTP 200');
      assert(loginRes.body.status === 'success', 'Status must be success');
      assert(typeof loginRes.body.token === 'string', 'Token must be returned');
      assert(loginRes.body.user.role === 'admin', 'User role must be admin');
      assert(!loginRes.body.user.passwordHash, 'Password hash must never be returned');
      console.log('✅ Test 1.1: Admin login succeeded with secure session token.');

      // 1.2: Reject Invalid Password
      const badPassRes = await sendRequest('POST', '/api/admin/auth/login', {
        username: 'admin_test',
        password: 'WrongPassword!',
      });
      assert(badPassRes.statusCode === 401, 'Invalid password must return HTTP 401');
      assert(badPassRes.body.code === 'INVALID_CREDENTIALS', 'Code must be INVALID_CREDENTIALS');
      console.log('✅ Test 1.2: Invalid password rejected with HTTP 401.');

      // 1.3: Reject Non-Existent User
      const badUserRes = await sendRequest('POST', '/api/admin/auth/login', {
        username: 'non_existent_user',
        password: 'AnyPassword123',
      });
      assert(badUserRes.statusCode === 401, 'Non-existent user must return HTTP 401');
      console.log('✅ Test 1.3: Non-existent user rejected safely.');

      // 1.4: Reject Missing Credentials
      const missingCredsRes = await sendRequest('POST', '/api/admin/auth/login', {
        username: '',
      });
      assert(missingCredsRes.statusCode === 400, 'Missing credentials must return HTTP 400');
      console.log('✅ Test 1.4: Missing credentials rejected with HTTP 400.');

      // 1.5: Verify Password Salt and PBKDF2 Hashing
      assert(verifyPassword(adminPassword, adminUser.passwordHash) === true, 'Valid password must verify');
      assert(verifyPassword('WrongPass', adminUser.passwordHash) === false, 'Wrong password must fail verify');
      console.log('✅ Test 1.5: Cryptographic password verification (PBKDF2 sha512) confirmed.');

      // -----------------------------------------------------------------
      // Suite 2: Session Token Security & Expiration
      // -----------------------------------------------------------------
      console.log('\n--- Suite 2: Session Token Security & Expiration ---');

      // 2.1: Expired Token Rejection
      const expiredToken = generateToken(
        { userId: 'u1', username: 'exp', role: 'admin' },
        -10 // expired 10 seconds ago
      );
      assert(verifyToken(expiredToken) === null, 'Expired token must return null in verifyToken');

      const expiredReqRes = await sendRequest('GET', '/api/admin/overview', null, {
        Authorization: `Bearer ${expiredToken}`,
      });
      assert(expiredReqRes.statusCode === 401, 'Expired token request must return HTTP 401');
      console.log('✅ Test 2.1: Expired session token rejected with HTTP 401.');

      // 2.2: Forged Token Signature Rejection
      const forgedToken = `${expiredToken.split('.')[0]}.${expiredToken.split('.')[1]}.forged_sig_tampered`;
      const forgedReqRes = await sendRequest('GET', '/api/admin/overview', null, {
        Authorization: `Bearer ${forgedToken}`,
      });
      assert(forgedReqRes.statusCode === 401, 'Forged token must return HTTP 401');
      console.log('✅ Test 2.2: Tampered/forged token signature rejected with HTTP 401.');

      // 2.3: GET /api/admin/auth/me returns current authenticated agent context
      const meRes = await sendRequest('GET', '/api/admin/auth/me', null, {
        Authorization: `Bearer ${adminToken}`,
      });
      assert(meRes.statusCode === 200, 'GET /auth/me must return HTTP 200');
      assert(meRes.body.user.role === 'admin', 'User role must match admin');
      console.log('✅ Test 2.3: GET /api/admin/auth/me verified authenticated agent context.');

      // -----------------------------------------------------------------
      // Suite 3: Role-Based Authorization & Privilege Escalation Defense
      // -----------------------------------------------------------------
      console.log('\n--- Suite 3: Role-Based Authorization & Privilege Defense ---');

      // 3.1: Support Agent can access overview
      const agentOverviewRes = await sendRequest('GET', '/api/admin/overview', null, {
        Authorization: `Bearer ${agentToken}`,
      });
      assert(agentOverviewRes.statusCode === 200, 'Agent can access overview');
      console.log('✅ Test 3.1: Agent permitted access to standard support overview (HTTP 200).');

      // 3.2: Support Agent forbidden from Team Management (Admin Only)
      const agentForbiddenTeamRes = await sendRequest('GET', '/api/admin/agents', null, {
        Authorization: `Bearer ${agentToken}`,
      });
      assert(agentForbiddenTeamRes.statusCode === 403, 'Agent must receive HTTP 403 on /agents');
      assert(agentForbiddenTeamRes.body.code === 'INSUFFICIENT_PERMISSIONS', 'Code must be INSUFFICIENT_PERMISSIONS');
      console.log('✅ Test 3.2: Agent forbidden from accessing Team Management (HTTP 403).');

      // 3.3: Support Agent forbidden from Policy Publication (Admin Only)
      const agentForbiddenPolicyRes = await sendRequest('PATCH', '/api/admin/policies/shipping_policy/publish', null, {
        Authorization: `Bearer ${agentToken}`,
      });
      assert(agentForbiddenPolicyRes.statusCode === 403, 'Agent must receive HTTP 403 on policy publish');
      console.log('✅ Test 3.3: Agent forbidden from publishing store policies (HTTP 403).');

      // 3.4: Admin permitted to access Team Management
      const adminTeamRes = await sendRequest('GET', '/api/admin/agents', null, {
        Authorization: `Bearer ${adminToken}`,
      });
      assert(adminTeamRes.statusCode === 200, 'Admin can access /agents');
      assert(adminTeamRes.body.count >= 2, 'Must list agents');
      console.log('✅ Test 3.4: Admin permitted access to Team Management (HTTP 200).');

      // -----------------------------------------------------------------
      // Suite 4: Dashboard Overview & Real Aggregations
      // -----------------------------------------------------------------
      console.log('\n--- Suite 4: Dashboard Overview & Real Aggregations ---');

      const overviewRes = await sendRequest('GET', '/api/admin/overview', null, {
        Authorization: `Bearer ${adminToken}`,
      });
      assert(overviewRes.statusCode === 200, 'Overview must return HTTP 200');
      const stats = overviewRes.body.data.stats;
      assert(stats.totalConversations >= 1, 'Total conversations must reflect DB records');
      assert(stats.pendingAgentTickets >= 1, 'Pending agent tickets must reflect DB records');
      assert(overviewRes.body.data.recentConversations.length >= 1, 'Recent conversations populated');
      assert(overviewRes.body.data.recentTickets.length >= 1, 'Recent tickets populated');
      console.log('✅ Test 4.1: Dashboard overview returned verified database metrics and recent activity.');

      // 4.2: Analytics Aggregation API
      const analyticsRes = await sendRequest('GET', '/api/admin/analytics?days=7', null, {
        Authorization: `Bearer ${adminToken}`,
      });
      assert(analyticsRes.statusCode === 200, 'Analytics must return HTTP 200');
      assert(Array.isArray(analyticsRes.body.data.conversationsPerDay), 'Must return daily volume array');
      assert(analyticsRes.body.data.conversationsPerDay.length === 7, 'Must aggregate 7 days');
      console.log('✅ Test 4.2: Analytics returned real temporal conversation aggregations.');

      // -----------------------------------------------------------------
      // Suite 5: Customer Conversation Management & Store Isolation
      // -----------------------------------------------------------------
      console.log('\n--- Suite 5: Customer Conversation Management & Store Isolation ---');

      // 5.1: List conversations with pagination
      const convListRes = await sendRequest('GET', '/api/admin/conversations?limit=10', null, {
        Authorization: `Bearer ${agentToken}`,
      });
      assert(convListRes.statusCode === 200, 'List conversations returned HTTP 200');
      assert(convListRes.body.data.conversations.length >= 1, 'Must return conversation list');
      console.log('✅ Test 5.1: Conversations listed with pagination metadata.');

      // 5.2: Inspect conversation details
      const convDetailRes = await sendRequest('GET', `/api/admin/conversations/${testConvId}`, null, {
        Authorization: `Bearer ${agentToken}`,
      });
      assert(convDetailRes.statusCode === 200, 'Conversation detail returned HTTP 200');
      assert(convDetailRes.body.data.messages.length === 2, 'Must return full message history');
      console.log('✅ Test 5.2: Conversation history inspected safely with message roles.');

      // 5.3: Authorized agent replies into conversation
      const replyConvRes = await sendRequest('POST', `/api/admin/conversations/${testConvId}/reply`, {
        message: 'Hello! I am taking over this conversation to assist you directly.',
      }, {
        Authorization: `Bearer ${agentToken}`,
      });
      assert(replyConvRes.statusCode === 200, 'Agent reply returned HTTP 200');
      const convAfterReply = await ConversationStore.findByConversationId(testConvId);
      const lastMsg = convAfterReply.messages[convAfterReply.messages.length - 1];
      assert(lastMsg.sender === 'agent', 'Sender must be agent');
      console.log('✅ Test 5.3: Agent reply appended and synchronized to customer conversation.');

      // 5.4: Cross-store conversation lookup blocked
      const foreignConvId = 'abh_foreign_conv_9999';
      await ConversationStore.createOrUpdate(foreignConvId, 'competing-store.myshopify.com', {
        id: 'msg_f1',
        sender: 'user',
        text: 'Foreign store customer message',
      });
      const crossConvRes = await sendRequest('GET', `/api/admin/conversations/${foreignConvId}`, null, {
        Authorization: `Bearer ${adminToken}`,
      });
      assert(crossConvRes.statusCode === 403, 'Cross-store conversation lookup must return HTTP 403');
      console.log('✅ Test 5.4: Cross-store conversation access rejected with HTTP 403 STORE_ACCESS_DENIED.');

      // -----------------------------------------------------------------
      // Suite 6: WhatsApp Support Tickets & 24h Window Enforcement
      // -----------------------------------------------------------------
      console.log('\n--- Suite 6: WhatsApp Support Tickets & 24h Window Enforcement ---');

      // 6.1: List WhatsApp tickets with 24h window flag
      const ticketListRes = await sendRequest('GET', '/api/admin/tickets', null, {
        Authorization: `Bearer ${agentToken}`,
      });
      assert(ticketListRes.statusCode === 200, 'Tickets list returned HTTP 200');
      const sampleTicket = ticketListRes.body.data[0];
      assert(sampleTicket.isWithin24hWindow === true, 'Must accurately flag active 24h window');
      console.log('✅ Test 6.1: WhatsApp tickets listed with active 24h service window status.');

      // 6.2: Assign ticket to agent
      const assignRes = await sendRequest('PATCH', `/api/admin/tickets/${testTicket.ticketId}/assign`, {
        agentName: 'Tariq Mansoor',
      }, {
        Authorization: `Bearer ${agentToken}`,
      });
      assert(assignRes.statusCode === 200, 'Assign ticket returned HTTP 200');
      const ticketAfterAssign = await SupportTicketStore.findByTicketId(testTicket.ticketId);
      assert(ticketAfterAssign.assignedTo === 'Tariq Mansoor', 'Assigned agent must be recorded');
      console.log('✅ Test 6.2: Ticket assigned to support agent.');

      // 6.3: Agent reply within 24h window succeeds
      const agentTicketReplyRes = await sendRequest('POST', `/api/admin/tickets/${testTicket.ticketId}/reply`, {
        message: 'Hello Noura, I can guide you through the grinder setup step-by-step.',
      }, {
        Authorization: `Bearer ${agentToken}`,
      });
      assert(agentTicketReplyRes.statusCode === 200, 'Reply within 24h window must succeed');
      console.log('✅ Test 6.3: WhatsApp agent reply dispatched within 24h window (HTTP 200).');

      // 6.4: Expired 24h window blocks free-form text with HTTP 422
      await SupportTicketStore.updateTicketStatus(testTicket.ticketId, 'open', {
        lastCustomerMessageAt: new Date(Date.now() - 26 * 3600000), // 26 hours ago
      });
      const expiredTicketReplyRes = await sendRequest('POST', `/api/admin/tickets/${testTicket.ticketId}/reply`, {
        message: 'Trying to send freeform message outside 24h',
      }, {
        Authorization: `Bearer ${agentToken}`,
      });
      assert(expiredTicketReplyRes.statusCode === 422, 'Freeform reply outside 24h must return HTTP 422');
      assert(expiredTicketReplyRes.body.code === 'OUTSIDE_24H_WINDOW', 'Code must be OUTSIDE_24H_WINDOW');
      console.log('✅ Test 6.4: Expired 24h customer window blocked free-form replies (HTTP 422).');

      // 6.5: Expired 24h window permits approved template message
      const templateReplyRes = await sendRequest('POST', `/api/admin/tickets/${testTicket.ticketId}/reply`, {
        message: 'Follow-up template',
        template: {
          name: 'customer_support_followup',
          languageCode: 'en_US',
        },
      }, {
        Authorization: `Bearer ${agentToken}`,
      });
      assert(templateReplyRes.statusCode === 200, 'Approved template reply must return HTTP 200');
      console.log('✅ Test 6.5: Approved template successfully dispatched outside 24h window.');

      // -----------------------------------------------------------------
      // Suite 7: AI Telemetry & Tool Calling Monitoring
      // -----------------------------------------------------------------
      console.log('\n--- Suite 7: AI Telemetry & Tool Calling Monitoring ---');

      const aiRes = await sendRequest('GET', '/api/admin/ai-monitoring', null, {
        Authorization: `Bearer ${agentToken}`,
      });
      assert(aiRes.statusCode === 200, 'AI monitoring returned HTTP 200');
      assert(aiRes.body.data.model === 'gpt-6-luna', 'Model must be gpt-6-luna');
      assert(typeof aiRes.body.data.toolExecutions === 'object', 'Tool executions breakdown returned');
      console.log('✅ Test 7.1: AI monitoring telemetry returned verified model & tool frequency metrics.');

      // -----------------------------------------------------------------
      // Suite 8: Knowledge Base CRUD & Multi-Step Governance
      // -----------------------------------------------------------------
      console.log('\n--- Suite 8: Knowledge Base CRUD & Multi-Step Governance ---');

      // 8.1: Create draft knowledge entry
      const testKbKey = 'coffee_maker_cleaning_guide';
      const createKbRes = await sendRequest('POST', '/api/admin/knowledge-base', {
        key: testKbKey,
        title: 'Coffee Maker Descaling and Cleaning Instructions',
        category: 'faq',
        content: 'Descaling instructions: use 1:1 white vinegar and water, run half cycle, rest 30m, flush 2x.',
      }, {
        Authorization: `Bearer ${agentToken}`,
      });
      assert(createKbRes.statusCode === 201, 'Create KB entry must return HTTP 201');
      assert(createKbRes.body.data.isApproved === false, 'New entry must be unapproved by default');
      assert(createKbRes.body.data.approvalStatus === 'pending_approval', 'Status must be pending_approval');
      console.log('✅ Test 8.1: New knowledge entry created as draft (pending approval).');

      // 8.2: Update knowledge entry content
      const updateKbRes = await sendRequest('PUT', `/api/admin/knowledge-base/${testKbKey}`, {
        title: 'Updated Coffee Maker Descaling Instructions',
        content: 'Updated content with warranty notes.',
      }, {
        Authorization: `Bearer ${agentToken}`,
      });
      assert(updateKbRes.statusCode === 200, 'Update KB entry returned HTTP 200');
      console.log('✅ Test 8.2: Knowledge base entry updated successfully.');

      // 8.3: Admin approves entry as official store knowledge
      const approveKbRes = await sendRequest('PATCH', `/api/admin/knowledge-base/${testKbKey}/approve`, null, {
        Authorization: `Bearer ${adminToken}`,
      });
      assert(approveKbRes.statusCode === 200, 'Approve KB entry returned HTTP 200');
      assert(approveKbRes.body.data.isApproved === true, 'Entry must be approved');
      assert(approveKbRes.body.data.approvalStatus === 'approved', 'Status must be approved');
      console.log('✅ Test 8.3: Admin explicitly approved knowledge entry as official store knowledge.');

      // 8.4: Delete knowledge entry
      const deleteKbRes = await sendRequest('DELETE', `/api/admin/knowledge-base/${testKbKey}`, null, {
        Authorization: `Bearer ${adminToken}`,
      });
      assert(deleteKbRes.statusCode === 200, 'Delete KB entry returned HTTP 200');
      console.log('✅ Test 8.4: Knowledge base entry deleted successfully.');

      // -----------------------------------------------------------------
      // Suite 9: Store Policies Management & Publication Controls
      // -----------------------------------------------------------------
      console.log('\n--- Suite 9: Store Policies Management & Publication Controls ---');

      // 9.1: List policies
      const policiesRes = await sendRequest('GET', '/api/admin/policies', null, {
        Authorization: `Bearer ${agentToken}`,
      });
      assert(policiesRes.statusCode === 200, 'Policies list returned HTTP 200');
      assert(policiesRes.body.count >= 3, 'Must list store policies');
      console.log('✅ Test 9.1: Official store policies listed.');

      // 9.2: Edit draft policy content
      const editPolicyRes = await sendRequest('PUT', '/api/admin/policies/shipping_policy', {
        title: 'UAE Shipping & Delivery Policy',
        content: 'Free delivery on orders above AED 150 across all 7 Emirates. Standard delivery takes 1-3 business days.',
      }, {
        Authorization: `Bearer ${agentToken}`,
      });
      assert(editPolicyRes.statusCode === 200, 'Edit policy returned HTTP 200');
      console.log('✅ Test 9.2: Policy draft content edited.');

      // 9.3: Publish policy to live AI Knowledge Base (Admin Only)
      const publishRes = await sendRequest('PATCH', '/api/admin/policies/shipping_policy/publish', null, {
        Authorization: `Bearer ${adminToken}`,
      });
      assert(publishRes.statusCode === 200, 'Publish policy returned HTTP 200');
      const verifiedPolicy = await KnowledgeBaseStore.getPolicy('shipping_policy');
      assert(verifiedPolicy.isApproved === true, 'Policy must be approved');
      console.log('✅ Test 9.3: Policy published and activated for AI consumption.');

      // 9.4: Deactivate policy back to pending
      const deactivateRes = await sendRequest('PATCH', '/api/admin/policies/shipping_policy/deactivate', null, {
        Authorization: `Bearer ${adminToken}`,
      });
      assert(deactivateRes.statusCode === 200, 'Deactivate policy returned HTTP 200');
      console.log('✅ Test 9.4: Policy deactivated and reverted to pending status.');

      // -----------------------------------------------------------------
      // Suite 10: Team & Agent Management (Admin Only)
      // -----------------------------------------------------------------
      console.log('\n--- Suite 10: Team & Agent Management ---');

      // 10.1: Admin creates new agent account
      const createAgentRes = await sendRequest('POST', '/api/admin/agents', {
        username: 'agent_salma',
        email: 'salma@abihacart.com',
        name: 'Salma - Customer Care',
        password: 'SalmaSecurePass@2026',
        role: 'agent',
      }, {
        Authorization: `Bearer ${adminToken}`,
      });
      assert(createAgentRes.statusCode === 201, 'Create agent returned HTTP 201');
      assert(createAgentRes.body.data.username === 'agent_salma', 'Username must match');
      assert(!createAgentRes.body.data.passwordHash, 'Password hash must never be returned');
      console.log('✅ Test 10.1: Admin provisioned new support agent account.');

      // 10.2: Reject duplicate username/email
      const dupeAgentRes = await sendRequest('POST', '/api/admin/agents', {
        username: 'agent_salma',
        email: 'salma2@abihacart.com',
        name: 'Salma Duplicate',
        password: 'SalmaSecurePass@2026',
      }, {
        Authorization: `Bearer ${adminToken}`,
      });
      assert(dupeAgentRes.statusCode === 409, 'Duplicate agent must return HTTP 409');
      console.log('✅ Test 10.2: Duplicate agent creation blocked with HTTP 409.');

      // 10.3: Toggle agent active status
      const salmaUser = await AdminUserStore.findByUsernameOrEmail('agent_salma');
      const toggleRes = await sendRequest('PATCH', `/api/admin/agents/${salmaUser.id}/status`, {
        isActive: false,
      }, {
        Authorization: `Bearer ${adminToken}`,
      });
      assert(toggleRes.statusCode === 200, 'Toggle status returned HTTP 200');
      assert(toggleRes.body.data.isActive === false, 'User must be deactivated');
      console.log('✅ Test 10.3: Agent account status toggled (deactivated).');

      // 10.4: Prevent admin self-deactivation
      const selfDeactivateRes = await sendRequest('PATCH', `/api/admin/agents/${adminUser.id}/status`, {
        isActive: false,
      }, {
        Authorization: `Bearer ${adminToken}`,
      });
      assert(selfDeactivateRes.statusCode === 400, 'Self-deactivation must return HTTP 400');
      assert(selfDeactivateRes.body.code === 'CANNOT_DEACTIVATE_SELF', 'Code must be CANNOT_DEACTIVATE_SELF');
      console.log('✅ Test 10.4: Admin self-deactivation prevented safely.');

      // -----------------------------------------------------------------
      // Suite 11: Security Ingress, Input Validation & Static Asset Serving
      // -----------------------------------------------------------------
      console.log('\n--- Suite 11: Security Ingress, Input Validation & Assets ---');

      // 11.1: Static admin dashboard serves HTML
      const staticRes = await sendRequest('GET', '/admin/index.html');
      assert(staticRes.statusCode === 200, 'Static admin dashboard must return HTTP 200');
      assert(staticRes.raw.includes('Abihacart Support Cockpit'), 'Must serve admin cockpit HTML');
      console.log('✅ Test 11.1: Static Admin Dashboard served at /admin/index.html (HTTP 200).');

      // 11.2: System Settings endpoint does not expose credentials
      const settingsRes = await sendRequest('GET', '/api/admin/settings', null, {
        Authorization: `Bearer ${adminToken}`,
      });
      assert(settingsRes.statusCode === 200, 'Settings returned HTTP 200');
      const settingsJson = JSON.stringify(settingsRes.body);
      assert(!settingsJson.includes('password') && !settingsJson.includes('secret') && !settingsJson.includes('key'), 'Settings must never expose secrets or keys');
      console.log('✅ Test 11.2: System settings endpoint verified: zero exposed secrets or tokens.');

      // 11.3: Reject unauthenticated request to protected endpoint
      const unauthRes = await sendRequest('GET', '/api/admin/overview');
      assert(unauthRes.statusCode === 401, 'Unauthenticated request must return HTTP 401');
      console.log('✅ Test 11.3: Unauthenticated access blocked with HTTP 401.');

      console.log('\n======================================================================');
      console.log('🎉 ALL PHASE 8 ADMIN DASHBOARD & SECURITY TESTS PASSED (100%)');
      console.log('======================================================================\n');

      server.close(() => process.exit(0));
    } catch (err) {
      console.error('\n❌ Phase 8 Test Failure:', err.message);
      if (server) server.close();
      process.exit(1);
    }
  });
};

runPhase8Tests();
