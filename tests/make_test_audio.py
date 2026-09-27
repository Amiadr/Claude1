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


def _highpass(sig, sr, fc=600.0):
    """מסנן HPF פשוט (biquad מסדר 2) – לנשימות: איוושה בלי תדרים נמוכים."""
    import math
    w0 = 2 * math.pi * fc / sr
    alpha = math.sin(w0) / (2 * math.sqrt(0.5))
    cw = math.cos(w0)
    b0, b1, b2 = (1 + cw) / 2, -(1 + cw), (1 + cw) / 2
    a0, a1, a2 = 1 + alpha, -2 * cw, 1 - alpha
    out = np.zeros_like(sig)
    x1 = x2 = y1 = y2 = 0.0
    for i, v in enumerate(sig):
        y = (b0 * v + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2) / a0
        x2, x1, y2, y1 = x1, v, y1, y
        out[i] = y
    return out


def make_breath_file(out, sr):
    rng = np.random.default_rng(99)
    n = int(60 * sr)
    sig = rng.normal(0, 0.0005, n)  # רקע ~ -66 dBFS
    # נשימות: איוושה בתדרים גבוהים, 1.6 שניות, עלייה ודעיכה איטיות, כל 3.5 שניות
    blen = int(1.6 * sr)
    env = np.sin(np.pi * np.arange(blen) / blen) ** 2
    for k in range(int(60 / 3.5)):
        t0 = 1.0 + k * 3.5
        if 16.5 <= t0 <= 24.5 or 36.5 <= t0 <= 45:  # הפסקות בנשימה סביב הדפיקה והגרירה, כדי שלא יתמזגו איתן
            continue
        i0 = int(t0 * sr)
        if i0 + blen > n:
            break
        sig[i0:i0 + blen] += 0.03 * _highpass(rng.normal(0, 1, blen), sr) * env
    # דפיקה דרך הקיר בשנייה 20: תדר נמוך, התקפה מהירה, דעיכה 0.6 שניות
    i0 = int(20 * sr); t = np.arange(int(0.6 * sr)) / sr
    sig[i0:i0 + len(t)] += 0.35 * (np.sin(2 * np.pi * 90 * t) + 0.5 * np.sin(2 * np.pi * 140 * t)) * np.exp(-7 * t) + 0.1 * rng.normal(0, 1, len(t)) * np.exp(-40 * t)
    # גרירה בשנייה 40: רעש רחב עם תדרים נמוכים, 2 שניות
    i0 = int(40 * sr); m = int(2 * sr)
    sig[i0:i0 + m] += 0.06 * rng.normal(0, 1, m) + 0.05 * np.sin(2 * np.pi * 60 * np.arange(m) / sr) * (0.7 + 0.3 * rng.normal(0, 1, m))
    pcm = (np.clip(sig, -1, 1) * 32767).astype(np.int16)
    with wave.open(out, "wb") as w:
        w.setnchannels(1); w.setsampwidth(2); w.setframerate(sr); w.writeframes(pcm.tobytes())
    print(f"wrote {out}: 60s @ {sr} Hz, breaths every 3.5s (13 of them), bang at 20.0, drag at 40.0")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("out")
    ap.add_argument("--rate", type=int, default=48000)
    ap.add_argument("--with-speech", action="store_true", help="הוספת קטע דמוי דיבור (הרמוניות עם גובה צליל משתנה והברות) בשנייה 32")
    ap.add_argument("--breath-file", action="store_true", help="קובץ אחר לגמרי: 60 שניות עם נשימות כל 3.5 שניות, דפיקה בשנייה 20 וגרירה בשנייה 40")
    args = ap.parse_args()
    if args.breath_file:
        return make_breath_file(args.out, args.rate)
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
    if args.with_speech:
        i0 = int(32.0 * sr)
        t = np.arange(int(2.5 * sr)) / sr
        f0 = 100 + 80 * (0.5 + 0.5 * np.sin(2 * np.pi * 0.7 * t))
        phase = 2 * np.pi * np.cumsum(f0) / sr
        voice = sum(np.sin(h * phase) / h for h in range(1, 13))
        syl = (0.5 + 0.5 * np.sin(2 * np.pi * 4 * t)) ** 2
        sig[i0:i0 + len(t)] += 0.15 * voice * syl
    pcm = np.clip(sig, -1, 1)
    pcm = (pcm * 32767).astype(np.int16)
    with wave.open(args.out, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(sr)
        w.writeframes(pcm.tobytes())
    print(f"wrote {args.out}: {DURATION}s @ {sr} Hz, events at {[e[1] for e in EVENTS]}{' + speech-like at 32.0' if args.with_speech else ''}")


if __name__ == "__main__":
    main()
