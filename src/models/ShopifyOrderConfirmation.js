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

const hashToken = (token) => {
  if (!token || typeof token !== 'string') return '';
  return crypto.createHash('sha256').update(token).digest('hex');
};

const ShopifyOrderLineItemSchema = new mongoose.Schema({
  title: { type: String, required: true },
  variantTitle: { type: String, default: '' },
  quantity: { type: Number, required: true, default: 1 },
  price: { type: Number, required: true },
  sku: { type: String, default: '' },
  image: { type: String, default: '' },
}, { _id: false });

const ShopifyOrderConfirmationSchema = new mongoose.Schema({
  shopifyOrderId: {
    type: String,
    required: true,
    unique: true,
    index: true,
  },
  orderNumber: {
    type: String,
    required: true,
    index: true,
  },
  shop: {
    type: String,
    required: true,
    default: 'abihacart.myshopify.com',
    index: true,
  },
  customerName: {
    type: String,
    required: true,
  },
  customerPhone: {
    type: String,
    default: '',
    index: true,
  },
  maskedPhone: {
    type: String,
    default: '',
  },
  customerEmail: {
    type: String,
    default: '',
  },
  lineItems: [ShopifyOrderLineItemSchema],
  subtotal: {
    type: Number,
    required: true,
  },
  shippingCharges: {
    type: Number,
    required: true,
    default: 0.00,
  },
  totalAmount: {
    type: Number,
    required: true,
  },
  currency: {
    type: String,
    default: 'AED',
  },
  shippingAddress: {
    name: { type: String, default: '' },
    address1: { type: String, default: '' },
    address2: { type: String, default: '' },
    city: { type: String, default: 'Dubai' },
    province: { type: String, default: 'Dubai' },
    country: { type: String, default: 'United Arab Emirates' },
    zip: { type: String, default: '' },
    phone: { type: String, default: '' },
  },
  status: {
    type: String,
    enum: ['pending', 'confirmed', 'cancelled', 'expired', 'failed'],
    default: 'pending',
    index: true,
  },
  confirmationToken: {
    type: String,
    required: true,
    index: true,
  },
  confirmationTokenHash: {
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
    required: true,
  },
  confirmedAt: {
    type: Date,
    default: null,
  },
  cancelledAt: {
    type: Date,
    default: null,
  },
  cancellationReason: {
    type: String,
    default: '',
  },
  cancellationStatus: {
    type: String,
    enum: ['none', 'requested', 'shopify_cancelled', 'failed'],
    default: 'none',
  },
  customerSms: {
    messageId: { type: String, default: null },
    status: { type: String, enum: ['pending', 'sent', 'failed'], default: 'pending' },
    sentAt: { type: Date, default: null },
    body: { type: String, default: null },
    error: { type: String, default: null },
  },
  ownerEmailNotification: {
    provider: { type: String, default: 'resend' },
    status: { type: String, enum: ['pending', 'accepted', 'delivered', 'failed'], default: 'pending' },
    resendMessageId: { type: String, default: null },
    recipientEmail: { type: String, default: '' },
    sentAt: { type: Date, default: null },
    error: { type: String, default: null },
    payload: { type: String, default: null },
  },
  ownerCancellationEmailNotification: {
    provider: { type: String, default: 'resend' },
    status: { type: String, enum: ['pending', 'accepted', 'delivered', 'failed'], default: 'pending' },
    resendMessageId: { type: String, default: null },
    recipientEmail: { type: String, default: '' },
    sentAt: { type: Date, default: null },
    error: { type: String, default: null },
    payload: { type: String, default: null },
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

let ShopifyOrderConfirmationModel;
try {
  ShopifyOrderConfirmationModel = mongoose.model('ShopifyOrderConfirmation', ShopifyOrderConfirmationSchema);
} catch (e) {
  ShopifyOrderConfirmationModel = mongoose.model('ShopifyOrderConfirmation');
}

// In-Memory fallback store for tests or when MongoDB is disconnected
const inMemoryConfirmations = new Map();

class ShopifyOrderConfirmationStore {
  static isDbConnected() {
    return mongoose.connection.readyState === 1;
  }

  /**
   * Generates a tamper-proof HMAC-SHA256 single-use confirmation token (default 30 min expiry)
   * Format: <shopifyOrderId>:<expiresAtMs>:<hmacHex>
   */
  static generateToken(shopifyOrderId, ttlMinutes = 30) {
    const expiresAtMs = Date.now() + ttlMinutes * 60 * 1000;
    const payload = `${shopifyOrderId}:${expiresAtMs}`;
    const secret = config.shopify.clientSecret || 'abh_shopify_order_confirm_token_secret_2026';
    const hmac = crypto.createHmac('sha256', secret).update(payload).digest('hex');
    const token = `${shopifyOrderId}:${expiresAtMs}:${hmac}`;
    const tokenHash = hashToken(token);
    return {
      token,
      tokenHash,
      expiresAt: new Date(expiresAtMs),
    };
  }

  /**
   * Verifies the cryptographic HMAC-SHA256 signature and TTL of a confirmation token
   */
  static verifyToken(token) {
    if (!token || typeof token !== 'string') {
      return { valid: false, reason: 'missing_token' };
    }

    const parts = token.split(':');
    if (parts.length !== 3) {
      return { valid: false, reason: 'malformed_token' };
    }

    const [shopifyOrderId, expiresAtStr, providedHmac] = parts;
    const expiresAtMs = parseInt(expiresAtStr, 10);

    if (isNaN(expiresAtMs)) {
      return { valid: false, reason: 'invalid_expiry_timestamp' };
    }

    if (!/^[0-9a-f]{64}$/i.test(providedHmac)) {
      return { valid: false, reason: 'invalid_signature_format', shopifyOrderId };
    }

    const payload = `${shopifyOrderId}:${expiresAtMs}`;
    const secret = config.shopify.clientSecret || 'abh_shopify_order_confirm_token_secret_2026';
    const expectedHmac = crypto.createHmac('sha256', secret).update(payload).digest('hex');

    // Constant-time comparison to prevent timing attacks
    const providedBuf = Buffer.from(providedHmac, 'hex');
    const expectedBuf = Buffer.from(expectedHmac, 'hex');

    if (providedBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(providedBuf, expectedBuf)) {
      return { valid: false, reason: 'invalid_signature', shopifyOrderId };
    }

    // Check TTL (30 min window)
    if (Date.now() > expiresAtMs) {
      return { valid: false, reason: 'token_expired', shopifyOrderId, expiredAt: new Date(expiresAtMs) };
    }

    return { valid: true, shopifyOrderId, expiresAt: new Date(expiresAtMs) };
  }

  /**
   * Creates a new pending order confirmation record
   */
  static async create(data) {
    const confirmationData = {
      ...data,
      confirmationTokenHash: data.confirmationTokenHash || hashToken(data.confirmationToken),
      maskedPhone: maskPhone(data.customerPhone),
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    if (this.isDbConnected()) {
      try {
        const doc = await ShopifyOrderConfirmationModel.create(confirmationData);
        return doc.toObject();
      } catch (err) {
        logger.warn(`MongoDB write failed, caching in memory: ${err.message}`);
      }
    }

    inMemoryConfirmations.set(String(confirmationData.shopifyOrderId), { ...confirmationData });
    return { ...confirmationData };
  }

  /**
   * Finds a confirmation record by Shopify Order ID
   */
  static async findByShopifyOrderId(shopifyOrderId) {
    const idStr = String(shopifyOrderId);
    if (this.isDbConnected()) {
      try {
        const doc = await ShopifyOrderConfirmationModel.findOne({ shopifyOrderId: idStr }).lean();
        if (doc) return doc;
      } catch (err) {
        logger.warn(`MongoDB read failed, checking in memory: ${err.message}`);
      }
    }
    return inMemoryConfirmations.get(idStr) || null;
  }

  /**
   * Finds a confirmation record by confirmation token
   */
  static async findByConfirmationToken(token) {
    if (!token) return null;
    const parts = String(token).split(':');
    const shopifyOrderId = parts[0];
    if (shopifyOrderId) {
      const record = await this.findByShopifyOrderId(shopifyOrderId);
      if (record) return record;
    }
    const tokenHash = hashToken(token);
    if (this.isDbConnected()) {
      try {
        const doc = await ShopifyOrderConfirmationModel.findOne({
          $or: [
            { confirmationToken: token },
            { confirmationTokenHash: tokenHash },
          ],
        }).lean();
        if (doc) return doc;
      } catch (err) {
        logger.warn(`MongoDB read failed: ${err.message}`);
      }
    }
    for (const record of inMemoryConfirmations.values()) {
      if (record.confirmationToken === token || record.confirmationTokenHash === tokenHash) {
        return record;
      }
    }
    return null;
  }

  /**
   * Updates a confirmation record by Shopify Order ID
   */
  static async update(shopifyOrderId, updateData) {
    const idStr = String(shopifyOrderId);
    const updates = {
      ...updateData,
      updatedAt: new Date(),
    };

    if (this.isDbConnected()) {
      try {
        const doc = await ShopifyOrderConfirmationModel.findOneAndUpdate(
          { shopifyOrderId: idStr },
          { $set: updates },
          { new: true, lean: true }
        );
        if (doc) return doc;
      } catch (err) {
        logger.warn(`MongoDB update failed, updating in memory: ${err.message}`);
      }
    }

    const existing = inMemoryConfirmations.get(idStr) || {};
    const updated = { ...existing, ...updates };
    inMemoryConfirmations.set(idStr, updated);
    return updated;
  }

  /**
   * Atomically transitions a pending record to confirmed (protects against concurrent requests)
   * Returns updated record if transition succeeded, or null if already confirmed/expired
   */
  static async atomicConfirm(shopifyOrderId, confirmedAt = new Date()) {
    const idStr = String(shopifyOrderId);
    if (this.isDbConnected()) {
      try {
        const doc = await ShopifyOrderConfirmationModel.findOneAndUpdate(
          { shopifyOrderId: idStr, status: 'pending' },
          { $set: { status: 'confirmed', confirmedAt, updatedAt: new Date() } },
          { new: true, lean: true }
        );
        if (doc) return doc;
      } catch (err) {
        logger.warn(`MongoDB atomicConfirm failed, attempting in memory: ${err.message}`);
      }
    }

    const record = inMemoryConfirmations.get(idStr);
    if (!record || record.status !== 'pending') {
      return null;
    }
    record.status = 'confirmed';
    record.confirmedAt = confirmedAt;
    record.updatedAt = new Date();
    inMemoryConfirmations.set(idStr, record);
    return { ...record };
  }

  /**
   * Atomically transitions a record to cancelled (protects against concurrent requests)
   * Only allows cancellation if status is 'pending' or 'confirmed' (not already cancelled/expired)
   */
  static async atomicCancel(shopifyOrderId, cancelledAt = new Date(), reason = 'Customer requested cancellation via popup', cancellationStatus = 'requested') {
    const idStr = String(shopifyOrderId);
    if (this.isDbConnected()) {
      try {
        const doc = await ShopifyOrderConfirmationModel.findOneAndUpdate(
          { shopifyOrderId: idStr, status: { $in: ['pending', 'confirmed'] } },
          { $set: { status: 'cancelled', cancelledAt, cancellationReason: reason, cancellationStatus, updatedAt: new Date() } },
          { new: true, lean: true }
        );
        if (doc) return doc;
      } catch (err) {
        logger.warn(`MongoDB atomicCancel failed, attempting in memory: ${err.message}`);
      }
    }

    const record = inMemoryConfirmations.get(idStr);
    if (!record || (record.status !== 'pending' && record.status !== 'confirmed')) {
      return null;
    }
    record.status = 'cancelled';
    record.cancelledAt = cancelledAt;
    record.cancellationReason = reason;
    record.cancellationStatus = cancellationStatus;
    record.updatedAt = new Date();
    inMemoryConfirmations.set(idStr, record);
    return { ...record };
  }

  /**
   * Clears in-memory store (for test suite resets)
   */
  static clear() {
    inMemoryConfirmations.clear();
  }
}

module.exports = {
  ShopifyOrderConfirmationModel,
  ShopifyOrderConfirmationStore,
  maskPhone,
  hashToken,
};
