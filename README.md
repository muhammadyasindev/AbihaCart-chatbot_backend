# Abihacart AI Customer Support Chatbot

Production-ready enterprise AI customer-support concierge and administration cockpit for [Abihacart](https://abihacart.myshopify.com/) (UAE).

## Architecture & Directory Structure

```text
abihacart-chatbot/
│
├── frontend/                     # Dedicated Frontend (Deployed on Vercel)
│   ├── admin-dashboard/          # Administrative management cockpit
│   ├── storefront-widget/        # Customer-facing luxury concierge chat
│   ├── assets/                   # Shared frontend CSS/JS assets
│   ├── index.html                # Main frontend landing portal
│   └── vercel.json               # Vercel routing & cleanUrls configuration
│
├── backend/                      # Dedicated Backend (Deployed on Render)
│   ├── src/                      # Controllers, models, routes, services, middleware, config, utils
│   ├── tests/                    # Comprehensive regression test suite
│   ├── server.js                 # Server entry point
│   ├── package.json              # Backend dependencies and scripts
│   └── .env.example              # Environment variable template (no secrets)
│
├── extensions/                   # Shopify Online Store 2.0 Theme App Extension
│   └── abihacart-chat-embed/     # App Embed Block with zero theme file modification
│
├── shopify.app.toml              # Shopify CLI 3.x App Configuration
├── render.yaml                   # Render Blueprint Specification
├── vercel.json                   # Root Vercel fallback configuration
└── .gitignore                    # Environment & credential protection
```

## Deployment Specifications

### Frontend (Vercel)
- **Framework Preset:** `Other` (Vanilla HTML/CSS/JS)
- **Root Directory:** `frontend`
- **Build Command:** *(leave empty)*
- **Output Directory:** `.`

### Backend (Render)
- **Runtime:** `Node`
- **Root Directory:** `backend`
- **Build Command:** `npm install`
- **Start Command:** `node server.js`
- **Health Check Path:** `/api/health`
- **MongoDB Atlas:** Mandatory live connection in production (`NODE_ENV=production`)

## Security & Protection
- Never commit `.env` or secrets to Git.
- Client secrets, access tokens, and API keys are strictly server-side.
- Zero customer PII disclosure without dual-factor order verification.
