#!/usr/bin/env python3
"""VoiceClaw Kokoro TTS helper.

Reads UTF-8 text from stdin and writes raw PCM s16le mono 16 kHz audio to stdout.
Diagnostics go to stderr so Node can stream stdout directly to the iPhone.
"""

from __future__ import annotations

import argparse
import sys

import numpy as np
from scipy.signal import resample_poly


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Stream Kokoro TTS as PCM16/16k.")
    parser.add_argument("--model", default="mlx-community/Kokoro-82M-bf16")
    parser.add_argument("--voice", default="af_heart")
    parser.add_argument("--lang", default="a")
    parser.add_argument("--speed", type=float, default=1.0)
    return parser.parse_args()


def trim_silence(audio: np.ndarray, threshold: float = 0.01, pad_samples: int = 120) -> np.ndarray:
    if audio.size == 0:
        return audio
    active = np.flatnonzero(np.abs(audio) > threshold)
    if active.size == 0:
        return audio
    start = max(0, int(active[0]) - pad_samples)
    end = min(audio.size, int(active[-1]) + pad_samples)
    return audio[start:end]


def to_pcm16_16k(audio: np.ndarray, sample_rate: int) -> bytes:
    audio = np.asarray(audio, dtype=np.float32).reshape(-1)
    audio = trim_silence(audio)
    if sample_rate != 16000:
        audio = resample_poly(audio, 16000, int(sample_rate))
    audio = np.clip(audio, -1.0, 1.0)
    return (audio * 32767.0).astype("<i2").tobytes()


def generate_with_mlx_audio(text: str, args: argparse.Namespace) -> None:
    from mlx_audio.tts.utils import load_model

    model = load_model(args.model)
    sample_rate = int(getattr(model, "sample_rate", 24000) or 24000)
    for result in model.generate(
        text=text,
        voice=args.voice,
        speed=args.speed,
        lang_code=args.lang,
        split_pattern=r"\n+",
    ):
        audio = getattr(result, "audio", None)
        if audio is None:
            continue
        pcm = to_pcm16_16k(np.asarray(audio), sample_rate)
        if pcm:
            sys.stdout.buffer.write(pcm)
            sys.stdout.buffer.flush()


def generate_with_native_kokoro(text: str, args: argparse.Namespace) -> None:
    from kokoro import KPipeline

    pipeline = KPipeline(lang_code=args.lang)
    for _, _, audio in pipeline(text, voice=args.voice, speed=args.speed):
        if audio is None:
            continue
        pcm = to_pcm16_16k(np.asarray(audio), 24000)
        if pcm:
            sys.stdout.buffer.write(pcm)
            sys.stdout.buffer.flush()


def main() -> int:
    args = parse_args()
    text = sys.stdin.read().strip()
    if not text:
        print("empty text", file=sys.stderr)
        return 2
    try:
        generate_with_mlx_audio(text, args)
        return 0
    except Exception as mlx_error:
        print(f"mlx_audio kokoro failed: {mlx_error}", file=sys.stderr)
        try:
            generate_with_native_kokoro(text, args)
            return 0
        except Exception as native_error:
            print(f"native kokoro failed: {native_error}", file=sys.stderr)
            return 1


if __name__ == "__main__":
    raise SystemExit(main())
