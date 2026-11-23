const crypto = require('crypto');
const logger = require('../utils/logger');
const config = require('../config/env');
const { ConversationStore } = require('../models/Conversation');
const cacheService = require('../services/cache.service');
const openaiService = require('../services/openai.service');

const INITIAL_SUGGESTIONS = [
  'Where is my order?',
  'Tell me about your products',
  'What are your shipping options?',
  'What is your return policy?',
  'I need help from a human agent',
];

/**
 * Derives a consistent secret for signing customer conversation session tokens
 */
const getConversationSecret = () => {
  return config.shopify.clientSecret || 'abh_conv_default_secret_key_development';
};

const CONVERSATION_TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days TTL

/**
 * Generates an HMAC-SHA256 authorization token bound to a conversation ID with explicit expiration.
 * Prevents unauthorized customers from accessing or tampering with another customer's chat.
 */
const generateConversationToken = (conversationId, ttlMs = CONVERSATION_TOKEN_TTL_MS) => {
  const expiresAtMs = Date.now() + ttlMs;
  const payload = `${conversationId}:${expiresAtMs}`;
  const signature = crypto
    .createHmac('sha256', getConversationSecret())
    .update(payload)
    .digest('hex');
  return `${payload}:${signature}`;
};

/**
 * Constant-time verification of customer conversation authorization token
 * Validates conversation-ID binding, expiry timestamp, and cryptographic signature.
 */
const verifyConversationToken = (conversationId, token) => {
  if (!conversationId || !token || typeof token !== 'string') {
    return { valid: false, reason: 'missing_token' };
  }

  const parts = token.split(':');
  if (parts.length !== 3) {
    return { valid: false, reason: 'malformed_token' };
  }

  const [tokenConvId, expiresAtStr, signature] = parts;

  // 1. Strict conversation-ID binding
  if (tokenConvId !== conversationId) {
    return { valid: false, reason: 'conversation_mismatch' };
  }

  // 2. Expiration verification
  const expiresAtMs = parseInt(expiresAtStr, 10);
  if (isNaN(expiresAtMs) || Date.now() > expiresAtMs) {
    return { valid: false, reason: 'expired', code: 'TOKEN_EXPIRED' };
  }

  // 3. Constant-time HMAC signature check
  const payload = `${tokenConvId}:${expiresAtStr}`;
  const expectedSignature = crypto
    .createHmac('sha256', getConversationSecret())
    .update(payload)
    .digest('hex');

  const sigBuf = Buffer.from(signature, 'utf8');
  const expBuf = Buffer.from(expectedSignature, 'utf8');

  if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) {
    return { valid: false, reason: 'invalid_signature' };
  }

  return { valid: true };
};

/**
 * Chat Controller for Storefront Customer Support
 */
const sendMessage = async (req, res, next) => {
  try {
    const { message, shop = config.shopify.shop } = req.body;
    let { conversationId } = req.body;
    const clientToken = req.get('x-conversation-token') || req.body.conversationToken;

    if (!message || typeof message !== 'string' || !message.trim()) {
      return res.status(400).json({
        status: 'fail',
        error: 'Validation Error',
        message: 'Message cannot be empty.',
      });
    }

    const trimmedMessage = message.trim();
    if (trimmedMessage.length > 1000) {
      return res.status(400).json({
        status: 'fail',
        error: 'Validation Error',
        message: 'Message exceeds maximum length of 1000 characters.',
      });
    }

    let isNewConversation = false;
    if (!conversationId) {
      conversationId = `abh_conv_${crypto.randomBytes(12).toString('hex')}`;
      isNewConversation = true;
    } else {
      // Existing conversation requires valid signature token to prevent IDOR hijacking
      const tokenVerification = verifyConversationToken(conversationId, clientToken);
      if (!tokenVerification.valid) {
        return res.status(403).json({
          status: 'fail',
          statusCode: 403,
          error: 'Forbidden',
          code: tokenVerification.code || 'INVALID_TOKEN',
          message: tokenVerification.code === 'TOKEN_EXPIRED'
            ? 'Conversation token has expired. Please initiate a new conversation session.'
            : 'Invalid or missing conversation authorization token.',
          recoverable: tokenVerification.code === 'TOKEN_EXPIRED',
        });
      }
    }

    const conversationToken = generateConversationToken(conversationId);

    // Save user message
    const userMsg = {
      id: `msg_${Date.now()}_u`,
      sender: 'user',
      text: trimmedMessage,
      timestamp: new Date(),
    };
    await ConversationStore.createOrUpdate(conversationId, shop, userMsg);

    // Retrieve previous conversation messages for conversational context
    const existingConversation = await ConversationStore.findByConversationId(conversationId);
    const history = existingConversation && existingConversation.messages ? existingConversation.messages.slice(0, -1) : [];

    // Process through OpenAI Support Engine (gpt-6-luna)
    const aiResult = await openaiService.processSupportMessage({
      messages: history,
      userMessage: trimmedMessage,
      shop,
    });

    const replyText = aiResult.reply;
    const productCards = aiResult.productCards || [];
    const isEscalated = Boolean(aiResult.escalated);

    // Compute contextual suggestions based on intent and reply content
    let suggestions = [];
    if (productCards.length > 0) {
      suggestions = ['What are your shipping options?', 'Where is my order?', 'What is your return policy?'];
    } else if (trimmedMessage.toLowerCase().includes('order') || trimmedMessage.toLowerCase().includes('track')) {
      suggestions = ['Tell me about your products', 'What are your shipping options?', 'I need help from a human agent'];
    } else if (trimmedMessage.toLowerCase().includes('shipping') || trimmedMessage.toLowerCase().includes('delivery')) {
      suggestions = ['Tell me about your products', 'What is your return policy?', 'Where is my order?'];
    } else if (trimmedMessage.toLowerCase().includes('return') || trimmedMessage.toLowerCase().includes('refund')) {
      suggestions = ['I need help from a human agent', 'Tell me about your products', 'What are your shipping options?'];
    } else if (isEscalated) {
      suggestions = ['Where is my order?', 'Tell me about your products', 'What are your shipping options?'];
    } else {
      suggestions = INITIAL_SUGGESTIONS;
    }

    // Save assistant response
    const assistantMsg = {
      id: `msg_${Date.now()}_a`,
      sender: 'assistant',
      text: replyText,
      productCards,
      suggestions,
      escalated: isEscalated,
      timestamp: new Date(),
    };
    await ConversationStore.createOrUpdate(conversationId, shop, assistantMsg);

    logger.info(`Chat message processed for conversation ${conversationId}`);

    const engineMode = aiResult.engineMode || (aiResult.liveConnection ? 'live_openai_responses_api' : 'local_deterministic_degraded');
    const liveConnection = Boolean(aiResult.liveConnection);

    res.set('x-ai-engine', engineMode);
    res.set('x-ai-live', String(liveConnection));

    return res.status(200).json({
      status: 'success',
      conversationId,
      conversationToken,
      reply: replyText,
      productCards,
      suggestions,
      escalated: isEscalated,
      engineMode,
      liveConnection,
      timestamp: assistantMsg.timestamp,
    });
  } catch (error) {
    logger.error('Error processing chat message:', { message: error.message });
    return next(error);
  }
};

/**
 * Retrieves conversation history for active session restoration
 * Protected with conversationToken signature to prevent IDOR vulnerabilities.
 */
const getHistory = async (req, res, next) => {
  try {
    const { conversationId } = req.params;
    const clientToken = req.get('x-conversation-token') || req.query.token;

    const tokenVerification = verifyConversationToken(conversationId, clientToken);
    if (!tokenVerification.valid) {
      return res.status(403).json({
        status: 'fail',
        statusCode: 403,
        error: 'Forbidden',
        code: tokenVerification.code || 'INVALID_TOKEN',
        message: tokenVerification.code === 'TOKEN_EXPIRED'
          ? 'Conversation token has expired. Please initiate a new conversation session.'
          : 'Unauthorized access to conversation history. Valid conversation token required.',
        recoverable: tokenVerification.code === 'TOKEN_EXPIRED',
      });
    }

    const conversation = await ConversationStore.findByConversationId(conversationId);

    if (!conversation) {
      return res.status(200).json({
        status: 'success',
        conversationId,
        messages: [],
      });
    }

    return res.status(200).json({
      status: 'success',
      conversationId,
      messages: conversation.messages || [],
    });
  } catch (error) {
    logger.error('Error retrieving conversation history:', { message: error.message });
    return next(error);
  }
};

/**
 * Returns initial suggestion chips
 */
const getSuggestions = (req, res) => {
  return res.status(200).json({
    status: 'success',
    suggestions: INITIAL_SUGGESTIONS,
  });
};

module.exports = {
  sendMessage,
  getHistory,
  getSuggestions,
};
