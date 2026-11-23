const mongoose = require('mongoose');

const ProductCacheSchema = new mongoose.Schema({
  shop: {
    type: String,
    required: true,
    index: true,
    trim: true,
    lowercase: true,
  },
  productId: {
    type: String,
    required: true,
    index: true,
  },
  handle: {
    type: String,
    required: true,
    index: true,
  },
  title: {
    type: String,
    required: true,
    index: 'text',
  },
  description: {
    type: String,
    default: '',
  },
  productType: {
    type: String,
    default: '',
  },
  vendor: {
    type: String,
    default: '',
  },
  tags: {
    type: [String],
    default: [],
    index: true,
  },
  status: {
    type: String,
    default: 'ACTIVE',
  },
  currencyCode: {
    type: String,
    default: 'AED',
  },
  priceRange: {
    minPrice: { type: Number, default: 0 },
    maxPrice: { type: Number, default: 0 },
  },
  images: [{
    url: String,
    altText: String,
    width: Number,
    height: Number,
  }],
  variants: [{
    id: String,
    title: String,
    sku: String,
    price: Number,
    compareAtPrice: Number,
    availableForSale: Boolean,
    inventoryQuantity: Number, // Cached number, marked with isInventoryLive = false
    inventoryItemId: String,
  }],
  collections: [{
    id: String,
    title: String,
    handle: String,
  }],
  isInventoryLive: {
    type: Boolean,
    default: false, // Cached data is explicitly NOT guaranteed live stock
  },
  cachedAt: {
    type: Date,
    default: Date.now,
  },
  expiresAt: {
    type: Date,
    required: true,
    index: { expires: 0 }, // MongoDB TTL auto-cleanup
  },
}, {
  bufferCommands: false,
});

const MongooseProductCache = mongoose.model('ProductCache', ProductCacheSchema);

// In-memory fallback cache for test environments and offline scenarios
const memoryProductCache = new Map();

class ProductCacheStore {
  static isDBConnected() {
    return mongoose.connection.readyState === 1;
  }

  static async findByHandleOrId(shop, identifier) {
    const normalizedShop = (shop || '').trim().toLowerCase();
    const idStr = String(identifier).trim();

    if (this.isDBConnected()) {
      return MongooseProductCache.findOne({
        shop: normalizedShop,
        $or: [{ handle: idStr }, { productId: idStr }],
        expiresAt: { $gt: new Date() },
      });
    }

    const key = `${normalizedShop}:${idStr}`;
    const mem = memoryProductCache.get(key);
    if (!mem) return null;
    if (new Date(mem.expiresAt) <= new Date()) {
      memoryProductCache.delete(key);
      return null;
    }
    return new MongooseProductCache(mem);
  }

  static async upsert(shop, productData, ttlSeconds = 3600) {
    const normalizedShop = (shop || '').trim().toLowerCase();
    const expiresAt = new Date(Date.now() + ttlSeconds * 1000);
    const data = {
      ...productData,
      shop: normalizedShop,
      cachedAt: new Date(),
      expiresAt,
      isInventoryLive: false, // Strict rule: cached inventory is not live
    };

    if (this.isDBConnected()) {
      return MongooseProductCache.findOneAndUpdate(
        { shop: normalizedShop, productId: productData.productId },
        data,
        { upsert: true, new: true }
      );
    }

    const handleKey = `${normalizedShop}:${productData.handle}`;
    const idKey = `${normalizedShop}:${productData.productId}`;
    memoryProductCache.set(handleKey, data);
    memoryProductCache.set(idKey, data);
    return new MongooseProductCache(data);
  }

  static async invalidate(shop, identifier) {
    const normalizedShop = (shop || '').trim().toLowerCase();
    const idStr = String(identifier).trim();

    if (this.isDBConnected()) {
      return MongooseProductCache.deleteMany({
        shop: normalizedShop,
        $or: [{ handle: idStr }, { productId: idStr }],
      });
    }

    memoryProductCache.delete(`${normalizedShop}:${idStr}`);
    return true;
  }

  static async invalidateAll(shop) {
    const normalizedShop = (shop || '').trim().toLowerCase();
    if (this.isDBConnected()) {
      return MongooseProductCache.deleteMany({ shop: normalizedShop });
    }
    for (const key of memoryProductCache.keys()) {
      if (key.startsWith(`${normalizedShop}:`)) {
        memoryProductCache.delete(key);
      }
    }
    return true;
  }

  static clearMemory() {
    memoryProductCache.clear();
  }
}

module.exports = MongooseProductCache;
module.exports.ProductCacheStore = ProductCacheStore;
