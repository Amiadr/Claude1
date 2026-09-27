#!/usr/bin/env python3
"""יוצר קובץ WAV סינתטי לבדיקות: רקע שקט, שתי דפיקות ו"גרירה", בזמנים ידועים.

שימוש: make_test_audio.py OUT.wav [--rate 48000]
אירועים צפויים (שניות מתחילת הקובץ): דפיקה ב-5.0, גרירה 12.0–14.0, דפיקה כפולה ב-25.0/25.5.
"""
import argparse
import wave

import numpy as np

EVENTS = [
    ("bang", 5.0, 0.15),
    ("drag", 12.0, 2.0),
    ("bang", 25.0, 0.15),
    ("bang", 25.5, 0.15),
]
DURATION = 40.0


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("out")
    ap.add_argument("--rate", type=int, default=48000)
    args = ap.parse_args()
    sr = args.rate
    rng = np.random.default_rng(1234)
    n = int(DURATION * sr)
    sig = rng.normal(0, 0.001, n)  # רקע ~ -60 dBFS
    for kind, t0, dur in EVENTS:
        i0, i1 = int(t0 * sr), int((t0 + dur) * sr)
        t = np.arange(i1 - i0) / sr
        if kind == "bang":
            burst = np.sin(2 * np.pi * 120 * t) * np.exp(-t * 25) * 0.4 + rng.normal(0, 0.15, i1 - i0) * np.exp(-t * 30)
        else:
            burst = rng.normal(0, 0.056, i1 - i0)  # ~ -25 dBFS RMS
        sig[i0:i1] += burst
    pcm = np.clip(sig, -1, 1)
    pcm = (pcm * 32767).astype(np.int16)
    with wave.open(args.out, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(sr)
        w.writeframes(pcm.tobytes())
    print(f"wrote {args.out}: {DURATION}s @ {sr} Hz, events at {[e[1] for e in EVENTS]}")


if __name__ == "__main__":
    main()
