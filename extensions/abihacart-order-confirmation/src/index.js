/**
 * Abihacart Assistant — Checkout UI Extension
 * Target: purchase.thank-you.block.render, customer-account.order-status.block.render
 * Automatically appears on the Shopify Thank You and Order Status pages
 */
import {
  extension,
  Banner,
  BlockStack,
  InlineStack,
  Text,
  Button,
  Image,
  Divider,
  View,
} from '@shopify/ui-extensions/checkout';

export default extension('purchase.thank-you.block.render', (root, api) => {
  const { order, cost, shop, settings } = api;

  // Track confirmation state
  let status = 'pending'; // 'pending' | 'confirmed' | 'cancelled' | 'loading'
  let feedbackMessage = '';

  const backendUrl = settings.current?.backend_url || 'https://abihacart-support-backend.onrender.com';
  const orderNumber = order.current?.name || `#${order.current?.id || ''}`;
  const totalAmount = cost.totalAmount?.current?.amount || '0.00';
  const currencyCode = cost.totalAmount?.current?.currencyCode || 'AED';

  // Build View Container
  const container = root.createComponent(BlockStack, {
    border: 'base',
    cornerRadius: 'large',
    padding: 'base',
    spacing: 'loose',
  });

  // Render function for reactive updates
  function render() {
    // Clear existing children
    while (container.children.length > 0) {
      container.removeChild(container.children[0]);
    }

    if (status === 'confirmed') {
      container.appendChild(
        root.createComponent(Banner, {
          status: 'success',
          title: 'Order Confirmed!',
        }, [
          root.createComponent(Text, {}, 'Assalam-o-Alaikum! Thank you! Your order has been confirmed successfully. Our concierge team is preparing your package.'),
        ])
      );
      return;
    }

    if (status === 'cancelled') {
      container.appendChild(
        root.createComponent(Banner, {
          status: 'warning',
          title: 'Order Cancellation Request Recorded',
        }, [
          root.createComponent(Text, {}, 'Your cancellation request has been recorded. The store owner has been notified.'),
        ])
      );
      return;
    }

    // Header: Abihacart Assistant + Status Badge
    const header = root.createComponent(InlineStack, {
      alignment: 'center',
      distribution: 'equalSpacing',
    }, [
      root.createComponent(InlineStack, { alignment: 'center', spacing: 'tight' }, [
        root.createComponent(Text, { size: 'base', emphasis: 'bold' }, '🤖 Abihacart Assistant'),
      ]),
      root.createComponent(View, {
        padding: 'extraTight',
        cornerRadius: 'base',
        background: 'subdued',
      }, [
        root.createComponent(Text, { size: 'small', appearance: 'success', emphasis: 'bold' }, 'Order Received'),
      ]),
    ]);

    // Greeting and Inquiry
    const greetingStack = root.createComponent(BlockStack, { spacing: 'extraTight' }, [
      root.createComponent(Text, { size: 'medium', emphasis: 'bold' }, 'Assalam-o-Alaikum! Thank you for shopping with Abihacart.'),
      root.createComponent(Text, { size: 'base' }, `Your order ${orderNumber} has been placed successfully.`),
      root.createComponent(Text, { size: 'base', emphasis: 'bold' }, 'Would you like to confirm your order?'),
    ]);

    // Financial Summary
    const costSummary = root.createComponent(InlineStack, {
      distribution: 'equalSpacing',
    }, [
      root.createComponent(Text, { size: 'base', emphasis: 'bold' }, 'Total Amount:'),
      root.createComponent(Text, { size: 'base', emphasis: 'bold', appearance: 'accent' }, `${currencyCode} ${totalAmount}`),
    ]);

    // Action Buttons
    const confirmButton = root.createComponent(Button, {
      kind: 'primary',
      loading: status === 'loading_confirm',
      onPress: async () => {
        status = 'loading_confirm';
        render();
        try {
          const res = await fetch(`${backendUrl}/api/orders/confirm-shopify-order`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              orderId: order.current?.id,
              orderNumber,
            }),
          });
          const data = await res.json();
          status = 'confirmed';
        } catch (err) {
          status = 'pending';
        }
        render();
      },
    }, '✓ Confirm My Order');

    const cancelButton = root.createComponent(Button, {
      kind: 'secondary',
      loading: status === 'loading_cancel',
      onPress: async () => {
        status = 'loading_cancel';
        render();
        try {
          const res = await fetch(`${backendUrl}/api/orders/cancel-shopify-order`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              orderId: order.current?.id,
              orderNumber,
              reason: 'Customer cancelled on Thank You page',
            }),
          });
          status = 'cancelled';
        } catch (err) {
          status = 'pending';
        }
        render();
      },
    }, '✕ Cancel My Order');

    const actionStack = root.createComponent(BlockStack, { spacing: 'tight' }, [
      confirmButton,
      cancelButton,
    ]);

    // Security message
    const securityMessage = root.createComponent(Text, {
      size: 'extraSmall',
      appearance: 'subdued',
      alignment: 'center',
    }, '🔒 Your response is secure and will be processed immediately.');

    // Assemble components
    container.appendChild(header);
    container.appendChild(root.createComponent(Divider));
    container.appendChild(greetingStack);
    container.appendChild(costSummary);
    container.appendChild(actionStack);
    container.appendChild(securityMessage);
  }

  render();
  root.appendChild(container);
});
