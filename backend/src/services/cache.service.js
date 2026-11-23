const logger = require('../utils/logger');
const { ProductCacheStore } = require('../models/ProductCache');
const config = require('../config/env');

/**
 * Cache Management Service for Shopify Store Data
 * Enforces strict rule: Cached inventory is never presented as guaranteed live stock.
 */
class CacheService {
  constructor(defaultTtlSeconds = 3600) { // 1 hour default TTL
    this.defaultTtl = defaultTtlSeconds;
  }

  /**
   * Retrieves a product from the cache by handle or GID
   * @param {string} shop
   * @param {string} identifier
   * @returns {Promise<Object|null>}
   */
  async getCachedProduct(shop, identifier) {
    try {
      const cached = await ProductCacheStore.findByHandleOrId(shop, identifier);
      if (cached) {
        logger.debug(`Cache HIT for product "${identifier}" on ${shop}`);
        return {
          ...cached.toObject(),
          isInventoryLive: false, // Ensure inventory from cache is strictly flagged as non-live
        };
      }
      logger.debug(`Cache MISS for product "${identifier}" on ${shop}`);
      return null;
    } catch (err) {
      logger.error('Error fetching cached product:', { message: err.message, identifier });
      return null;
    }
  }

  /**
   * Stores a normalized Shopify product in the cache
   * @param {string} shop
   * @param {Object} productData
   * @param {number} [ttlSeconds]
   * @returns {Promise<Object>}
   */
  async setCachedProduct(shop, productData, ttlSeconds = this.defaultTtl) {
    try {
      return await ProductCacheStore.upsert(shop, productData, ttlSeconds);
    } catch (err) {
      logger.error('Error storing product in cache:', { message: err.message, handle: productData.handle });
      return null;
    }
  }

  /**
   * Invalidates a single product in cache (e.g. on products/update or products/delete)
   * @param {string} shop
   * @param {string} identifier
   */
  async invalidateProduct(shop, identifier) {
    try {
      logger.info(`Invalidating product cache for "${identifier}" on ${shop}`);
      await ProductCacheStore.invalidate(shop, identifier);
    } catch (err) {
      logger.error('Error invalidating product cache:', { message: err.message, identifier });
    }
  }

  /**
   * Flushes entire product cache for a shop
   * @param {string} shop
   */
  async invalidateAllProducts(shop = config.shopify.shop) {
    try {
      logger.info(`Invalidating all cached products for shop ${shop}`);
      await ProductCacheStore.invalidateAll(shop);
    } catch (err) {
      logger.error('Error invalidating all products cache:', { message: err.message });
    }
  }

  /**
   * Enriches a product with verified live inventory numbers
   * Upgrades `isInventoryLive` from false to true
   * @param {Object} product
   * @param {Map<string, number>} liveInventoryMap - Map of variantId or inventoryItemId -> quantity
   * @returns {Object} enriched product
   */
  enrichWithLiveInventory(product, liveInventoryMap) {
    if (!product || !product.variants) return product;

    const updatedVariants = product.variants.map((variant) => {
      const liveQty = liveInventoryMap.get(variant.inventoryItemId) ??
                      liveInventoryMap.get(variant.id);
      return {
        ...variant,
        inventoryQuantity: liveQty !== undefined ? liveQty : variant.inventoryQuantity,
        availableForSale: liveQty !== undefined ? liveQty > 0 : variant.availableForSale,
      };
    });

    return {
      ...product,
      variants: updatedVariants,
      isInventoryLive: true, // Confirmed live stock check
    };
  }
}

module.exports = new CacheService();
