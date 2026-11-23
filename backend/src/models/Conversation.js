const mongoose = require('mongoose');

const MessageSchema = new mongoose.Schema({
  id: {
    type: String,
    required: true,
  },
  sender: {
    type: String,
    enum: ['user', 'assistant', 'system', 'agent'],
    required: true,
  },
  text: {
    type: String,
    required: true,
  },
  productCards: [{
    id: String,
    title: String,
    handle: String,
    price: Number,
    compareAtPrice: Number,
    currencyCode: { type: String, default: 'AED' },
    imageUrl: String,
    availableForSale: Boolean,
    url: String,
  }],
  suggestions: [{
    type: String,
  }],
  timestamp: {
    type: Date,
    default: Date.now,
  },
}, { _id: false });

const ConversationSchema = new mongoose.Schema({
  conversationId: {
    type: String,
    required: true,
    unique: true,
    index: true,
  },
  shop: {
    type: String,
    required: true,
    index: true,
  },
  status: {
    type: String,
    enum: ['active', 'escalated', 'closed'],
    default: 'active',
  },
  messages: [MessageSchema],
  customer: {
    id: String,
    email: String,
    phone: String,
    name: String,
    isVerified: { type: Boolean, default: false },
  },
  lastMessageAt: {
    type: Date,
    default: Date.now,
  },
  createdAt: {
    type: Date,
    default: Date.now,
  },
  updatedAt: {
    type: Date,
    default: Date.now,
  },
}, {
  bufferCommands: false,
});

ConversationSchema.pre('save', function (next) {
  this.updatedAt = new Date();
  next();
});

const MongooseConversation = mongoose.model('Conversation', ConversationSchema);

// In-memory conversation store for offline test execution
const memoryConversations = new Map();

class ConversationStore {
  static isDBConnected() {
    return mongoose.connection.readyState === 1;
  }

  static async findByConversationId(conversationId) {
    if (!conversationId) return null;

    if (this.isDBConnected()) {
      return MongooseConversation.findOne({ conversationId });
    }

    // In production, do not silently fall back to in-memory store
    if (process.env.NODE_ENV === 'production') {
      const logger = require('../utils/logger');
      logger.error('CRITICAL: MongoDB is disconnected in production. Cannot retrieve conversation.');
      throw new Error('Database connection required for conversation retrieval in production.');
    }

    const mem = memoryConversations.get(conversationId);
    if (!mem) return null;
    return new MongooseConversation(mem);
  }

  static async createOrUpdate(conversationId, shop, messageObj) {
    const now = new Date();

    if (this.isDBConnected()) {
      return MongooseConversation.findOneAndUpdate(
        { conversationId },
        {
          $setOnInsert: { conversationId, shop, createdAt: now, status: 'active' },
          $push: { messages: messageObj },
          $set: { lastMessageAt: now, updatedAt: now },
        },
        { upsert: true, new: true }
      );
    }

    // Guard: Production multi-instance deployments must not rely on memory fallback
    if (process.env.NODE_ENV === 'production') {
      const logger = require('../utils/logger');
      logger.error('CRITICAL: MongoDB is disconnected in production. Cannot guarantee conversation persistence.');
      throw new Error('Database connection required for conversation persistence in production.');
    }

    let conv = memoryConversations.get(conversationId);
    if (!conv) {
      conv = {
        conversationId,
        shop,
        status: 'active',
        messages: [],
        createdAt: now,
        updatedAt: now,
        lastMessageAt: now,
      };
    }
    conv.messages.push(messageObj);
    conv.updatedAt = now;
    conv.lastMessageAt = now;
    memoryConversations.set(conversationId, conv);
    return new MongooseConversation(conv);
  }

  static async listConversations({ shop, status, search, page = 1, limit = 20, startDate, endDate } = {}) {
    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const limitNum = Math.min(100, Math.max(1, parseInt(limit, 10) || 20));
    const skip = (pageNum - 1) * limitNum;

    if (this.isDBConnected()) {
      const query = {};
      if (shop) query.shop = shop;
      if (status) query.status = status;
      if (startDate || endDate) {
        query.createdAt = {};
        if (startDate) query.createdAt.$gte = new Date(startDate);
        if (endDate) query.createdAt.$lte = new Date(endDate);
      }
      if (search) {
        const cleanSearch = String(search).trim();
        query.$or = [
          { conversationId: { $regex: cleanSearch, $options: 'i' } },
          { 'messages.text': { $regex: cleanSearch, $options: 'i' } },
          { 'customer.name': { $regex: cleanSearch, $options: 'i' } },
        ];
      }

      const [items, total] = await Promise.all([
        MongooseConversation.find(query).sort({ lastMessageAt: -1 }).skip(skip).limit(limitNum),
        MongooseConversation.countDocuments(query),
      ]);

      return {
        conversations: items,
        total,
        page: pageNum,
        totalPages: Math.ceil(total / limitNum) || 1,
      };
    }

    // In-memory fallback
    let list = Array.from(memoryConversations.values());
    if (shop) list = list.filter((c) => c.shop === shop);
    if (status) list = list.filter((c) => c.status === status);
    if (startDate) list = list.filter((c) => new Date(c.createdAt) >= new Date(startDate));
    if (endDate) list = list.filter((c) => new Date(c.createdAt) <= new Date(endDate));
    if (search) {
      const s = String(search).toLowerCase();
      list = list.filter(
        (c) =>
          c.conversationId.toLowerCase().includes(s) ||
          c.messages?.some((m) => m.text?.toLowerCase().includes(s)) ||
          c.customer?.name?.toLowerCase().includes(s)
      );
    }

    list.sort((a, b) => new Date(b.lastMessageAt || b.createdAt) - new Date(a.lastMessageAt || a.createdAt));
    const total = list.length;
    const items = list.slice(skip, skip + limitNum).map((c) => new MongooseConversation(c));

    return {
      conversations: items,
      total,
      page: pageNum,
      totalPages: Math.ceil(total / limitNum) || 1,
    };
  }

  static async updateStatus(conversationId, status, shop) {
    const now = new Date();
    if (this.isDBConnected()) {
      const query = { conversationId };
      if (shop) query.shop = shop;
      return MongooseConversation.findOneAndUpdate(
        query,
        { $set: { status, updatedAt: now } },
        { new: true }
      );
    }

    const conv = memoryConversations.get(conversationId);
    if (!conv) return null;
    if (shop && conv.shop && conv.shop !== shop) return null;
    conv.status = status;
    conv.updatedAt = now;
    memoryConversations.set(conversationId, conv);
    return new MongooseConversation(conv);
  }

  static async updateCustomer(conversationId, customer, shop) {
    const now = new Date();
    if (this.isDBConnected()) {
      const query = { conversationId };
      if (shop) query.shop = shop;
      return MongooseConversation.findOneAndUpdate(
        query,
        { $set: { customer, updatedAt: now } },
        { new: true }
      );
    }

    const conv = memoryConversations.get(conversationId);
    if (!conv) return null;
    if (shop && conv.shop && conv.shop !== shop) return null;
    conv.customer = customer;
    conv.updatedAt = now;
    memoryConversations.set(conversationId, conv);
    return new MongooseConversation(conv);
  }

  static async getConversationStats({ shop } = {}) {
    let list = [];
    if (this.isDBConnected()) {
      const query = shop ? { shop } : {};
      list = await MongooseConversation.find(query);
    } else {
      list = Array.from(memoryConversations.values()).filter((c) => !shop || c.shop === shop);
    }

    let total = list.length;
    let active = 0;
    let escalated = 0;
    let closed = 0;
    let aiHandled = 0;
    let humanHandled = 0;

    for (const c of list) {
      if (c.status === 'active') active++;
      if (c.status === 'escalated') escalated++;
      if (c.status === 'closed') closed++;

      const hasAgent = c.messages?.some((m) => m.sender === 'agent');
      if (hasAgent) {
        humanHandled++;
      } else {
        aiHandled++;
      }
    }

    return {
      total,
      active,
      escalated,
      closed,
      aiHandled,
      humanHandled,
    };
  }

  static clearMemory() {
    memoryConversations.clear();
  }
}

module.exports = MongooseConversation;
module.exports.ConversationStore = ConversationStore;
