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
    const status  = err.response?.status;
    const errBody = err.response?.data;
    const igError = errBody?.error;
    console.error(`[meta] sendTextMessage failed — HTTP ${status ?? 'N/A'}`);
    console.error(`[meta] recipient: ${recipientId}`);
    console.error(`[meta] token present: ${!!process.env.META_ACCESS_TOKEN}`);
    if (igError) {
      console.error(`[meta] Instagram error code: ${igError.code}`);
      console.error(`[meta] Instagram error type: ${igError.type}`);
      console.error(`[meta] Instagram error message: ${igError.message}`);
      console.error(`[meta] Instagram error fbtrace_id: ${igError.fbtrace_id}`);
    } else {
      console.error(`[meta] Raw response body:`, JSON.stringify(errBody ?? err.message, null, 2));
    }
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

// Token exchange disabled — already using a long-lived Instagram token (META_ACCESS_TOKEN).
// eslint-disable-next-line no-unused-vars
async function exchangeToken() {
  console.log('[meta] Token exchange skipped — using long-lived META_ACCESS_TOKEN as-is');
  return null;
}

module.exports = { sendTextMessage, sendAudioMessage, getUserProfile, exchangeToken };
