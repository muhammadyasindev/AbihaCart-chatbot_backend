const whatsappService = require('../services/whatsapp.service');
const { SupportTicketStore } = require('../models/SupportTicket');
const logger = require('../utils/logger');
const config = require('../config/env');

/**
 * WhatsApp Controller for Meta WhatsApp Business Cloud API Integration
 */

/**
 * Handles Webhook Subscription Handshake (GET /api/whatsapp/webhook)
 * Responds with hub.challenge if hub.verify_token matches configured secret
 */
const verifyWebhook = (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  const verification = whatsappService.verifyWebhookSubscription(mode, token, challenge);
  if (verification.success) {
    logger.info('Meta WhatsApp Webhook subscription handshake verified successfully.');
    return res.status(200).send(challenge);
  }

  logger.warn('Meta WhatsApp Webhook subscription handshake rejected: Token mismatch.');
  return res.status(403).json({
    status: 'fail',
    statusCode: 403,
    error: 'Forbidden',
    code: 'WEBHOOK_VERIFY_TOKEN_MISMATCH',
    message: 'The provided hub.verify_token did not match the configured secret.',
  });
};

/**
 * Inbound Webhook Ingress (POST /api/whatsapp/webhook)
 * Processes incoming customer messages, updates delivery statuses, associates with SupportTickets
 */
const handleWebhook = async (req, res, next) => {
  try {
    const shop = req.query.shop || req.headers['x-shopify-shop'] || config.shopify.shop;
    const result = await whatsappService.processInboundWebhook(req.body, shop);
    return res.status(200).json({
      status: 'success',
      data: result,
    });
  } catch (err) {
    logger.error('Error processing inbound WhatsApp webhook:', { message: err.message });
    return next(err);
  }
};

/**
 * Human Support Agent Reply (POST /api/whatsapp/agent/reply)
 * Protected: Requires authenticated support agent.
 * Enforces store isolation and Meta 24-hour customer service window rules.
 */
const sendAgentReply = async (req, res, next) => {
  try {
    const { ticketId, conversationId, message, template } = req.body;
    const trustedShop = req.agent?.shop || config.shopify.shop;
    const requestedShop = req.body.shop || req.headers['x-shopify-shop'];

    if (requestedShop && requestedShop !== trustedShop) {
      return res.status(403).json({
        status: 'fail',
        statusCode: 403,
        error: 'Forbidden',
        code: 'STORE_ACCESS_DENIED',
        message: `Store access violation: Agent context is restricted to [${trustedShop}]. Cannot access [${requestedShop}].`,
      });
    }

    const shop = trustedShop;
    const agentName = req.body.agentName || req.agent?.name || 'Abihacart Support Specialist';

    if (!message || typeof message !== 'string' || !message.trim()) {
      return res.status(400).json({
        status: 'fail',
        statusCode: 400,
        error: 'Bad Request',
        code: 'MISSING_MESSAGE',
        message: 'Agent reply message cannot be empty.',
      });
    }

    if (message.trim().length > 2000) {
      return res.status(400).json({
        status: 'fail',
        statusCode: 400,
        error: 'Bad Request',
        code: 'MESSAGE_TOO_LONG',
        message: 'Agent reply message exceeds maximum length of 2000 characters.',
      });
    }

    if (!ticketId && !conversationId) {
      return res.status(400).json({
        status: 'fail',
        statusCode: 400,
        error: 'Bad Request',
        code: 'MISSING_TICKET_OR_CONVERSATION',
        message: 'Either ticketId or conversationId is required to route agent reply.',
      });
    }

    const replyResult = await whatsappService.sendAgentReply({
      ticketId,
      conversationId,
      message: message.trim(),
      template,
      agentName,
      shop,
    });

    if (replyResult.code === 'OUTSIDE_24H_WINDOW') {
      return res.status(422).json({
        status: 'fail',
        statusCode: 422,
        error: 'Unprocessable Entity',
        code: 'OUTSIDE_24H_WINDOW',
        message: replyResult.error,
        requiresTemplate: true,
        lastCustomerMessageAt: replyResult.lastCustomerMessageAt,
      });
    }

    return res.status(200).json({
      status: 'success',
      data: replyResult,
    });
  } catch (err) {
    logger.error('Error sending agent reply:', { message: err.message });
    if (err.message.includes('not found')) {
      return res.status(404).json({
        status: 'fail',
        statusCode: 404,
        error: 'Not Found',
        code: 'TICKET_NOT_FOUND',
        message: err.message,
      });
    }
    if (err.message.includes('Store access') || err.message.includes('does not belong to store')) {
      return res.status(403).json({
        status: 'fail',
        statusCode: 403,
        error: 'Forbidden',
        code: 'STORE_ACCESS_DENIED',
        message: err.message,
      });
    }
    return next(err);
  }
};

/**
 * Retrieve Ticket Status & History (GET /api/whatsapp/tickets/:ticketId)
 * Protected: Requires authenticated agent. Enforces store isolation.
 */
const getTicketStatus = async (req, res, next) => {
  try {
    const { ticketId } = req.params;
    const trustedShop = req.agent?.shop || config.shopify.shop;
    const requestedShop = req.query.shop || req.headers['x-shopify-shop'];

    if (requestedShop && requestedShop !== trustedShop) {
      return res.status(403).json({
        status: 'fail',
        statusCode: 403,
        error: 'Forbidden',
        code: 'STORE_ACCESS_DENIED',
        message: `Store access violation: Agent context is restricted to [${trustedShop}]. Cannot access [${requestedShop}].`,
      });
    }

    const shop = trustedShop;
    const ticket = await SupportTicketStore.findByTicketId(ticketId, shop);

    if (!ticket) {
      return res.status(404).json({
        status: 'fail',
        statusCode: 404,
        error: 'Not Found',
        code: 'TICKET_NOT_FOUND',
        message: `Support ticket ${ticketId} not found for store ${shop}.`,
      });
    }

    return res.status(200).json({
      status: 'success',
      data: ticket,
    });
  } catch (err) {
    return next(err);
  }
};

/**
 * List Active Tickets (GET /api/whatsapp/tickets)
 * Protected: Requires authenticated agent. Enforces store isolation.
 */
const listTickets = async (req, res, next) => {
  try {
    const { status, limit } = req.query;
    const trustedShop = req.agent?.shop || config.shopify.shop;
    const requestedShop = req.query.shop || req.headers['x-shopify-shop'];

    if (requestedShop && requestedShop !== trustedShop) {
      return res.status(403).json({
        status: 'fail',
        statusCode: 403,
        error: 'Forbidden',
        code: 'STORE_ACCESS_DENIED',
        message: `Store access violation: Agent context is restricted to [${trustedShop}]. Cannot access [${requestedShop}].`,
      });
    }

    const shop = trustedShop;
    const tickets = await SupportTicketStore.listTickets({
      shop,
      status,
      limit: limit ? parseInt(limit, 10) : 50,
    });

    return res.status(200).json({
      status: 'success',
      count: tickets.length,
      data: tickets,
    });
  } catch (err) {
    return next(err);
  }
};

module.exports = {
  verifyWebhook,
  handleWebhook,
  sendAgentReply,
  getTicketStatus,
  listTickets,
};
