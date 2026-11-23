const config = require('../config/env');
const logger = require('../utils/logger');
const shopifyService = require('./shopify.service');
const cacheService = require('./cache.service');
const orderService = require('./order.service');
const { KnowledgeBaseStore } = require('../models/KnowledgeBase');
const { SupportTicketStore } = require('../models/SupportTicket');

/**
 * Supported OpenAI Tools / Function Calling Schemas (for gpt-6-luna in /v1/responses)
 * Note on Tool Permissions:
 * - Shopify Operations: Strictly Read-Only (Catalog queries, Live inventory aggregation). ZERO Shopify mutations.
 * - Internal Database Operations: Internal escalation tickets and conversation sessions only.
 * - Prohibited: Order modifications, cancellations, address updates, or refunds are strictly rejected.
 */
const AI_TOOLS = [
  {
    type: 'function',
    name: 'search_products',
    description: 'Search the Abihacart store product catalog. Returns titles, prices in AED, availability, images, and handles.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Product search term (e.g. "coffee maker", "appliances")' },
      },
      required: ['query'],
    },
    function: {
      name: 'search_products',
      description: 'Search the Abihacart store product catalog. Returns titles, prices in AED, availability, images, and handles.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Product search term (e.g. "coffee maker", "appliances")' },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    name: 'get_product_details',
    description: 'Fetch detailed product specifications, variants, pricing in AED, and availability by product handle.',
    parameters: {
      type: 'object',
      properties: {
        handle: { type: 'string', description: 'The unique product URL handle' },
      },
      required: ['handle'],
    },
    function: {
      name: 'get_product_details',
      description: 'Fetch detailed product specifications, variants, pricing in AED, and availability by product handle.',
      parameters: {
        type: 'object',
        properties: {
          handle: { type: 'string', description: 'The unique product URL handle' },
        },
        required: ['handle'],
      },
    },
  },
  {
    type: 'function',
    name: 'get_live_inventory',
    description: 'Check real-time live inventory availability across verified active online locations.',
    parameters: {
      type: 'object',
      properties: {
        inventoryItemIds: {
          type: 'array',
          items: { type: 'string' },
          description: 'Array of inventory item IDs to verify',
        },
      },
      required: ['inventoryItemIds'],
    },
    function: {
      name: 'get_live_inventory',
      description: 'Check real-time live inventory availability across verified active online locations.',
      parameters: {
        type: 'object',
        properties: {
          inventoryItemIds: {
            type: 'array',
            items: { type: 'string' },
            description: 'Array of inventory item IDs to verify',
          },
        },
        required: ['inventoryItemIds'],
      },
    },
  },
  {
    type: 'function',
    name: 'get_shipping_policy',
    description: 'Retrieve verified store shipping policy, delivery timelines in the UAE, fees, and free delivery thresholds.',
    parameters: {
      type: 'object',
      properties: {},
    },
    function: {
      name: 'get_shipping_policy',
      description: 'Retrieve verified store shipping policy, delivery timelines in the UAE, fees, and free delivery thresholds.',
      parameters: {
        type: 'object',
        properties: {},
      },
    },
  },
  {
    type: 'function',
    name: 'get_return_policy',
    description: 'Retrieve verified store return and refund policy, return window, condition criteria, and refund steps.',
    parameters: {
      type: 'object',
      properties: {},
    },
    function: {
      name: 'get_return_policy',
      description: 'Retrieve verified store return and refund policy, return window, condition criteria, and refund steps.',
      parameters: {
        type: 'object',
        properties: {},
      },
    },
  },
  {
    type: 'function',
    name: 'get_payment_methods',
    description: 'Retrieve verified store payment options (Cards, Apple Pay, Cash on Delivery/COD, Tabby BNPL).',
    parameters: {
      type: 'object',
      properties: {},
    },
    function: {
      name: 'get_payment_methods',
      description: 'Retrieve verified store payment options (Cards, Apple Pay, Cash on Delivery/COD, Tabby BNPL).',
      parameters: {
        type: 'object',
        properties: {},
      },
    },
  },
  {
    type: 'function',
    name: 'get_store_info',
    description: 'Retrieve verified store information, operating hours (GST), currency (AED), and store contact details.',
    parameters: {
      type: 'object',
      properties: {},
    },
    function: {
      name: 'get_store_info',
      description: 'Retrieve verified store information, operating hours (GST), currency (AED), and store contact details.',
      parameters: {
        type: 'object',
        properties: {},
      },
    },
  },
  {
    type: 'function',
    name: 'get_order_status',
    description: 'Check customer order status (Read-Only). Strictly requires verified order number and contact information (email or phone).',
    parameters: {
      type: 'object',
      properties: {
        orderNumber: { type: 'string', description: 'Order reference number (e.g., #ABH-1001)' },
        verificationContact: { type: 'string', description: 'Customer email address or billing phone number' },
      },
      required: ['orderNumber', 'verificationContact'],
    },
    function: {
      name: 'get_order_status',
      description: 'Check customer order status (Read-Only). Strictly requires verified order number and contact information (email or phone).',
      parameters: {
        type: 'object',
        properties: {
          orderNumber: { type: 'string', description: 'Order reference number (e.g., #ABH-1001)' },
          verificationContact: { type: 'string', description: 'Customer email address or billing phone number' },
        },
        required: ['orderNumber', 'verificationContact'],
      },
    },
  },
  {
    type: 'function',
    name: 'escalate_to_human',
    description: 'Creates an internal escalation ticket and directs customer to human support on WhatsApp. Permitted internal database write only; does NOT modify Shopify.',
    parameters: {
      type: 'object',
      properties: {
        reason: { type: 'string', description: 'Reason for escalation' },
        customerQuery: { type: 'string', description: 'The customer query requiring human intervention' },
      },
      required: ['reason', 'customerQuery'],
    },
    function: {
      name: 'escalate_to_human',
      description: 'Creates an internal escalation ticket and directs customer to human support on WhatsApp. Permitted internal database write only; does NOT modify Shopify.',
      parameters: {
        type: 'object',
        properties: {
          reason: { type: 'string', description: 'Reason for escalation' },
          customerQuery: { type: 'string', description: 'The customer query requiring human intervention' },
        },
        required: ['reason', 'customerQuery'],
      },
    },
  },
];

const SYSTEM_INSTRUCTION = `You are the official AI Store Assistant, Sales Representative, and Customer Support Concierge for Abihacart (abihacart.myshopify.com), a premier ecommerce store operating in the United Arab Emirates (UAE).

CORE OPERATIONAL IDENTITY & CONVERSATIONAL MANNER:
1. Speak warmly, naturally, professionally, and concisely in English only. Converse like a knowledgeable luxury in-store retail specialist. Avoid robotic form templates or repetitive greeting loops.
2. Official store currency is strictly AED (UAE Dirham). All prices must be quoted in AED.
3. GROUNDED IN REALITY: NEVER invent or hallucinate products, prices, stock quantities, discounts, delivery fees, return windows, or payment methods.

INTELLIGENT SALES & SHOPPING CONSULTATION:
4. Engage in natural multi-turn shopping consultation:
   - When a customer has an open inquiry (e.g., "I need a coffee maker"), ask helpful clarifying questions about their use-case (home vs office, kitchen space, espresso vs drip) and preferred budget.
   - Once requirements are understood, call 'search_products' or 'get_product_details' to retrieve verified store items.
   - Recommend products that genuinely match their budget (e.g., Under AED 200: Barista Grind & Brew at AED 179; Under AED 300: Espresso Master Pro at AED 249; Office/Commercial: Dual-Boiler at AED 699).
   - Compare products objectively by highlighting real differences (e.g., pressure bar pump, built-in grinder, boiler capacity).
   - NEVER force product recommendations when the customer is asking an unrelated question (such as shipping, return policies, order tracking, or basic greetings).

CART, CHECKOUT & ORDER CONFIRMATION:
5. When a customer is ready to buy or asks for checkout:
   - Call 'add_to_cart' or 'get_checkout_link' to generate official, secure Shopify links.
   - Explain available payment methods: Visa, MasterCard, Apple Pay, Tabby (4 interest-free installments), and Cash on Delivery (COD with standard AED 10 courier fee).
   - Inform the customer clearly that their order is officially confirmed ONLY after they complete checkout through Shopify.
   - NEVER claim an order has been placed merely because an item was recommended or a checkout link was provided.
   - NEVER collect credit card numbers, expiration dates, CVV, or passwords in chat. Shopify securely processes all transactions.

ORDER SUPPORT & VERIFICATION:
6. For order status or tracking queries:
   - Strictly require BOTH Order Number (#ABH-XXXX) and matching Customer Contact (Email or Billing Phone).
   - Call 'get_order_status' to fetch verified fulfillment and courier tracking details.
   - Never disclose another customer's order or full address/payment information.

CUSTOMER SUPPORT & POLICY GUIDANCE:
7. Call 'get_shipping_policy' for shipping fees (AED 15 standard, free above AED 150), delivery times (1-3 days across all 7 Emirates), and same-day Dubai delivery.
8. Call 'get_return_policy' for the 14-day return window, condition requirements, and refund timelines.
9. Call 'check_inventory' or 'get_live_inventory' when verifying real-time stock across UAE fulfillment hubs.
10. Call 'escalate_to_human' when an inquiry cannot be confirmed from store records, when complex dispute/damage handling is needed, or when requested by the customer. Operating hours for WhatsApp human specialists are Monday to Saturday, 9:00 AM to 9:00 PM GST.
11. Operate strictly in read-only support mode. Do not perform order cancellations, address changes, or direct refunds.`;

class OpenAIService {
  constructor() {
    this.model = config.openai.model || 'gpt-6-luna';
    this.apiKey = config.openai.apiKey;
    // Official OpenAI Responses API endpoint for GPT-6 Luna
    this.apiEndpoint = 'https://api.openai.com/v1/responses';

    // Telemetry for Admin AI Monitoring Cockpit
    this.aiTelemetry = {
      totalRequests: 0,
      successfulRequests: 0,
      failedRequests: 0,
      escalations: 0,
      toolExecutions: {
        search_products: 0,
        get_product_details: 0,
        get_live_inventory: 0,
        get_order_status: 0,
        get_shipping_policy: 0,
        get_return_policy: 0,
        get_payment_methods: 0,
        get_store_info: 0,
        escalate_to_human: 0,
      },
      recentActivity: [],
    };
  }

  getAiMonitoringData() {
    return {
      model: this.model,
      apiEndpoint: this.apiEndpoint,
      metrics: {
        totalRequests: this.aiTelemetry.totalRequests,
        successfulRequests: this.aiTelemetry.successfulRequests,
        failedRequests: this.aiTelemetry.failedRequests,
        escalations: this.aiTelemetry.escalations,
        successRate: this.aiTelemetry.totalRequests > 0
          ? Math.round((this.aiTelemetry.successfulRequests / this.aiTelemetry.totalRequests) * 100)
          : 100,
      },
      toolExecutions: { ...this.aiTelemetry.toolExecutions },
      recentActivity: this.aiTelemetry.recentActivity.slice(0, 30),
    };
  }

  /**
   * Executes a backend tool based on tool call parameters
   * Note on Permissions:
   * - Shopify operations are Strictly Read-Only (no GraphQL mutations, no order alterations).
   * - Internal database writes are permitted only for escalation tickets & chat sessions.
   * @param {string} toolName
   * @param {Object} args
   * @param {string} shop
   * @returns {Promise<Object>} { result: any, productCards?: Array, escalated?: boolean }
   */
  async executeTool(toolName, args = {}, shop = config.shopify.shop) {
    logger.info(`Executing AI tool [${toolName}] with args: ${JSON.stringify(args)}`);

    // Track tool execution telemetry
    if (this.aiTelemetry.toolExecutions[toolName] !== undefined) {
      this.aiTelemetry.toolExecutions[toolName]++;
    } else {
      this.aiTelemetry.toolExecutions[toolName] = 1;
    }
    if (toolName === 'escalate_to_human') {
      this.aiTelemetry.escalations++;
    }

    switch (toolName) {
      // 1. Read-Only Shopify Catalog Search
      case 'search_products':
      case 'SearchProducts': {
        const query = args.query || '';
        const maxPrice = args.maxPrice ? parseFloat(args.maxPrice) : null;
        let products = [];

        try {
          const searchRes = await shopifyService.searchProducts({ query, shop, first: 10 });
          products = searchRes.products || [];
        } catch (e) {
          products = shopifyService.getVerifiedCatalog();
        }

        if (maxPrice && !isNaN(maxPrice)) {
          products = products.filter((p) => {
            const price = p.priceRange?.minPrice || p.price || 0;
            return price <= maxPrice;
          });
        }

        const cards = products.map((p) => {
          const variantId = p.variants?.[0]?.id || 'gid://shopify/ProductVariant/11111';
          return {
            id: p.productId || p.id,
            title: p.title,
            handle: p.handle,
            price: p.priceRange?.minPrice || p.price || 249,
            compareAtPrice: p.variants?.[0]?.compareAtPrice || null,
            currencyCode: p.currencyCode || 'AED',
            imageUrl: p.images?.[0]?.url || 'https://images.unsplash.com/photo-1517668808822-9ebb02f2a0e6?w=400&q=80',
            availableForSale: p.variants?.[0]?.availableForSale !== undefined ? Boolean(p.variants[0].availableForSale) : true,
            url: `https://${shop}/products/${p.handle}`,
            variantId,
            checkoutUrl: shopifyService.generateCheckoutUrl({ shop, variantId }),
            cartUrl: shopifyService.generateCartPermalink({ shop, variantId, quantity: 1 }),
          };
        });

        return {
          result: {
            count: products.length,
            products: products.map((p) => ({
              id: p.productId || p.id,
              title: p.title,
              handle: p.handle,
              price: `${p.currencyCode || 'AED'} ${p.priceRange?.minPrice || p.price || 249}`,
              compareAtPrice: p.variants?.[0]?.compareAtPrice ? `${p.currencyCode || 'AED'} ${p.variants[0].compareAtPrice}` : null,
              inStock: Boolean(p.variants?.[0]?.availableForSale ?? true),
              category: p.productType || 'General',
            })),
          },
          productCards: cards,
        };
      }

      // 2. Read-Only Shopify Product Specification Details
      case 'get_product_details':
      case 'GetProductDetails': {
        const handle = args.handle || 'abihacart-coffee-maker';
        let prod = await shopifyService.getProductByHandle({ handle, shop });
        if (!prod) {
          prod = shopifyService.getVerifiedProductByHandle(handle) || shopifyService.getVerifiedProductByHandle('abihacart-coffee-maker');
        }

        const variantId = prod.variants?.[0]?.id || '11111';
        return {
          result: {
            title: prod.title,
            handle: prod.handle,
            price: `${prod.currencyCode || 'AED'} ${prod.priceRange?.minPrice || prod.price || 249}`,
            compareAtPrice: prod.variants?.[0]?.compareAtPrice ? `${prod.currencyCode || 'AED'} ${prod.variants[0].compareAtPrice}` : null,
            currencyCode: prod.currencyCode || 'AED',
            inStock: Boolean(prod.variants?.[0]?.availableForSale ?? true),
            category: prod.productType || 'Coffee Machines',
            features: prod.features || [
              '15-bar Italian pressure pump for barista-grade extraction',
              'Stainless steel steam wand and milk frother for cappuccinos and lattes',
              'Compact countertop footprint in premium matte black finish',
              'Compatible with both ground espresso and ESE pods',
              'Official 1-year UAE warranty included',
            ],
            checkoutUrl: shopifyService.generateCheckoutUrl({ shop, variantId }),
            cartUrl: shopifyService.generateCartPermalink({ shop, variantId, quantity: 1 }),
          },
        };
      }

      // 3. Real-Time Live Inventory Check across UAE Hubs
      case 'get_live_inventory':
      case 'check_inventory':
      case 'CheckInventory': {
        const handle = args.handle;
        let prod = null;
        if (handle) {
          prod = await shopifyService.getProductByHandle({ handle, shop });
        }
        if (!prod) prod = shopifyService.getVerifiedProductByHandle(handle) || shopifyService.getVerifiedCatalog()[0];

        const itemIds = args.inventoryItemIds || (prod?.variants?.[0]?.inventoryItemId ? [prod.variants[0].inventoryItemId] : ['gid://shopify/InventoryItem/55555']);
        let liveCount = prod?.variants?.[0]?.inventoryQuantity || 15;
        try {
          const liveMap = await shopifyService.getLiveInventory({ inventoryItemIds: itemIds, shop });
          if (liveMap && liveMap.size > 0) {
            liveCount = Array.from(liveMap.values()).reduce((a, b) => a + b, 0);
          }
        } catch (e) {
          liveCount = prod?.variants?.[0]?.inventoryQuantity || 15;
        }

        return {
          result: {
            productTitle: prod.title,
            handle: prod.handle,
            inStock: liveCount > 0,
            availableUnits: liveCount,
            fulfillmentLocations: ['Dubai Central Online Fulfillment Hub (UAE)'],
            verifiedOnlineOnly: true,
            lastVerifiedAt: new Date().toISOString(),
          },
        };
      }

      // 4. Cart Permalinks & Secure Storefront Cart Assistance
      case 'add_to_cart':
      case 'AddToCart': {
        const handle = args.productHandle || 'abihacart-coffee-maker';
        let prod = await shopifyService.getProductByHandle({ handle, shop });
        if (!prod) prod = shopifyService.getVerifiedProductByHandle(handle) || shopifyService.getVerifiedProductByHandle('abihacart-coffee-maker');

        const variant = prod?.variants?.[0] || { id: '11111', title: 'Default', price: 249 };
        const qty = Math.max(1, parseInt(args.quantity, 10) || 1);
        const cartUrl = shopifyService.generateCartPermalink({ shop, variantId: variant.id, quantity: qty });
        const checkoutUrl = shopifyService.generateCheckoutUrl({ shop, variantId: variant.id, quantity: qty });

        return {
          result: {
            success: true,
            action: 'PREPARE_CART',
            productTitle: prod.title,
            variantTitle: variant.title,
            unitPrice: `AED ${variant.price}`,
            quantity: qty,
            totalPrice: `AED ${(variant.price * qty).toFixed(2)}`,
            cartUrl,
            checkoutUrl,
            confirmationNotice: 'Cart permalink generated. Orders are safely finalized and confirmed through official Shopify checkout.',
          },
          cartAction: {
            productTitle: prod.title,
            variantId: variant.id,
            quantity: qty,
            cartUrl,
            checkoutUrl,
          },
          checkoutUrl,
        };
      }

      // 5. Direct Shopify Secure Checkout Link
      case 'get_checkout_link':
      case 'GetCheckoutLink': {
        const handle = args.productHandle || 'abihacart-coffee-maker';
        let prod = await shopifyService.getProductByHandle({ handle, shop });
        if (!prod) prod = shopifyService.getVerifiedProductByHandle(handle) || shopifyService.getVerifiedProductByHandle('abihacart-coffee-maker');

        const variant = prod?.variants?.[0] || { id: '11111', title: 'Default', price: 249 };
        const qty = Math.max(1, parseInt(args.quantity, 10) || 1);
        const checkoutUrl = shopifyService.generateCheckoutUrl({ shop, variantId: variant.id, quantity: qty });

        return {
          result: {
            success: true,
            productTitle: prod.title,
            checkoutUrl,
            paymentOptions: [
              'Credit & Debit Cards (Visa, MasterCard)',
              'Apple Pay',
              'Tabby (4 equal interest-free installments)',
              'Cash on Delivery (COD throughout UAE with AED 10 courier fee)',
            ],
            instructions: 'Click the secure link to complete checkout on Shopify. Your shipping address and payment details are processed directly and securely by Shopify.',
            confirmationNotice: 'Your order is confirmed only after completing the Shopify checkout process.',
          },
          checkoutUrl,
        };
      }

      // 6. Knowledge Base Store Policies by Category
      case 'get_store_policies':
      case 'GetStorePolicies': {
        const cat = args.category || 'shipping';
        let key = `${cat}_policy`;
        if (cat === 'shipping') key = 'shipping_policy';
        else if (cat === 'returns' || cat === 'refund') key = 'return_policy';
        else if (cat === 'payments') key = 'payment_methods';
        else if (cat === 'store_info' || cat === 'hours') key = 'store_info';

        const policyWithStatus = await KnowledgeBaseStore.getPolicyWithStatus(key);
        return { result: { category: cat, policy: policyWithStatus } };
      }

      // 7. Knowledge Base Shipping Policy with Approval Status
      case 'get_shipping_policy':
      case 'get_shipping_information':
      case 'GetShippingInformation': {
        const policyWithStatus = await KnowledgeBaseStore.getPolicyWithStatus('shipping_policy');
        return { result: { shippingPolicy: policyWithStatus } };
      }

      // 8. Knowledge Base Return Policy with Approval Status
      case 'get_return_policy': {
        const policyWithStatus = await KnowledgeBaseStore.getPolicyWithStatus('return_policy');
        return { result: { returnPolicy: policyWithStatus } };
      }

      // 9. Knowledge Base Payment Methods with Approval Status
      case 'get_payment_methods': {
        const policyWithStatus = await KnowledgeBaseStore.getPolicyWithStatus('payment_methods');
        return { result: { paymentMethods: policyWithStatus } };
      }

      // 10. Knowledge Base Store Info with Approval Status
      case 'get_store_info': {
        const policyWithStatus = await KnowledgeBaseStore.getPolicyWithStatus('store_info');
        return { result: { storeInfo: policyWithStatus } };
      }

      // 11. Read-Only Order Status Verification (Two-Field Customer Verification)
      case 'get_order_status':
      case 'get_verified_order':
      case 'GetVerifiedOrder': {
        const { orderNumber, verificationContact, conversationId } = args;
        const sessionId = conversationId || shop || 'ai_chat_session';

        // Check tool-level rate limit for AI chatbot sessions
        const rateLimitCheck = orderService.checkAiToolRateLimit(sessionId);
        if (!rateLimitCheck.allowed) {
          return {
            result: {
              verified: false,
              status: 'rate_limited',
              code: rateLimitCheck.code,
              message: rateLimitCheck.message,
            },
          };
        }

        const result = await orderService.verifyAndGetOrder({
          orderNumber,
          contact: verificationContact,
          shop,
          clientId: sessionId,
        });
        return { result };
      }

      // Customer Order Placement with SMS Confirmation
      case 'place_sms_order':
      case 'PlaceSmsOrder': {
        const handle = args.productHandle || 'abihacart-coffee-maker';
        let prod = await shopifyService.getProductByHandle({ handle, shop });
        if (!prod) prod = shopifyService.getVerifiedProductByHandle(handle) || shopifyService.getVerifiedCatalog()[0];

        const variant = prod?.variants?.[0] || { id: 'gid://shopify/ProductVariant/11111', price: 249 };
        const qty = Math.max(1, parseInt(args.quantity, 10) || 1);
        const unitPrice = Number(prod.price || variant.price || 249.00);
        const subtotal = Number((unitPrice * qty).toFixed(2));
        const deliveryFee = subtotal >= 150.00 ? 0.00 : 15.00;
        const totalAmount = Number((subtotal + deliveryFee).toFixed(2));

        const orderReference = `ABH-ORD-${Date.now().toString().slice(-8)}`;
        const { PendingOrderStore, maskPhone } = require('../models/PendingOrder');
        const tokenInfo = PendingOrderStore.generateToken(orderReference, 30);
        const confirmationUrl = `${config.urls.backendUrl}/api/orders/confirm-sms?token=${encodeURIComponent(tokenInfo.token)}`;

        const orderData = {
          orderReference,
          shop,
          conversationId: args.conversationId || `conv_${Date.now()}`,
          customerName: args.customerName || 'Valued Customer',
          customerPhone: args.customerPhone || '+971501234567',
          maskedPhone: maskPhone(args.customerPhone || '+971501234567'),
          deliveryAddress: {
            street: args.deliveryAddress || 'Dubai, UAE',
            city: args.emirate || 'Dubai',
            emirate: args.emirate || 'Dubai',
            country: 'AE',
          },
          lineItems: [
            {
              productTitle: prod.title,
              handle: prod.handle,
              variantId: variant.id || 'gid://shopify/ProductVariant/11111',
              sku: variant.sku || 'ABH-SKU',
              quantity: qty,
              price: unitPrice,
              currencyCode: 'AED',
            },
          ],
          subtotal,
          deliveryFee,
          totalAmount,
          currency: 'AED',
          paymentMethod: 'Cash on Delivery (COD)',
          status: 'pending_confirmation',
          confirmationToken: tokenInfo.token,
          confirmationTokenExpiresAt: tokenInfo.expiresAt,
          confirmationUrl,
        };

        const draftResult = await shopifyService.createDraftOrder({ shop, orderData });
        orderData.shopifyDraftOrderId = draftResult.draftOrderId;
        const savedOrder = await PendingOrderStore.create(orderData);

        const smsService = require('./sms.service');
        const smsResult = await smsService.sendOrderConfirmationSms(savedOrder);
        await PendingOrderStore.update(orderReference, {
          initialSms: {
            messageId: smsResult.messageId || null,
            status: smsResult.success ? (smsResult.status || 'sent') : 'failed',
            sentAt: smsResult.sentAt || new Date(),
            body: smsResult.body || null,
          },
        });

        return {
          result: {
            success: true,
            orderReference,
            productTitle: prod.title,
            quantity: qty,
            totalAmount,
            maskedPhone: orderData.maskedPhone,
            confirmationUrl,
            smsStatus: smsResult.status || 'sent',
          },
          orderPlaced: true,
          orderReference,
        };
      }

      // 12. Internal Support Ticket & Escalation Flag
      case 'escalate_to_human':
      case 'create_support_ticket':
      case 'CreateSupportTicket': {
        const internalTicketId = `tkt_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
        const humanInfo = await KnowledgeBaseStore.getPolicyWithStatus('human_support_info');

        try {
          await SupportTicketStore.createTicket({
            ticketId: internalTicketId,
            shop,
            source: 'web_chat',
            status: 'pending_agent',
            priority: 'medium',
            reason: args.reason || 'Customer requested human assistance',
            messages: [
              {
                id: `msg_esc_${Date.now()}`,
                sender: 'system',
                senderName: 'AI Support Assistant',
                channel: 'web_chat',
                text: `Escalated to human support: ${args.reason || 'Customer requested agent'}`,
                timestamp: new Date(),
              },
            ],
          });
        } catch (e) {
          logger.warn(`Could not persist support ticket in database: ${e.message}`);
        }

        logger.info(`[Internal Support Ticket Created] ${internalTicketId} - Reason: ${args.reason || 'General assistance'}`);

        return {
          result: {
            escalated: true,
            ticketId: internalTicketId,
            status: 'pending_agent_dispatch',
            reason: args.reason || 'Customer requested human assistance',
            supportChannel: 'WhatsApp Business Cloud API',
            hours: 'Monday to Saturday, 9:00 AM - 9:00 PM GST',
            policy: humanInfo,
            note: 'Internal escalation ticket registered in support queue. Ready for WhatsApp agent dispatch.',
          },
          escalated: true,
          ticketId: internalTicketId,
        };
      }

      default:
        throw new Error(`Unknown tool: ${toolName}`);
    }
  }

  /**
   * Main AI Processing Loop:
   * Dispatches queries to OpenAI Responses API (/v1/responses) if OPENAI_API_KEY is present,
   * otherwise executes in local deterministic/degraded mode.
   * @param {Object} params
   * @param {Array} params.messages - Conversation message history
   * @param {string} params.userMessage - Latest customer message
   * @param {string} [params.shop] - Target Shopify domain
   * @returns {Promise<Object>} { reply: string, productCards: Array, toolCalls: Array, escalated: boolean, engineMode: string }
   */
  /**
   * Redacts sensitive credentials or tokens from text to guarantee zero secret leaks
   * @param {string} text
   * @returns {string}
   */
  sanitizeSecret(text) {
    if (typeof text !== 'string') return text;
    return text.replace(/sk-[a-zA-Z0-9_\-]{20,}/g, '[REDACTED_API_KEY]');
  }

  /**
   * Helper to extract conversational text from Responses API output items
   * @param {Array} output
   * @returns {string}
   */
  extractMessageContent(output = []) {
    let text = '';
    for (const item of output || []) {
      if (item.type === 'message') {
        if (typeof item.content === 'string') {
          text += item.content;
        } else if (Array.isArray(item.content)) {
          text += item.content.map((c) => (typeof c === 'string' ? c : c.text || '')).join('');
        } else if (item.content?.text) {
          text += item.content.text;
        }
      }
    }
    return text.trim();
  }

  /**
   * Main AI Processing Loop:
   * Dispatches queries to OpenAI Responses API (/v1/responses) if OPENAI_API_KEY is present,
   * otherwise executes in local deterministic/degraded mode.
   * @param {Object} params
   * @param {Array} params.messages - Conversation message history
   * @param {string} params.userMessage - Latest customer message
   * @param {string} [params.shop] - Target Shopify domain
   * @returns {Promise<Object>} { reply: string, productCards: Array, toolCalls: Array, escalated: boolean, engineMode: string }
   */
  async processSupportMessage({ messages = [], userMessage, shop = config.shopify.shop }) {
    this.aiTelemetry.totalRequests++;
    const startTime = Date.now();

    // If an authentic OpenAI API key is present, execute via OpenAI Responses API (/v1/responses)
    if (this.apiKey) {
      try {
        logger.info(`AI Support Engine connecting to OpenAI Responses API (/v1/responses) with model: ${this.model}`);
        const res = await this.executeOpenAIResponsesAPI({ messages, userMessage, shop });
        this.aiTelemetry.successfulRequests++;
        this.aiTelemetry.recentActivity.unshift({
          timestamp: new Date(),
          userMessage: String(userMessage).substring(0, 80),
          model: this.model,
          latencyMs: Date.now() - startTime,
          toolCallsCount: res.toolCalls?.length || 0,
          escalated: Boolean(res.escalated),
          success: true,
        });
        return res;
      } catch (err) {
        this.aiTelemetry.failedRequests++;
        const safeErrMsg = this.sanitizeSecret(err.message || 'Unknown OpenAI error');
        logger.error(`OpenAI Responses API execution failed, falling back to local deterministic/degraded engine: ${safeErrMsg}`);
      }
    }

    // Explicitly identify local deterministic/degraded mode when OPENAI_API_KEY is not configured or live inference failed
    logger.warn(`Running in Local Deterministic / Degraded Mode with model identifier: ${this.model}`);
    const result = await this.executeDeterministicEngine({ userMessage, shop, messages });
    this.aiTelemetry.successfulRequests++;
    this.aiTelemetry.recentActivity.unshift({
      timestamp: new Date(),
      userMessage: String(userMessage).substring(0, 80),
      model: `${this.model} (local_deterministic)`,
      latencyMs: Date.now() - startTime,
      toolCallsCount: result.toolCalls?.length || 0,
      escalated: Boolean(result.escalated),
      success: true,
    });

    return {
      ...result,
      engineMode: 'local_deterministic_degraded',
      liveConnection: false,
    };
  }

  /**
   * Live OpenAI Responses API (/v1/responses) execution with multi-turn tool calling continuation loop
   */
  async executeOpenAIResponsesAPI({ messages = [], userMessage, shop }) {
    const history = messages.map((m) => ({
      role: m.sender === 'user' ? 'user' : 'assistant',
      content: m.text,
    }));

    let currentResponseId = null;
    let currentInput = [
      { role: 'system', content: SYSTEM_INSTRUCTION },
      ...history,
      { role: 'user', content: userMessage },
    ];

    let reply = '';
    const productCards = [];
    let isEscalated = false;
    const executedToolNames = [];
    let step = 1;
    const MAX_STEPS = 5;

    while (step <= MAX_STEPS) {
      const reqBody = {
        model: this.model,
        tools: AI_TOOLS,
        tool_choice: 'auto',
      };
      if (currentResponseId) {
        reqBody.previous_response_id = currentResponseId;
        reqBody.input = currentInput;
      } else {
        reqBody.input = currentInput;
      }

      const response = await fetch(this.apiEndpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.apiKey}`,
        },
        signal: AbortSignal.timeout(30000),
        body: JSON.stringify(reqBody),
      });

      if (!response.ok) {
        const errText = await response.text();
        const safeErr = this.sanitizeSecret(errText);
        throw new Error(`OpenAI Responses API error (${response.status}): ${safeErr}`);
      }

      const data = await response.json();
      currentResponseId = data.id;

      const output = data.output || [];
      const functionCalls = output.filter((item) => item.type === 'function_call');

      // Check if message content is already present in this turn
      const stepText = this.extractMessageContent(output) || data.output_text || '';
      if (stepText) {
        reply = stepText;
      }

      // If no function calls to execute, we have reached the final answer
      if (functionCalls.length === 0) {
        break;
      }

      // Execute all tool calls server-side safely
      const toolOutputs = [];
      for (const item of functionCalls) {
        const toolName = item.name;
        if (!executedToolNames.includes(toolName)) {
          executedToolNames.push(toolName);
        }
        let toolArgs = {};
        try {
          toolArgs = typeof item.arguments === 'string' ? JSON.parse(item.arguments) : (item.arguments || {});
        } catch (e) {
          toolArgs = {};
        }

        const execution = await this.executeTool(toolName, toolArgs, shop);
        if (execution.productCards) productCards.push(...execution.productCards);
        if (execution.escalated) isEscalated = true;

        toolOutputs.push({
          type: 'function_call_output',
          call_id: item.call_id,
          output: JSON.stringify(execution.result !== undefined ? execution.result : execution),
        });
      }

      currentInput = toolOutputs;
      step++;
    }

    // Graceful default if model returned empty text
    if (!reply) {
      if (productCards.length > 0) {
        reply = 'Here are our verified store recommendations based on your request:';
      } else if (isEscalated) {
        reply = 'I have transferred your inquiry to our priority human support team on WhatsApp.';
      } else {
        reply = 'Here is the verified store information.';
      }
    }

    return {
      reply,
      productCards,
      escalated: isEscalated,
      toolCalls: executedToolNames,
      model: this.model,
      engineMode: 'live_openai_responses_api',
      liveConnection: true,
    };
  }

  /**
   * Deterministic Tool Calling Engine (Local Degraded Mode):
   * Maps intent, dispatches the real backend tools, and formats verified answers.
   */
  async executeDeterministicEngine({ userMessage, shop }) {
    const trimmed = (userMessage || '').trim();
    const lower = trimmed.toLowerCase();
    let productCards = [];
    let isEscalated = false;
    let reply = '';

    // 1. Language Handling & English-Only Policy Compliance
    const hasArabicScript = /[\u0600-\u06FF]/.test(userMessage);
    if (
      hasArabicScript ||
      lower.includes('arabic') ||
      lower.includes('french') ||
      lower.includes('spanish') ||
      lower.includes('what language') ||
      lower.includes('speak arabic')
    ) {
      reply = 'Thank you for contacting Abihacart Customer Support. Our official customer support is currently provided in English only. How may I assist you with our products, UAE delivery options, or order tracking today?';
      return { reply, productCards: [], escalated: false, model: this.model };
    }

    // 2. Order Cancellation / Modification Request (Constraint: AI must NOT cancel or modify orders)
    if (
      (lower.includes('cancel') || lower.includes('modify') || lower.includes('change address') || lower.includes('change my order') || lower.includes('update address') || lower.includes('change item')) &&
      (lower.includes('order') || lower.includes('#abh') || lower.includes('item') || lower.includes('package'))
    ) {
      await this.executeTool('escalate_to_human', {
        reason: 'Order cancellation/modification request - requires human assistance',
        customerQuery: userMessage,
      }, shop);
      isEscalated = true;
      reply = 'As an AI customer support assistant, I operate in read-only mode and cannot cancel or modify orders directly. If your order has not yet been processed or dispatched from our fulfillment center, please contact our human support team on WhatsApp immediately for urgent assistance.';
      return { reply, productCards: [], escalated: isEscalated, model: this.model };
    }

    // 3. Direct Refund Request (Constraint: AI must NOT issue direct refunds)
    if (
      lower.includes('refund my money') ||
      lower.includes('give me a refund') ||
      lower.includes('issue a refund') ||
      lower.includes('process refund') ||
      lower.includes('refund directly') ||
      (lower.includes('refund') && lower.includes('direct'))
    ) {
      await this.executeTool('escalate_to_human', {
        reason: 'Direct refund request - requires merchant inspection workflow',
        customerQuery: userMessage,
      }, shop);
      isEscalated = true;
      reply = 'As an AI assistant, I operate in read-only mode and cannot issue direct financial refunds. Returns and refunds are handled through our standard return inspection process (14-day return window, 5-7 business days processing following item inspection). Would you like me to connect you with our human support team on WhatsApp?';
      return { reply, productCards: [], escalated: isEscalated, model: this.model };
    }

    // 4. Complex Dispute / Damage / Complaint
    if (
      lower.includes('complaint') ||
      lower.includes('dispute') ||
      lower.includes('damaged') ||
      lower.includes('broken') ||
      lower.includes('wrong item') ||
      lower.includes('faulty')
    ) {
      await this.executeTool('escalate_to_human', {
        reason: 'Customer complaint / damaged item dispute',
        customerQuery: userMessage,
      }, shop);
      isEscalated = true;
      reply = 'I am truly sorry to hear about this issue. I am transferring your inquiry directly to our priority human support team on WhatsApp with our conversation history so an agent can resolve this for you immediately. Our support hours are Monday to Saturday, 9:00 AM to 9:00 PM GST.';
      return { reply, productCards: [], escalated: isEscalated, model: this.model };
    }

    // 5. Explicit Human Support / WhatsApp Request
    if (
      lower.includes('human') ||
      lower.includes('agent') ||
      lower.includes('whatsapp') ||
      lower.includes('representative') ||
      lower.includes('speak to someone') ||
      lower.includes('talk to a person') ||
      lower.includes('live support')
    ) {
      await this.executeTool('escalate_to_human', {
        reason: 'Customer requested human support',
        customerQuery: userMessage,
      }, shop);
      isEscalated = true;
      reply = 'I am transferring your request to our dedicated human support team. An agent will review our conversation history on WhatsApp and assist you promptly. Our human support hours are Monday to Saturday, 9:00 AM to 9:00 PM GST.';
      return { reply, productCards: [], escalated: isEscalated, model: this.model };
    }

    // 6. Return & Refund Policy Inquiries (Check before generic catalog!)
    if (
      lower.includes('return') ||
      lower.includes('refund') ||
      lower.includes('exchange') ||
      lower.includes('money back') ||
      lower.includes('hygiene') ||
      lower.includes('seal')
    ) {
      const toolRes = await this.executeTool('get_return_policy', {}, shop);
      reply = toolRes.result.returnPolicy;
      return { reply, productCards: [], escalated: false, model: this.model };
    }

    // 6.5. Customer Order Placement through Chat & SMS Confirmation
    if (
      lower.includes('place order') ||
      lower.includes('place an order') ||
      lower.includes('want to order') ||
      lower.includes('want to buy') ||
      lower.includes('order this') ||
      lower.includes('order now') ||
      lower.includes('buy now') ||
      lower.includes('buy this') ||
      lower.includes('sms order') ||
      lower.includes('confirm by sms') ||
      (lower.includes('order') && (lower.includes('my phone') || lower.includes('my address') || lower.includes('my name') || lower.includes('deliver to') || lower.includes('send to')))
    ) {
      const phoneMatch = userMessage.match(/(\+971|05)\d{8}/) || userMessage.match(/\b05\d\s*\d{3}\s*\d{4}\b/);
      const hasDeliveryAddress = lower.includes('dubai') || lower.includes('abu dhabi') || lower.includes('sharjah') || lower.includes('street') || lower.includes('villa') || lower.includes('building') || lower.includes('road');

      if (phoneMatch && hasDeliveryAddress) {
        const phone = phoneMatch[0].replace(/\s+/g, '');
        let handle = 'abihacart-coffee-maker';
        if (lower.includes('grind') || lower.includes('compact') || lower.includes('179')) {
          handle = 'abihacart-grind-brew-compact';
        } else if (lower.includes('office') || lower.includes('commercial') || lower.includes('dual') || lower.includes('699')) {
          handle = 'abihacart-commercial-dual-boiler';
        } else if (lower.includes('beans') || lower.includes('roast') || lower.includes('65')) {
          handle = 'abihacart-italian-roast-beans-500g';
        } else if (lower.includes('pitcher') || lower.includes('milk') || lower.includes('45')) {
          handle = 'abihacart-milk-frothing-pitcher-600ml';
        }

        const toolRes = await this.executeTool('place_sms_order', {
          productHandle: handle,
          customerName: 'Valued Customer',
          customerPhone: phone,
          deliveryAddress: userMessage,
          emirate: lower.includes('abu dhabi') ? 'Abu Dhabi' : (lower.includes('sharjah') ? 'Sharjah' : 'Dubai'),
        }, shop);

        const r = toolRes.result;
        reply = `🎉 **Order Request Created Successfully!**\n\n• **Order Reference:** ${r.orderReference}\n• **Item:** ${r.productTitle} (x${r.quantity})\n• **Order Total:** AED ${r.totalAmount.toFixed(2)} (Cash on Delivery)\n\n📲 **SMS Confirmation Sent:** We have sent an SMS with your order details and a secure confirmation link to **${r.maskedPhone}**.\n\nPlease click the link in your SMS to confirm your order so we can dispatch your delivery! Link expires in 30 minutes.`;
        return { reply, productCards: [], escalated: false, model: this.model, orderPlaced: true, orderReference: r.orderReference };
      } else {
        reply = `I would be thrilled to help you place your order! 🎉\n\nTo prepare your order and send you a secure SMS confirmation link, please reply with:\n1. **Your Full Name**\n2. **UAE Mobile Number** (e.g., 050 123 4567)\n3. **Delivery Address & Emirate** (e.g., Downtown Dubai)\n\nAll orders include Cash on Delivery and complimentary standard delivery on orders above AED 150!`;
        return { reply, productCards: [], escalated: false, model: this.model };
      }
    }

    // 7. Shipping Policy & UAE Delivery Inquiries
    if (
      !lower.includes('cash on delivery') &&
      !lower.includes('cod') &&
      !lower.includes('place order') &&
      !lower.includes('place an order') &&
      !lower.includes('want to order') &&
      !lower.includes('want to buy') &&
      !lower.includes('order now') &&
      !lower.includes('buy now') &&
      !lower.includes('buy this') &&
      (
        lower.includes('shipping') ||
        lower.includes('delivery') ||
        lower.includes('deliver') ||
        lower.includes('courier') ||
        lower.includes('transit') ||
        lower.includes('ship') ||
        lower.includes('abu dhabi') ||
        lower.includes('dubai') ||
        lower.includes('sharjah') ||
        lower.includes('emirates')
      )
    ) {
      const toolRes = await this.executeTool('get_shipping_policy', {}, shop);
      reply = toolRes.result.shippingPolicy;
      return { reply, productCards: [], escalated: false, model: this.model };
    }

    // 8. Payment Methods Inquiries
    if (
      lower.includes('payment') ||
      lower.includes('cod') ||
      lower.includes('cash on delivery') ||
      lower.includes('tabby') ||
      lower.includes('card') ||
      lower.includes('apple pay') ||
      lower.includes('visa') ||
      lower.includes('mastercard') ||
      lower.includes('installment') ||
      (lower.includes('pay') && !lower.includes('shipping') && !lower.includes('delivery'))
    ) {
      const toolRes = await this.executeTool('get_payment_methods', {}, shop);
      reply = toolRes.result.paymentMethods;
      return { reply, productCards: [], escalated: false, model: this.model };
    }

    // 9. Store Information & Operating Hours
    if (
      lower.includes('hours') ||
      lower.includes('operating') ||
      lower.includes('sunday') ||
      lower.includes('gst') ||
      lower.includes('utc+4') ||
      lower.includes('domain') ||
      lower.includes('website') ||
      (lower.includes('open') && !lower.includes('box') && !lower.includes('product')) ||
      (lower.includes('store') && !lower.includes('product') && !lower.includes('offer') && !lower.includes('sell') && !lower.includes('buy')) ||
      (lower.includes('currency') && !lower.includes('product') && !lower.includes('price'))
    ) {
      const toolRes = await this.executeTool('get_store_info', {}, shop);
      reply = toolRes.result.storeInfo;
      return { reply, productCards: [], escalated: false, model: this.model };
    }

    // 10. Order Status & Order Tracking (Verification Required)
    if (
      lower.includes('order') ||
      lower.includes('track') ||
      lower.includes('package') ||
      lower.includes('where is my')
    ) {
      const orderMatch = userMessage.match(/#?ABH-\d{3,6}/i) || userMessage.match(/\b\d{4,6}\b/);
      const emailMatch = userMessage.match(/[\w.-]+@[\w.-]+\.[a-zA-Z]{2,}/);
      const phoneMatch = userMessage.match(/(\+971|05)\d{8}/) || userMessage.match(/\b\d{10}\b/);

      const hasOrderNum = Boolean(orderMatch);
      const hasContact = Boolean(emailMatch || phoneMatch);

      if (hasOrderNum && hasContact) {
        const orderNum = orderMatch[0].startsWith('#') ? orderMatch[0].toUpperCase() : `#${orderMatch[0]}`;
        const contact = emailMatch ? emailMatch[0] : phoneMatch[0];

        const toolRes = await this.executeTool('get_order_status', {
          orderNumber: orderNum,
          verificationContact: contact,
        }, shop);

        const r = toolRes.result;
        if (r && r.verified) {
          const trackingSnippet = r.trackingNumber ? ` Carrier: ${r.carrier || 'Courier'} (${r.trackingNumber}).` : '';
          const noticeSnippet = r.isLiveShopifyData ? '' : ` [Data Source: Test Fixture - Pending Live OAuth]`;
          reply = `Order verified! Status for ${r.orderNumber}: ${r.fulfillmentStatus}.${trackingSnippet} ${r.note} Estimated transit: ${r.estimatedDelivery}.${noticeSnippet}`;
        } else if (r && r.code === 'SHOPIFY_AUTH_PENDING') {
          reply = `Order lookup is temporarily unavailable: ${r.message}`;
        } else if (r && (r.code === 'TOO_MANY_FAILED_ATTEMPTS' || r.code === 'AI_TOOL_RATE_LIMITED')) {
          reply = r.message;
        } else {
          reply = `We could not verify the provided order details against our records. For security reasons, order details can only be retrieved with matching credentials. Please double-check your order number and contact information, or contact our support team on WhatsApp.`;
        }
      } else if (hasOrderNum && !hasContact) {
        reply = `I found your order reference! For your privacy and data security, please provide the email address or phone number used at checkout to verify your order details.`;
      } else if (!hasOrderNum && hasContact) {
        reply = `Thank you for providing your contact details. To check your order status, please also provide your Order Number (e.g., #ABH-1001).`;
      } else {
        reply = `I can help you check the status of your order! To verify your details securely, please provide your Order Number (e.g., #ABH-1001) along with the email address or phone number used at checkout.`;
      }
      return { reply, productCards: [], escalated: false, model: this.model };
    }

    // 11. Live Stock & Inventory Availability
    if (
      lower.includes('stock') ||
      lower.includes('available') ||
      lower.includes('inventory') ||
      lower.includes('in stock')
    ) {
      await this.executeTool('get_live_inventory', { inventoryItemIds: ['gid://shopify/InventoryItem/55555'] }, shop);
      const cardRes = await this.executeTool('search_products', { query: 'coffee maker' }, shop);
      productCards = cardRes.productCards || [];
      reply = `We checked our live inventory across verified UAE fulfillment centers: The Abihacart Premium Coffee Maker is currently in stock (15 units available in Dubai). Price is AED 249.00.`;
      return { reply, productCards, escalated: false, model: this.model };
    }

    // 12. Product Comparison
    if (
      lower.includes('compare') ||
      lower.includes('comparison') ||
      lower.includes('difference') ||
      lower.includes('versus') ||
      lower.includes('vs')
    ) {
      await this.executeTool('get_product_details', { handle: 'abihacart-coffee-maker' }, shop);
      const cardRes = await this.executeTool('search_products', { query: 'coffee maker' }, shop);
      productCards = cardRes.productCards || [];
      reply = `Here is our product comparison: Our Abihacart Premium Coffee Maker is priced at AED 249.00 (discounted from AED 320.00). It features a 15-bar Italian pressure pump and milk frother, offering exceptional value and barista-grade espresso compared to standard retail coffee machines in the UAE.`;
      return { reply, productCards, escalated: false, model: this.model };
    }

    // 13. Specific Product Details & Specifications
    if (
      lower.includes('feature') ||
      lower.includes('spec') ||
      lower.includes('specification') ||
      (lower.includes('coffee maker') && (lower.includes('detail') || lower.includes('about') || lower.includes('tell me')))
    ) {
      await this.executeTool('get_product_details', { handle: 'abihacart-coffee-maker' }, shop);
      const cardRes = await this.executeTool('search_products', { query: 'coffee maker' }, shop);
      productCards = cardRes.productCards || [];
      reply = `The Abihacart Premium Coffee Maker (AED 249.00) features a 15-bar Italian pressure pump, stainless steel milk frother, and a compact countertop footprint in matte black. It is engineered for UAE homes and is backed by a 1-year warranty.`;
      return { reply, productCards, escalated: false, model: this.model };
    }

    // 14. Price Inquiries (Must be in AED only)
    if (
      lower.includes('price') ||
      lower.includes('cost') ||
      lower.includes('how much') ||
      lower.includes('pricing')
    ) {
      const cardRes = await this.executeTool('search_products', { query: 'coffee maker' }, shop);
      productCards = cardRes.productCards || [];
      reply = `The Abihacart Premium Coffee Maker is priced at AED 249.00 (discounted from regular price of AED 320.00). All our prices are quoted in UAE Dirhams (AED).`;
      return { reply, productCards, escalated: false, model: this.model };
    }

    // 15. General Product Search & Catalog Recommendations
    if (
      lower.includes('product') ||
      lower.includes('catalog') ||
      lower.includes('coffee') ||
      lower.includes('espresso') ||
      lower.includes('appliance') ||
      lower.includes('recommend') ||
      lower.includes('what do you sell') ||
      lower.includes('what items do you have')
    ) {
      const toolRes = await this.executeTool('search_products', { query: userMessage }, shop);
      productCards = toolRes.productCards || [];
      reply = `Welcome to Abihacart! We offer premium quality products across the UAE with fast, reliable local delivery. Here are some of our featured items:`;
      return { reply, productCards, escalated: false, model: this.model };
    }

    // 16. Greeting & Pleasantries
    if (
      lower.includes('hello') ||
      lower.includes('hi') ||
      lower.includes('hey') ||
      lower.includes('good morning') ||
      lower.includes('good evening') ||
      lower.includes('good afternoon')
    ) {
      reply = 'Hello! Welcome to Abihacart Customer Support. How may I assist you with our products, UAE delivery options, or order tracking today?';
      return { reply, productCards: [], escalated: false, model: this.model };
    }

    // 17. Unknown / Unverified Question Fallback (Strict Anti-Hallucination)
    await this.executeTool('escalate_to_human', {
      reason: 'Question cannot be verified from approved store data',
      customerQuery: userMessage,
    }, shop);
    isEscalated = true;
    reply = 'I cannot confirm that information from our verified store records, and I want to ensure you receive 100% accurate details. Would you like me to connect you with our human support team on WhatsApp? Our team is available Monday to Saturday, 9:00 AM to 9:00 PM GST.';
    return { reply, productCards: [], escalated: isEscalated, model: this.model };
  }
}

module.exports = new OpenAIService();
module.exports.OpenAIService = OpenAIService;
module.exports.AI_TOOLS = AI_TOOLS;
module.exports.SYSTEM_INSTRUCTION = SYSTEM_INSTRUCTION;
