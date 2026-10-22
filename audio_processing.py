"""Select a speech microphone and produce an honest noise-reduced mono preview."""
from pathlib import Path
import wave

import av
import numpy as np
from scipy import signal, ndimage
from faster_whisper.vad import get_speech_timestamps, VadOptions

RATE = 16000
PIPELINE_VERSION = "speech-channel-v3"


def write_wav(path, samples):
    with wave.open(str(path), "wb") as output:
        output.setnchannels(1)
        output.setsampwidth(2)
        output.setframerate(RATE)
        output.writeframes((np.clip(samples, -1, 1) * 32767).astype("<i2").tobytes())


def decode_channels(path):
    pieces = []
    count = 0
    with av.open(str(path)) as container:
        stream = container.streams.audio[0]
        resampler = av.AudioResampler(format="fltp", layout=stream.codec_context.layout, rate=RATE)
        for frame in container.decode(stream):
            for converted in resampler.resample(frame):
                values = converted.to_ndarray()
                count += values.shape[1]
                if count > RATE * 60 * 60:
                    raise ValueError("Recordings longer than one hour must be split before conversion.")
                pieces.append(values)
        for converted in resampler.resample(None):
            pieces.append(converted.to_ndarray())
    if not pieces:
        raise ValueError("This file contains no decodable audio.")
    return np.concatenate(pieces, axis=1).astype(np.float32)


def prepare_audio(source, raw_path, clear_path):
    channels = decode_channels(source)
    sos = signal.butter(3, [80, 7600], btype="bandpass", fs=RATE, output="sos")
    best = None
    for index, channel in enumerate(channels):
        filtered = signal.sosfilt(sos, channel).astype(np.float32)
        peak = float(np.quantile(np.abs(filtered), .999))
        if peak < 0.0001:
            continue
        normalized = filtered * min(8.0, 0.85 / max(peak, .0001))
        sample = normalized[:RATE * 60]
        spans = get_speech_timestamps(sample, VadOptions(threshold=.55, min_speech_duration_ms=250, min_silence_duration_ms=400))
        mask = np.zeros(len(sample), dtype=bool)
        for span in spans:
            mask[span["start"]:span["end"]] = True
        if mask.sum() < RATE * .4:
            continue
        speech = np.sqrt(np.mean(sample[mask] ** 2))
        noise = np.sqrt(np.mean(sample[~mask] ** 2)) if (~mask).sum() else speech
        clipping = np.mean(np.abs(channel) > .99)
        score = float(20 * np.log10((speech + 1e-7) / (noise + 1e-7)) - clipping * 100)
        if best is None or score > best[0]:
            best = (score, index, normalized)
    # Still produce playable audio when speech is absent. Recognition is gated below.
    if best is None:
        index = int(np.argmax(np.mean(channels ** 2, axis=1)))
        normalized = signal.sosfilt(sos, channels[index]).astype(np.float32)
    else:
        _, index, normalized = best
    write_wav(raw_path, channels[index])
    # Work in bounded blocks; stationary spectral attenuation, not beamforming.
    clear = np.empty_like(normalized)
    for start in range(0, len(normalized), RATE * 30):
        block = normalized[start:start + RATE * 30]
        if len(block) < 512:
            clear[start:start + len(block)] = block
            continue
        _, _, spectrum = signal.stft(block, fs=RATE, nperseg=512, noverlap=384)
        power = np.abs(spectrum) ** 2
        noise_floor = np.quantile(power, .15, axis=1, keepdims=True)
        gain = np.clip(1 - .8 * noise_floor / (power + 1e-10), .3, 1)
        gain = ndimage.uniform_filter(gain, size=(3, 5))
        _, restored = signal.istft(spectrum * gain, fs=RATE, nperseg=512, noverlap=384)
        clear[start:start + len(block)] = restored[:len(block)]
    peak = float(np.max(np.abs(clear)))
    if peak > .98:
        clear *= .98 / peak
    write_wav(clear_path, clear)
    spans = get_speech_timestamps(normalized, VadOptions(threshold=.55, min_speech_duration_ms=250, min_silence_duration_ms=400))
    speech_seconds = sum(s["end"] - s["start"] for s in spans) / RATE
    return normalized, {"channels": int(channels.shape[0]), "selectedChannel": index + 1,
                        "durationSeconds": len(clear) / RATE, "speechSeconds": speech_seconds,
                        "enhancement": "Selected microphone · Noise reduced"}
