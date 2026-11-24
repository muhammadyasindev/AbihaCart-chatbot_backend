const express = require('express');
const router = express.Router();
const orderController = require('../controllers/order.controller');
const { orderTrackingLimiter, orderConfirmationLimiter } = require('../middleware/rateLimiter');

// Rate-limited Two-Field Customer Verification order lookup (Read-only)
router.post('/track', orderTrackingLimiter, orderController.trackOrder);

// Customer SMS Order Placement & Confirmation
router.post('/place-sms-order', orderController.placeSmsOrder);
router.get('/confirm-sms', orderController.confirmSmsOrder);
router.post('/confirm-sms', orderController.confirmSmsOrder);
// Shopify Customer-Facing Order Confirmation & Cancellation Popup (Phase 10)
router.get('/confirm-shopify-order', orderConfirmationLimiter, orderController.confirmShopifyOrder);
router.post('/confirm-shopify-order', orderConfirmationLimiter, orderController.confirmShopifyOrder);
router.post('/cancel-shopify-order', orderConfirmationLimiter, orderController.cancelShopifyOrder);
router.get('/checkout-confirmation-status', orderController.getCheckoutConfirmationStatus);
router.get('/popup-script.js', orderController.servePopupScript);
router.get('/robot-avatar.png', orderController.serveRobotAvatar);
router.post('/sms-status-callback', orderController.handleTwilioStatusCallback);
router.get('/:orderReference', orderController.getSmsOrderDetails);

// Prohibited mutation refusal routes (Strict read-only security boundary)
router.post('/cancel', orderController.cancelOrderRefusal);
router.post('/modify', orderController.modifyOrderRefusal);
router.post('/refund', orderController.refundOrderRefusal);

module.exports = router;
