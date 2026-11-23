const mongoose = require('mongoose');
const crypto = require('crypto');
const config = require('../config/env');
const logger = require('../utils/logger');

const maskPhone = (phone) => {
  if (!phone || typeof phone !== 'string') return '';
  const digits = phone.replace(/\D/g, '');
  if (digits.length >= 9) {
    const start = phone.slice(0, Math.min(phone.indexOf(digits.slice(0, 4)) + 4, 8));
    const end = phone.slice(-2);
    return `${start}*** **${end}`;
  }
  return phone.replace(/.(?=.{2})/g, '*');
};

const PendingOrderLineItemSchema = new mongoose.Schema({
  productTitle: { type: String, required: true },
  handle: { type: String, required: true },
  variantId: { type: String, required: true },
  sku: { type: String, default: '' },
  quantity: { type: Number, required: true, min: 1, default: 1 },
  price: { type: Number, required: true },
  currencyCode: { type: String, default: 'AED' },
}, { _id: false });

const PendingOrderSchema = new mongoose.Schema({
  orderReference: {
    type: String,
    required: true,
    unique: true,
    index: true,
  },
  shop: {
    type: String,
    required: true,
    default: 'abihacart.myshopify.com',
    index: true,
  },
  conversationId: {
    type: String,
    index: true,
  },
  customerName: {
    type: String,
    required: true,
  },
  customerPhone: {
    type: String,
    required: true,
    index: true,
  },
  maskedPhone: {
    type: String,
  },
  deliveryAddress: {
    street: { type: String, required: true },
    city: { type: String, default: 'Dubai' },
    emirate: { type: String, required: true, default: 'Dubai' },
    country: { type: String, default: 'AE' },
  },
  lineItems: [PendingOrderLineItemSchema],
  subtotal: {
    type: Number,
    required: true,
  },
  deliveryFee: {
    type: Number,
    required: true,
    default: 15.00,
  },
  totalAmount: {
    type: Number,
    required: true,
  },
  currency: {
    type: String,
    default: 'AED',
  },
  paymentMethod: {
    type: String,
    default: 'Cash on Delivery (COD)',
  },
  status: {
    type: String,
    enum: ['pending_confirmation', 'confirmed', 'expired', 'cancelled', 'failed'],
    default: 'pending_confirmation',
    index: true,
  },
  confirmationToken: {
    type: String,
    required: true,
    index: true,
  },
  confirmationTokenExpiresAt: {
    type: Date,
    required: true,
  },
  confirmationUrl: {
    type: String,
  },
  shopifyDraftOrderId: {
    type: String,
    default: null,
  },
  shopifyOrderId: {
    type: String,
    default: null,
  },
  shopifyOrderName: {
    type: String,
    default: null,
  },
  initialSms: {
    messageId: { type: String, default: null },
    status: { type: String, enum: ['pending', 'queued', 'sent', 'delivered', 'failed'], default: 'pending' },
    sentAt: { type: Date, default: null },
    body: { type: String, default: null },
    error: { type: String, default: null },
  },
  finalSms: {
    messageId: { type: String, default: null },
    status: { type: String, enum: ['pending', 'queued', 'sent', 'delivered', 'failed'], default: 'pending' },
    sentAt: { type: Date, default: null },
    body: { type: String, default: null },
    error: { type: String, default: null },
  },
  confirmedAt: {
    type: Date,
    default: null,
  },
  notes: {
    type: String,
    default: '',
  },
  createdAt: {
    type: Date,
    default: Date.now,
  },
  updatedAt: {
    type: Date,
    default: Date.now,
  },
});

PendingOrderSchema.pre('save', function (next) {
  if (this.customerPhone && !this.maskedPhone) {
    this.maskedPhone = maskPhone(this.customerPhone);
  }
  this.updatedAt = new Date();
  next();
});

let MongoosePendingOrder;
try {
  MongoosePendingOrder = mongoose.model('PendingOrder');
} catch (e) {
  MongoosePendingOrder = mongoose.model('PendingOrder', PendingOrderSchema);
}

/**
 * In-Memory Fallback Store for Pending Orders
 */
class MemoryPendingOrderStore {
  constructor() {
    this.orders = new Map();
  }

  async create(orderData) {
    const id = orderData.orderReference;
    const doc = {
      ...orderData,
      maskedPhone: orderData.maskedPhone || maskPhone(orderData.customerPhone),
      status: orderData.status || 'pending_confirmation',
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    this.orders.set(id, doc);
    return { ...doc };
  }

  async findByReference(orderReference) {
    const doc = this.orders.get(orderReference);
    return doc ? { ...doc } : null;
  }

  async findByToken(confirmationToken) {
    for (const doc of this.orders.values()) {
      if (doc.confirmationToken === confirmationToken) {
        return { ...doc };
      }
    }
    return null;
  }

  findByMessageId(messageId) {
    if (!messageId) return null;
    for (const doc of this.orders.values()) {
      if (doc.initialSms?.messageId === messageId || doc.finalSms?.messageId === messageId) {
        return { ...doc };
      }
    }
    return null;
  }

  async update(orderReference, updates) {
    const doc = this.orders.get(orderReference);
    if (!doc) return null;
    const updated = {
      ...doc,
      ...updates,
      updatedAt: new Date(),
    };
    this.orders.set(orderReference, updated);
    return { ...updated };
  }

  async list({ shop, status, limit = 50, skip = 0 }) {
    let all = Array.from(this.orders.values());
    if (shop) all = all.filter((o) => o.shop === shop);
    if (status) all = all.filter((o) => o.status === status);
    all.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    const total = all.length;
    const items = all.slice(skip, skip + limit);
    return { items, total };
  }

  async count(filter = {}) {
    let all = Array.from(this.orders.values());
    if (filter.status) all = all.filter((o) => o.status === filter.status);
    if (filter.shop) all = all.filter((o) => o.shop === filter.shop);
    return all.length;
  }
}

const memoryStore = new MemoryPendingOrderStore();

/**
 * Unified PendingOrderStore Interface (MongoDB with Memory Fallback)
 */
class PendingOrderStore {
  static isMongoConnected() {
    return mongoose.connection && mongoose.connection.readyState === 1;
  }

  static getSecret() {
    return config.shopify.clientSecret || 'abh_order_confirmation_secret_2026';
  }

  /**
   * Generates a tamper-proof, single-use, time-limited confirmation token
   */
  static generateToken(orderReference, ttlMinutes = 30) {
    const expiresAt = Date.now() + (ttlMinutes * 60 * 1000);
    const payload = `${orderReference}:${expiresAt}`;
    const signature = crypto
      .createHmac('sha256', this.getSecret())
      .update(payload)
      .digest('hex');
    const token = `${payload}:${signature}`;
    return {
      token,
      expiresAt: new Date(expiresAt),
    };
  }

  /**
   * Validates a confirmation token's HMAC signature and expiry
   */
  static verifyToken(token) {
    if (!token || typeof token !== 'string') {
      return { valid: false, reason: 'missing_token' };
    }
    const parts = token.split(':');
    if (parts.length !== 3) {
      return { valid: false, reason: 'malformed_token' };
    }
    const [orderReference, expiresAtStr, signature] = parts;
    const expiresAtMs = parseInt(expiresAtStr, 10);
    if (isNaN(expiresAtMs) || Date.now() > expiresAtMs) {
      return { valid: false, reason: 'token_expired', orderReference };
    }
    const payload = `${orderReference}:${expiresAtStr}`;
    const expected = crypto
      .createHmac('sha256', this.getSecret())
      .update(payload)
      .digest('hex');

    const sigBuf = Buffer.from(signature, 'utf8');
    const expBuf = Buffer.from(expected, 'utf8');
    if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) {
      return { valid: false, reason: 'invalid_signature', orderReference };
    }

    return {
      valid: true,
      orderReference,
      expiresAt: new Date(expiresAtMs),
    };
  }

  static async create(orderData) {
    if (this.isMongoConnected()) {
      try {
        const doc = new MongoosePendingOrder(orderData);
        await doc.save();
        return doc.toObject();
      } catch (err) {
        logger.warn('Failed to save PendingOrder in MongoDB, using memory store:', { error: err.message });
      }
    }
    return memoryStore.create(orderData);
  }

  static async findByReference(orderReference) {
    if (this.isMongoConnected()) {
      try {
        const doc = await MongoosePendingOrder.findOne({ orderReference });
        if (doc) return doc.toObject();
      } catch (err) {
        logger.warn('MongoDB lookup failed for PendingOrder, checking memory store:', { error: err.message });
      }
    }
    return memoryStore.findByReference(orderReference);
  }

  static async findByToken(confirmationToken) {
    if (this.isMongoConnected()) {
      try {
        const doc = await MongoosePendingOrder.findOne({ confirmationToken });
        if (doc) return doc.toObject();
      } catch (err) {
        logger.warn('MongoDB lookup failed by token, checking memory store:', { error: err.message });
      }
    }
    return memoryStore.findByToken(confirmationToken);
  }

  static async findByMessageId(messageId) {
    if (!messageId) return null;
    if (this.isMongoConnected()) {
      try {
        const doc = await MongoosePendingOrder.findOne({
          $or: [
            { 'initialSms.messageId': messageId },
            { 'finalSms.messageId': messageId },
          ],
        });
        if (doc) return doc.toObject();
      } catch (err) {
        logger.warn('MongoDB lookup failed by messageId, checking memory store:', { error: err.message });
      }
    }
    return memoryStore.findByMessageId(messageId);
  }

  static async update(orderReference, updates) {
    if (this.isMongoConnected()) {
      try {
        const doc = await MongoosePendingOrder.findOneAndUpdate(
          { orderReference },
          { $set: { ...updates, updatedAt: new Date() } },
          { new: true }
        );
        if (doc) return doc.toObject();
      } catch (err) {
        logger.warn('MongoDB update failed for PendingOrder, updating memory store:', { error: err.message });
      }
    }
    return memoryStore.update(orderReference, updates);
  }

  static async list({ shop, status, limit = 50, skip = 0 }) {
    if (this.isMongoConnected()) {
      try {
        const query = {};
        if (shop) query.shop = shop;
        if (status) query.status = status;
        const total = await MongoosePendingOrder.countDocuments(query);
        const docs = await MongoosePendingOrder.find(query)
          .sort({ createdAt: -1 })
          .skip(skip)
          .limit(limit);
        return {
          items: docs.map((d) => d.toObject()),
          total,
        };
      } catch (err) {
        logger.warn('MongoDB list failed for PendingOrder, using memory store:', { error: err.message });
      }
    }
    return memoryStore.list({ shop, status, limit, skip });
  }

  static async count(filter = {}) {
    if (this.isMongoConnected()) {
      try {
        return await MongoosePendingOrder.countDocuments(filter);
      } catch (err) {
        // Fall back to memoryStore
      }
    }
    return memoryStore.count(filter);
  }
}

module.exports = {
  PendingOrderSchema,
  MongoosePendingOrder,
  PendingOrderStore,
  maskPhone,
};
