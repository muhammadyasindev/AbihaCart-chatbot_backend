const mongoose = require('mongoose');
const crypto = require('crypto');
const config = require('../config/env');
const logger = require('../utils/logger');

/**
 * Hashes a plaintext password using PBKDF2 (100,000 iterations, sha512)
 * @param {string} password
 * @returns {string} Format: "salt:hash"
 */
const hashPassword = (password) => {
  if (!password || typeof password !== 'string') {
    throw new Error('Password must be a non-empty string.');
  }
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.pbkdf2Sync(password, salt, 100000, 64, 'sha512').toString('hex');
  return `${salt}:${hash}`;
};

/**
 * Verifies a plaintext password against a stored "salt:hash"
 * @param {string} password
 * @param {string} storedHash
 * @returns {boolean}
 */
const verifyPassword = (password, storedHash) => {
  if (!password || !storedHash || typeof storedHash !== 'string') return false;
  const parts = storedHash.split(':');
  if (parts.length !== 2) return false;

  const [salt, expectedHash] = parts;
  const computedHash = crypto.pbkdf2Sync(password, salt, 100000, 64, 'sha512').toString('hex');

  const expBuf = Buffer.from(expectedHash, 'hex');
  const compBuf = Buffer.from(computedHash, 'hex');

  if (expBuf.length !== compBuf.length) return false;
  return crypto.timingSafeEqual(expBuf, compBuf);
};

const AdminUserSchema = new mongoose.Schema({
  id: {
    type: String,
    required: true,
    unique: true,
    index: true,
  },
  username: {
    type: String,
    required: true,
    unique: true,
    trim: true,
    lowercase: true,
    index: true,
  },
  email: {
    type: String,
    required: true,
    unique: true,
    trim: true,
    lowercase: true,
    index: true,
  },
  passwordHash: {
    type: String,
    required: true,
    select: false, // Never returned in default queries
  },
  name: {
    type: String,
    required: true,
    trim: true,
  },
  role: {
    type: String,
    enum: ['admin', 'agent'],
    default: 'agent',
    index: true,
  },
  isActive: {
    type: Boolean,
    default: true,
    index: true,
  },
  shop: {
    type: String,
    required: true,
    default: 'abihacart.myshopify.com',
  },
  lastLoginAt: {
    type: Date,
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

AdminUserSchema.pre('save', function (next) {
  this.updatedAt = new Date();
  next();
});

const MongooseAdminUser = mongoose.model('AdminUser', AdminUserSchema);

// In-memory admin user store for offline test execution
const memoryAdminUsers = new Map();

class AdminUserStore {
  static isDBConnected() {
    return mongoose.connection.readyState === 1;
  }

  static async findById(id) {
    if (!id) return null;
    if (this.isDBConnected()) {
      return MongooseAdminUser.findOne({ id }).select('+passwordHash');
    }
    const mem = memoryAdminUsers.get(id);
    return mem ? { ...mem } : null;
  }

  static async findByUsernameOrEmail(identifier) {
    if (!identifier || typeof identifier !== 'string') return null;
    const clean = identifier.trim().toLowerCase();

    if (this.isDBConnected()) {
      return MongooseAdminUser.findOne({
        $or: [{ username: clean }, { email: clean }],
      }).select('+passwordHash');
    }

    for (const user of memoryAdminUsers.values()) {
      if (user.username === clean || user.email === clean) {
        return { ...user };
      }
    }
    return null;
  }

  static async createUser(userData) {
    const now = new Date();
    const id = userData.id || `usr_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
    const cleanUsername = (userData.username || '').trim().toLowerCase();
    const cleanEmail = (userData.email || '').trim().toLowerCase();

    if (!cleanUsername || !cleanEmail) {
      throw new Error('Username and email are required.');
    }
    if (!userData.passwordHash) {
      throw new Error('Password hash is required.');
    }

    const payload = {
      id,
      username: cleanUsername,
      email: cleanEmail,
      passwordHash: userData.passwordHash,
      name: (userData.name || cleanUsername).trim(),
      role: userData.role === 'admin' ? 'admin' : 'agent',
      isActive: userData.isActive !== false,
      shop: userData.shop || config.shopify.shop,
      createdAt: now,
      updatedAt: now,
    };

    if (this.isDBConnected()) {
      return MongooseAdminUser.create(payload);
    }

    memoryAdminUsers.set(id, payload);
    return { ...payload };
  }

  static async updateUser(id, updateData) {
    const now = new Date();
    const update = {
      ...updateData,
      updatedAt: now,
    };

    if (this.isDBConnected()) {
      return MongooseAdminUser.findOneAndUpdate(
        { id },
        { $set: update },
        { new: true }
      );
    }

    const user = memoryAdminUsers.get(id);
    if (!user) return null;
    Object.assign(user, update);
    memoryAdminUsers.set(id, user);
    return { ...user };
  }

  static async listUsers(shop = config.shopify.shop) {
    if (this.isDBConnected()) {
      return MongooseAdminUser.find({ shop }).select('-passwordHash').sort({ createdAt: -1 });
    }

    const list = Array.from(memoryAdminUsers.values())
      .filter((u) => !shop || u.shop === shop)
      .map(({ passwordHash, ...safeUser }) => safeUser);

    return list;
  }

  /**
   * Seeds an initial default admin account if none exists
   * Safe for development, testing, and production bootstrapping
   */
  static async seedDefaultAdminIfNeeded() {
    const defaultUsername = 'admin';
    const defaultEmail = 'admin@abihacart.com';
    const existing = await this.findByUsernameOrEmail(defaultUsername);

    if (existing) {
      return existing;
    }

    // In production, use configured password or generate secure random one
    const initialPassword = process.env.ADMIN_INITIAL_PASSWORD || (
      config.env === 'production'
        ? crypto.randomBytes(16).toString('hex')
        : 'Abihacart@2026!'
    );

    const passwordHash = hashPassword(initialPassword);
    const adminUser = await this.createUser({
      id: 'usr_admin_root_001',
      username: defaultUsername,
      email: defaultEmail,
      name: 'System Administrator',
      passwordHash,
      role: 'admin',
      isActive: true,
      shop: config.shopify.shop,
    });

    logger.info(`Initial admin account provisioned: [${defaultUsername}] (${defaultEmail})`);
    return adminUser;
  }

  static clearMemory() {
    memoryAdminUsers.clear();
  }
}

module.exports = MongooseAdminUser;
module.exports.AdminUserStore = AdminUserStore;
module.exports.hashPassword = hashPassword;
module.exports.verifyPassword = verifyPassword;
