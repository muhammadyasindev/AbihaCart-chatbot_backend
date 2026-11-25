const path = require('path');
const dotenv = require('dotenv');

// Load environment variables directly from backend/.env
dotenv.config({ path: path.resolve(__dirname, '../.env') });

const config = require('../src/config/env');
const openaiService = require('../src/services/openai.service');

const maskSecret = (val) => {
  if (!val || typeof val !== 'string') return '[NOT_CONFIGURED]';
  return '[CONFIGURED_AND_KEPT_CONFIDENTIAL]';
};

const sanitizeOutput = (text, secret) => {
  if (!text || typeof text !== 'string') return text;
  if (!secret || typeof secret !== 'string') return text;
  return text.replaceAll(secret, '[REDACTED_SECRET]');
};

async function verifyOpenAIConnectivity() {
  console.log('======================================================================');
  console.log('🔍 OpenAI API Connectivity Verification (Abihacart Customer Support)');
  console.log('======================================================================\n');

  const apiKey = config.openai.apiKey;
  const model = config.openai.model;
  const endpoint = openaiService.apiEndpoint || 'https://api.openai.com/v1/responses';

  // 1. Confirm OPENAI_API_KEY is loaded correctly without printing or exposing its value
  const isKeyLoaded = Boolean(apiKey && apiKey.trim().length > 0);
  console.log('1. API Key Status:');
  console.log(`   - Key Present: ${isKeyLoaded ? 'YES (Loaded successfully from backend/.env)' : 'NO (Missing or empty)'}`);
  console.log(`   - Key Secret Handling: ${maskSecret(apiKey)}`);

  // 2. Confirm OPENAI_MODEL is set to gpt-6-luna
  console.log('\n2. Model Configuration:');
  console.log(`   - Configured Model: "${model}"`);
  console.log(`   - Verified Expected Model (gpt-6-luna): ${model === 'gpt-6-luna' ? 'MATCHES (gpt-6-luna)' : 'MISMATCH'}`);

  // 3. Verify the backend is using the OpenAI Responses API endpoint
  console.log('\n3. Endpoint Verification:');
  console.log(`   - Service Target Endpoint: "${endpoint}"`);
  console.log(`   - Verified Expected Endpoint (https://api.openai.com/v1/responses): ${endpoint === 'https://api.openai.com/v1/responses' ? 'MATCHES' : 'MISMATCH'}`);

  if (!isKeyLoaded) {
    console.log('\n❌ Verification Aborted: OPENAI_API_KEY is not configured in backend/.env.');
    return;
  }

  // 4. Send one minimal real API request using gpt-6-luna
  console.log('\n4. Sending Minimal Direct API Request:');
  console.log(`   - Target: POST ${endpoint}`);
  console.log(`   - Model Requested: ${model}`);
  console.log('   - Request Payload: { model: "gpt-6-luna", input: "Hello" }');

  const startTime = Date.now();
  let response;
  let rawText = '';
  let parsedJson = null;

  try {
    response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: model,
        input: 'Hello',
      }),
    });

    const elapsed = Date.now() - startTime;
    rawText = await response.text();

    try {
      parsedJson = JSON.parse(rawText);
    } catch (e) {
      parsedJson = null;
    }

    console.log(`\n5. API Response Status: HTTP ${response.status} (${response.statusText || 'Status received'}) in ${elapsed}ms`);

    if (response.ok) {
      console.log('\n🎉 Direct API Request Succeeded (Live OpenAI Connection Active):');
      console.log(`   - Returned Model: ${parsedJson?.model || 'N/A'}`);
      console.log(`   - Object Type: ${parsedJson?.object || 'N/A'}`);
      console.log(`   - Output Items: ${(parsedJson?.output || []).length} item(s)`);

      // Extract text content from output
      let responseText = '';
      if (parsedJson?.output) {
        for (const item of parsedJson.output) {
          if (item.type === 'message' && Array.isArray(item.content)) {
            responseText = item.content.map(c => c.text || '').join('');
          } else if (item.type === 'message' && typeof item.content === 'string') {
            responseText = item.content;
          }
        }
      }
      console.log(`   - Assistant Reply: "${responseText.trim() || parsedJson?.output_text || 'Output received'}"`);

      if (parsedJson?.usage) {
        console.log(`   - Token Usage: input=${parsedJson.usage.input_tokens}, output=${parsedJson.usage.output_tokens}, total=${parsedJson.usage.total_tokens}`);
      }

      // 6. Test through backend OpenAI Service
      console.log('\n6. Testing through OpenAIService.processSupportMessage:');
      const svcRes = await openaiService.processSupportMessage({
        messages: [],
        userMessage: 'Hello',
      });

      console.log(`   - Engine Mode: ${svcRes.engineMode}`);
      console.log(`   - Live Connection: ${svcRes.liveConnection}`);
      console.log(`   - Model Used: ${svcRes.model}`);
      console.log(`   - Response Generated: "${svcRes.reply}"`);
      console.log(`   - Product Cards: ${svcRes.productCards.length}`);
      console.log(`   - Escalated: ${svcRes.escalated}`);
    } else {
      console.log('\n⚠️ API Error Response Received:');
      console.log(`   - HTTP Status: ${response.status}`);

      let errorCategory = 'Unknown';
      if (response.status === 401) errorCategory = 'Authentication Error (Invalid API Key or unauthorized)';
      else if (response.status === 403) errorCategory = 'Permission Error (Forbidden / Country or scope restriction)';
      else if (response.status === 404) errorCategory = 'Not Found (Model ID or endpoint path not found on OpenAI API)';
      else if (response.status === 429) errorCategory = 'Rate Limit / Quota Exceeded (Insufficient billing credits or throughput limit)';
      else if (response.status === 400) errorCategory = 'Bad Request (Parameter schema or endpoint request format mismatch)';
      else if (response.status >= 500) errorCategory = 'OpenAI Internal Server Error';

      console.log(`   - Error Category: ${errorCategory}`);

      if (parsedJson?.error) {
        const sanitizedErrMessage = sanitizeOutput(parsedJson.error.message, apiKey);
        console.log(`   - Error Type: ${parsedJson.error.type || 'N/A'}`);
        console.log(`   - Error Code: ${parsedJson.error.code || 'N/A'}`);
        console.log(`   - Error Message: ${sanitizedErrMessage || 'N/A'}`);
      } else {
        const sanitizedRaw = sanitizeOutput(rawText, apiKey);
        console.log(`   - Raw Body: ${sanitizedRaw}`);
      }
    }
  } catch (networkErr) {
    console.error('\n❌ Network or Connectivity Failure:');
    const sanitizedNetworkErr = sanitizeOutput(networkErr.message, apiKey);
    console.error(`   - Details: ${sanitizedNetworkErr}`);
  }

  console.log('\n======================================================================');
  console.log('Verification check finished.');
  console.log('======================================================================\n');
}

verifyOpenAIConnectivity();
