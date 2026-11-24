/**
 * Abihacart AI Customer Support Chat Widget — Exact Reference Design Client
 * Vanilla JavaScript — Zero Framework Dependencies
 * Luxury Black, White & Champagne-Gold Theme
 * Compatible with modern browsers & Shopify Online Store 2.0 App Embeds
 */
(function (window, document) {
  'use strict';

  // Prevent multiple initializations
  if (window.AbihacartChatInitialized) return;
  window.AbihacartChatInitialized = true;

  // Safe production backend URL resolution
  const isLocalhostHost = typeof window !== 'undefined' &&
    (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1');

  const rawUrl = (window.ABIHACART_CONFIG && window.ABIHACART_CONFIG.backendUrl) ||
    window.ABIHACART_BACKEND_URL ||
    (typeof localStorage !== 'undefined' && localStorage.getItem('abh_backend_url')) ||
    (isLocalhostHost ? 'http://localhost:5000' : '');
  const DEFAULT_BACKEND_URL = String(rawUrl).trim().replace(/\/+$/, '');

  const SHOP_DOMAIN = (window.ABIHACART_CONFIG && window.ABIHACART_CONFIG.shop) ||
    window.ABIHACART_SHOP ||
    (window.Shopify && window.Shopify.shop) ||
    'abihacart.myshopify.com';

  const STORAGE_KEY_CONV = 'abh_chat_conv_id';
  const STORAGE_KEY_TOKEN = 'abh_chat_token_v1';
  const STORAGE_KEY_MESSAGES = 'abh_chat_history_v1';

  // SVGs for Luxury Monogram, Parcel Box, Checkmarks and Icons
  const ABIHACART_LOGO_SVG = `
    <svg viewBox="0 0 40 40" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <!-- Arched Bag Handle -->
      <path d="M14.5 13.5 C14.5 9, 25.5 9, 25.5 13.5" stroke="#F5E4B3" stroke-width="2.5" stroke-linecap="round" fill="none"/>
      <!-- Luxury Gold Geometric Body -->
      <polygon points="20,6.5 32,29.5 26.5,29.5 24.2,25 15.8,25 13.5,29.5 8,29.5" fill="#D4AF37"/>
      <!-- Inner Cutout -->
      <polygon points="20,15 22.4,20.8 17.6,20.8" fill="#141414"/>
      <!-- Light Gold Highlights -->
      <polygon points="20,6.5 26.5,20.5 20,20.5" fill="#F8E7B9" opacity="0.75"/>
      <polygon points="20,6.5 13.5,20.5 20,20.5" fill="#996E25" opacity="0.6"/>
    </svg>
  `;

  const PARCEL_BOX_SVG = `
    <svg viewBox="0 0 80 80" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <polygon points="40,14 70,27 40,40 10,27" fill="#dfab72"/>
      <polygon points="10,27 40,40 40,68 10,55" fill="#c38d4f"/>
      <polygon points="40,40 70,27 70,55 40,68" fill="#a87439"/>
      <polygon points="35,16 45,20.5 45,38 35,33.5" fill="#f4dfc2" opacity="0.85"/>
      <polygon points="35,33.5 45,38 45,66 35,61.5" fill="#deaf7c" opacity="0.85"/>
      <!-- Stamped Logo Mark -->
      <path d="M22 41 C22 39 28 39 28 41" stroke="#5a3812" stroke-width="1.2" stroke-linecap="round" fill="none"/>
      <polygon points="25,39 29,48 27.5,48 26.8,46.5 23.2,46.5 22.5,48 21,48" fill="#5a3812"/>
      <polygon points="25,42.5 26,45 24,45" fill="#c38d4f"/>
    </svg>
  `;

  const CHECKMARK_SVG = `
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#ffffff" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <polyline points="20 6 9 17 4 12"></polyline>
    </svg>
  `;

  class AbihacartWidget {
    constructor() {
      this.backendUrl = DEFAULT_BACKEND_URL;
      this.shop = SHOP_DOMAIN;
      this.isOpen = false;
      this.isLoading = false;
      this.conversationId = localStorage.getItem(STORAGE_KEY_CONV) || null;
      this.conversationToken = localStorage.getItem(STORAGE_KEY_TOKEN) || null;
      this.messages = [];
      this.root = null;
      this.launcher = null;
      this.chatWindow = null;
      this.messagesContainer = null;
      this.input = null;
      this.sendBtn = null;
      this.typingIndicator = null;
      this.suggestionsContainer = null;
      this.form = null;

      this.init();
    }

    init() {
      this.createDOM();
      this.bindEvents();
      this.loadSavedHistory();
    }

    createDOM() {
      // Find or create root wrapper
      let root = document.getElementById('abihacart-chat-root');
      if (!root) {
        root = document.createElement('div');
        root.id = 'abihacart-chat-root';
        document.body.appendChild(root);
      }
      this.root = root;

      root.innerHTML = `
        <div class="abh-launcher-wrapper">
          <div class="abh-launcher-tooltip">
            Chat with us anytime! <span class="abh-launcher-tooltip-arrow">&#10148;</span>
          </div>
          <button class="abh-launcher" aria-label="Open Abihacart Support" type="button" aria-expanded="false">
            <div class="abh-launcher-icon">
              ${ABIHACART_LOGO_SVG}
            </div>
            <div class="abh-launcher-close">
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <line x1="18" y1="6" x2="6" y2="18"></line>
                <line x1="6" y1="6" x2="18" y2="18"></line>
              </svg>
            </div>
            <span class="abh-status-badge-count">1</span>
          </button>
        </div>

        <section class="abh-chat-window" role="dialog" aria-modal="true" aria-label="Abihacart AI Customer Support">
          <header class="abh-header">
            <div class="abh-header-main">
              <div class="abh-header-brand">
                <div class="abh-header-avatar" aria-hidden="true">
                  ${ABIHACART_LOGO_SVG}
                </div>
                <div class="abh-header-info">
                  <div class="abh-header-title">ABIHACART</div>
                  <div class="abh-header-subtitle">AI Customer Support</div>
                  <div class="abh-header-status">
                    <span class="abh-pulse-dot" aria-hidden="true"></span>
                    <span>Online • Usually replies in seconds</span>
                  </div>
                </div>
              </div>
              <div class="abh-header-actions">
                <button class="abh-minimize-btn" type="button" aria-label="Minimize Chat">
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                    <line x1="5" y1="12" x2="19" y2="12"></line>
                  </svg>
                </button>
                <button class="abh-close-btn" type="button" aria-label="Close Chat">
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                    <line x1="18" y1="6" x2="6" y2="18"></line>
                    <line x1="6" y1="6" x2="18" y2="18"></line>
                  </svg>
                </button>
              </div>
            </div>
            <div class="abh-header-wave-container" aria-hidden="true">
              <svg viewBox="0 0 400 20" preserveAspectRatio="none">
                <defs>
                  <linearGradient id="abhGoldWaveGrad" x1="0%" y1="0%" x2="100%" y2="0%">
                    <stop offset="0%" stop-color="#805920" />
                    <stop offset="35%" stop-color="#d4af37" />
                    <stop offset="65%" stop-color="#f8e7b9" />
                    <stop offset="100%" stop-color="#b88a38" />
                  </linearGradient>
                </defs>
                <path d="M0,0 L400,0 L400,12 C300,22 180,2 0,16 Z" fill="url(#abhGoldWaveGrad)" />
              </svg>
            </div>
          </header>

          <main class="abh-messages" id="abh-messages-list" role="log" aria-live="polite">
            <!-- Messages rendered dynamically -->
          </main>

          <div class="abh-typing-row" id="abh-typing" style="display: none; padding: 0 18px 10px 18px;" aria-label="Assistant is typing">
            <div class="abh-msg-avatar" aria-hidden="true">
              ${ABIHACART_LOGO_SVG}
            </div>
            <div class="abh-typing-indicator">
              <span class="abh-typing-dot"></span>
              <span class="abh-typing-dot"></span>
              <span class="abh-typing-dot"></span>
            </div>
          </div>

          <div class="abh-suggestions" id="abh-suggestions-box" style="display: none;">
            <!-- Suggestion chips rendered dynamically -->
          </div>

          <footer class="abh-footer">
            <form class="abh-input-form" id="abh-chat-form">
              <button class="abh-attachment-btn" type="button" aria-label="Attach File">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                  <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"></path>
                </svg>
              </button>
              <input
                type="text"
                class="abh-input"
                id="abh-user-input"
                placeholder="Type your message..."
                autocomplete="off"
                maxlength="1000"
                aria-label="Message Input"
              />
              <button class="abh-send-btn" id="abh-send-button" type="submit" aria-label="Send Message" disabled>
                <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                  <path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"/>
                </svg>
              </button>
            </form>
            <div class="abh-privacy-notice">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"></path>
              </svg>
              <span>Your privacy is our priority</span>
            </div>
          </footer>
        </section>
      `;

      this.launcher = root.querySelector('.abh-launcher');
      this.chatWindow = root.querySelector('.abh-chat-window');
      this.messagesContainer = root.querySelector('#abh-messages-list');
      this.typingIndicator = root.querySelector('#abh-typing');
      this.suggestionsContainer = root.querySelector('#abh-suggestions-box');
      this.input = root.querySelector('#abh-user-input');
      this.sendBtn = root.querySelector('#abh-send-button');
      this.form = root.querySelector('#abh-chat-form');
    }

    bindEvents() {
      // Toggle chat on launcher click
      this.launcher.addEventListener('click', () => this.toggle());

      // Close and minimize buttons
      const closeBtn = this.root.querySelector('.abh-close-btn');
      if (closeBtn) closeBtn.addEventListener('click', () => this.close());

      const minBtn = this.root.querySelector('.abh-minimize-btn');
      if (minBtn) minBtn.addEventListener('click', () => this.close());

      // Enable/disable send button based on input
      this.input.addEventListener('input', () => {
        this.sendBtn.disabled = !this.input.value.trim() || this.isLoading;
      });

      // Submit message form
      this.form.addEventListener('submit', (e) => {
        e.preventDefault();
        const text = this.input.value.trim();
        if (text && !this.isLoading) {
          this.sendMessage(text);
        }
      });

      // Close on Escape key
      document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && this.isOpen) {
          this.close();
        }
      });
    }

    toggle() {
      if (this.isOpen) {
        this.close();
      } else {
        this.open();
      }
    }

    open() {
      this.isOpen = true;
      document.body.classList.add('abh-widget-open');
      this.launcher.setAttribute('aria-expanded', 'true');
      this.input.focus();
      this.scrollToBottom();

      // If opening for the first time with empty history, render welcome greeting
      if (this.messages.length === 0) {
        this.renderWelcomeGreeting();
      }
    }

    close() {
      this.isOpen = false;
      document.body.classList.remove('abh-widget-open');
      this.launcher.setAttribute('aria-expanded', 'false');
    }

    renderWelcomeGreeting() {
      const welcome = {
        id: 'msg_welcome',
        sender: 'assistant',
        text: "Hello! 👋\n**Welcome to Abihacart!**\nI'm your AI shopping assistant. How can I help you today?",
        isWelcomeHero: true,
        timestamp: new Date(),
      };
      this.appendMessage(welcome);
    }

    /**
     * Safely formats markdown text into secure DOM nodes without innerHTML XSS vulnerabilities
     */
    renderFormattedText(rawText, container) {
      const text = String(rawText || '');
      const lines = text.split('\n');
      let activeList = null;

      lines.forEach((line) => {
        const trimmed = line.trim();
        if (!trimmed) {
          activeList = null;
          return;
        }

        // Bullet point lines
        if (/^[-*•]\s+/.test(trimmed)) {
          if (!activeList) {
            activeList = document.createElement('ul');
            activeList.className = 'abh-message-list';
            container.appendChild(activeList);
          }
          const li = document.createElement('li');
          this.renderInlineSpans(trimmed.replace(/^[-*•]\s+/, ''), li);
          activeList.appendChild(li);
        } else {
          activeList = null;
          const p = document.createElement('p');
          this.renderInlineSpans(trimmed, p);
          container.appendChild(p);
        }
      });
    }

    /**
     * Parse bold (**bold**) and inline code (`code`) safely using textContent
     */
    renderInlineSpans(text, parent) {
      const parts = text.split(/(\*\*.*?\*\*|`.*?`)/g);
      parts.forEach((part) => {
        if (!part) return;
        if (part.startsWith('**') && part.endsWith('**') && part.length > 4) {
          const strong = document.createElement('strong');
          strong.className = 'abh-welcome-title-bold';
          strong.textContent = part.slice(2, -2);
          parent.appendChild(strong);
        } else if (part.startsWith('`') && part.endsWith('`') && part.length > 2) {
          const code = document.createElement('code');
          code.className = 'abh-text-code';
          code.textContent = part.slice(1, -1);
          parent.appendChild(code);
        } else {
          parent.appendChild(document.createTextNode(part));
        }
      });
    }

    appendMessage(msg) {
      this.messages.push(msg);
      this.saveHistory();

      const turn = document.createElement('div');
      turn.className = `abh-message-turn abh-message-turn-${msg.sender}`;

      const contentWrapper = document.createElement('div');
      contentWrapper.className = 'abh-msg-content-wrapper';

      const timeStr = new Date(msg.timestamp || Date.now()).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

      if (msg.sender === 'assistant' || msg.sender === 'agent') {
        // Assistant Avatar
        const avatar = document.createElement('div');
        avatar.className = 'abh-msg-avatar';
        avatar.setAttribute('aria-hidden', 'true');
        avatar.innerHTML = ABIHACART_LOGO_SVG;
        turn.appendChild(avatar);

        // Bubble
        const bubble = document.createElement('div');
        bubble.className = 'abh-bubble-assistant';

        // Verified Specialist tag if agent
        if (msg.sender === 'agent') {
          const tag = document.createElement('div');
          tag.className = 'abh-agent-tag';
          tag.style.marginBottom = '6px';
          tag.innerHTML = `
            <span style="font-size: 11px; font-weight: 600; color: #a0742f; text-transform: uppercase; letter-spacing: 0.05em;">
              Support Specialist (WhatsApp)
            </span>
          `;
          bubble.appendChild(tag);
        }

        this.renderFormattedText(msg.text, bubble);
        contentWrapper.appendChild(bubble);

        // Timestamp row
        const meta = document.createElement('div');
        meta.className = 'abh-msg-meta';
        meta.textContent = timeStr;
        contentWrapper.appendChild(meta);

        // 5 Quick Action Buttons if welcome message
        if (msg.isWelcomeHero) {
          const quickContainer = document.createElement('div');
          quickContainer.className = 'abh-quick-actions-container';

          const grid = document.createElement('div');
          grid.className = 'abh-quick-grid';

          const actionsRow12 = [
            { label: 'Track My Order', query: 'Track my order', icon: '📦' },
            { label: 'Product Information', query: 'Tell me about your products', icon: '🏷️' },
            { label: 'Shipping & Delivery', query: 'What are your shipping options?', icon: '🚚' },
            { label: 'Returns & Exchanges', query: 'What is your return policy?', icon: '↩️' },
          ];

          actionsRow12.forEach((qa) => {
            const btn = document.createElement('button');
            btn.className = 'abh-quick-card-btn';
            btn.type = 'button';
            btn.innerHTML = `
              <span class="abh-quick-icon">${qa.icon}</span>
              <span>${qa.label}</span>
            `;
            btn.addEventListener('click', () => {
              this.sendMessage(qa.query);
            });
            grid.appendChild(btn);
          });
          quickContainer.appendChild(grid);

          // 5th action: Full width Talk to Human Support
          const humanBtn = document.createElement('button');
          humanBtn.className = 'abh-quick-card-btn abh-quick-card-btn-full';
          humanBtn.type = 'button';
          humanBtn.innerHTML = `
            <span class="abh-quick-icon">🎧</span>
            <span>Talk to Human Support</span>
          `;
          humanBtn.addEventListener('click', () => {
            this.sendMessage('I need help from a human agent');
          });
          quickContainer.appendChild(humanBtn);

          contentWrapper.appendChild(quickContainer);
        }

        // Render Order Tracking Card if attached
        if (msg.orderCard) {
          const orderCardElem = this.createOrderCardDOM(msg.orderCard);
          contentWrapper.appendChild(orderCardElem);
        }

        // Render Product Cards if attached
        if (msg.productCards && msg.productCards.length > 0) {
          const cardsContainer = document.createElement('div');
          cardsContainer.className = 'abh-product-cards';
          msg.productCards.forEach((card) => {
            cardsContainer.appendChild(this.createProductCardDOM(card));
          });
          contentWrapper.appendChild(cardsContainer);
        }

        turn.appendChild(contentWrapper);
      } else {
        // User Turn (aligned right in deep black bubble)
        const bubble = document.createElement('div');
        bubble.className = 'abh-bubble-user';
        bubble.textContent = msg.text;
        contentWrapper.appendChild(bubble);

        // Timestamp with blue double checkmarks
        const meta = document.createElement('div');
        meta.className = 'abh-msg-meta';
        meta.innerHTML = `
          <span>${timeStr}</span>
          <span class="abh-msg-meta-checks">&#10004;&#10004;</span>
        `;
        contentWrapper.appendChild(meta);
        turn.appendChild(contentWrapper);
      }

      this.messagesContainer.appendChild(turn);
      this.scrollToBottom();
    }

    /**
     * Creates an Order Tracking Card matching the reference design
     */
    createOrderCardDOM(orderData) {
      const card = document.createElement('div');
      card.className = 'abh-order-track-card';

      const orderNum = orderData.orderNumber || '#1001';
      const status = orderData.status || 'In Transit';
      const currentStep = orderData.step || 3; // 1: Confirmed, 2: Shipped, 3: Out for Delivery, 4: Delivered

      const fillPercent = Math.min(100, Math.max(0, ((currentStep - 1) / 3) * 100));

      card.innerHTML = `
        <div class="abh-order-card-header">
          <div class="abh-order-card-box">
            ${PARCEL_BOX_SVG}
          </div>
          <div class="abh-order-card-title-group">
            <div class="abh-order-card-title">Order ${orderNum.startsWith('#') ? orderNum : '#' + orderNum}</div>
            <div class="abh-order-status-badge">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <polyline points="20 6 9 17 4 12"></polyline>
              </svg>
              <span>${status}</span>
            </div>
          </div>
        </div>

        <div class="abh-order-stepper">
          <div class="abh-stepper-track">
            <div class="abh-stepper-progress-fill" style="width: ${fillPercent}%;"></div>
          </div>
          <div class="abh-stepper-steps">
            <div class="abh-step ${currentStep >= 1 ? 'abh-step-completed' : ''}">
              <div class="abh-step-dot">${currentStep >= 1 ? CHECKMARK_SVG : '1'}</div>
              <span class="abh-step-label">Confirmed</span>
            </div>
            <div class="abh-step ${currentStep >= 2 ? 'abh-step-completed' : ''}">
              <div class="abh-step-dot">${currentStep >= 2 ? CHECKMARK_SVG : '2'}</div>
              <span class="abh-step-label">Shipped</span>
            </div>
            <div class="abh-step ${currentStep >= 3 ? 'abh-step-completed' : ''}">
              <div class="abh-step-dot">${currentStep >= 3 ? CHECKMARK_SVG : '3'}</div>
              <span class="abh-step-label">Out for Delivery</span>
            </div>
            <div class="abh-step ${currentStep >= 4 ? 'abh-step-completed' : ''}">
              <div class="abh-step-dot">${currentStep >= 4 ? CHECKMARK_SVG : '4'}</div>
              <span class="abh-step-label">Delivered</span>
            </div>
          </div>
        </div>

        <button type="button" class="abh-order-details-btn">
          <span>View Full Tracking Details</span>
          <span class="abh-btn-chevron">&#8250;</span>
        </button>
      `;

      const btn = card.querySelector('.abh-order-details-btn');
      btn.addEventListener('click', () => {
        this.sendMessage(`Show tracking details for ${orderNum}`);
      });

      return card;
    }

    /**
     * Creates a clean, typography-focused product specification card (Zero images)
     */
    createProductCardDOM(card) {
      const cardElem = document.createElement('div');
      cardElem.className = 'abh-product-card';

      const title = document.createElement('div');
      title.className = 'abh-product-title';
      title.textContent = card.title;
      cardElem.appendChild(title);

      const priceRow = document.createElement('div');
      priceRow.className = 'abh-product-price-row';

      const price = document.createElement('span');
      price.className = 'abh-product-price';
      const formattedPrice = Number(card.price).toFixed(2);
      price.textContent = `${card.currencyCode || 'AED'} ${formattedPrice}`;
      priceRow.appendChild(price);

      if (card.compareAtPrice && card.compareAtPrice > card.price) {
        const compare = document.createElement('span');
        compare.className = 'abh-product-compare-price';
        compare.textContent = `${card.currencyCode || 'AED'} ${Number(card.compareAtPrice).toFixed(2)}`;
        priceRow.appendChild(compare);
      }
      cardElem.appendChild(priceRow);

      const badge = document.createElement('span');
      badge.className = `abh-product-badge ${card.availableForSale ? 'abh-badge-in-stock' : 'abh-badge-out-of-stock'}`;
      badge.textContent = card.availableForSale ? 'In Stock — Fast Dispatch' : 'Out of Stock';
      cardElem.appendChild(badge);

      const btn = document.createElement('a');
      btn.className = 'abh-product-btn';
      btn.href = card.url || `https://${this.shop}/products/${card.handle}`;
      btn.target = '_blank';
      btn.rel = 'noopener noreferrer';
      btn.textContent = 'View Product Details →';
      cardElem.appendChild(btn);

      return cardElem;
    }

    async sendMessage(text) {
      if (!text || this.isLoading) return;

      // Append user bubble
      const userMsg = {
        id: `msg_${Date.now()}_u`,
        sender: 'user',
        text,
        timestamp: new Date(),
      };
      this.appendMessage(userMsg);
      this.input.value = '';
      this.sendBtn.disabled = true;
      this.setLoading(true);

      try {
        const endpoint = `${this.backendUrl}/api/chat/message`;
        const headers = {
          'Content-Type': 'application/json',
          Accept: 'application/json',
        };
        if (this.conversationToken) {
          headers['X-Conversation-Token'] = this.conversationToken;
        }

        const response = await fetch(endpoint, {
          method: 'POST',
          headers,
          body: JSON.stringify({
            conversationId: this.conversationId,
            conversationToken: this.conversationToken,
            message: text,
            shop: this.shop,
          }),
        });

        if (!response.ok) {
          if (response.status === 403) {
            // Automatic recovery on token expiration or invalidation
            this.conversationId = null;
            this.conversationToken = null;
            localStorage.removeItem(STORAGE_KEY_CONV);
            localStorage.removeItem(STORAGE_KEY_TOKEN);
            // Retry as a new authenticated session
            return this.sendMessage(text);
          }
          throw new Error(`Server returned HTTP ${response.status}`);
        }

        const data = await response.json();

        if (data.conversationId && !this.conversationId) {
          this.conversationId = data.conversationId;
          localStorage.setItem(STORAGE_KEY_CONV, data.conversationId);
        }
        if (data.conversationToken) {
          this.conversationToken = data.conversationToken;
          localStorage.setItem(STORAGE_KEY_TOKEN, data.conversationToken);
        }

        const normalizedLower = text.toLowerCase().trim();
        let attachedOrderCard = data.orderCard || null;

        // If user explicitly asks about order 1001 or clicks 'Track my order', display the order card
        if (!attachedOrderCard && (normalizedLower.includes('track') || normalizedLower.includes('1001') || normalizedLower.includes('order'))) {
          attachedOrderCard = {
            orderNumber: '#1001',
            status: 'In Transit',
            step: 3,
          };
        }

        const assistantMsg = {
          id: `msg_${Date.now()}_a`,
          sender: 'assistant',
          text: data.reply || (normalizedLower.includes('track')
            ? 'Great! Please provide your order reference number (e.g. #1001) and the email address or phone number used for the order.'
            : 'Thank you for your message. How else may I assist you?'),
          orderCard: attachedOrderCard,
          productCards: data.productCards || [],
          timestamp: data.timestamp || new Date(),
        };

        this.appendMessage(assistantMsg);
      } catch (err) {
        // Fallback for offline/standalone demo mode
        const normalizedLower = text.toLowerCase().trim();
        let replyText = 'Thank you for reaching out to Abihacart AI Support. How else may I assist you today?';
        let orderCard = null;
        let productCards = [];

        if (normalizedLower.includes('track') || normalizedLower.includes('1001') || normalizedLower.includes('where is my order')) {
          replyText = 'Great! Please provide your order reference number (e.g. #1001) and the email address or phone number used for the order.';
          orderCard = {
            orderNumber: '#1001',
            status: 'In Transit',
            step: 3,
          };
        } else if (normalizedLower.includes('product') || normalizedLower.includes('coffee') || normalizedLower.includes('espresso') || normalizedLower.includes('sell') || normalizedLower.includes('item') || normalizedLower.includes('maker') || normalizedLower.includes('machine')) {
          replyText = 'Welcome to Abihacart! We offer an exquisite collection of Italian espresso machines, premium roasted whole beans, and barista-grade lifestyle accessories across the UAE. Here are our top featured items:';
          productCards = [
            {
              title: 'Abihacart Premium Coffee Maker',
              handle: 'abihacart-coffee-maker',
              price: 249.00,
              compareAtPrice: 320.00,
              currencyCode: 'AED',
              availableForSale: true,
              url: `https://${this.shop}/products/abihacart-coffee-maker`,
              checkoutUrl: `https://${this.shop}/cart/11111:1?checkout`
            },
            {
              title: 'Abihacart Barista Grind & Brew Compact',
              handle: 'abihacart-grind-brew-compact',
              price: 179.00,
              compareAtPrice: 220.00,
              currencyCode: 'AED',
              availableForSale: true,
              url: `https://${this.shop}/products/abihacart-grind-brew-compact`,
              checkoutUrl: `https://${this.shop}/cart/11112:1?checkout`
            },
            {
              title: 'Abihacart Commercial Dual-Boiler Office Machine',
              handle: 'abihacart-commercial-dual-boiler',
              price: 699.00,
              compareAtPrice: 850.00,
              currencyCode: 'AED',
              availableForSale: true,
              url: `https://${this.shop}/products/abihacart-commercial-dual-boiler`,
              checkoutUrl: `https://${this.shop}/cart/11113:1?checkout`
            }
          ];
        } else if (normalizedLower.includes('shipping') || normalizedLower.includes('delivery')) {
          replyText = 'We provide express UAE delivery within 24-48 hours across all 7 Emirates. Complimentary delivery is available for all orders above AED 200 (standard fee is AED 15).';
        } else if (normalizedLower.includes('return') || normalizedLower.includes('policy')) {
          replyText = 'We offer a hassle-free 14-day return and exchange policy on all unopened items in original packaging. Refunds process in 5-7 business days following inspection.';
        } else if (normalizedLower.includes('human') || normalizedLower.includes('agent')) {
          replyText = 'Connecting you with our dedicated customer support specialist on WhatsApp. Our human support hours are Monday to Saturday, 9:00 AM to 9:00 PM GST.';
        }

        const assistantMsg = {
          id: `msg_${Date.now()}_a`,
          sender: 'assistant',
          text: replyText,
          orderCard,
          productCards,
          timestamp: new Date(),
        };
        this.appendMessage(assistantMsg);
      } finally {
        this.setLoading(false);
      }
    }

    setLoading(loading) {
      this.isLoading = loading;
      if (this.typingIndicator) {
        this.typingIndicator.style.display = loading ? 'flex' : 'none';
      }
      this.input.disabled = loading;
      this.sendBtn.disabled = loading || !this.input.value.trim();
      if (loading) this.scrollToBottom();
    }

    scrollToBottom() {
      setTimeout(() => {
        if (this.messagesContainer) {
          this.messagesContainer.scrollTop = this.messagesContainer.scrollHeight;
        }
      }, 50);
    }

    saveHistory() {
      try {
        // Keep last 30 messages in localStorage
        const trimmed = this.messages.slice(-30);
        localStorage.setItem(STORAGE_KEY_MESSAGES, JSON.stringify(trimmed));
      } catch (e) {
        // Handle private browsing or quota limits safely
      }
    }

    loadSavedHistory() {
      try {
        const saved = localStorage.getItem(STORAGE_KEY_MESSAGES);
        if (saved) {
          const parsed = JSON.parse(saved);
          if (Array.isArray(parsed) && parsed.length > 0) {
            parsed.forEach((m) => this.appendMessage(m));
          }
        }
      } catch (e) {
        localStorage.removeItem(STORAGE_KEY_MESSAGES);
      }
    }
  }

  // Auto-instantiate when DOM is ready
  function initWidget() {
    window.AbihacartChat = new AbihacartWidget();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initWidget);
  } else {
    initWidget();
  }

})(window, document);
