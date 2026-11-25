const crypto = require('crypto');
const config = require('../config/env');
const logger = require('../utils/logger');
const { SupportTicketStore } = require('../models/SupportTicket');
const { WhatsAppMessageLogStore } = require('../models/WhatsAppMessageLog');
const { ConversationStore } = require('../models/Conversation');

class WhatsAppService {
  constructor() {
    // Upgraded to supported Meta Graph API version v26.0 (configurable via env)
    this.apiVersion = config.whatsapp.apiVersion || 'v26.0';
    this.phoneNumberId = config.whatsapp.phoneNumberId;
    this.businessAccountId = config.whatsapp.businessAccountId;
    this.accessToken = config.whatsapp.accessToken;
    this.verifyToken = config.whatsapp.verifyToken;
    this.appSecret = config.whatsapp.appSecret;

    // Mock testing harness for offline tests
    this.mockDeliveries = [];
    this.mockMode = false;
  }

  /**
   * Enables or disables mock mode for offline testing
   */
  setMockMode(enabled) {
    this.mockMode = Boolean(enabled);
  }

  clearMockDeliveries() {
    this.mockDeliveries = [];
  }

  /**
   * Normalizes customer phone numbers to clean E.164 digits without '+' (Meta Cloud API standard)
   * Specifically handles UAE mobile prefixes (+971, 00971, 05)
   */
  normalizeWhatsAppNumber(phone) {
    if (!phone || typeof phone !== 'string') return '';
    const digits = phone.replace(/\D/g, '');
    if (!digits) return '';

    // Handle UAE phone numbers
    if (digits.startsWith('00971')) {
      return digits.substring(2); // e.g. 00971501234567 -> 971501234567
    }
    if (digits.startsWith('971')) {
      return digits; // e.g. 971501234567
    }
    if (digits.startsWith('05') && digits.length === 10) {
      return `971${digits.substring(1)}`; // e.g. 0501234567 -> 971501234567
    }
    if (digits.startsWith('5') && digits.length === 9) {
      return `971${digits}`; // e.g. 501234567 -> 971501234567
    }

    return digits;
  }

  /**
   * Masks customer phone number for PII compliance in application logs (e.g. +971 50*** **67)
   */
  maskPhone(phone) {
    if (!phone) return '***-***-****';
    let digits = String(phone).replace(/\D/g, '');
    if (digits.length < 4) return '***-****';
    if (digits.startsWith('971')) {
      digits = digits.substring(3);
    } else if (digits.startsWith('0') && digits.length === 10) {
      digits = digits.substring(1);
    }
    const last2 = digits.slice(-2);
    const first2 = digits.slice(0, 2);
    return `+971 ${first2}*** **${last2}`;
  }

  /**
   * Summarizes message text for PII compliance in application logs
   */
  maskMessage(text) {
    if (!text || typeof text !== 'string') return '[Empty message]';
    return `[Message length: ${text.length} chars]`;
  }

  /**
   * Constant-time verification of Meta X-Hub-Signature-256 header against exact raw body
   */
  verifyWebhookSignature(rawBody, signatureHeader) {
    const secret = this.appSecret || config.whatsapp.appSecret;
    if (!secret) {
      logger.warn('WhatsApp Webhook verification warning: WHATSAPP_APP_SECRET is not configured.');
      return false;
    }

    if (!signatureHeader || !signatureHeader.startsWith('sha256=')) {
      return false;
    }

    const providedSignature = signatureHeader.substring(7);
    const expectedSignature = crypto
      .createHmac('sha256', secret)
      .update(rawBody || '')
      .digest('hex');

    const sigBuf = Buffer.from(providedSignature, 'hex');
    const expBuf = Buffer.from(expectedSignature, 'hex');

    if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) {
      return false;
    }

    return true;
  }

  /**
   * Verifies Webhook Challenge for GET /api/whatsapp/webhook
   */
  verifyWebhookSubscription(mode, token, challenge) {
    const configuredToken = this.verifyToken || config.whatsapp.verifyToken;
    if (!configuredToken) {
      return { success: false, reason: 'VERIFY_TOKEN_NOT_CONFIGURED' };
    }

    if (mode === 'subscribe' && token === configuredToken) {
      return { success: true, challenge };
    }

    return { success: false, reason: 'TOKEN_MISMATCH' };
  }

  /**
   * Sends an outbound free-form text message via Meta WhatsApp Business Cloud API
   * Note: Freeform messages require an active 24-hour customer service window.
   * @param {Object} params
   * @param {string} params.to - Recipient phone number
   * @param {string} params.text - Message content
   * @param {boolean} [params.previewUrl] - Whether to render web URL preview
   * @returns {Promise<Object>} Delivery result
   */
  async sendTextMessage({ to, text, previewUrl = false }) {
    const cleanTo = this.normalizeWhatsAppNumber(to);
    if (!cleanTo) {
      throw new Error('Valid recipient phone number is required.');
    }
    if (!text || !text.trim()) {
      throw new Error('Message text cannot be empty.');
    }

    const maskedPhone = this.maskPhone(cleanTo);
    logger.info(`Dispatching WhatsApp message to ${maskedPhone} ${this.maskMessage(text)} (Graph API: ${this.apiVersion})`);

    // In production, missing credentials must NEVER produce fake mock delivery
    if (config.env === 'production' && !this.mockMode && (!this.phoneNumberId || !this.accessToken)) {
      logger.error(`CRITICAL: Outbound WhatsApp dispatch attempted in production without configured credentials for ${maskedPhone}`);
      return {
        success: false,
        error: 'WhatsApp Business Cloud API credentials are not configured in production.',
        code: 'WHATSAPP_CREDENTIALS_MISSING',
        deliveryStatus: 'FAILED_UNCONFIGURED_CREDENTIALS',
        isLiveMetaDelivery: false,
      };
    }

    // Offline / Mock Testing Mode (Development / Test harness only)
    if (this.mockMode || (!this.phoneNumberId || !this.accessToken)) {
      const mockWamid = `wamid.MOCK_${Date.now()}_${crypto.randomBytes(6).toString('hex')}`;
      const record = {
        to: cleanTo,
        maskedPhone,
        text,
        wamid: mockWamid,
        timestamp: new Date(),
        status: 'mock_delivered',
      };
      this.mockDeliveries.push(record);

      const hasCredentials = Boolean(this.phoneNumberId && this.accessToken);
      return {
        success: true,
        messageId: mockWamid,
        recipient: maskedPhone,
        deliveryStatus: hasCredentials ? 'MOCK_DISPATCH_TEST' : 'MOCK_PENDING_CREDENTIALS',
        isLiveMetaDelivery: false,
        notice: 'Dispatched via verified local mock/testing harness. Live Meta Cloud API delivery requires active WhatsApp credentials.',
      };
    }

    // Live Meta WhatsApp Business Cloud API Request (v26.0)
    const url = `https://graph.facebook.com/${this.apiVersion}/${this.phoneNumberId}/messages`;
    const payload = {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: cleanTo,
      type: 'text',
      text: {
        preview_url: Boolean(previewUrl),
        body: text,
      },
    };

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.accessToken}`,
        },
        body: JSON.stringify(payload),
      });

      const data = await response.json();
      if (!response.ok) {
        logger.error(`Meta WhatsApp API delivery failed for ${maskedPhone}:`, {
          status: response.status,
          error: data.error?.message,
          code: data.error?.code,
        });
        return {
          success: false,
          error: data.error?.message || 'Meta WhatsApp API delivery error',
          code: data.error?.code || 'WHATSAPP_API_ERROR',
          isLiveMetaDelivery: true,
        };
      }

      const wamid = data.messages?.[0]?.id || `wamid.${Date.now()}`;
      logger.info(`WhatsApp message successfully dispatched to ${maskedPhone} (WAMID: ${wamid})`);

      return {
        success: true,
        messageId: wamid,
        recipient: maskedPhone,
        deliveryStatus: 'ACCEPTED_BY_META',
        isLiveMetaDelivery: true,
      };
    } catch (err) {
      logger.error(`Meta WhatsApp API network error for ${maskedPhone}:`, { message: err.message });
      return {
        success: false,
        error: err.message,
        code: 'NETWORK_ERROR',
        isLiveMetaDelivery: true,
      };
    }
  }

  /**
   * Sends an outbound pre-approved template message via Meta WhatsApp Business Cloud API
   * Required for re-engaging customers outside the 24-hour customer service window
   * @param {Object} params
   * @param {string} params.to - Recipient phone number
   * @param {string} params.templateName - Approved Meta template identifier
   * @param {string} [params.languageCode='en_US'] - Template language
   * @param {Array} [params.components=[]] - Template parameter components
   * @returns {Promise<Object>} Delivery result
   */
  async sendTemplateMessage({ to, templateName, languageCode = 'en_US', components = [] }) {
    const cleanTo = this.normalizeWhatsAppNumber(to);
    if (!cleanTo) {
      throw new Error('Valid recipient phone number is required.');
    }
    if (!templateName || !templateName.trim()) {
      throw new Error('Template name is required.');
    }
    const cleanTemplateName = templateName.trim();
    if (!/^[a-z0-9_]{1,512}$/.test(cleanTemplateName)) {
      throw new Error('Invalid template name. Meta template names must only contain lowercase letters, numbers, and underscores.');
    }
    const cleanLanguageCode = (languageCode || 'en_US').trim();
    if (!/^[a-z]{2}(_[A-Z]{2})?$/.test(cleanLanguageCode)) {
      throw new Error('Invalid template language code format. Expected standard locale e.g. en_US, ar, en.');
    }

    const maskedPhone = this.maskPhone(cleanTo);
    logger.info(`Dispatching WhatsApp template [${cleanTemplateName}] to ${maskedPhone} (Graph API: ${this.apiVersion})`);

    // In production, missing credentials must NEVER produce fake mock delivery
    if (config.env === 'production' && !this.mockMode && (!this.phoneNumberId || !this.accessToken)) {
      logger.error(`CRITICAL: Outbound WhatsApp template dispatch attempted in production without credentials for ${maskedPhone}`);
      return {
        success: false,
        error: 'WhatsApp Business Cloud API credentials are not configured in production.',
        code: 'WHATSAPP_CREDENTIALS_MISSING',
        deliveryStatus: 'FAILED_UNCONFIGURED_CREDENTIALS',
        isLiveMetaDelivery: false,
      };
    }

    // Offline / Mock Testing Mode
    if (this.mockMode || (!this.phoneNumberId || !this.accessToken)) {
      const mockWamid = `wamid.MOCK_TPL_${Date.now()}_${crypto.randomBytes(6).toString('hex')}`;
      const record = {
        to: cleanTo,
        maskedPhone,
        templateName: cleanTemplateName,
        wamid: mockWamid,
        timestamp: new Date(),
        status: 'mock_delivered',
        isTemplate: true,
      };
      this.mockDeliveries.push(record);
      return {
        success: true,
        messageId: mockWamid,
        recipient: maskedPhone,
        templateName: cleanTemplateName,
        deliveryStatus: Boolean(this.phoneNumberId && this.accessToken) ? 'MOCK_DISPATCH_TEST' : 'MOCK_PENDING_CREDENTIALS',
        isLiveMetaDelivery: false,
        notice: 'Template dispatched via verified local mock harness.',
      };
    }

    // Live Meta WhatsApp Cloud API Template Request (v26.0)
    const url = `https://graph.facebook.com/${this.apiVersion}/${this.phoneNumberId}/messages`;
    const payload = {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: cleanTo,
      type: 'template',
      template: {
        name: cleanTemplateName,
        language: { code: cleanLanguageCode },
        components: Array.isArray(components) ? components : [],
      },
    };

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.accessToken}`,
        },
        body: JSON.stringify(payload),
      });

      const data = await response.json();
      if (!response.ok) {
        logger.error(`Meta WhatsApp template delivery failed for ${maskedPhone}:`, {
          status: response.status,
          error: data.error?.message,
          code: data.error?.code,
        });
        return {
          success: false,
          error: data.error?.message || 'Meta WhatsApp template delivery error',
          code: data.error?.code || 'WHATSAPP_API_ERROR',
          isLiveMetaDelivery: true,
        };
      }

      const wamid = data.messages?.[0]?.id || `wamid.${Date.now()}`;
      return {
        success: true,
        messageId: wamid,
        recipient: maskedPhone,
        deliveryStatus: 'ACCEPTED_BY_META',
        isLiveMetaDelivery: true,
      };
    } catch (err) {
      return {
        success: false,
        error: err.message,
        code: 'NETWORK_ERROR',
        isLiveMetaDelivery: true,
      };
    }
  }

  /**
   * Processes inbound Meta Webhook payload:
   * - Deduplicates using WhatsApp message ID (wamid)
   * - Associates customer messages with internal Support Tickets
   * - Refreshes the 24-hour customer service window timestamp (lastCustomerMessageAt)
   * - Synchronizes inbound messages into website Conversation when linked
   * - Updates message delivery/read status notifications
   */
  async processInboundWebhook(body, shop = config.shopify.shop) {
    if (!body || body.object !== 'whatsapp_business_account' || !Array.isArray(body.entry)) {
      return { status: 'ignored', reason: 'NOT_WHATSAPP_EVENT' };
    }

    const processedMessages = [];
    const processedStatuses = [];

    for (const entry of body.entry) {
      const changes = entry.changes || [];
      for (const change of changes) {
        if (change.field !== 'messages') continue;
        const value = change.value || {};

        // 1. Process delivery/read status updates
        const statuses = value.statuses || [];
        for (const st of statuses) {
          const wamid = st.id;
          const status = st.status; // 'sent', 'delivered', 'read', 'failed'
          if (wamid && status) {
            processedStatuses.push({ wamid, status });
            await WhatsAppMessageLogStore.updateStatus(wamid, status);
            await SupportTicketStore.updateMessageStatusByWamid(wamid, status, shop);
          }
        }

        // 2. Process customer inbound messages
        const messages = value.messages || [];
        const contacts = value.contacts || [];
        const contactProfile = contacts[0]?.profile?.name || 'WhatsApp Customer';

        for (const msg of messages) {
          const wamid = msg.id;
          const rawFrom = msg.from;
          const normalizedFrom = this.normalizeWhatsAppNumber(rawFrom);
          const maskedPhone = this.maskPhone(normalizedFrom);

          let messageText = '';
          if (msg.type === 'text') {
            messageText = msg.text?.body || '';
          } else if (msg.type === 'interactive') {
            messageText = msg.interactive?.button_reply?.title || msg.interactive?.list_reply?.title || '[Interactive selection]';
          } else {
            messageText = `[Customer sent ${msg.type || 'media'} attachment via WhatsApp]`;
          }

          // Idempotency: Deduplicate message ID
          const alreadyProcessed = await WhatsAppMessageLogStore.isProcessed(wamid);
          if (alreadyProcessed) {
            logger.warn(`Duplicate webhook message detected and safely ignored (WAMID: ${wamid})`);
            continue;
          }

          // Record message in deduplication log
          await WhatsAppMessageLogStore.logMessage({
            messageId: wamid,
            direction: 'inbound',
            fromMasked: maskedPhone,
            status: 'received',
          });

          // Find or create internal support ticket for this customer phone (store-isolated)
          let ticket = await SupportTicketStore.findByCustomerPhone(normalizedFrom, shop);
          const isNewTicket = !ticket;
          const messageTimestamp = new Date(Number(msg.timestamp) * 1000 || Date.now());

          if (!ticket) {
            const ticketId = `tkt_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
            ticket = await SupportTicketStore.createTicket({
              ticketId,
              shop,
              source: 'whatsapp',
              status: 'pending_agent',
              priority: 'medium',
              reason: 'Customer initiated contact via WhatsApp',
              lastCustomerMessageAt: messageTimestamp,
              customer: {
                name: contactProfile,
                phone: normalizedFrom,
                maskedPhone,
              },
              whatsapp: {
                phoneNumberId: value.metadata?.phone_number_id,
                wamid,
                lastMessageStatus: 'received',
              },
              messages: [
                {
                  id: `msg_${wamid}`,
                  sender: 'user',
                  senderName: contactProfile,
                  channel: 'whatsapp',
                  text: messageText,
                  whatsappMessageId: wamid,
                  status: 'received',
                  timestamp: messageTimestamp,
                },
              ],
            });
          } else {
            // Append message to existing ticket and refresh 24h customer window timestamp
            await SupportTicketStore.appendMessage(ticket.ticketId, {
              id: `msg_${wamid}`,
              sender: 'user',
              senderName: contactProfile,
              channel: 'whatsapp',
              text: messageText,
              whatsappMessageId: wamid,
              status: 'received',
              timestamp: messageTimestamp,
            });
            await SupportTicketStore.updateTicketStatus(ticket.ticketId, 'pending_agent', {
              'whatsapp.wamid': wamid,
              'whatsapp.lastMessageStatus': 'received',
              lastCustomerMessageAt: messageTimestamp,
            });
          }

          // Synchronize message into website Conversation if ticket has linked conversationId
          if (ticket.conversationId) {
            const websiteMessage = {
              id: `msg_${wamid}`,
              sender: 'user',
              text: `[WhatsApp: ${contactProfile}]: ${messageText}`,
              timestamp: messageTimestamp,
            };
            await ConversationStore.createOrUpdate(ticket.conversationId, shop, websiteMessage);
            logger.info(`Inbound WhatsApp message synchronized to storefront conversation ${ticket.conversationId}`);
          }

          logger.info(`Inbound WhatsApp message recorded for ticket ${ticket.ticketId} from ${maskedPhone}`);
          processedMessages.push({
            wamid,
            ticketId: ticket.ticketId,
            isNewTicket,
          });
        }
      }
    }

    return {
      status: 'processed',
      messagesCount: processedMessages.length,
      statusesCount: processedStatuses.length,
      processedMessages,
      processedStatuses,
    };
  }

  /**
   * Allows human support agents to reply to a ticket
   * - Enforces store isolation (rejects cross-store access)
   * - Enforces 24-hour customer service window for free-form messages
   * - Outside 24h window, requires an approved WhatsApp template
   * - Sends outbound WhatsApp message to customer if phone number is present
   * - Appends message to SupportTicket
   * - Synchronizes message back to storefront chatbot Conversation
   * - Updates ticket status to 'agent_replied'
   */
  async sendAgentReply({
    ticketId,
    conversationId,
    message,
    template,
    agentName = 'Abihacart Support Specialist',
    shop = config.shopify.shop,
  }) {
    if (!message || typeof message !== 'string' || !message.trim()) {
      throw new Error('Agent reply message cannot be empty.');
    }

    const trimmedMsg = message.trim();
    let ticket = null;

    if (ticketId) {
      ticket = await SupportTicketStore.findByTicketId(ticketId, shop);
    } else if (conversationId) {
      ticket = await SupportTicketStore.findByConversationId(conversationId, shop);
    }

    if (!ticket) {
      throw new Error(`Support ticket not found or does not belong to store [${shop}]`);
    }

    // Verify store isolation on linked conversation
    const targetConvId = conversationId || ticket.conversationId;
    if (targetConvId) {
      const conv = await ConversationStore.findByConversationId(targetConvId);
      if (conv && conv.shop && conv.shop !== shop) {
        throw new Error(`Store access violation: Target conversation [${targetConvId}] does not belong to store [${shop}]`);
      }
    }

    const customerPhone = ticket.customer?.phone;
    let deliveryResult = null;

    // 1. WhatsApp Messaging Rules: Enforce 24-Hour Customer Service Window
    if (customerPhone) {
      const TWENTY_FOUR_HOURS_MS = 24 * 60 * 60 * 1000;
      const lastInboundAt = ticket.lastCustomerMessageAt || ticket.createdAt;
      const isWithin24Hours = (Date.now() - new Date(lastInboundAt).getTime()) <= TWENTY_FOUR_HOURS_MS;

      if (!isWithin24Hours) {
        if (!template) {
          return {
            success: false,
            code: 'OUTSIDE_24H_WINDOW',
            error: 'The 24-hour customer service window has expired. Meta WhatsApp Business policy requires an approved message template to message this customer.',
            requiresTemplate: true,
            lastCustomerMessageAt: lastInboundAt,
          };
        }

        // Outbound template dispatch for expired window
        deliveryResult = await this.sendTemplateMessage({
          to: customerPhone,
          templateName: template.name,
          languageCode: template.languageCode || 'en_US',
          components: template.components || [],
        });
      } else {
        // Within 24-hour window: free-form message permitted
        deliveryResult = await this.sendTextMessage({
          to: customerPhone,
          text: `[${agentName}]: ${trimmedMsg}`,
        });
      }
    }

    const replyMsgId = `msg_agent_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`;
    const agentMessageObj = {
      id: replyMsgId,
      sender: 'agent',
      senderName: agentName,
      channel: customerPhone ? 'whatsapp' : 'web_chat',
      text: trimmedMsg,
      whatsappMessageId: deliveryResult?.messageId,
      status: deliveryResult?.success ? 'sent' : (deliveryResult ? 'failed' : 'delivered'),
      timestamp: new Date(),
    };

    // 2. Append reply to SupportTicket
    await SupportTicketStore.appendMessage(ticket.ticketId, agentMessageObj);
    await SupportTicketStore.updateTicketStatus(ticket.ticketId, 'agent_replied');

    // 3. Synchronize reply back to website storefront Conversation
    if (targetConvId) {
      const convMessage = {
        id: replyMsgId,
        sender: 'agent',
        text: trimmedMsg,
        timestamp: new Date(),
      };
      await ConversationStore.createOrUpdate(targetConvId, shop, convMessage);
      logger.info(`Human agent reply synchronized to storefront conversation ${targetConvId}`);
    }

    return {
      success: true,
      ticketId: ticket.ticketId,
      conversationId: targetConvId,
      agentName,
      message: trimmedMsg,
      deliveryResult,
      status: 'agent_replied',
      timestamp: agentMessageObj.timestamp,
    };
  }
}

module.exports = new WhatsAppService();
module.exports.WhatsAppService = WhatsAppService;
