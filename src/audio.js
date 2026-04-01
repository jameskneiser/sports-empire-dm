'use strict';

const ffmpeg = require('fluent-ffmpeg');
const path = require('path');

// Try to use system ffmpeg
const FFMPEG_PATHS = [
  '/opt/homebrew/bin/ffmpeg',
  '/usr/local/bin/ffmpeg',
  '/usr/bin/ffmpeg',
];

function findFfmpeg() {
  const { execSync } = require('child_process');
  try {
    const which = execSync('which ffmpeg', { encoding: 'utf8' }).trim();
    if (which) return which;
  } catch (e) {
    // not found in PATH
  }
  const fs = require('fs');
  for (const p of FFMPEG_PATHS) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

const ffmpegPath = findFfmpeg();
if (ffmpegPath) {
  ffmpeg.setFfmpegPath(ffmpegPath);
  console.log(`[audio] Using ffmpeg at: ${ffmpegPath}`);
} else {
  console.warn('[audio] ffmpeg not found — voice memos will not convert to OGG');
}

function convertToOgg(inputPath, outputPath) {
  return new Promise((resolve, reject) => {
    if (!ffmpegPath) {
      // If no ffmpeg, just copy the MP3 as-is with .ogg extension (fallback)
      const fs = require('fs');
      fs.copyFileSync(inputPath, outputPath);
      console.warn('[audio] ffmpeg unavailable — serving MP3 as OGG fallback');
      return resolve(outputPath);
    }

    ffmpeg(inputPath)
      .audioCodec('libopus')
      .audioChannels(1)
      .audioBitrate('64k')
      .format('ogg')
      .on('end', () => resolve(outputPath))
      .on('error', (err) => {
        console.error('[audio] ffmpeg error:', err.message);
        // Fallback: copy file
        const fs = require('fs');
        try {
          fs.copyFileSync(inputPath, outputPath);
          resolve(outputPath);
        } catch (copyErr) {
          reject(copyErr);
        }
      })
      .save(outputPath);
  });
}

module.exports = { convertToOgg };
