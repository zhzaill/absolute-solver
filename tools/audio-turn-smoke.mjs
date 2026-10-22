import fs from 'node:fs';

const hubUrl = process.env.HUB_URL || 'http://127.0.0.1:18100';
const wavPath = process.env.WAV_FILE;
const deviceId = process.env.DEVICE_ID || 'audio-turn-smoke';
if (!wavPath) throw new Error('WAV_FILE is required');

function parseWav(path) {
  const bytes = fs.readFileSync(path);
  if (bytes.toString('ascii', 0, 4) !== 'RIFF' || bytes.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('not a RIFF/WAVE file');
  }
  let channels = 0;
  let sampleRate = 0;
  let bits = 0;
  let pcm = null;
  for (let offset = 12; offset + 8 <= bytes.length;) {
    const kind = bytes.toString('ascii', offset, offset + 4);
    const size = bytes.readUInt32LE(offset + 4);
    const start = offset + 8;
    if (kind === 'fmt ') {
      channels = bytes.readUInt16LE(start + 2);
      sampleRate = bytes.readUInt32LE(start + 4);
      bits = bytes.readUInt16LE(start + 14);
    } else if (kind === 'data') {
      pcm = bytes.subarray(start, start + size);
    }
    offset = start + size + (size & 1);
  }
  if (!pcm || channels !== 1 || bits !== 16) {
    throw new Error(`expected mono PCM16 WAV, got channels=${channels}, bits=${bits}`);
  }
  return { pcm, sampleRate };
}

function pcmWav(pcm, sampleRate) {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVEfmt ', 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

const state = await (await fetch(`${hubUrl}/state`)).json();
const turn = Number(state.turn || 0) + 1;
const { pcm, sampleRate } = parseWav(wavPath);
const socketUrl = `${hubUrl.replace(/^http/, 'ws')}/ws`;
const socket = new WebSocket(socketUrl);
let sequence = 0;

function send(value) {
  socket.send(JSON.stringify(value));
}

const result = await new Promise((resolve, reject) => {
  const timeout = setTimeout(() => reject(new Error('timed out waiting for say')), 60000);
  socket.addEventListener('open', () => {
    send({
      v: 1,
      type: 'hello',
      device_id: deviceId,
      caps: { mic: true, speaker: true, display: 'subtitle', codec: ['pcm16'] },
    });
    const chunkSize = Math.max(2, Math.floor(pcm.length / 3 / 2) * 2);
    for (let offset = 0; offset < pcm.length; offset += chunkSize) {
      const chunk = pcm.subarray(offset, Math.min(pcm.length, offset + chunkSize));
      send({
        v: 1,
        type: 'audio.up',
        turn,
        seq: sequence++,
        pcm_b64: chunk.toString('base64'),
        sr: sampleRate,
      });
    }
    send({ v: 1, type: 'speech.end', turn, at_ms: Date.now() });
  });
  socket.addEventListener('message', event => {
    const message = JSON.parse(String(event.data));
    if (message.type === 'say' && message.v === 1 && Number(message.turn) >= turn) {
      const responsePcm = Buffer.from(String(message.pcm_b64 || ''), 'base64');
      clearTimeout(timeout);
      resolve({
        turn: message.turn,
        text: message.text,
        sampleRate: message.sr,
        pcmBytes: responsePcm.length,
        mouthValues: Array.isArray(message.mouth) ? message.mouth.length : 0,
        responsePcm,
      });
    }
  });
  socket.addEventListener('error', () => reject(new Error('websocket error')));
});

const outputWav = process.env.OUTPUT_WAV;
let outputPath = null;
if (outputWav) {
  fs.writeFileSync(outputWav, pcmWav(result.responsePcm, result.sampleRate));
  outputPath = outputWav;
}
delete result.responsePcm;

console.log(JSON.stringify({
  hubUrl,
  wavPath,
  inputSampleRate: sampleRate,
  inputPcmBytes: pcm.length,
  ...result,
  outputWav: outputPath,
}));
socket.close();
