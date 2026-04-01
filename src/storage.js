'use strict';

const fs = require('fs');
const path = require('path');

const DATA_FILE = path.join(__dirname, '..', 'conversations.json');

function loadAll() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      const raw = fs.readFileSync(DATA_FILE, 'utf8');
      return JSON.parse(raw);
    }
  } catch (e) {
    console.error('[storage] Failed to load conversations:', e.message);
  }
  return {};
}

function saveAll(data) {
  try {
    fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2), 'utf8');
  } catch (e) {
    console.error('[storage] Failed to save conversations:', e.message);
  }
}

let store = loadAll();

function get(senderId) {
  return store[senderId] || null;
}

function getOrCreate(senderId) {
  if (!store[senderId]) {
    store[senderId] = {
      senderId,
      handle: null,
      stage: 'welcome',
      qualified: null,
      aiPaused: false,
      messages: [],
      voiceMemoSent: false,
      callBooked: false,
      lastMessageAt: new Date().toISOString(),
      createdAt: new Date().toISOString(),
      rating: null,
      disqualifiedAt: null,
      bookedAt: null,
    };
    saveAll(store);
  }
  return store[senderId];
}

function update(senderId, updates) {
  if (!store[senderId]) getOrCreate(senderId);
  store[senderId] = { ...store[senderId], ...updates };
  saveAll(store);
  return store[senderId];
}

function addMessage(senderId, role, text, extra = {}) {
  if (!store[senderId]) getOrCreate(senderId);
  const msg = {
    role,
    content: text,
    timestamp: new Date().toISOString(),
    ...extra,
  };
  store[senderId].messages.push(msg);
  store[senderId].lastMessageAt = msg.timestamp;
  saveAll(store);
  return msg;
}

function getAll() {
  return store;
}

function pauseAll() {
  Object.keys(store).forEach((id) => {
    store[id].aiPaused = true;
  });
  saveAll(store);
}

function unpauseAll() {
  Object.keys(store).forEach((id) => {
    store[id].aiPaused = false;
  });
  saveAll(store);
}

function getStats() {
  const convos = Object.values(store);
  const today = new Date().toDateString();

  const qualifiedToday = convos.filter(
    (c) =>
      c.qualified === true &&
      c.lastMessageAt &&
      new Date(c.lastMessageAt).toDateString() === today,
  ).length;

  const callsBooked = convos.filter((c) => c.callBooked).length;
  const disqualified = convos.filter((c) => c.stage === 'disqualified').length;
  const voiceMemosSent = convos.filter((c) => c.voiceMemoSent).length;
  const aiPaused = convos.filter((c) => c.aiPaused).length;
  const activeLeads = convos.filter(
    (c) => c.stage !== 'disqualified' && !c.callBooked,
  ).length;

  const totalQualified = convos.filter((c) => c.qualified === true).length;
  const conversionRate =
    convos.length > 0 ? Math.round((callsBooked / convos.length) * 100) : 0;

  return {
    activeLeads,
    qualifiedToday,
    callsBooked,
    disqualified,
    voiceMemosSent,
    conversionRate,
    aiPausedCount: aiPaused,
    totalLeads: convos.length,
    totalQualified,
  };
}

module.exports = { get, getOrCreate, update, addMessage, getAll, pauseAll, unpauseAll, getStats };
