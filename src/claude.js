'use strict';

const Anthropic = require('@anthropic-ai/sdk');
const { buildSystemPrompt } = require('./playbook');

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

async function getAIResponse(conversation) {
  const systemPrompt = buildSystemPrompt();

  // Build message history for Claude (user/assistant alternating)
  const messages = conversation.messages
    .filter((m) => m.role === 'user' || m.role === 'assistant')
    .map((m) => ({
      role: m.role,
      content: m.content,
    }));

  // Ensure we have at least one message
  if (messages.length === 0) {
    return null;
  }

  // Ensure messages alternate properly — Claude requires user/assistant alternation
  const cleaned = [];
  let lastRole = null;
  for (const msg of messages) {
    if (msg.role === lastRole) {
      // Merge consecutive messages of same role
      if (cleaned.length > 0) {
        cleaned[cleaned.length - 1].content += '\n' + msg.content;
      }
    } else {
      cleaned.push({ role: msg.role, content: msg.content });
      lastRole = msg.role;
    }
  }

  // Must start with user message
  if (cleaned[0]?.role !== 'user') {
    return null;
  }

  try {
    const response = await client.messages.create({
      model: 'claude-opus-4-6',
      max_tokens: 1024,
      system: systemPrompt,
      messages: cleaned,
    });

    const rawText = response.content[0]?.text || '';

    // Parse JSON response
    let parsed;
    try {
      // Strip markdown code blocks if present
      const jsonStr = rawText.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
      parsed = JSON.parse(jsonStr);
    } catch (parseErr) {
      console.error('[claude] Failed to parse JSON response:', rawText.slice(0, 200));
      // Fallback: return raw text as responseText
      parsed = {
        responseText: rawText,
        sendVoiceMemo: false,
        voiceScript: '',
        stage: conversation.stage || 'welcome',
        qualified: null,
        internalNote: 'JSON parse failed — raw response used',
      };
    }

    return parsed;
  } catch (err) {
    console.error('[claude] API error:', err.message);
    throw err;
  }
}

module.exports = { getAIResponse };
