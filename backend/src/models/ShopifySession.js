const mongoose = require('mongoose');

const ShopifySessionSchema = new mongoose.Schema({
  shop: {
    type: String,
    required: true,
    unique: true,
    trim: true,
    lowercase: true,
    index: true,
  },
  accessToken: {
    type: String,
    required: true,
  },
  refreshToken: {
    type: String,
    default: null,
  },
  expiresAt: {
    type: Date,
    default: null,
  },
  scope: {
    type: String,
    required: true,
  },
  isOnline: {
    type: Boolean,
    default: false,
  },
  state: {
    type: String,
    default: null,
  },
  stateExpiresAt: {
    type: Date,
    default: null,
  },
  installedAt: {
    type: Date,
    default: Date.now,
  },
  updatedAt: {
    type: Date,
    default: Date.now,
  },
}, {
  bufferCommands: false, // Prevent hanging/buffering timeouts when DB is disconnected
});

ShopifySessionSchema.pre('save', function (next) {
  this.updatedAt = new Date();
  next();
});

ShopifySessionSchema.methods.isTokenExpired = function () {
  if (!this.expiresAt) return false;
  const safetyBufferMs = 60 * 1000;
  return Date.now() >= new Date(this.expiresAt).getTime() - safetyBufferMs;
};

ShopifySessionSchema.methods.toSafeObject = function () {
  return {
    shop: this.shop,
    scope: this.scope,
    isOnline: this.isOnline,
    hasRefreshToken: Boolean(this.refreshToken),
    expiresAt: this.expiresAt,
    installedAt: this.installedAt,
    updatedAt: this.updatedAt,
  };
};

const MongooseShopifySession = mongoose.model('ShopifySession', ShopifySessionSchema);

// Resilient in-memory session cache for offline execution/unit tests
const memorySessions = new Map();

class SessionStore {
  static isDBConnected() {
    return mongoose.connection.readyState === 1;
  }

  static async findByShop(shop) {
    const normalizedShop = (shop || '').trim().toLowerCase();
    if (this.isDBConnected()) {
      return MongooseShopifySession.findOne({ shop: normalizedShop });
    }
    const mem = memorySessions.get(normalizedShop);
    if (!mem) return null;
    return new MongooseShopifySession(mem);
  }

  static async upsertSession(shop, updateData) {
    const normalizedShop = (shop || '').trim().toLowerCase();
    if (this.isDBConnected()) {
      return MongooseShopifySession.findOneAndUpdate(
        { shop: normalizedShop },
        { ...updateData, shop: normalizedShop, updatedAt: new Date() },
        { upsert: true, new: true }
      );
    }

    // In-memory update for unit testing / offline resilience
    const existing = memorySessions.get(normalizedShop) || {
      shop: normalizedShop,
      installedAt: new Date(),
    };
    const updated = {
      ...existing,
      ...updateData,
      shop: normalizedShop,
      updatedAt: new Date(),
    };
    memorySessions.set(normalizedShop, updated);
    return new MongooseShopifySession(updated);
  }

  static clearMemory() {
    memorySessions.clear();
  }
}

module.exports = MongooseShopifySession;
module.exports.SessionStore = SessionStore;
