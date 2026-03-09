#!/usr/bin/env node
/**
 * Quick test: generate a valid WAV file with a sine wave tone,
 * send it to Whisper, and print the result.
 *
 * Usage: OPENAI_API_KEY=... node test-stt.js
 *
 * If this works, the issue is in the browser's audio recording.
 * If this fails with the same error, the issue is in our upload code.
 */
const { transcribe } = require("./stt");

function generateWav(durationSec, sampleRate, freq) {
  const numSamples = durationSec * sampleRate;
  const dataSize = numSamples * 2; // 16-bit mono
  const buf = Buffer.alloc(44 + dataSize);

  // RIFF header
  buf.write("RIFF", 0);
  buf.writeUInt32LE(36 + dataSize, 4);
  buf.write("WAVE", 8);

  // fmt chunk
  buf.write("fmt ", 12);
  buf.writeUInt32LE(16, 16);       // chunk size
  buf.writeUInt16LE(1, 20);        // PCM
  buf.writeUInt16LE(1, 22);        // mono
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28); // byte rate
  buf.writeUInt16LE(2, 32);        // block align
  buf.writeUInt16LE(16, 34);       // bits per sample

  // data chunk
  buf.write("data", 36);
  buf.writeUInt32LE(dataSize, 40);

  // Generate sine wave
  for (let i = 0; i < numSamples; i++) {
    const sample = Math.sin(2 * Math.PI * freq * i / sampleRate) * 0.5 * 32767;
    buf.writeInt16LE(Math.round(sample), 44 + i * 2);
  }

  return buf;
}

async function main() {
  if (!process.env.OPENAI_API_KEY) {
    console.error("Set OPENAI_API_KEY first");
    process.exit(1);
  }

  console.log("Generating 2s WAV tone at 440Hz...");
  const wav = generateWav(2, 16000, 440);
  console.log(`WAV buffer: ${wav.length} bytes`);

  console.log("Sending to Whisper as audio/wav...");
  try {
    const text = await transcribe(wav, "audio/wav");
    console.log(`SUCCESS: "${text}"`);
  } catch (err) {
    console.error(`FAILED: ${err.message}`);
  }
}

main();
