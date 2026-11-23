const mongoose = require('mongoose');

const TicketMessageSchema = new mongoose.Schema({
  id: {
    type: String,
    required: true,
  },
  sender: {
    type: String,
    enum: ['user', 'assistant', 'agent', 'system'],
    required: true,
  },
  senderName: {
    type: String,
    default: 'Customer',
  },
  channel: {
    type: String,
    enum: ['web_chat', 'whatsapp', 'internal'],
    default: 'web_chat',
  },
  text: {
    type: String,
    required: true,
  },
  whatsappMessageId: {
    type: String,
  },
  status: {
    type: String,
    enum: ['pending', 'sent', 'delivered', 'read', 'failed', 'received'],
    default: 'received',
  },
  timestamp: {
    type: Date,
    default: Date.now,
  },
}, { _id: false });

const SupportTicketSchema = new mongoose.Schema({
  ticketId: {
    type: String,
    required: true,
    unique: true,
    index: true,
  },
  conversationId: {
    type: String,
    index: true,
  },
  shop: {
    type: String,
    required: true,
    default: 'abihacart.myshopify.com',
  },
  customer: {
    name: { type: String, default: 'Abihacart Customer' },
    phone: String,
    email: String,
    maskedPhone: String,
    maskedEmail: String,
  },
  status: {
    type: String,
    enum: ['open', 'pending_agent', 'agent_replied', 'resolved', 'closed'],
    default: 'open',
    index: true,
  },
  priority: {
    type: String,
    enum: ['low', 'medium', 'high', 'urgent'],
    default: 'medium',
  },
  source: {
    type: String,
    enum: ['web_chat', 'whatsapp'],
    default: 'web_chat',
  },
  reason: {
    type: String,
    default: 'General Support Inquiry',
  },
  whatsapp: {
    phoneNumberId: String,
    wamid: String,
    threadId: String,
    lastMessageStatus: {
      type: String,
      enum: ['sent', 'delivered', 'read', 'failed', 'received'],
    },
  },
  messages: [TicketMessageSchema],
  assignedTo: {
    type: String,
    default: 'Unassigned',
  },
  notes: String,
  lastCustomerMessageAt: {
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
  resolvedAt: Date,
}, {
  bufferCommands: false,
});

SupportTicketSchema.index({ 'customer.phone': 1, shop: 1 });
SupportTicketSchema.index({ shop: 1, status: 1 });
SupportTicketSchema.index({ 'whatsapp.wamid': 1 });
SupportTicketSchema.index({ 'messages.whatsappMessageId': 1 });

SupportTicketSchema.pre('save', function (next) {
  this.updatedAt = new Date();
  next();
});

const MongooseSupportTicket = mongoose.model('SupportTicket', SupportTicketSchema);

// In-memory support ticket store for offline test execution
const memoryTickets = new Map();

class SupportTicketStore {
  static isDBConnected() {
    return mongoose.connection.readyState === 1;
  }

  static async findByTicketId(ticketId, shop) {
    if (!ticketId) return null;
    const query = { ticketId };
    if (shop) query.shop = shop;

    if (this.isDBConnected()) {
      return MongooseSupportTicket.findOne(query);
    }
    const mem = memoryTickets.get(ticketId);
    if (!mem) return null;
    if (shop && mem.shop && mem.shop !== shop) return null;
    return new MongooseSupportTicket(mem);
  }

  static async findByConversationId(conversationId, shop) {
    if (!conversationId) return null;
    const query = { conversationId };
    if (shop) query.shop = shop;

    if (this.isDBConnected()) {
      return MongooseSupportTicket.findOne(query).sort({ createdAt: -1 });
    }
    for (const ticket of memoryTickets.values()) {
      if (ticket.conversationId === conversationId) {
        if (!shop || ticket.shop === shop) {
          return new MongooseSupportTicket(ticket);
        }
      }
    }
    return null;
  }

  static async findByCustomerPhone(phone, shop) {
    if (!phone) return null;
    const query = { 'customer.phone': phone, status: { $ne: 'closed' } };
    if (shop) query.shop = shop;

    if (this.isDBConnected()) {
      return MongooseSupportTicket.findOne(query).sort({ createdAt: -1 });
    }
    for (const ticket of memoryTickets.values()) {
      if (ticket.customer?.phone === phone && ticket.status !== 'closed') {
        if (!shop || ticket.shop === shop) {
          return new MongooseSupportTicket(ticket);
        }
      }
    }
    return null;
  }

  static async createTicket(ticketData) {
    const now = new Date();
    const payload = {
      ...ticketData,
      createdAt: now,
      updatedAt: now,
      messages: ticketData.messages || [],
    };

    if (this.isDBConnected()) {
      return MongooseSupportTicket.create(payload);
    }

    memoryTickets.set(payload.ticketId, payload);
    return new MongooseSupportTicket(payload);
  }

  static async appendMessage(ticketId, messageObj) {
    const now = new Date();
    if (this.isDBConnected()) {
      return MongooseSupportTicket.findOneAndUpdate(
        { ticketId },
        {
          $push: { messages: messageObj },
          $set: { updatedAt: now },
        },
        { new: true }
      );
    }

    const ticket = memoryTickets.get(ticketId);
    if (ticket) {
      ticket.messages = ticket.messages || [];
      ticket.messages.push(messageObj);
      ticket.updatedAt = now;
      memoryTickets.set(ticketId, ticket);
      return new MongooseSupportTicket(ticket);
    }
    return null;
  }

  static async updateTicketStatus(ticketId, status, extraFields = {}) {
    const now = new Date();
    const update = {
      status,
      updatedAt: now,
      ...extraFields,
    };
    if (status === 'resolved' || status === 'closed') {
      update.resolvedAt = now;
    }

    if (this.isDBConnected()) {
      return MongooseSupportTicket.findOneAndUpdate(
        { ticketId },
        { $set: update },
        { new: true }
      );
    }

    const ticket = memoryTickets.get(ticketId);
    if (ticket) {
      Object.assign(ticket, update);
      memoryTickets.set(ticketId, ticket);
      return new MongooseSupportTicket(ticket);
    }
    return null;
  }

  static async listTickets({ shop, status, limit = 50 } = {}) {
    if (this.isDBConnected()) {
      const query = {};
      if (status) query.status = status;
      if (shop) query.shop = shop;
      return MongooseSupportTicket.find(query).sort({ createdAt: -1 }).limit(limit);
    }
    let list = Array.from(memoryTickets.values());
    if (shop) {
      list = list.filter((t) => t.shop === shop);
    }
    if (status) {
      list = list.filter((t) => t.status === status);
    }
    list.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    return list.slice(0, limit).map((t) => new MongooseSupportTicket(t));
  }

  static async updateMessageStatusByWamid(wamid, status, shop) {
    if (!wamid) return null;
    const now = new Date();
    if (this.isDBConnected()) {
      const query = {
        $or: [
          { 'whatsapp.wamid': wamid },
          { 'messages.whatsappMessageId': wamid },
        ],
      };
      if (shop) query.shop = shop;
      return MongooseSupportTicket.findOneAndUpdate(
        query,
        {
          $set: {
            'whatsapp.lastMessageStatus': status,
            'messages.$[msg].status': status,
            updatedAt: now,
          },
        },
        {
          arrayFilters: [{ 'msg.whatsappMessageId': wamid }],
          new: true,
        }
      );
    }

    for (const ticket of memoryTickets.values()) {
      if (!shop || ticket.shop === shop) {
        let matched = false;
        if (ticket.whatsapp?.wamid === wamid) {
          ticket.whatsapp.lastMessageStatus = status;
          matched = true;
        }
        if (ticket.messages) {
          for (const msg of ticket.messages) {
            if (msg.whatsappMessageId === wamid) {
              msg.status = status;
              matched = true;
            }
          }
        }
        if (matched) {
          ticket.updatedAt = now;
          memoryTickets.set(ticket.ticketId, ticket);
          return new MongooseSupportTicket(ticket);
        }
      }
    }
    return null;
  }

  static async getTicketStats({ shop } = {}) {
    let list = [];
    if (this.isDBConnected()) {
      const query = shop ? { shop } : {};
      list = await MongooseSupportTicket.find(query);
    } else {
      list = Array.from(memoryTickets.values()).filter((t) => !shop || t.shop === shop);
    }

    let open = 0;
    let pendingAgent = 0;
    let agentReplied = 0;
    let resolved = 0;
    let closed = 0;
    let totalResponseTimeMs = 0;
    let responseCount = 0;

    for (const t of list) {
      if (t.status === 'open') open++;
      else if (t.status === 'pending_agent') pendingAgent++;
      else if (t.status === 'agent_replied') agentReplied++;
      else if (t.status === 'resolved') resolved++;
      else if (t.status === 'closed') closed++;

      // Reliable average response time: from customer message to first subsequent agent reply
      if (t.messages && t.messages.length >= 2) {
        const firstUser = t.messages.find((m) => m.sender === 'user');
        const firstAgent = t.messages.find((m) => m.sender === 'agent');
        if (firstUser?.timestamp && firstAgent?.timestamp) {
          const diff = new Date(firstAgent.timestamp).getTime() - new Date(firstUser.timestamp).getTime();
          if (diff > 0 && diff < 7 * 24 * 3600 * 1000) {
            totalResponseTimeMs += diff;
            responseCount++;
          }
        }
      }
    }

    const avgResponseTimeMinutes = responseCount > 0 ? Math.round(totalResponseTimeMs / responseCount / 60000) : 0;

    return {
      total: list.length,
      open,
      pendingAgent,
      agentReplied,
      resolved,
      closed,
      avgResponseTimeMinutes,
    };
  }

  static async assignTicket(ticketId, agentName, shop) {
    const ticket = await this.findByTicketId(ticketId, shop);
    if (!ticket) return null;
    return this.updateTicketStatus(ticketId, ticket.status, { assignedTo: agentName });
  }

  static clearMemory() {
    memoryTickets.clear();
  }
}

module.exports = MongooseSupportTicket;
module.exports.SupportTicketStore = SupportTicketStore;
