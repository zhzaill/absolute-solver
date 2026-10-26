"""Compare a source WAV with a microphone capture of the same playback.

Renders a side-by-side spectrogram PNG and prints level statistics, so the
database entry for the ASR acceptance can show *why* the capture failed.
"""

import struct
import sys
import wave

import numpy as np
from PIL import Image, ImageDraw

SRC = r"D:\11\Logs\asr\loopback-tts.wav"
CAP = r"D:\11\Logs\asr\record-1793026759495.wav"
OUT = r"D:\11\Logs\asr\loopback-spectrogram.png"


def load(path):
    with wave.open(path, "rb") as handle:
        channels = handle.getnchannels()
        width = handle.getsampwidth()
        rate = handle.getframerate()
        frames = handle.readframes(handle.getnframes())
    if width != 2:
        raise SystemExit(f"{path}: expected 16-bit PCM, got {width * 8}-bit")
    data = np.frombuffer(frames, dtype="<i2").astype(np.float32) / 32768.0
    if channels > 1:
        data = data.reshape(-1, channels).mean(axis=1)
    return rate, data


def stats(rate, data, label):
    window = max(1, rate // 10)
    rms = []
    peak = []
    for start in range(0, len(data) - window + 1, window):
        block = data[start : start + window]
        rms.append(float(np.sqrt(np.mean(block**2))))
        peak.append(float(np.max(np.abs(block))))
    rms = np.array(rms)
    peak = np.array(peak)

    def db(value):
        return 20 * np.log10(value) if value > 0 else -120.0

    zeros = float(np.mean(data == 0) * 100)
    print(f"== {label} ==")
    print(f"  {len(data)} samples, {len(data) / rate:.2f}s @ {rate} Hz")
    print(f"  overall rms {db(float(np.sqrt(np.mean(data**2)))):.1f} dBFS, peak {db(float(np.max(np.abs(data)))):.1f} dBFS")
    print(f"  exact-zero samples: {zeros:.1f}%")
    print(f"  loudest 100ms block: {db(float(peak.max())):.1f} dBFS")
    print(f"  blocks above -40 dBFS: {int((rms > 10 ** (-40 / 20)).sum())}/{len(rms)}")
    print("  envelope (dBFS per 100ms, first 40 blocks):")
    print("   " + " ".join(f"{db(v):.0f}" if v > 0 else "-inf" for v in rms[:40]))
    return rms, peak


def spectrogram(rate, data, height=170, width=520, fmax=5000):
    win = 1024
    hop = max(1, (len(data) - win) // width) if len(data) > win else win
    frames = []
    for offset in range(0, max(1, len(data) - win), hop):
        block = data[offset : offset + win]
        if len(block) < win:
            block = np.pad(block, (0, win - len(block)))
        spectrum = np.abs(np.fft.rfft(block * np.hanning(win))) / (win / 4)
        frames.append(spectrum[: int(fmax / (rate / 2) * len(spectrum))])
        if len(frames) >= width:
            break
    grid = np.array(frames).T  # rows = frequency, cols = time
    if grid.size == 0:
        return Image.new("RGB", (width, height), (2, 6, 15))
    db = 20 * np.log10(np.maximum(grid, 1e-7))
    norm = np.clip((db + 90) / 80, 0, 1)
    # dark blue -> cyan -> mint -> amber
    stops = np.array([[4, 8, 18], [12, 43, 75], [50, 140, 190], [85, 224, 176], [242, 195, 91]])
    positions = np.linspace(0, 1, len(stops))
    rgb = np.zeros(norm.shape + (3,), dtype=np.uint8)
    for channel in range(3):
        rgb[..., channel] = np.interp(norm, positions, stops[:, channel]).astype(np.uint8)
    image = Image.fromarray(rgb[::-1]).resize((width, height), Image.BILINEAR)
    return image


def main():
    rate_src, src = load(SRC)
    rate_cap, cap = load(CAP)
    stats(rate_src, src, "source (clean TTS file)")
    stats(rate_cap, cap, "capture (headset mic, room playback)")

    left = spectrogram(rate_src, src)
    right = spectrogram(rate_cap, cap)
    padding, header = 10, 34
    canvas = Image.new(
        "RGB", (left.width + right.width + padding * 3, left.height + header + padding), (4, 8, 18)
    )
    draw = ImageDraw.Draw(canvas)
    canvas.paste(left, (padding, header))
    canvas.paste(right, (left.width + padding * 2, header))
    draw.text((padding, 10), "SOURCE  (clean TTS, ASR reads it perfectly)", fill=(85, 224, 176))
    draw.text(
        (left.width + padding * 2, 10),
        "CAPTURE  (mic, peak -33 dBFS, ASR says garbage)",
        fill=(255, 108, 125),
    )
    draw.text((padding, header + left.height + 2), "0s", fill=(115, 148, 181))
    draw.text((left.width + padding - 14, header + left.height + 2), f"{len(src)/rate_src:.1f}s", fill=(115, 148, 181))
    draw.text((left.width + padding * 2, header + left.height + 2), "0s", fill=(115, 148, 181))
    draw.text(
        (left.width * 2 + padding * 2 - 14, header + left.height + 2),
        f"{len(cap)/rate_cap:.1f}s",
        fill=(115, 148, 181),
    )
    canvas.save(OUT)
    print(f"\nwrote {OUT}")


if __name__ == "__main__":
    sys.exit(main())
