const mongoose = require('mongoose');

const WebhookLogSchema = new mongoose.Schema({
  webhookId: {
    type: String,
    required: true,
    unique: true,
    index: true,
  },
  topic: {
    type: String,
    required: true,
  },
  shop: {
    type: String,
    required: true,
  },
  processedAt: {
    type: Date,
    default: Date.now,
    expires: 86400, // Retain for 24 hours for deduplication then auto-expire
  },
}, {
  bufferCommands: false,
});

const MongooseWebhookLog = mongoose.model('WebhookLog', WebhookLogSchema);

// In-memory set for fast deduplication check and test environments
const memoryProcessedWebhooks = new Set();

class WebhookDeduplicator {
  static isDBConnected() {
    return mongoose.connection.readyState === 1;
  }

  /**
   * Attempts to record a webhook ID. Returns true if first time processed, false if duplicate.
   * @param {Object} param
   * @param {string} param.webhookId
   * @param {string} param.topic
   * @param {string} param.shop
   * @returns {Promise<boolean>} isNew
   */
  static async recordIfNew({ webhookId, topic, shop }) {
    if (!webhookId) return true;

    // When MongoDB is connected, database persistence is strictly authoritative across all instances and restarts
    if (this.isDBConnected()) {
      try {
        await MongooseWebhookLog.create({ webhookId, topic, shop });
        memoryProcessedWebhooks.add(webhookId);
        return true;
      } catch (err) {
        if (err.code === 11000) {
          // Unique index constraint violation in MongoDB: duplicate event confirmed across cluster
          return false;
        }
        throw err;
      }
    }

    // Guard: Production multi-instance deployments must not rely on memory fallback
    if (process.env.NODE_ENV === 'production') {
      const logger = require('../utils/logger');
      logger.error('CRITICAL: MongoDB is disconnected in production. Cannot guarantee multi-instance webhook idempotency.');
      throw new Error('Database connection required for production webhook deduplication.');
    }

    // Isolated unit test / local development fallback
    if (memoryProcessedWebhooks.has(webhookId)) {
      return false; // Duplicate found in local test memory
    }

    memoryProcessedWebhooks.add(webhookId);
    return true;
  }

  static clearMemory() {
    memoryProcessedWebhooks.clear();
  }
}

module.exports = MongooseWebhookLog;
module.exports.WebhookDeduplicator = WebhookDeduplicator;
