'use strict';

require('dotenv').config();

const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');

// Ensure uploads directory exists (Railway containers start with a clean filesystem)
try {
  fs.mkdirSync(path.join(__dirname, 'uploads'), { recursive: true });
} catch (err) {
  console.error('[startup] Failed to create uploads directory:', err.message);
  process.exit(1);
}

const storage = require('./src/storage');
const meta = require('./src/meta');
const claude = require('./src/claude');
const elevenlabs = require('./src/elevenlabs');
const ws = require('./src/ws');
const playbook = require('./src/playbook');

const app = express();
const server = http.createServer(app);

// Master AI flag — readable at runtime without restart
let masterAiEnabled = process.env.MASTER_AI_ENABLED === 'true';
function isMasterEnabled() { return masterAiEnabled; }

// Effective AI state for a conversation:
//   aiEnabled=null  → follow global (masterAiEnabled)
//   aiEnabled=true  → forced ON regardless of global
//   aiEnabled=false → forced OFF regardless of global
function isAiActive(convo) {
  if (convo.aiEnabled !== null && convo.aiEnabled !== undefined) return convo.aiEnabled;
  return masterAiEnabled;
}

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));
app.use(express.static(path.join(__dirname, 'public')));

// Init WebSocket — pass master state getter so snapshots include it
ws.init(server, isMasterEnabled);

// ─────────────────────────────────────────────────────────────────────────────
// META WEBHOOK
// ─────────────────────────────────────────────────────────────────────────────

// GET /webhook — verify token handshake
// Health check for Railway
app.get('/', (req, res) => res.sendStatus(200));

app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  console.log(`[webhook] Verify request — mode: ${mode}, token: ${token}`);

  if (mode === 'subscribe' && token === process.env.META_VERIFY_TOKEN) {
    console.log('[webhook] Verified successfully');
    return res.status(200).send(challenge);
  }

  console.warn('[webhook] Verification failed');
  res.sendStatus(403);
});

// POST /webhook — receive incoming DMs
app.post('/webhook', async (req, res) => {
  // Respond immediately to Meta (must be within 20 seconds)
  res.sendStatus(200);

  const body = req.body;

  if (body.object !== 'instagram') {
    return;
  }

  for (const entry of body.entry || []) {
    for (const event of entry.messaging || []) {
      // Skip echo messages (sent by the page)
      if (event.message?.is_echo) continue;

      // Skip read receipts and typing indicators
      if (!event.message?.text && !event.message?.attachments) continue;

      const senderId = event.sender?.id;
      const messageText = event.message?.text || '';

      if (!senderId) continue;

      console.log(`[webhook] Inbound DM from ${senderId}: "${messageText}"`);

      // Process asynchronously
      handleInboundMessage(senderId, messageText).catch((err) => {
        console.error(`[pipeline] Error processing message from ${senderId}:`, err.message);
      });
    }
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// CORE AI PIPELINE
// ─────────────────────────────────────────────────────────────────────────────

async function handleInboundMessage(senderId, messageText) {
  // Get or create conversation
  const convo = storage.getOrCreate(senderId);

  // Fetch profile on first message — username, name, and profile picture
  if (!convo.handle) {
    const profile = await meta.getUserProfile(senderId).catch(() => null);
    if (profile) {
      storage.update(senderId, {
        handle: profile.username || profile.name || senderId,
        name: profile.name || null,
        profilePic: profile.profile_pic || null,
      });
    }
  }

  // Add inbound message
  storage.addMessage(senderId, 'user', messageText);

  // Broadcast inbound message
  ws.broadcastUpdate(senderId);

  // Check effective AI state (global + per-convo override)
  const fresh = storage.get(senderId);
  if (!isAiActive(fresh)) {
    const reason = fresh.aiEnabled === false ? 'individually paused'
      : !masterAiEnabled ? 'master AI is OFF'
      : 'unknown';
    console.log(`[pipeline] AI inactive for ${senderId} (${reason}) — logged, no response sent`);
    return;
  }

  // Run AI
  const aiResult = await claude.getAIResponse(fresh);
  if (!aiResult) {
    console.warn(`[pipeline] No AI response for ${senderId}`);
    return;
  }

  console.log(`[pipeline] AI result for ${senderId}:`, {
    stage: aiResult.stage,
    qualified: aiResult.qualified,
    sendVoiceMemo: aiResult.sendVoiceMemo,
    note: aiResult.internalNote,
  });

  // Send text response
  if (aiResult.responseText) {
    await meta.sendTextMessage(senderId, aiResult.responseText);
    storage.addMessage(senderId, 'assistant', aiResult.responseText, {
      aiResult,
      rating: null,
    });
  }

  // Update conversation state
  const updates = {
    stage: aiResult.stage || fresh.stage,
    lastMessageAt: new Date().toISOString(),
  };

  if (aiResult.qualified !== undefined && aiResult.qualified !== null) {
    updates.qualified = aiResult.qualified;
  }

  if (aiResult.stage === 'disqualified') {
    updates.disqualifiedAt = new Date().toISOString();
    updates.qualified = false;
  }

  if (aiResult.stage === 'book' && aiResult.responseText?.includes('calendly')) {
    // Calendly link was sent — mark as pitched
  }

  storage.update(senderId, updates);
  ws.broadcastUpdate(senderId);

  // Voice memo pipeline
  const voiceEnabled = playbook.getSettings().voiceMemosEnabled;
  if (voiceEnabled && aiResult.sendVoiceMemo && aiResult.voiceScript) {
    const currentConvo = storage.get(senderId);
    if (!currentConvo.voiceMemoSent) {
      await sendVoiceMemo(senderId, aiResult.voiceScript);
    } else {
      console.log(`[pipeline] Voice memo already sent for ${senderId} — skipping duplicate`);
    }
  }

  // Final broadcast
  ws.broadcastUpdate(senderId);
}

async function sendVoiceMemo(senderId, script) {
  try {
    console.log(`[pipeline] Generating voice memo for ${senderId}...`);
    const { audioUrl } = await elevenlabs.generateVoiceMemo(script, senderId);

    await meta.sendAudioMessage(senderId, audioUrl);

    storage.update(senderId, { voiceMemoSent: true });
    storage.addMessage(senderId, 'assistant', '[Voice memo sent]', {
      isVoiceMemo: true,
      audioUrl,
    });

    ws.broadcastUpdate(senderId);
    console.log(`[pipeline] Voice memo sent to ${senderId}: ${audioUrl}`);
  } catch (err) {
    console.error(`[pipeline] Voice memo failed for ${senderId}:`, err.message);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// API ENDPOINTS
// ─────────────────────────────────────────────────────────────────────────────

// Dashboard
app.get('/dashboard', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
});

// All conversations
app.get('/api/conversations', (req, res) => {
  res.json({
    conversations: storage.getAll(),
    stats: storage.getStats(),
  });
});

// Toggle AI for a single conversation (smart override logic)
app.post('/api/pause/:senderId', (req, res) => {
  const { senderId } = req.params;
  const convo = storage.get(senderId);
  if (!convo) return res.status(404).json({ error: 'Conversation not found' });

  const effectiveOn = isAiActive(convo);

  // If turning OFF: set explicit false when global=ON, clear override when global=OFF (was forced-on)
  // If turning ON:  set explicit true  when global=OFF, clear override when global=ON (was forced-off)
  const newAiEnabled = effectiveOn
    ? (masterAiEnabled ? false : null)
    : (masterAiEnabled ? null  : true);

  storage.update(senderId, { aiEnabled: newAiEnabled });
  ws.broadcastUpdate(senderId);

  const newEffective = isAiActive(storage.get(senderId));
  res.json({ senderId, aiEnabled: newAiEnabled, effectiveAiOn: newEffective, masterAiEnabled });
});

// Pause all — sets master AI off (individual overrides are preserved)
app.post('/api/pause-all', (req, res) => {
  const { pause } = req.body;
  masterAiEnabled = pause === false ? true : false;
  console.log(`[master] pause-all set masterAiEnabled=${masterAiEnabled}`);
  ws.broadcast('master-ai', { masterAiEnabled });
  res.json({ success: true, masterAiEnabled });
});

// Manually send a message as James
app.post('/api/send/:senderId', async (req, res) => {
  const { senderId } = req.params;
  const { message } = req.body;

  if (!message) return res.status(400).json({ error: 'Message required' });

  const convo = storage.get(senderId);
  if (!convo) return res.status(404).json({ error: 'Conversation not found' });

  try {
    await meta.sendTextMessage(senderId, message);
    storage.addMessage(senderId, 'assistant', message, { manual: true });
    ws.broadcastUpdate(senderId);
    res.json({ success: true });
  } catch (err) {
    const apiBody = err.response?.data;
    console.error('[/api/send] Error sending message to', senderId);
    console.error('[/api/send] Message:', err.message);
    if (apiBody) console.error('[/api/send] Instagram API response:', JSON.stringify(apiBody, null, 2));
    res.status(500).json({ error: err.message });
  }
});

// Mark as booked
app.post('/api/book/:senderId', (req, res) => {
  const { senderId } = req.params;
  storage.update(senderId, {
    callBooked: true,
    bookedAt: new Date().toISOString(),
    qualified: true,
    stage: 'book',
  });
  ws.broadcastUpdate(senderId);
  res.json({ success: true });
});

// Mark as disqualified
app.post('/api/disqualify/:senderId', (req, res) => {
  const { senderId } = req.params;
  storage.update(senderId, {
    stage: 'disqualified',
    qualified: false,
    disqualifiedAt: new Date().toISOString(),
  });
  ws.broadcastUpdate(senderId);
  res.json({ success: true });
});

// Update playbook settings
app.post('/api/settings', (req, res) => {
  try {
    playbook.updateSettings(req.body);
    res.json({ success: true, settings: playbook.getSettings() });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Get current settings
app.get('/api/settings', (req, res) => {
  res.json({ ...playbook.getSettings(), masterAiEnabled });
});

// Toggle master AI kill switch
app.post('/api/master-ai', (req, res) => {
  const { enabled } = req.body;
  if (typeof enabled !== 'boolean') {
    return res.status(400).json({ error: 'enabled (boolean) required' });
  }
  masterAiEnabled = enabled;
  console.log(`[master] MASTER_AI_ENABLED set to ${masterAiEnabled}`);
  // Broadcast new state to all dashboard clients
  ws.broadcast('master-ai', { masterAiEnabled });
  res.json({ masterAiEnabled });
});

// Rate an AI response (thumbs up/down)
app.post('/api/train', (req, res) => {
  const { senderId, messageIndex, rating, note } = req.body;

  if (!senderId) return res.status(400).json({ error: 'senderId required' });

  const convo = storage.get(senderId);
  if (!convo) return res.status(404).json({ error: 'Conversation not found' });

  if (messageIndex !== undefined && convo.messages[messageIndex]) {
    convo.messages[messageIndex].rating = rating;
    convo.messages[messageIndex].ratingNote = note || null;
    storage.update(senderId, { messages: convo.messages });
    ws.broadcastUpdate(senderId);
  }

  console.log(`[train] Rating for ${senderId} msg[${messageIndex}]: ${rating}`, note || '');
  res.json({ success: true });
});

// Send manual voice memo
app.post('/api/voice/:senderId', async (req, res) => {
  const { senderId } = req.params;
  const { script } = req.body;

  if (!script) return res.status(400).json({ error: 'script required' });

  const convo = storage.get(senderId);
  if (!convo) return res.status(404).json({ error: 'Conversation not found' });

  try {
    await sendVoiceMemo(senderId, script);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Stats endpoint
app.get('/api/stats', (req, res) => {
  res.json(storage.getStats());
});

// ─────────────────────────────────────────────────────────────────────────────
// START SERVER
// ─────────────────────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3000;

async function start() {
  // Token exchange disabled — already using a long-lived Instagram token
  // await meta.exchangeToken();

  server.listen(PORT, '0.0.0.0', () => {
    console.log(`[startup] Listening on 0.0.0.0:${PORT}`);
    console.log('');
    console.log('╔═══════════════════════════════════════════════════╗');
    console.log('║         SPORTS EMPIRE DM AUTOMATION               ║');
    console.log('╠═══════════════════════════════════════════════════╣');
    console.log(`║  Server:    http://localhost:${PORT}                  ║`);
    console.log(`║  Dashboard: http://localhost:${PORT}/dashboard         ║`);
    console.log(`║  Webhook:   http://localhost:${PORT}/webhook           ║`);
    console.log('╠═══════════════════════════════════════════════════╣');
    console.log(`║  Verify Token: ${process.env.META_VERIFY_TOKEN}  ║`);
    console.log('╚═══════════════════════════════════════════════════╝');
    console.log('');
    console.log('Run: npx localtunnel --port 3000');
    console.log('Then register webhook URL in Meta Developer Portal');
    console.log('');
  });
}

start().catch((err) => {
  console.error('[startup] FATAL ERROR — server failed to start');
  console.error('[startup] Message:', err.message);
  console.error('[startup] Stack:', err.stack);
  if (err.code) console.error('[startup] Error code:', err.code);
  process.exit(1);
});
