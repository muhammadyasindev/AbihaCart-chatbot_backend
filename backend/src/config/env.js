const dotenv = require('dotenv');
const path = require('path');

// Load environment variables from .env if present
dotenv.config({ path: path.resolve(__dirname, '../../.env') });

const config = {
  env: (process.env.NODE_ENV || 'development').trim(),
  port: parseInt((process.env.PORT || '5000').trim(), 10),
  mongodbUri: (process.env.MONGODB_URI || '').trim(),

  shopify: {
    shop: (process.env.SHOPIFY_SHOP || 'abihacart.myshopify.com').trim(),
    clientId: (process.env.SHOPIFY_CLIENT_ID || '').trim(),
    clientSecret: (process.env.SHOPIFY_CLIENT_SECRET || '').trim(),
    apiVersion: (process.env.SHOPIFY_API_VERSION || '2026-10').trim(),
    scopes: (process.env.SHOPIFY_SCOPES || 'read_products,read_inventory,read_orders,write_orders,read_draft_orders,write_draft_orders,read_fulfillments,read_customers')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  },

  openai: {
    apiKey: (process.env.OPENAI_API_KEY || '').trim(),
    model: (process.env.OPENAI_MODEL || 'gpt-6-luna').trim(),
  },

  whatsapp: {
    phoneNumberId: (process.env.WHATSAPP_PHONE_NUMBER_ID || '').trim(),
    businessAccountId: (process.env.WHATSAPP_BUSINESS_ACCOUNT_ID || '').trim(),
    accessToken: (process.env.WHATSAPP_ACCESS_TOKEN || '').trim(),
    verifyToken: (process.env.WHATSAPP_VERIFY_TOKEN || '').trim(),
    appSecret: (process.env.WHATSAPP_APP_SECRET || '').trim(),
    apiVersion: (process.env.WHATSAPP_API_VERSION || 'v26.0').trim(),
  },

  sms: {
    provider: (process.env.SMS_PROVIDER || 'twilio').trim(),
    accountSid: (process.env.TWILIO_ACCOUNT_SID || process.env.SMS_ACCOUNT_SID || '').trim(),
    authToken: (process.env.TWILIO_AUTH_TOKEN || process.env.SMS_AUTH_TOKEN || '').trim(),
    phoneNumber: (process.env.TWILIO_PHONE_NUMBER || process.env.SMS_PHONE_NUMBER || '').trim(),
    senderId: (process.env.TWILIO_SENDER_ID || process.env.SMS_SENDER_ID || 'ABIHACART').trim(),
  },

  agent: {
    apiKey: (process.env.AGENT_API_KEY || (process.env.NODE_ENV === 'production' ? '' : 'abh_agent_secure_auth_token_default')).trim(),
    adminApiKey: (process.env.ADMIN_API_KEY || (process.env.NODE_ENV === 'production' ? '' : 'abh_admin_secure_auth_token_default')).trim(),
  },

  urls: {
    frontendUrl: (process.env.FRONTEND_URL || 'https://abihacart.myshopify.com').trim(),
    backendUrl: (process.env.BACKEND_URL || 'http://localhost:5000').trim(),
    allowedOrigins: (process.env.ALLOWED_ORIGINS || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  },
};

module.exports = config;
