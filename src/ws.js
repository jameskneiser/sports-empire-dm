'use strict';

const { WebSocketServer } = require('ws');
const storage = require('./storage');

let wss = null;
let getMasterState = () => false; // injected from server.js

function init(server, masterStateFn) {
  if (masterStateFn) getMasterState = masterStateFn;
  wss = new WebSocketServer({ server });

  wss.on('connection', (ws) => {
    console.log('[ws] Client connected');

    // Send full snapshot on connect, including master AI state
    try {
      ws.send(
        JSON.stringify({
          type: 'snapshot',
          conversations: storage.getAll(),
          stats: storage.getStats(),
          masterAiEnabled: getMasterState(),
        }),
      );
    } catch (e) {
      console.error('[ws] Failed to send snapshot:', e.message);
    }

    ws.on('close', () => {
      console.log('[ws] Client disconnected');
    });

    ws.on('error', (err) => {
      console.error('[ws] Error:', err.message);
    });
  });

  console.log('[ws] WebSocket server attached to HTTP server');
}

function broadcast(type, payload) {
  if (!wss) return;

  const msg = JSON.stringify({ type, ...payload });

  wss.clients.forEach((client) => {
    if (client.readyState === 1 /* OPEN */) {
      try {
        client.send(msg);
      } catch (e) {
        console.error('[ws] Broadcast error:', e.message);
      }
    }
  });
}

function broadcastUpdate(senderId) {
  const conversation = storage.get(senderId);
  if (!conversation) return;

  broadcast('update', {
    conversation,
    stats: storage.getStats(),
  });
}

function broadcastAll() {
  broadcast('snapshot', {
    conversations: storage.getAll(),
    stats: storage.getStats(),
  });
}

module.exports = { init, broadcast, broadcastUpdate, broadcastAll };
