'use strict';

const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { convertToOgg } = require('./audio');

const ELEVENLABS_API_URL = 'https://api.elevenlabs.io/v1/text-to-speech';
const UPLOADS_DIR = path.join(__dirname, '..', 'uploads');

async function generateVoiceMemo(script, senderId) {
  const voiceId = process.env.ELEVENLABS_VOICE_ID;
  const apiKey = process.env.ELEVENLABS_API_KEY;

  if (!voiceId || !apiKey) {
    throw new Error('ElevenLabs credentials not configured');
  }

  console.log(`[elevenlabs] Generating voice memo for ${senderId}...`);

  const response = await axios.post(
    `${ELEVENLABS_API_URL}/${voiceId}`,
    {
      text: script,
      model_id: 'eleven_turbo_v2',
      voice_settings: {
        stability: 0.5,
        similarity_boost: 0.85,
      },
    },
    {
      headers: {
        'xi-api-key': apiKey,
        'Content-Type': 'application/json',
        Accept: 'audio/mpeg',
      },
      responseType: 'arraybuffer',
    },
  );

  // Save MP3
  const timestamp = Date.now();
  const mp3Filename = `memo_${senderId}_${timestamp}.mp3`;
  const mp3Path = path.join(UPLOADS_DIR, mp3Filename);
  fs.writeFileSync(mp3Path, Buffer.from(response.data));
  console.log(`[elevenlabs] Saved MP3: ${mp3Path}`);

  // Convert to OGG
  const oggFilename = `memo_${senderId}_${timestamp}.ogg`;
  const oggPath = path.join(UPLOADS_DIR, oggFilename);
  await convertToOgg(mp3Path, oggPath);
  console.log(`[elevenlabs] Converted to OGG: ${oggPath}`);

  // Clean up MP3
  try {
    fs.unlinkSync(mp3Path);
  } catch (e) {
    // non-fatal
  }

  const publicUrl = process.env.PUBLIC_URL || 'http://localhost:3000';
  const audioUrl = `${publicUrl}/uploads/${oggFilename}`;
  console.log(`[elevenlabs] Audio URL: ${audioUrl}`);

  return { oggPath, audioUrl, oggFilename };
}

module.exports = { generateVoiceMemo };
