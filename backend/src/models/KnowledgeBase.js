const mongoose = require('mongoose');

const KnowledgeBaseSchema = new mongoose.Schema({
  key: {
    type: String,
    required: true,
    unique: true,
    trim: true,
    index: true,
  },
  title: {
    type: String,
    required: true,
  },
  content: {
    type: String,
    required: true,
  },
  category: {
    type: String,
    enum: ['shipping', 'returns', 'payments', 'store_info', 'faq', 'support'],
    default: 'store_info',
  },
  isApproved: {
    type: Boolean,
    default: false, // Strictly unapproved by default; requires explicit merchant approval
  },
  approvalStatus: {
    type: String,
    enum: ['pending_approval', 'approved', 'rejected'],
    default: 'pending_approval',
  },
  approvedBy: {
    type: String,
    default: null,
  },
  approvedAt: {
    type: Date,
    default: null,
  },
  lastUpdatedBy: {
    type: String,
    default: 'system',
  },
  updatedAt: {
    type: Date,
    default: Date.now,
  },
}, {
  bufferCommands: false,
});

const MongooseKnowledgeBase = mongoose.model('KnowledgeBase', KnowledgeBaseSchema);

/**
 * Working Draft Policies for Abihacart (UAE Market)
 * Initial baseline policies are marked as PENDING MERCHANT APPROVAL.
 * They cannot be presented as official confirmed store facts until explicit merchant activation.
 */
const DEFAULT_POLICIES = new Map([
  [
    'shipping_policy',
    {
      key: 'shipping_policy',
      title: 'UAE Shipping & Delivery Policy',
      category: 'shipping',
      isApproved: false, // Pending merchant confirmation
      approvalStatus: 'pending_approval',
      approvedBy: null,
      approvedAt: null,
      content: 'Abihacart delivers across all 7 Emirates in the United Arab Emirates (Dubai, Abu Dhabi, Sharjah, Ajman, Umm Al Quwain, Ras Al Khaimah, Fujairah). Standard delivery takes 1 to 3 business days. The standard delivery fee is AED 15; orders above AED 150 qualify for Free Standard Delivery. Express same-day delivery is available in Dubai for orders placed before 12:00 PM GST.',
    },
  ],
  [
    'return_policy',
    {
      key: 'return_policy',
      title: 'Return and Refund Policy',
      category: 'returns',
      isApproved: false, // Pending merchant confirmation
      approvalStatus: 'pending_approval',
      approvedBy: null,
      approvedAt: null,
      content: 'Abihacart offers a 14-day return window starting from the date of package delivery. Returned products must be unused, in their original packaging with all protective seals intact, and accompanied by the original receipt. Personal care, hygiene-sensitive, and perishable goods cannot be returned. Approved refunds are credited to the original payment method within 5 to 7 business days following item inspection.',
    },
  ],
  [
    'payment_methods',
    {
      key: 'payment_methods',
      title: 'Accepted Payment Methods',
      category: 'payments',
      isApproved: false, // Pending merchant confirmation
      approvalStatus: 'pending_approval',
      approvedBy: null,
      approvedAt: null,
      content: 'Abihacart accepts: 1. Credit & Debit Cards (Visa, MasterCard); 2. Apple Pay; 3. Cash on Delivery (COD) available throughout the UAE for orders under AED 1,000 (a standard courier handling fee of AED 10 applies to COD orders); 4. Buy Now Pay Later through Tabby (split payments into 4 equal interest-free installments). All transactions are billed in UAE Dirhams (AED).',
    },
  ],
  [
    'store_info',
    {
      key: 'store_info',
      title: 'Store Information and Operating Hours',
      category: 'store_info',
      isApproved: false, // Pending merchant confirmation
      approvalStatus: 'pending_approval',
      approvedBy: null,
      approvedAt: null,
      content: 'Store: Abihacart (abihacart.myshopify.com). Primary Market: United Arab Emirates (UAE). Official Currency: AED (UAE Dirham). Support Language: English only. Customer support hours: Monday through Saturday, 9:00 AM to 9:00 PM Gulf Standard Time (GST / UTC+4). Closed on Sundays and official UAE public holidays.',
    },
  ],
  [
    'human_support_info',
    {
      key: 'human_support_info',
      title: 'Human Support Escalation Workflow',
      category: 'support',
      isApproved: false, // Pending merchant confirmation
      approvalStatus: 'pending_approval',
      approvedBy: null,
      approvedAt: null,
      content: 'When an inquiry requires personal assistance or human escalation, the chatbot connects the conversation to our dedicated human support team via the Meta WhatsApp Business Cloud API. Operating hours for human agents are 9:00 AM to 9:00 PM GST. Agents receive the full conversation context to resolve requests efficiently.',
    },
  ],
]);

class KnowledgeBaseStore {
  static isDBConnected() {
    return mongoose.connection.readyState === 1;
  }

  /**
   * Retrieves policy document with full governance metadata
   */
  static async getPolicy(key) {
    const normalizedKey = (key || '').trim().toLowerCase();

    if (this.isDBConnected()) {
      const doc = await MongooseKnowledgeBase.findOne({ key: normalizedKey });
      if (doc) {
        return {
          key: doc.key,
          title: doc.title,
          content: doc.content,
          isApproved: Boolean(doc.isApproved),
          approvalStatus: doc.approvalStatus || (doc.isApproved ? 'approved' : 'pending_approval'),
          approvedBy: doc.approvedBy,
          approvedAt: doc.approvedAt,
        };
      }
    }

    const fallback = DEFAULT_POLICIES.get(normalizedKey);
    return fallback ? { ...fallback } : null;
  }

  /**
   * Returns policy text formatted with its governance status:
   * If approved: returns policy content directly.
   * If pending approval: returns content prefixed with an explicit pending disclaimer.
   * This guarantees that pending policies are NEVER presented as confirmed official store facts.
   */
  static async getPolicyWithStatus(key) {
    const policy = await this.getPolicy(key);
    if (!policy) return null;

    if (policy.isApproved) {
      return policy.content;
    }

    // Explicit disclaimer when policy is still pending merchant approval
    return `[Pending Merchant Approval - Working Store Guideline]: ${policy.content}`;
  }

  /**
   * Explicitly approves a policy document (callable by merchant dashboard in Phase 9)
   */
  static async approvePolicy(key, approvedBy = 'merchant') {
    const normalizedKey = (key || '').trim().toLowerCase();
    const update = {
      isApproved: true,
      approvalStatus: 'approved',
      approvedBy,
      approvedAt: new Date(),
      updatedAt: new Date(),
    };

    if (this.isDBConnected()) {
      return MongooseKnowledgeBase.findOneAndUpdate(
        { key: normalizedKey },
        { $set: update },
        { new: true, upsert: true }
      );
    }

    const existing = DEFAULT_POLICIES.get(normalizedKey) || {};
    const updated = { ...existing, ...update };
    DEFAULT_POLICIES.set(normalizedKey, updated);
    return updated;
  }

  /**
   * Explicitly marks a policy document as rejected
   */
  static async rejectPolicy(key) {
    const normalizedKey = (key || '').trim().toLowerCase();
    const update = {
      isApproved: false,
      approvalStatus: 'rejected',
      updatedAt: new Date(),
    };

    if (this.isDBConnected()) {
      return MongooseKnowledgeBase.findOneAndUpdate(
        { key: normalizedKey },
        { $set: update },
        { new: true }
      );
    }

    const existing = DEFAULT_POLICIES.get(normalizedKey) || {};
    const updated = { ...existing, ...update };
    DEFAULT_POLICIES.set(normalizedKey, updated);
    return updated;
  }

  /**
   * Upserts policy content while preserving governance state
   */
  static async upsertPolicy(key, policyData) {
    const normalizedKey = (key || '').trim().toLowerCase();
    const data = {
      ...policyData,
      key: normalizedKey,
      isApproved: Boolean(policyData.isApproved),
      approvalStatus: policyData.approvalStatus || (policyData.isApproved ? 'approved' : 'pending_approval'),
      updatedAt: new Date(),
    };

    if (this.isDBConnected()) {
      return MongooseKnowledgeBase.findOneAndUpdate(
        { key: normalizedKey },
        data,
        { upsert: true, new: true }
      );
    }

    DEFAULT_POLICIES.set(normalizedKey, data);
    return data;
  }

  static async listPolicies({ category, search, approvalStatus } = {}) {
    if (this.isDBConnected()) {
      const query = {};
      if (category) query.category = category;
      if (approvalStatus) query.approvalStatus = approvalStatus;
      if (search) {
        const s = String(search).trim();
        query.$or = [
          { key: { $regex: s, $options: 'i' } },
          { title: { $regex: s, $options: 'i' } },
          { content: { $regex: s, $options: 'i' } },
        ];
      }
      return MongooseKnowledgeBase.find(query).sort({ updatedAt: -1 });
    }

    let list = Array.from(DEFAULT_POLICIES.values());
    if (category) list = list.filter((p) => p.category === category);
    if (approvalStatus) list = list.filter((p) => p.approvalStatus === approvalStatus);
    if (search) {
      const s = String(search).toLowerCase();
      list = list.filter(
        (p) =>
          p.key.toLowerCase().includes(s) ||
          p.title?.toLowerCase().includes(s) ||
          p.content?.toLowerCase().includes(s)
      );
    }
    return list;
  }

  static async deletePolicy(key) {
    const normalizedKey = (key || '').trim().toLowerCase();
    if (this.isDBConnected()) {
      const res = await MongooseKnowledgeBase.findOneAndDelete({ key: normalizedKey });
      return Boolean(res);
    }
    return DEFAULT_POLICIES.delete(normalizedKey);
  }

  static async createEntry({ key, title, content, category = 'faq', author = 'admin' }) {
    const normalizedKey = (key || '').trim().toLowerCase().replace(/[^a-z0-9_]/g, '_');
    const existing = await this.getPolicy(normalizedKey);
    if (existing) {
      throw new Error(`Knowledge base entry with key [${normalizedKey}] already exists.`);
    }

    const newDoc = {
      key: normalizedKey,
      title: (title || '').trim(),
      content: (content || '').trim(),
      category,
      isApproved: false, // Strictly unapproved by default; requires explicit admin review
      approvalStatus: 'pending_approval',
      approvedBy: null,
      approvedAt: null,
      lastUpdatedBy: author,
      updatedAt: new Date(),
    };

    return this.upsertPolicy(normalizedKey, newDoc);
  }

  static async updateEntry(key, { title, content, category, editor = 'admin' }) {
    const normalizedKey = (key || '').trim().toLowerCase();
    const existing = await this.getPolicy(normalizedKey);
    if (!existing) {
      throw new Error(`Knowledge base entry [${normalizedKey}] not found.`);
    }

    const update = {
      ...existing,
      lastUpdatedBy: editor,
      updatedAt: new Date(),
    };
    if (title !== undefined) update.title = title.trim();
    if (content !== undefined) update.content = content.trim();
    if (category !== undefined) update.category = category;

    return this.upsertPolicy(normalizedKey, update);
  }
}

module.exports = MongooseKnowledgeBase;
module.exports.KnowledgeBaseStore = KnowledgeBaseStore;
module.exports.DEFAULT_POLICIES = DEFAULT_POLICIES;
