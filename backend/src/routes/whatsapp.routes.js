const express = require('express');
const router = express.Router();
const whatsappController = require('../controllers/whatsapp.controller');
const { verifyMetaSignature } = require('../middleware/verifyWhatsAppWebhook');
const { requireAgentAuth } = require('../middleware/agentAuth');
const { whatsappWebhookLimiter, agentReplyLimiter } = require('../middleware/rateLimiter');

// Public Meta Webhook Verification Handshake (Meta platform to server)
router.get('/webhook', whatsappController.verifyWebhook);

// Inbound Meta Webhook Ingress (Cryptographically verified via X-Hub-Signature-256 and rate-limited)
router.post('/webhook', whatsappWebhookLimiter, verifyMetaSignature, whatsappController.handleWebhook);

// Protected Human Support Agent Endpoints (Requires valid Agent/Admin credentials)
router.post('/agent/reply', agentReplyLimiter, requireAgentAuth(['agent', 'admin']), whatsappController.sendAgentReply);
router.get('/tickets', requireAgentAuth(['agent', 'admin']), whatsappController.listTickets);
router.get('/tickets/:ticketId', requireAgentAuth(['agent', 'admin']), whatsappController.getTicketStatus);

module.exports = router;
