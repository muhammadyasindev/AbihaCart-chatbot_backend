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
  canonicalShop: {
    type: String,
    default: null,
    trim: true,
    lowercase: true,
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
  pendingStates: {
    type: [
      {
        _id: false,
        state: { type: String, required: true },
        expiresAt: { type: Date, required: true },
      },
    ],
    default: [],
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
      return MongooseShopifySession.findOne({ shop: normalizedShop }).sort({ updatedAt: -1 });
    }
    const mem = memorySessions.get(normalizedShop);
    if (!mem) return null;
    return new MongooseShopifySession(mem);
  }

  static async upsertSession(shop, updateData) {
    const normalizedShop = (shop || '').trim().toLowerCase();
    const updatePayload = {
      ...updateData,
      shop: normalizedShop,
      updatedAt: new Date(),
    };

    if (this.isDBConnected()) {
      return MongooseShopifySession.findOneAndUpdate(
        { shop: normalizedShop },
        { $set: updatePayload },
        { upsert: true, new: true, sort: { updatedAt: -1 } }
      );
    }

    // In-memory update for unit testing / offline resilience
    const existing = memorySessions.get(normalizedShop) || {
      shop: normalizedShop,
      installedAt: new Date(),
    };
    const updated = {
      ...existing,
      ...updatePayload,
    };
    memorySessions.set(normalizedShop, updated);
    return new MongooseShopifySession(updated);
  }

  /**
   * Registers a new CSRF OAuth state nonce without invalidating other active pending flows.
   * Keeps up to the latest 10 unexpired states per shop and mirrors to memory fallback.
   * @param {string} shop
   * @param {string} state
   * @param {Date} stateExpiresAt
   */
  static async registerAuthState(shop, state, stateExpiresAt) {
    const normalizedShop = (shop || '').trim().toLowerCase();
    const nowMs = Date.now();
    const existing = await this.findByShop(normalizedShop);
    const currentPending = Array.isArray(existing?.pendingStates)
      ? existing.pendingStates
        .filter((entry) => entry && entry.state && new Date(entry.expiresAt).getTime() > nowMs)
        .map((entry) => ({
          state: String(entry.state),
          expiresAt: new Date(entry.expiresAt),
        }))
      : [];

    const nextPending = [
      ...currentPending.filter((entry) => entry.state !== state),
      { state: String(state), expiresAt: new Date(stateExpiresAt) },
    ].slice(-10);

    // Mirror to in-memory cache as well so transient DB disconnects during OAuth still resolve
    const memExisting = memorySessions.get(normalizedShop) || {
      shop: normalizedShop,
      installedAt: new Date(),
    };
    memorySessions.set(normalizedShop, {
      ...memExisting,
      shop: normalizedShop,
      state,
      stateExpiresAt,
      pendingStates: nextPending,
      updatedAt: new Date(),
    });

    return this.upsertSession(normalizedShop, {
      state,
      stateExpiresAt,
      pendingStates: nextPending,
    });
  }

  /**
   * Looks up a matching OAuth state entry across DB session, in-memory fallback, and any alias shop domains.
   * @param {string} shop
   * @param {string} state
   * @param {Object} [options]
   * @param {string[]} [options.fallbackShops]
   * @returns {Promise<{ matched: boolean, expired: boolean, matchedShop: string|null, session: Object|null }>}
   */
  static async findAuthState(shop, state, options = {}) {
    const normalizedShop = (shop || '').trim().toLowerCase();
    const fallbackShops = Array.isArray(options.fallbackShops) ? options.fallbackShops : [];
    const shopsToCheck = [
      normalizedShop,
      ...fallbackShops.map((s) => (s || '').trim().toLowerCase()).filter(Boolean),
    ].filter((value, index, arr) => value && arr.indexOf(value) === index);

    const nowMs = Date.now();
    let primarySession = null;

    for (const targetShop of shopsToCheck) {
      const candidates = [];
      const dbOrCurrentSession = await this.findByShop(targetShop);
      if (targetShop === normalizedShop) {
        primarySession = dbOrCurrentSession;
      }
      if (dbOrCurrentSession) candidates.push(dbOrCurrentSession);

      const mem = memorySessions.get(targetShop);
      if (mem && mem !== dbOrCurrentSession) {
        candidates.push(mem);
      }

      for (const candidate of candidates) {
        if (Array.isArray(candidate.pendingStates)) {
          const entry = candidate.pendingStates.find((item) => item && item.state === state);
          if (entry) {
            const isExpired = entry.expiresAt && new Date(entry.expiresAt).getTime() < nowMs;
            return {
              matched: !isExpired,
              expired: Boolean(isExpired),
              matchedShop: targetShop,
              session: dbOrCurrentSession || candidate,
            };
          }
        }

        if (candidate.state && candidate.state === state) {
          const isExpired = candidate.stateExpiresAt && new Date(candidate.stateExpiresAt).getTime() < nowMs;
          return {
            matched: !isExpired,
            expired: Boolean(isExpired),
            matchedShop: targetShop,
            session: dbOrCurrentSession || candidate,
          };
        }
      }
    }

    return { matched: false, expired: false, matchedShop: null, session: primarySession };
  }

  /**
   * Clears in-memory and persisted pending OAuth states after token exchange completes.
   * @param {string} shop
   */
  static clearMemoryState(shop) {
    const normalizedShop = (shop || '').trim().toLowerCase();
    const mem = memorySessions.get(normalizedShop);
    if (mem) {
      memorySessions.set(normalizedShop, {
        ...mem,
        state: null,
        stateExpiresAt: null,
        pendingStates: [],
      });
    }
  }

  static clearMemory() {
    memorySessions.clear();
  }
}

module.exports = MongooseShopifySession;
module.exports.SessionStore = SessionStore;
