const express = require('express');
const { getHealth, getReadiness } = require('../controllers/health.controller');
const { healthLimiter } = require('../middleware/rateLimiter');

const router = express.Router();

router.get('/health', healthLimiter, getHealth);
router.get('/health/ready', healthLimiter, getReadiness);

module.exports = router;
