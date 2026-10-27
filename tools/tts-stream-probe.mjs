// Measures time-to-first-audio-byte against the TTS upstream and the gateway.
//
// Task: docs/tasks/2026-10-26-tts-streaming-pcm.md. The verdict "is this really
// streaming?" needs the first chunk to arrive before the whole synthesis ends,
// so this script records TTFB, first-chunk size, chunk count, and total time.
//
// Usage: node tools/tts-stream-probe.mjs <url> <mode> [text]
//   mode: upstream (GPT-SoVITS /tts with streaming_mode) | gateway (OpenAI
//         compatible /v1/audio/speech with stream=true)

const url = process.argv[2];
const mode = process.argv[3] || 'upstream';
const text = process.argv[4] || '请分别说明图书馆的开放时间、借阅规则和闭馆日，每项各用一句话回答。';

const body =
  mode === 'upstream'
    ? {
        text,
        text_lang: 'zh',
        ref_audio_path: 'refs/furina/furina_normal.wav',
        prompt_text: '我只是一个普通的图书管理员，平时最喜欢的事情就是整理书架和安静地读书。',
        prompt_lang: 'zh',
        top_k: 15,
        top_p: 1,
        temperature: 1,
        text_split_method: 'cut5',
        batch_size: 1,
        speed_factor: 1.0,
        repetition_penalty: 1.35,
        seed: -1,
        media_type: 'wav',
        streaming_mode: 3,
      }
    : {
        model: 'tts-1',
        input: text,
        voice: 'xxx_trained',
        response_format: 'wav',
        text_lang: 'zh',
        prompt_lang: 'zh',
        stream: true,
      };

const started = performance.now();
const response = await fetch(url, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

if (!response.ok) {
  console.error(`HTTP ${response.status}: ${(await response.text()).slice(0, 300)}`);
  process.exit(1);
}

const reader = response.body.getReader();
let firstAt = null;
let firstSize = 0;
let chunks = 0;
let total = 0;
const arrivals = [];
const header = [];

for (;;) {
  const { done, value } = await reader.read();
  if (done) break;
  const at = performance.now() - started;
  if (firstAt === null) {
    firstAt = at;
    firstSize = value.byteLength;
    header.push(Buffer.from(value.subarray(0, 12)).toString('ascii'));
  }
  chunks += 1;
  total += value.byteLength;
  arrivals.push(at);
}
const totalMs = performance.now() - started;
const gaps = arrivals.slice(1).map((at, index) => Math.round(at - arrivals[index]));
const lastGap = gaps.length ? gaps[gaps.length - 1] : 0;
const cliff = arrivals.length > 1 && lastGap > 0 && arrivals[arrivals.length - 1] - totalMs > -100;

console.log(
  JSON.stringify(
    {
      mode,
      url,
      status: response.status,
      firstChunkMs: Math.round(firstAt ?? -1),
      firstChunkBytes: firstSize,
      firstChunkPrefix: header[0],
      chunks,
      totalBytes: total,
      totalMs: Math.round(totalMs),
      // "Generated then dumped at once" shows up as: first chunk late and every
      // chunk arriving in the last 100 ms.
      chunksWithinLast100ms: arrivals.filter(at => at > totalMs - 100).length,
      lastChunkGapMs: Math.round(Math.max(0, lastGap)),
      firstToTotalRatio: firstAt ? Number((firstAt / totalMs).toFixed(3)) : null,
    },
    null,
    2,
  ),
);
