const mongoose = require('mongoose');

const WhatsAppMessageLogSchema = new mongoose.Schema({
  messageId: {
    type: String,
    required: true,
    unique: true,
    index: true,
  },
  direction: {
    type: String,
    enum: ['inbound', 'outbound', 'status_update'],
    required: true,
  },
  ticketId: String,
  conversationId: String,
  fromMasked: String,
  toMasked: String,
  status: {
    type: String,
    default: 'received',
  },
  rawPayloadHash: String,
  createdAt: {
    type: Date,
    default: Date.now,
    expires: 30 * 24 * 60 * 60, // 30-day TTL index for automated pruning
  },
}, {
  bufferCommands: false,
});

const MongooseWhatsAppMessageLog = mongoose.model('WhatsAppMessageLog', WhatsAppMessageLogSchema);

// In-memory store for offline test execution
const memoryMessageLogs = new Set();

class WhatsAppMessageLogStore {
  static isDBConnected() {
    return mongoose.connection.readyState === 1;
  }

  static async isProcessed(messageId) {
    if (!messageId) return false;
    if (this.isDBConnected()) {
      const exists = await MongooseWhatsAppMessageLog.exists({ messageId });
      return Boolean(exists);
    }
    return memoryMessageLogs.has(messageId);
  }

  static async logMessage({ messageId, direction = 'inbound', ticketId, conversationId, fromMasked, toMasked, status = 'received', rawPayloadHash }) {
    if (!messageId) return null;

    if (this.isDBConnected()) {
      try {
        return await MongooseWhatsAppMessageLog.create({
          messageId,
          direction,
          ticketId,
          conversationId,
          fromMasked,
          toMasked,
          status,
          rawPayloadHash,
        });
      } catch (err) {
        // E11000 duplicate key error means it was already logged
        if (err.code === 11000) {
          return null;
        }
        throw err;
      }
    }

    if (memoryMessageLogs.has(messageId)) {
      return null;
    }
    memoryMessageLogs.add(messageId);
    return { messageId, direction, ticketId, status };
  }

  static async updateStatus(messageId, status) {
    if (!messageId) return null;
    if (this.isDBConnected()) {
      return MongooseWhatsAppMessageLog.findOneAndUpdate(
        { messageId },
        { $set: { status } },
        { new: true }
      );
    }
    return null;
  }

  static clearMemory() {
    memoryMessageLogs.clear();
  }
}

module.exports = MongooseWhatsAppMessageLog;
module.exports.WhatsAppMessageLogStore = WhatsAppMessageLogStore;
