const { AdminUserStore, hashPassword, verifyPassword } = require('../models/AdminUser');
const { ConversationStore } = require('../models/Conversation');
const { SupportTicketStore } = require('../models/SupportTicket');
const { KnowledgeBaseStore } = require('../models/KnowledgeBase');
const { WhatsAppMessageLogStore } = require('../models/WhatsAppMessageLog');
const { maskPhone } = require('../models/PendingOrder');
const whatsappService = require('../services/whatsapp.service');
const openaiService = require('../services/openai.service');
const { generateToken } = require('../utils/token.util');
const config = require('../config/env');
const logger = require('../utils/logger');

/**
 * Admin Dashboard Controller
 * Provides enterprise management APIs for Abihacart AI Support Cockpit
 */

// ---------------------------------------------------------------------------
// 1. Authentication & Session Management
// ---------------------------------------------------------------------------

const login = async (req, res, next) => {
  try {
    const { username, password } = req.body;

    if (!username || !password || typeof username !== 'string' || typeof password !== 'string') {
      return res.status(400).json({
        status: 'fail',
        statusCode: 400,
        error: 'Bad Request',
        code: 'MISSING_CREDENTIALS',
        message: 'Username/email and password are required.',
      });
    }

    // Auto-seed default admin if database/store has no admin yet
    await AdminUserStore.seedDefaultAdminIfNeeded();

    const user = await AdminUserStore.findByUsernameOrEmail(username.trim());

    if (!user) {
      logger.warn(`Failed admin login attempt: Unknown user [${username.trim()}] from IP: ${req.ip}`);
      return res.status(401).json({
        status: 'fail',
        statusCode: 401,
        error: 'Unauthorized',
        code: 'INVALID_CREDENTIALS',
        message: 'Invalid username or password.',
      });
    }

    const isValid = verifyPassword(password, user.passwordHash);
    if (!isValid) {
      logger.warn(`Failed admin login attempt: Incorrect password for [${user.username}] from IP: ${req.ip}`);
      return res.status(401).json({
        status: 'fail',
        statusCode: 401,
        error: 'Unauthorized',
        code: 'INVALID_CREDENTIALS',
        message: 'Invalid username or password.',
      });
    }

    if (!user.isActive) {
      logger.warn(`Deactivated user attempted login: [${user.username}] from IP: ${req.ip}`);
      return res.status(403).json({
        status: 'fail',
        statusCode: 403,
        error: 'Forbidden',
        code: 'ACCOUNT_DEACTIVATED',
        message: 'This account has been deactivated. Please contact an administrator.',
      });
    }

    await AdminUserStore.updateUser(user.id, { lastLoginAt: new Date() });

    const token = generateToken({
      userId: user.id,
      username: user.username,
      email: user.email,
      role: user.role,
      name: user.name,
      shop: user.shop || config.shopify.shop,
    });

    logger.info(`Successful admin login for [${user.username}] (role: ${user.role}) from IP: ${req.ip}`);

    return res.status(200).json({
      status: 'success',
      token,
      user: {
        id: user.id,
        username: user.username,
        email: user.email,
        name: user.name,
        role: user.role,
        shop: user.shop || config.shopify.shop,
      },
    });
  } catch (err) {
    return next(err);
  }
};

const getCurrentUser = async (req, res) => {
  return res.status(200).json({
    status: 'success',
    user: req.agent,
  });
};

const logout = async (req, res) => {
  return res.status(200).json({
    status: 'success',
    message: 'Logged out successfully.',
  });
};

// ---------------------------------------------------------------------------
// 2. Dashboard Overview & Real Analytics Aggregations
// ---------------------------------------------------------------------------

const getOverview = async (req, res, next) => {
  try {
    const shop = req.agent?.shop || config.shopify.shop;

    const [convStats, ticketStats, recentConvs, recentTickets] = await Promise.all([
      ConversationStore.getConversationStats({ shop }),
      SupportTicketStore.getTicketStats({ shop }),
      ConversationStore.listConversations({ shop, limit: 5 }),
      SupportTicketStore.listTickets({ shop, limit: 5 }),
    ]);

    return res.status(200).json({
      status: 'success',
      data: {
        stats: {
          totalConversations: convStats.total,
          activeConversations: convStats.active,
          escalatedConversations: convStats.escalated,
          aiHandledConversations: convStats.aiHandled,
          humanHandledConversations: convStats.humanHandled,
          openTickets: ticketStats.open,
          pendingAgentTickets: ticketStats.pendingAgent,
          agentRepliedTickets: ticketStats.agentReplied,
          resolvedTickets: ticketStats.resolved,
          closedTickets: ticketStats.closed,
          avgResponseTimeMinutes: ticketStats.avgResponseTimeMinutes,
        },
        recentConversations: recentConvs.conversations || [],
        recentTickets: recentTickets || [],
      },
    });
  } catch (err) {
    return next(err);
  }
};

const getAnalytics = async (req, res, next) => {
  try {
    const shop = req.agent?.shop || config.shopify.shop;
    const { days = 7 } = req.query;
    const numDays = Math.min(30, Math.max(1, parseInt(days, 10) || 7));

    const [convStats, ticketStats, convListResult] = await Promise.all([
      ConversationStore.getConversationStats({ shop }),
      SupportTicketStore.getTicketStats({ shop }),
      ConversationStore.listConversations({ shop, limit: 200 }),
    ]);

    // Build real aggregation of conversations per day
    const dailyVolumeMap = new Map();
    const today = new Date();
    for (let i = numDays - 1; i >= 0; i--) {
      const d = new Date(today.getTime() - i * 24 * 60 * 60 * 1000);
      const dateKey = d.toISOString().split('T')[0];
      dailyVolumeMap.set(dateKey, 0);
    }

    const allConvs = convListResult.conversations || [];
    for (const c of allConvs) {
      if (c.createdAt) {
        const dateKey = new Date(c.createdAt).toISOString().split('T')[0];
        if (dailyVolumeMap.has(dateKey)) {
          dailyVolumeMap.set(dateKey, dailyVolumeMap.get(dateKey) + 1);
        }
      }
    }

    const conversationsPerDay = Array.from(dailyVolumeMap.entries()).map(([date, count]) => ({
      date,
      count,
    }));

    return res.status(200).json({
      status: 'success',
      data: {
        conversationsPerDay,
        openVsResolved: {
          open: ticketStats.open + ticketStats.pendingAgent,
          resolved: ticketStats.resolved + ticketStats.closed,
        },
        aiVsHumanSupport: {
          aiHandled: convStats.aiHandled,
          humanHandled: convStats.humanHandled,
        },
        ticketDistribution: {
          open: ticketStats.open,
          pending_agent: ticketStats.pendingAgent,
          agent_replied: ticketStats.agentReplied,
          resolved: ticketStats.resolved,
          closed: ticketStats.closed,
        },
        escalationRate: convStats.total > 0
          ? Math.round((convStats.escalated / convStats.total) * 100)
          : 0,
        avgResponseTimeMinutes: ticketStats.avgResponseTimeMinutes,
      },
    });
  } catch (err) {
    return next(err);
  }
};

// ---------------------------------------------------------------------------
// 3. Customer Conversation Management
// ---------------------------------------------------------------------------

const listConversations = async (req, res, next) => {
  try {
    const shop = req.agent?.shop || config.shopify.shop;
    const { status, search, page = 1, limit = 20, startDate, endDate } = req.query;

    const result = await ConversationStore.listConversations({
      shop,
      status,
      search,
      page,
      limit,
      startDate,
      endDate,
    });

    const safeConversations = (result.conversations || []).map((c) => {
      const obj = c && typeof c.toObject === 'function' ? c.toObject() : { ...c };
      if (obj.customer && obj.customer.phone) {
        obj.customer.phone = maskPhone(obj.customer.phone);
      }
      return obj;
    });

    return res.status(200).json({
      status: 'success',
      data: {
        ...result,
        conversations: safeConversations,
      },
    });
  } catch (err) {
    return next(err);
  }
};

const getConversation = async (req, res, next) => {
  try {
    const { conversationId } = req.params;
    const shop = req.agent?.shop || config.shopify.shop;

    const conversation = await ConversationStore.findByConversationId(conversationId);
    if (!conversation) {
      return res.status(404).json({
        status: 'fail',
        statusCode: 404,
        error: 'Not Found',
        code: 'CONVERSATION_NOT_FOUND',
        message: `Conversation [${conversationId}] not found.`,
      });
    }

    if (conversation.shop && conversation.shop !== shop) {
      return res.status(403).json({
        status: 'fail',
        statusCode: 403,
        error: 'Forbidden',
        code: 'STORE_ACCESS_DENIED',
        message: `Store access violation: Conversation does not belong to store [${shop}].`,
      });
    }

    const safeData = conversation && typeof conversation.toObject === 'function' ? conversation.toObject() : { ...conversation };
    if (safeData.customer && safeData.customer.phone) {
      safeData.customer.phone = maskPhone(safeData.customer.phone);
    }

    return res.status(200).json({
      status: 'success',
      data: safeData,
    });
  } catch (err) {
    return next(err);
  }
};

const replyConversation = async (req, res, next) => {
  try {
    const { conversationId } = req.params;
    const { message } = req.body;
    const shop = req.agent?.shop || config.shopify.shop;

    if (!message || typeof message !== 'string' || !message.trim()) {
      return res.status(400).json({
        status: 'fail',
        statusCode: 400,
        error: 'Bad Request',
        code: 'MISSING_MESSAGE',
        message: 'Reply message cannot be empty.',
      });
    }

    const conversation = await ConversationStore.findByConversationId(conversationId);
    if (!conversation) {
      return res.status(404).json({
        status: 'fail',
        statusCode: 404,
        error: 'Not Found',
        code: 'CONVERSATION_NOT_FOUND',
        message: `Conversation [${conversationId}] not found.`,
      });
    }

    if (conversation.shop && conversation.shop !== shop) {
      return res.status(403).json({
        status: 'fail',
        statusCode: 403,
        error: 'Forbidden',
        code: 'STORE_ACCESS_DENIED',
        message: `Store access violation: Conversation does not belong to store [${shop}].`,
      });
    }

    const agentMessage = {
      id: `msg_agent_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
      sender: 'agent',
      text: message.trim(),
      timestamp: new Date(),
    };

    const updated = await ConversationStore.createOrUpdate(conversationId, shop, agentMessage);

    // If an associated ticket exists, synchronize message to SupportTicket as well
    const linkedTicket = await SupportTicketStore.findByConversationId(conversationId, shop);
    if (linkedTicket) {
      await SupportTicketStore.appendMessage(linkedTicket.ticketId, {
        id: agentMessage.id,
        sender: 'agent',
        senderName: req.agent.name || 'Support Specialist',
        channel: 'web_chat',
        text: message.trim(),
        status: 'delivered',
        timestamp: agentMessage.timestamp,
      });
      await SupportTicketStore.updateTicketStatus(linkedTicket.ticketId, 'agent_replied');
    }

    return res.status(200).json({
      status: 'success',
      data: updated,
    });
  } catch (err) {
    return next(err);
  }
};

const updateConversationStatus = async (req, res, next) => {
  try {
    const { conversationId } = req.params;
    const { status } = req.body;
    const shop = req.agent?.shop || config.shopify.shop;

    if (!['active', 'escalated', 'closed'].includes(status)) {
      return res.status(400).json({
        status: 'fail',
        statusCode: 400,
        error: 'Bad Request',
        code: 'INVALID_STATUS',
        message: 'Status must be one of: active, escalated, closed',
      });
    }

    const updated = await ConversationStore.updateStatus(conversationId, status, shop);
    if (!updated) {
      return res.status(404).json({
        status: 'fail',
        statusCode: 404,
        error: 'Not Found',
        code: 'CONVERSATION_NOT_FOUND',
        message: `Conversation [${conversationId}] not found.`,
      });
    }

    return res.status(200).json({
      status: 'success',
      data: updated,
    });
  } catch (err) {
    return next(err);
  }
};

// ---------------------------------------------------------------------------
// 4. WhatsApp Support Tickets Management
// ---------------------------------------------------------------------------

const listTickets = async (req, res, next) => {
  try {
    const shop = req.agent?.shop || config.shopify.shop;
    const { status, limit = 50 } = req.query;

    const tickets = await SupportTicketStore.listTickets({
      shop,
      status,
      limit: Math.min(100, Math.max(1, parseInt(limit, 10) || 50)),
    });

    // Decorate with 24-hour service window expiry flag
    const now = Date.now();
    const decorated = tickets.map((t) => {
      const doc = t.toObject ? t.toObject() : { ...t };
      const lastMsgAt = doc.lastCustomerMessageAt || doc.createdAt;
      const isWithin24h = (now - new Date(lastMsgAt).getTime()) <= 24 * 60 * 60 * 1000;
      return {
        ...doc,
        isWithin24hWindow: isWithin24h,
      };
    });

    return res.status(200).json({
      status: 'success',
      count: decorated.length,
      data: decorated,
    });
  } catch (err) {
    return next(err);
  }
};

const getTicket = async (req, res, next) => {
  try {
    const { ticketId } = req.params;
    const shop = req.agent?.shop || config.shopify.shop;

    const ticket = await SupportTicketStore.findByTicketId(ticketId, shop);
    if (!ticket) {
      return res.status(404).json({
        status: 'fail',
        statusCode: 404,
        error: 'Not Found',
        code: 'TICKET_NOT_FOUND',
        message: `Support ticket [${ticketId}] not found for store [${shop}].`,
      });
    }

    const doc = ticket.toObject ? ticket.toObject() : { ...ticket };
    const lastMsgAt = doc.lastCustomerMessageAt || doc.createdAt;
    doc.isWithin24hWindow = (Date.now() - new Date(lastMsgAt).getTime()) <= 24 * 60 * 60 * 1000;

    return res.status(200).json({
      status: 'success',
      data: doc,
    });
  } catch (err) {
    return next(err);
  }
};

const replyTicket = async (req, res, next) => {
  try {
    const { ticketId } = req.params;
    const { message, template } = req.body;
    const shop = req.agent?.shop || config.shopify.shop;
    const agentName = req.agent?.name || 'Abihacart Support Specialist';

    const replyResult = await whatsappService.sendAgentReply({
      ticketId,
      message,
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

const updateTicketStatus = async (req, res, next) => {
  try {
    const { ticketId } = req.params;
    const { status } = req.body;
    const shop = req.agent?.shop || config.shopify.shop;

    const validStatuses = ['open', 'pending_agent', 'agent_replied', 'resolved', 'closed'];
    if (!validStatuses.includes(status)) {
      return res.status(400).json({
        status: 'fail',
        statusCode: 400,
        error: 'Bad Request',
        code: 'INVALID_STATUS',
        message: `Status must be one of: ${validStatuses.join(', ')}`,
      });
    }

    const updated = await SupportTicketStore.updateTicketStatus(ticketId, status, { shop });
    if (!updated) {
      return res.status(404).json({
        status: 'fail',
        statusCode: 404,
        error: 'Not Found',
        code: 'TICKET_NOT_FOUND',
        message: `Support ticket [${ticketId}] not found.`,
      });
    }

    return res.status(200).json({
      status: 'success',
      data: updated,
    });
  } catch (err) {
    return next(err);
  }
};

const assignTicket = async (req, res, next) => {
  try {
    const { ticketId } = req.params;
    const { agentName } = req.body;
    const shop = req.agent?.shop || config.shopify.shop;

    if (!agentName || typeof agentName !== 'string' || !agentName.trim()) {
      return res.status(400).json({
        status: 'fail',
        statusCode: 400,
        error: 'Bad Request',
        code: 'MISSING_AGENT_NAME',
        message: 'Agent name is required to assign ticket.',
      });
    }

    const updated = await SupportTicketStore.assignTicket(ticketId, agentName.trim(), shop);
    if (!updated) {
      return res.status(404).json({
        status: 'fail',
        statusCode: 404,
        error: 'Not Found',
        code: 'TICKET_NOT_FOUND',
        message: `Support ticket [${ticketId}] not found.`,
      });
    }

    return res.status(200).json({
      status: 'success',
      data: updated,
    });
  } catch (err) {
    return next(err);
  }
};

// ---------------------------------------------------------------------------
// 5. AI Conversation Monitoring
// ---------------------------------------------------------------------------

const getAiMonitoring = async (req, res) => {
  const telemetry = openaiService.getAiMonitoringData();
  return res.status(200).json({
    status: 'success',
    data: telemetry,
  });
};

// ---------------------------------------------------------------------------
// 6. Knowledge Base Management
// ---------------------------------------------------------------------------

const listKnowledgeBase = async (req, res, next) => {
  try {
    const { category, search, approvalStatus } = req.query;
    const entries = await KnowledgeBaseStore.listPolicies({ category, search, approvalStatus });

    return res.status(200).json({
      status: 'success',
      count: entries.length,
      data: entries,
    });
  } catch (err) {
    return next(err);
  }
};

const createKnowledgeEntry = async (req, res, next) => {
  try {
    const { key, title, content, category } = req.body;

    if (!key || !title || !content) {
      return res.status(400).json({
        status: 'fail',
        statusCode: 400,
        error: 'Bad Request',
        code: 'MISSING_REQUIRED_FIELDS',
        message: 'key, title, and content are required.',
      });
    }

    const created = await KnowledgeBaseStore.createEntry({
      key,
      title,
      content,
      category: category || 'faq',
      author: req.agent?.username || 'admin',
    });

    logger.info(`New knowledge entry created by [${req.agent?.username}]: [${key}] (pending approval)`);

    return res.status(201).json({
      status: 'success',
      data: created,
    });
  } catch (err) {
    if (err.message.includes('already exists')) {
      return res.status(409).json({
        status: 'fail',
        statusCode: 409,
        error: 'Conflict',
        code: 'ENTRY_ALREADY_EXISTS',
        message: err.message,
      });
    }
    return next(err);
  }
};

const updateKnowledgeEntry = async (req, res, next) => {
  try {
    const { key } = req.params;
    const { title, content, category } = req.body;

    const updated = await KnowledgeBaseStore.updateEntry(key, {
      title,
      content,
      category,
      editor: req.agent?.username || 'admin',
    });

    return res.status(200).json({
      status: 'success',
      data: updated,
    });
  } catch (err) {
    if (err.message.includes('not found')) {
      return res.status(404).json({
        status: 'fail',
        statusCode: 404,
        error: 'Not Found',
        code: 'ENTRY_NOT_FOUND',
        message: err.message,
      });
    }
    return next(err);
  }
};

const deleteKnowledgeEntry = async (req, res, next) => {
  try {
    const { key } = req.params;
    const deleted = await KnowledgeBaseStore.deletePolicy(key);

    if (!deleted) {
      return res.status(404).json({
        status: 'fail',
        statusCode: 404,
        error: 'Not Found',
        code: 'ENTRY_NOT_FOUND',
        message: `Knowledge base entry [${key}] not found.`,
      });
    }

    logger.info(`Knowledge entry deleted by [${req.agent?.username}]: [${key}]`);

    return res.status(200).json({
      status: 'success',
      message: `Knowledge base entry [${key}] was deleted successfully.`,
    });
  } catch (err) {
    return next(err);
  }
};

const approveKnowledgeEntry = async (req, res, next) => {
  try {
    const { key } = req.params;
    const approved = await KnowledgeBaseStore.approvePolicy(key, req.agent?.username || 'admin');

    logger.info(`Knowledge entry explicitly approved by admin [${req.agent?.username}]: [${key}]`);

    return res.status(200).json({
      status: 'success',
      data: approved,
    });
  } catch (err) {
    return next(err);
  }
};

// ---------------------------------------------------------------------------
// 7. Store Policies Management
// ---------------------------------------------------------------------------

const listPolicies = async (req, res, next) => {
  try {
    const entries = await KnowledgeBaseStore.listPolicies();
    const policyCategories = ['shipping', 'returns', 'payments', 'store_info', 'support'];
    const policies = entries.filter((e) => policyCategories.includes(e.category));

    return res.status(200).json({
      status: 'success',
      count: policies.length,
      data: policies,
    });
  } catch (err) {
    return next(err);
  }
};

const updatePolicy = async (req, res, next) => {
  try {
    const { key } = req.params;
    const { title, content } = req.body;

    const updated = await KnowledgeBaseStore.updateEntry(key, {
      title,
      content,
      editor: req.agent?.username || 'admin',
    });

    return res.status(200).json({
      status: 'success',
      data: updated,
    });
  } catch (err) {
    return next(err);
  }
};

const publishPolicy = async (req, res, next) => {
  try {
    const { key } = req.params;
    const published = await KnowledgeBaseStore.approvePolicy(key, req.agent?.username || 'admin');

    logger.info(`Store policy published/activated by admin [${req.agent?.username}]: [${key}]`);

    return res.status(200).json({
      status: 'success',
      message: `Policy [${key}] has been approved and published to the AI Knowledge Base.`,
      data: published,
    });
  } catch (err) {
    return next(err);
  }
};

const deactivatePolicy = async (req, res, next) => {
  try {
    const { key } = req.params;
    const deactivated = await KnowledgeBaseStore.rejectPolicy(key);

    logger.info(`Store policy deactivated by admin [${req.agent?.username}]: [${key}]`);

    return res.status(200).json({
      status: 'success',
      message: `Policy [${key}] has been deactivated and set to pending/unapproved status.`,
      data: deactivated,
    });
  } catch (err) {
    return next(err);
  }
};

// ---------------------------------------------------------------------------
// 8. Team & Agent Management (Admin Only)
// ---------------------------------------------------------------------------

const listAgents = async (req, res, next) => {
  try {
    const shop = req.agent?.shop || config.shopify.shop;
    const users = await AdminUserStore.listUsers(shop);

    return res.status(200).json({
      status: 'success',
      count: users.length,
      data: users,
    });
  } catch (err) {
    return next(err);
  }
};

const createAgent = async (req, res, next) => {
  try {
    const { username, email, password, name, role = 'agent' } = req.body;
    const shop = req.agent?.shop || config.shopify.shop;

    if (!username || !email || !password || !name) {
      return res.status(400).json({
        status: 'fail',
        statusCode: 400,
        error: 'Bad Request',
        code: 'MISSING_FIELDS',
        message: 'username, email, password, and name are required.',
      });
    }

    if (password.length < 8) {
      return res.status(400).json({
        status: 'fail',
        statusCode: 400,
        error: 'Bad Request',
        code: 'PASSWORD_TOO_SHORT',
        message: 'Password must be at least 8 characters long.',
      });
    }

    const existing = await AdminUserStore.findByUsernameOrEmail(username);
    if (existing) {
      return res.status(409).json({
        status: 'fail',
        statusCode: 409,
        error: 'Conflict',
        code: 'USER_ALREADY_EXISTS',
        message: `An account with username or email [${username}] already exists.`,
      });
    }

    const passwordHash = hashPassword(password);
    const newUser = await AdminUserStore.createUser({
      username,
      email,
      passwordHash,
      name,
      role: role === 'admin' ? 'admin' : 'agent',
      isActive: true,
      shop,
    });

    const { passwordHash: _, ...safeUser } = newUser;
    logger.info(`New agent created by admin [${req.agent?.username}]: [${username}] (role: ${newUser.role})`);

    return res.status(201).json({
      status: 'success',
      data: safeUser,
    });
  } catch (err) {
    return next(err);
  }
};

const updateAgentStatus = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { isActive } = req.body;

    if (typeof isActive !== 'boolean') {
      return res.status(400).json({
        status: 'fail',
        statusCode: 400,
        error: 'Bad Request',
        code: 'INVALID_STATUS',
        message: 'isActive boolean is required.',
      });
    }

    // Prevent self-deactivation
    if (req.agent?.id === id && isActive === false) {
      return res.status(400).json({
        status: 'fail',
        statusCode: 400,
        error: 'Bad Request',
        code: 'CANNOT_DEACTIVATE_SELF',
        message: 'You cannot deactivate your own administrative account.',
      });
    }

    const updated = await AdminUserStore.updateUser(id, { isActive });
    if (!updated) {
      return res.status(404).json({
        status: 'fail',
        statusCode: 404,
        error: 'Not Found',
        code: 'USER_NOT_FOUND',
        message: `User [${id}] not found.`,
      });
    }

    const { passwordHash: _, ...safeUser } = updated;
    return res.status(200).json({
      status: 'success',
      data: safeUser,
    });
  } catch (err) {
    return next(err);
  }
};

const updateAgentRole = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { role } = req.body;

    if (!['admin', 'agent'].includes(role)) {
      return res.status(400).json({
        status: 'fail',
        statusCode: 400,
        error: 'Bad Request',
        code: 'INVALID_ROLE',
        message: 'Role must be either admin or agent.',
      });
    }

    // Prevent self-demotion
    if (req.agent?.id === id && role !== 'admin') {
      return res.status(400).json({
        status: 'fail',
        statusCode: 400,
        error: 'Bad Request',
        code: 'CANNOT_DEMOTE_SELF',
        message: 'You cannot demote your own administrative role.',
      });
    }

    const updated = await AdminUserStore.updateUser(id, { role });
    if (!updated) {
      return res.status(404).json({
        status: 'fail',
        statusCode: 404,
        error: 'Not Found',
        code: 'USER_NOT_FOUND',
        message: `User [${id}] not found.`,
      });
    }

    const { passwordHash: _, ...safeUser } = updated;
    return res.status(200).json({
      status: 'success',
      data: safeUser,
    });
  } catch (err) {
    return next(err);
  }
};

// ---------------------------------------------------------------------------
// 9. System Settings Overview (Safe / Zero Secrets)
// ---------------------------------------------------------------------------

const getSystemSettings = async (req, res) => {
  return res.status(200).json({
    status: 'success',
    data: {
      store: config.shopify.shop,
      environment: config.env,
      shopifyApiVersion: config.shopify.apiVersion,
      shopifyScopes: config.shopify.scopes,
      openaiModel: config.openai.model,
      whatsappApiVersion: config.whatsapp.apiVersion,
      status: {
        database: AdminUserStore.isDBConnected() ? 'connected' : 'hybrid_in_memory',
        shopify: 'configured_read_only',
        openai: config.openai.apiKey ? 'live_configured' : 'local_deterministic',
        whatsapp: config.whatsapp.phoneNumberId ? 'configured' : 'pending_credentials',
      },
    },
  });
};

module.exports = {
  login,
  getCurrentUser,
  logout,
  getOverview,
  getAnalytics,
  listConversations,
  getConversation,
  replyConversation,
  updateConversationStatus,
  listTickets,
  getTicket,
  replyTicket,
  updateTicketStatus,
  assignTicket,
  getAiMonitoring,
  listKnowledgeBase,
  createKnowledgeEntry,
  updateKnowledgeEntry,
  deleteKnowledgeEntry,
  approveKnowledgeEntry,
  listPolicies,
  updatePolicy,
  publishPolicy,
  deactivatePolicy,
  listAgents,
  createAgent,
  updateAgentStatus,
  updateAgentRole,
  getSystemSettings,
};
