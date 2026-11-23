const express = require('express');
const router = express.Router();
const adminController = require('../controllers/admin.controller');
const orderController = require('../controllers/order.controller');
const { requireAgentAuth } = require('../middleware/agentAuth');
const { adminLoginLimiter, adminApiLimiter, agentReplyLimiter } = require('../middleware/rateLimiter');

// ---------------------------------------------------------------------------
// Public Authentication Endpoints (Rate-limited against brute force)
// ---------------------------------------------------------------------------
router.post('/auth/login', adminLoginLimiter, adminController.login);

// ---------------------------------------------------------------------------
// Protected Common Endpoints (Accessible by both 'agent' and 'admin' roles)
// ---------------------------------------------------------------------------
router.use(adminApiLimiter);

router.get('/auth/me', requireAgentAuth(['agent', 'admin']), adminController.getCurrentUser);
router.post('/auth/logout', requireAgentAuth(['agent', 'admin']), adminController.logout);

// Dashboard Overview & Real Analytics
router.get('/overview', requireAgentAuth(['agent', 'admin']), adminController.getOverview);
router.get('/analytics', requireAgentAuth(['agent', 'admin']), adminController.getAnalytics);

// Customer Conversations
router.get('/conversations', requireAgentAuth(['agent', 'admin']), adminController.listConversations);
router.get('/conversations/:conversationId', requireAgentAuth(['agent', 'admin']), adminController.getConversation);
router.post('/conversations/:conversationId/reply', agentReplyLimiter, requireAgentAuth(['agent', 'admin']), adminController.replyConversation);
router.patch('/conversations/:conversationId/status', requireAgentAuth(['agent', 'admin']), adminController.updateConversationStatus);

// Customer SMS Orders Management
router.get('/sms-orders', requireAgentAuth(['agent', 'admin']), orderController.listSmsOrders);

// WhatsApp Support Tickets
router.get('/tickets', requireAgentAuth(['agent', 'admin']), adminController.listTickets);
router.get('/tickets/:ticketId', requireAgentAuth(['agent', 'admin']), adminController.getTicket);
router.post('/tickets/:ticketId/reply', agentReplyLimiter, requireAgentAuth(['agent', 'admin']), adminController.replyTicket);
router.patch('/tickets/:ticketId/status', requireAgentAuth(['agent', 'admin']), adminController.updateTicketStatus);
router.patch('/tickets/:ticketId/assign', requireAgentAuth(['agent', 'admin']), adminController.assignTicket);

// AI Conversation Monitoring
router.get('/ai-monitoring', requireAgentAuth(['agent', 'admin']), adminController.getAiMonitoring);

// Knowledge Base Management (Viewing & drafting)
router.get('/knowledge-base', requireAgentAuth(['agent', 'admin']), adminController.listKnowledgeBase);
router.post('/knowledge-base', requireAgentAuth(['agent', 'admin']), adminController.createKnowledgeEntry);
router.put('/knowledge-base/:key', requireAgentAuth(['agent', 'admin']), adminController.updateKnowledgeEntry);
router.delete('/knowledge-base/:key', requireAgentAuth(['agent', 'admin']), adminController.deleteKnowledgeEntry);

// Store Policies Management (Viewing & draft editing)
router.get('/policies', requireAgentAuth(['agent', 'admin']), adminController.listPolicies);
router.put('/policies/:key', requireAgentAuth(['agent', 'admin']), adminController.updatePolicy);

// System Settings
router.get('/settings', requireAgentAuth(['agent', 'admin']), adminController.getSystemSettings);

// ---------------------------------------------------------------------------
// Admin-Only Endpoints (Strictly restricted to 'admin' role)
// ---------------------------------------------------------------------------

// Knowledge Base & Policy Approvals
router.patch('/knowledge-base/:key/approve', requireAgentAuth(['admin']), adminController.approveKnowledgeEntry);
router.patch('/policies/:key/publish', requireAgentAuth(['admin']), adminController.publishPolicy);
router.patch('/policies/:key/deactivate', requireAgentAuth(['admin']), adminController.deactivatePolicy);

// Team & Agent Management
router.get('/agents', requireAgentAuth(['admin']), adminController.listAgents);
router.post('/agents', requireAgentAuth(['admin']), adminController.createAgent);
router.patch('/agents/:id/status', requireAgentAuth(['admin']), adminController.updateAgentStatus);
router.patch('/agents/:id/role', requireAgentAuth(['admin']), adminController.updateAgentRole);

module.exports = router;
