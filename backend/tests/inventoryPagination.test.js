/**
 * Comprehensive Automated Tests for Inventory Aggregation and Cursor-Based Pagination
 */
const shopifyService = require('../src/services/shopify.service');

const assert = (condition, msg) => {
  if (!condition) {
    throw new Error(`Assertion failed: ${msg}`);
  }
};

const runInventoryPaginationTests = async () => {
  console.log('====================================================');
  console.log('🧪 Starting Inventory Pagination & Location Filter Tests');
  console.log('====================================================\n');

  // -----------------------------------------------------------------
  // Suite 1: Pure Unit Tests for aggregateInventoryLevels
  // -----------------------------------------------------------------
  console.log('--- Suite 1: Location Filtering & Stock Aggregation Math ---');

  // 1.1 Empty array check
  assert(shopifyService.aggregateInventoryLevels([]) === 0, 'Empty levels must return 0');
  assert(shopifyService.aggregateInventoryLevels(null) === 0, 'Null levels must return 0');
  console.log('✅ Test 1.1: Empty levels return 0.');

  // 1.2 All active online locations
  const activeOnlineLevels = [
    {
      location: { id: 'loc1', name: 'Dubai Warehouse', isActive: true, fulfillsOnlineOrders: true },
      quantities: [{ name: 'available', quantity: 15 }],
    },
    {
      location: { id: 'loc2', name: 'Abu Dhabi Fulfillment Hub', isActive: true, fulfillsOnlineOrders: true },
      quantities: [{ name: 'available', quantity: 25 }],
    },
  ];
  assert(shopifyService.aggregateInventoryLevels(activeOnlineLevels) === 40, 'Active online locations must be summed (15 + 25 = 40)');
  console.log('✅ Test 1.2: Active online locations correctly summed to 40.');

  // 1.3 Inactive locations must be ignored
  const mixedActiveInactive = [
    {
      location: { id: 'loc1', name: 'Active Warehouse', isActive: true, fulfillsOnlineOrders: true },
      quantities: [{ name: 'available', quantity: 10 }],
    },
    {
      location: { id: 'loc2', name: 'Decommissioned Facility', isActive: false, fulfillsOnlineOrders: true },
      quantities: [{ name: 'available', quantity: 50 }], // Must NOT be counted
    },
  ];
  assert(shopifyService.aggregateInventoryLevels(mixedActiveInactive) === 10, 'Inactive location (50) must not be counted');
  console.log('✅ Test 1.3: Deactivated location stock strictly filtered out.');

  // 1.4 Non-online locations (retail-only / pickup only) must be ignored
  const mixedOnlineFulfillment = [
    {
      location: { id: 'loc1', name: 'Online Ecommerce Hub', isActive: true, fulfillsOnlineOrders: true },
      quantities: [{ name: 'available', quantity: 30 }],
    },
    {
      location: { id: 'loc2', name: 'Retail Storefront Only', isActive: true, fulfillsOnlineOrders: false },
      quantities: [{ name: 'available', quantity: 100 }], // Must NOT be counted
    },
  ];
  assert(shopifyService.aggregateInventoryLevels(mixedOnlineFulfillment) === 30, 'Non-online fulfillment location (100) must not be counted');
  console.log('✅ Test 1.4: Non-online fulfilling location stock strictly filtered out.');

  // 1.5 Oversold negative quantities floored at 0
  const oversoldLevels = [
    {
      location: { id: 'loc1', name: 'Oversold Location', isActive: true, fulfillsOnlineOrders: true },
      quantities: [{ name: 'available', quantity: -10 }],
    },
  ];
  assert(shopifyService.aggregateInventoryLevels(oversoldLevels) === 0, 'Negative available stock must be floored at 0');
  console.log('✅ Test 1.5: Oversold negative stock safely floored at 0 (never negative).');

  // -----------------------------------------------------------------
  // Suite 2: Cursor-Based Pagination Across 120+ Locations (3 Pages)
  // -----------------------------------------------------------------
  console.log('\n--- Suite 2: Multi-Page Cursor-Based Pagination (>50 Locations) ---');

  // Mock GraphQL caller that simulates 120 locations across 3 pages:
  // Page 1: 50 locations, each has 2 units available (active, online) -> 100 units. hasNextPage: true
  // Page 2: 50 locations, 40 active online (2 units each = 80 units), 10 inactive (ignored). hasNextPage: true
  // Page 3: 20 locations, 20 active online (3 units each = 60 units). hasNextPage: false
  // Expected Total: 100 + 80 + 60 = 240 units.
  const page1Edges = Array.from({ length: 50 }, (_, i) => ({
    node: {
      location: { id: `loc_p1_${i}`, name: `Location P1 ${i}`, isActive: true, fulfillsOnlineOrders: true },
      quantities: [{ name: 'available', quantity: 2 }],
    },
  }));

  const page2Edges = [
    ...Array.from({ length: 40 }, (_, i) => ({
      node: {
        location: { id: `loc_p2_act_${i}`, name: `Location P2 Active ${i}`, isActive: true, fulfillsOnlineOrders: true },
        quantities: [{ name: 'available', quantity: 2 }],
      },
    })),
    ...Array.from({ length: 10 }, (_, i) => ({
      node: {
        location: { id: `loc_p2_inact_${i}`, name: `Location P2 Inactive ${i}`, isActive: false, fulfillsOnlineOrders: true },
        quantities: [{ name: 'available', quantity: 999 }], // Should be ignored
      },
    })),
  ];

  const page3Edges = Array.from({ length: 20 }, (_, i) => ({
    node: {
      location: { id: `loc_p3_${i}`, name: `Location P3 ${i}`, isActive: true, fulfillsOnlineOrders: true },
      quantities: [{ name: 'available', quantity: 3 }],
    },
  }));

  const pageCallLog = [];

  // Temporarily stub shopifyService.graphql for pagination test
  const originalGraphql = shopifyService.graphql;
  shopifyService.graphql = async ({ query, variables }) => {
    pageCallLog.push({ after: variables.after, first: variables.first });

    if (variables.after === null) {
      // First page
      return {
        inventoryItem: {
          id: variables.id,
          inventoryLevels: {
            pageInfo: { hasNextPage: true, endCursor: 'cursor_page_1' },
            edges: page1Edges,
          },
        },
      };
    } else if (variables.after === 'cursor_page_1') {
      // Second page
      return {
        inventoryItem: {
          id: variables.id,
          inventoryLevels: {
            pageInfo: { hasNextPage: true, endCursor: 'cursor_page_2' },
            edges: page2Edges,
          },
        },
      };
    } else if (variables.after === 'cursor_page_2') {
      // Third (final) page
      return {
        inventoryItem: {
          id: variables.id,
          inventoryLevels: {
            pageInfo: { hasNextPage: false, endCursor: null },
            edges: page3Edges,
          },
        },
      };
    }

    throw new Error(`Unexpected cursor: ${variables.after}`);
  };

  try {
    const totalQty = await shopifyService.getLiveInventoryForItem({
      inventoryItemId: 'gid://shopify/InventoryItem/test_paginated_item',
      pageSize: 50,
    });

    assert(pageCallLog.length === 3, 'Must traverse exactly 3 pages of inventory levels');
    assert(pageCallLog[0].after === null, 'First page must start with after: null');
    assert(pageCallLog[1].after === 'cursor_page_1', 'Second page must use cursor_page_1');
    assert(pageCallLog[2].after === 'cursor_page_2', 'Third page must use cursor_page_2');
    assert(totalQty === 240, `Total aggregated quantity must equal 240 (Got: ${totalQty})`);
    console.log(`✅ Test 2.1: Successfully paginated through 120 locations across 3 pages. Total units: ${totalQty}`);

    // Test 2.2: Single empty result
    shopifyService.graphql = async () => ({ inventoryItem: null });
    const emptyQty = await shopifyService.getLiveInventoryForItem({
      inventoryItemId: 'gid://shopify/InventoryItem/non_existent',
    });
    assert(emptyQty === 0, 'Non-existent item must return 0 without errors');
    console.log('✅ Test 2.2: Empty inventoryItem returns 0 safely.');

    // Test 2.3: Multiple inventory item batch pagination
    let multiCallCount = 0;
    shopifyService.graphql = async ({ variables }) => {
      multiCallCount++;
      return {
        inventoryItem: {
          id: variables.id,
          inventoryLevels: {
            pageInfo: { hasNextPage: false, endCursor: null },
            edges: [
              {
                node: {
                  location: { isActive: true, fulfillsOnlineOrders: true },
                  quantities: [{ name: 'available', quantity: 7 }],
                },
              },
            ],
          },
        },
      };
    };

    const multiMap = await shopifyService.getLiveInventory({
      inventoryItemIds: ['item_1', 'item_2', 'item_3'],
    });

    assert(multiMap.size === 3, 'Map must contain all 3 items');
    assert(multiMap.get('item_1') === 7, 'Item 1 quantity must match');
    assert(multiMap.get('item_2') === 7, 'Item 2 quantity must match');
    assert(multiMap.get('item_3') === 7, 'Item 3 quantity must match');
    assert(multiCallCount === 3, 'Must query all 3 items');
    console.log('✅ Test 2.3: Multi-item batch pagination returns accurate stock map.');

    console.log('\n====================================================');
    console.log('🎉 ALL INVENTORY PAGINATION & FILTER TESTS PASSED');
    console.log('====================================================\n');
  } finally {
    // Restore original graphql implementation
    shopifyService.graphql = originalGraphql;
  }
};

runInventoryPaginationTests();
