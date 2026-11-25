const express = require('express');
const { sendMessage, getHistory, getSuggestions } = require('../controllers/chat.controller');
const { chatLimiter } = require('../middleware/rateLimiter');

const router = express.Router();

// Customer message exchange endpoint
router.post('/message', chatLimiter, sendMessage);

// Session history restoration endpoint
router.get('/history/:conversationId', chatLimiter, getHistory);

// Suggested questions endpoint
router.get('/suggestions', chatLimiter, getSuggestions);

module.exports = router;
