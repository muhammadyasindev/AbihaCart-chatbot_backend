const logger = require('../utils/logger');
const cacheService = require('../services/cache.service');

/**
 * Shopify Webhook Ingress Controller
 * Strictly read-only. Verifies HMAC and processes events idempotently.
 */
const handleShopifyWebhook = async (req, res) => {
  const { topic, shop, webhookId } = req.webhookMeta;
  const payload = req.body;

  logger.info(`Received verified Shopify webhook: [${topic}] on ${shop} (Id: ${webhookId})`);

  try {
    switch (topic) {
      case 'products/update': {
        const id = payload.id;
        const handle = payload.handle;
        if (handle) await cacheService.invalidateProduct(shop, handle);
        if (id) {
          await cacheService.invalidateProduct(shop, String(id));
          await cacheService.invalidateProduct(shop, `gid://shopify/Product/${id}`);
        }
        logger.info(`Invalidated product cache from webhook [products/update] for handle: ${handle}, id: ${id}`);
        break;
      }

      case 'products/delete': {
        const id = payload.id;
        if (id) {
          await cacheService.invalidateProduct(shop, String(id));
          await cacheService.invalidateProduct(shop, `gid://shopify/Product/${id}`);
        }
        logger.info(`Removed product from cache [products/delete] id: ${id}`);
        break;
      }

      case 'inventory_levels/update': {
        const inventoryItemId = payload.inventory_item_id;
        // Invalidate all product caches or inventory tracking for shop
        await cacheService.invalidateAllProducts(shop);
        logger.info(`Invalidated cache following inventory change on item: ${inventoryItemId}`);
        break;
      }

      case 'orders/create': {
        // Strictly read-only: record event notification without modifying orders
        const orderNumber = payload.name || payload.order_number;
        logger.info(`Read-only order event acknowledged: [orders/create] Order: ${orderNumber}`);
        break;
      }

      case 'orders/updated': {
        // Strictly read-only: record fulfillment / update notification
        const orderNumber = payload.name || payload.order_number;
        logger.info(`Read-only order event acknowledged: [orders/updated] Order: ${orderNumber}`);
        break;
      }

      case 'fulfillments/create':
      case 'fulfillments/update': {
        // Strictly read-only tracking update
        const trackingNumber = payload.tracking_number;
        logger.info(`Read-only fulfillment event acknowledged: [${topic}] Tracking: ${trackingNumber || 'N/A'}`);
        break;
      }

      default:
        logger.info(`Handled unmapped webhook topic: [${topic}]`);
    }

    // Always acknowledge Shopify webhooks promptly with 200 OK
    return res.status(200).json({
      status: 'success',
      received: true,
      topic,
      webhookId,
    });
  } catch (error) {
    logger.error('Error handling Shopify webhook payload:', {
      message: error.message,
      topic,
      shop,
    });
    // Return 200 to prevent retry storms if failure is internal non-retryable
    return res.status(200).json({
      status: 'error',
      message: 'Processed with warnings',
    });
  }
};

module.exports = {
  handleShopifyWebhook,
};
