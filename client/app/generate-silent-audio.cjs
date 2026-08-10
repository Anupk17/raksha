// Generate a 1-second silent WAV file
const fs = require('fs');
const path = require('path');

const sampleRate = 44100;
const numChannels = 1;
const bitsPerSample = 16;
const duration = 1;

const numSamples = sampleRate * duration;
const byteRate = (sampleRate * numChannels * bitsPerSample) / 8;
const blockAlign = (numChannels * bitsPerSample) / 8;
const dataSize = numSamples * blockAlign;
const fileSize = 44 + dataSize;

const buffer = Buffer.alloc(fileSize);

// RIFF header
buffer.write('RIFF', 0);
buffer.writeUInt32LE(fileSize - 8, 4);
buffer.write('WAVE', 8);

// fmt chunk
buffer.write('fmt ', 12);
buffer.writeUInt32LE(16, 16);
buffer.writeUInt16LE(1, 20);
buffer.writeUInt16LE(numChannels, 22);
buffer.writeUInt32LE(sampleRate, 24);
buffer.writeUInt32LE(byteRate, 28);
buffer.writeUInt16LE(blockAlign, 32);
buffer.writeUInt16LE(bitsPerSample, 34);

// data chunk
buffer.write('data', 36);
buffer.writeUInt32LE(dataSize, 40);

// All samples are 0 (silence)
for (let i = 0; i < dataSize; i++) {
  buffer.writeUInt8(0, 44 + i);
}

const outputPath = path.join(__dirname, 'public', 'silent-1sec.wav');
fs.writeFileSync(outputPath, buffer);
console.log(`Silent WAV generated at: ${outputPath}`);
