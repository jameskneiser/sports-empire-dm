'use strict';

const axios = require('axios');
const fs   = require('fs');
const path = require('path');

const GRAPH_API_BASE    = 'https://graph.facebook.com/v21.0';
const INSTAGRAM_API_BASE = 'https://graph.instagram.com';
const ENV_FILE = path.join(__dirname, '..', '.env');

function getHeaders() {
  return {
    Authorization: `Bearer ${process.env.META_ACCESS_TOKEN}`,
    'Content-Type': 'application/json',
  };
}

async function sendTextMessage(recipientId, text) {
  const url = `${GRAPH_API_BASE}/${process.env.INSTAGRAM_ACCOUNT_ID}/messages`;

  try {
    const response = await axios.post(
      url,
      {
        recipient: { id: recipientId },
        message: { text },
      },
      { headers: getHeaders() },
    );
    console.log(`[meta] Sent text to ${recipientId}:`, response.data);
    return response.data;
  } catch (err) {
    const errData = err.response?.data || err.message;
    console.error(`[meta] Failed to send text to ${recipientId}:`, JSON.stringify(errData));
    throw err;
  }
}

async function sendAudioMessage(recipientId, audioUrl) {
  const url = `${GRAPH_API_BASE}/${process.env.INSTAGRAM_ACCOUNT_ID}/messages`;

  try {
    const response = await axios.post(
      url,
      {
        recipient: { id: recipientId },
        message: {
          attachment: {
            type: 'audio',
            payload: {
              url: audioUrl,
              is_reusable: false,
            },
          },
        },
      },
      { headers: getHeaders() },
    );
    console.log(`[meta] Sent audio to ${recipientId}:`, response.data);
    return response.data;
  } catch (err) {
    const errData = err.response?.data || err.message;
    console.error(`[meta] Failed to send audio to ${recipientId}:`, JSON.stringify(errData));
    throw err;
  }
}

// Get user profile (name, username, profile_pic) from Instagram
async function getUserProfile(userId) {
  try {
    const url = `${GRAPH_API_BASE}/${userId}`;
    const response = await axios.get(url, {
      params: {
        fields: 'name,username,profile_pic',
        access_token: process.env.META_ACCESS_TOKEN,
      },
    });
    return response.data;
  } catch (err) {
    console.warn(`[meta] Could not fetch profile for ${userId}:`, err.response?.data?.error?.message || err.message);
    return null;
  }
}

// Exchange a short-lived token for a long-lived one (valid ~60 days).
// Updates process.env.META_ACCESS_TOKEN in memory and writes back to .env
// so the new token survives the next restart.
async function exchangeToken() {
  const shortToken = process.env.META_ACCESS_TOKEN;
  const appId      = process.env.META_APP_ID;
  const appSecret  = process.env.META_APP_SECRET;

  if (!appId || !appSecret) {
    console.warn('[meta] META_APP_ID / META_APP_SECRET not set — skipping token exchange');
    return null;
  }
  if (!shortToken) {
    console.warn('[meta] META_ACCESS_TOKEN not set — skipping token exchange');
    return null;
  }

  console.log('[meta] Exchanging short-lived token for long-lived token...');

  try {
    const response = await axios.get(`${INSTAGRAM_API_BASE}/access_token`, {
      params: {
        grant_type:   'ig_exchange_token',
        client_id:    appId,
        client_secret: appSecret,
        access_token: shortToken,
      },
    });

    const { access_token: longToken, expires_in } = response.data;

    if (!longToken) {
      console.error('[meta] Token exchange response missing access_token:', response.data);
      return null;
    }

    const expiresInDays = expires_in ? Math.floor(expires_in / 86400) : '?';

    // Update in-memory token so all subsequent API calls use the new one
    process.env.META_ACCESS_TOKEN = longToken;

    // Persist back to .env so the next restart doesn't need to re-exchange
    try {
      let envContent = fs.readFileSync(ENV_FILE, 'utf8');
      envContent = envContent.replace(
        /^META_ACCESS_TOKEN=.*/m,
        `META_ACCESS_TOKEN=${longToken}`,
      );
      fs.writeFileSync(ENV_FILE, envContent, 'utf8');
      console.log(`[meta] Long-lived token written back to .env (expires in ~${expiresInDays} days)`);
    } catch (writeErr) {
      // Non-fatal — in-memory token is still updated
      console.warn('[meta] Could not write token back to .env:', writeErr.message);
    }

    console.log(`[meta] Token exchange successful — expires in ~${expiresInDays} days`);
    return longToken;
  } catch (err) {
    const detail = err.response?.data?.error?.message || err.message;
    console.error('[meta] Token exchange failed:', detail);
    console.warn('[meta] Continuing with existing token');
    return null;
  }
}

module.exports = { sendTextMessage, sendAudioMessage, getUserProfile, exchangeToken };
