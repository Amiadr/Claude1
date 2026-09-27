#!/usr/bin/env python3
"""
noise_events.py – חילוץ אירועי רעש מהקלטה ארוכה (למשל הקלטה של לילה שלם מאפליקציית רשמקול).

הכלי סורק את הקובץ, מוצא קטעים שבהם הרמה עוברת סף, וכותב:
  * קליפ WAV לכל אירוע, עם שם קובץ שמכיל את התאריך והשעה המדויקים של תחילת הרעש
  * events.csv – טבלת אירועים (שעה, משך, רמה, היסט בתוך ההקלטה המקורית)
  * summary.txt – סיכום קריא

דוגמאות:
  python3 noise_events.py night.m4a --start "2026-09-26 23:10"
  python3 noise_events.py night.wav --start "2026-09-26 23:10" --threshold 45 --pre 3 --tail 3
  python3 noise_events.py night.mp3 --start 2026-09-26T23:10:00 --out ~/noise/2026-09-26

דרישות: Python 3.9+, numpy. לקבצים שאינם WAV נדרש ffmpeg בנתיב (או --ffmpeg /path/to/ffmpeg).
הרמות הן dBFS יחסי (0 = הרמה המרבית של הקובץ, שקט בחדר בדרך כלל -60 עד -45). לא dB(A) מכויל.
"""
from __future__ import annotations

import argparse
import csv
import datetime as dt
import math
import os
import re
import shutil
import subprocess
import sys
import wave
from dataclasses import dataclass

import numpy as np

BLOCK_SECONDS = 2.0  # גודל בלוק קריאה מהקובץ


# ---------------------------------------------------------------- קריאת אודיו
class AudioSource:
    """מקור PCM מונו int16, נקרא בבלוקים. תומך ב-WAV ישירות ובכל פורמט אחר דרך ffmpeg."""

    def __init__(self, path: str, ffmpeg: str | None, rate: int | None):
        self.path = path
        self.ffmpeg = ffmpeg
        self.is_wav = path.lower().endswith(".wav")
        if self.is_wav:
            with wave.open(path, "rb") as w:
                self.rate = w.getframerate()
                self.channels = w.getnchannels()
                self.width = w.getsampwidth()
                self.total = w.getnframes()
            if self.width not in (1, 2, 3, 4):
                raise SystemExit(f"WAV עם {self.width * 8} ביט לדגימה לא נתמך")
        else:
            exe = ffmpeg or shutil.which("ffmpeg")
            if not exe:
                raise SystemExit("הקובץ אינו WAV ולא נמצא ffmpeg. התקן ffmpeg (https://ffmpeg.org) או המר את הקובץ ל-WAV.")
            self.ffmpeg = exe
            self.rate = rate or 16000
            self.channels = 1
            self.width = 2
            self.total = None  # לא ידוע מראש

    def blocks(self, block_frames: int):
        if self.is_wav:
            yield from self._wav_blocks(block_frames)
        else:
            yield from self._ffmpeg_blocks(block_frames)

    def _wav_blocks(self, block_frames: int):
        with wave.open(self.path, "rb") as w:
            while True:
                raw = w.readframes(block_frames)
                if not raw:
                    break
                yield self._to_mono_int16(raw)

    def _to_mono_int16(self, raw: bytes) -> np.ndarray:
        if self.width == 2:
            a = np.frombuffer(raw, dtype="<i2").astype(np.int32)
        elif self.width == 1:
            a = (np.frombuffer(raw, dtype=np.uint8).astype(np.int32) - 128) << 8
        elif self.width == 3:
            b = np.frombuffer(raw, dtype=np.uint8).reshape(-1, 3).astype(np.int32)
            a = ((b[:, 0] | (b[:, 1] << 8) | (b[:, 2] << 16)) << 8) >> 16  # sign-extend ואז ל-16 ביט
        else:
            a = np.frombuffer(raw, dtype="<i4").astype(np.int64) >> 16
        if self.channels > 1:
            a = a.reshape(-1, self.channels).mean(axis=1)
        return np.clip(a, -32768, 32767).astype(np.int16)

    def _ffmpeg_blocks(self, block_frames: int):
        cmd = [self.ffmpeg, "-v", "error", "-nostdin", "-i", self.path, "-f", "s16le", "-ac", "1", "-ar", str(self.rate), "-"]
        proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        assert proc.stdout is not None
        nbytes = block_frames * 2
        try:
            while True:
                raw = proc.stdout.read(nbytes)
                if not raw:
                    break
                if len(raw) % 2:
                    raw = raw[:-1]
                yield np.frombuffer(raw, dtype="<i2")
        finally:
            err = proc.stderr.read().decode("utf-8", "replace").strip() if proc.stderr else ""
            proc.wait()
            if proc.returncode not in (0, None) and err:
                print(f"ffmpeg: {err}", file=sys.stderr)


# ---------------------------------------------------------------- זיהוי
@dataclass
class Event:
    index: int
    clip_start: int      # דגימה
    noise_start: int     # דגימה שבה הרעש התחיל (אחרי ה-pre-roll)
    clip_end: int        # דגימה (לא כולל)
    peak_db: float
    avg_db: float
    truncated: bool


def frame_levels(src: AudioSource, frame_len: int):
    """מעבר ראשון: רמת RMS (dBFS) לכל פריים. מחזיר (מערך dB, מספר דגימות כולל)."""
    levels = []
    carry = np.zeros(0, dtype=np.int16)
    total = 0
    block_frames = int(BLOCK_SECONDS * src.rate)
    for block in src.blocks(block_frames):
        total += len(block)
        data = np.concatenate([carry, block]) if len(carry) else block
        nfull = len(data) // frame_len
        if nfull:
            f = data[: nfull * frame_len].astype(np.float32).reshape(nfull, frame_len) / 32768.0
            rms = np.sqrt(np.mean(f * f, axis=1))
            levels.append(20 * np.log10(np.maximum(rms, 1e-6)))
        carry = data[nfull * frame_len:]
    if len(carry):
        f = carry.astype(np.float32) / 32768.0
        rms = math.sqrt(float(np.mean(f * f))) if len(f) else 0.0
        levels.append(np.array([20 * math.log10(max(rms, 1e-6))], dtype=np.float32))
    return (np.concatenate(levels) if levels else np.zeros(0, dtype=np.float32)), total


def detect(levels: np.ndarray, frame_len: int, total: int, rate: int, threshold: float, pre: float, tail: float, max_clip: float, min_frames: int) -> list[Event]:
    """אותו אלגוריתם כמו באפליקציית הווב: סף, pre-roll, זנב שקט, אורך מרבי."""
    events: list[Event] = []
    pre_f = int(round(pre * rate / frame_len))
    tail_f = max(1, int(round(tail * rate / frame_len)))
    max_f = max(tail_f + 1, int(round(max_clip * rate / frame_len)))
    loud = levels >= threshold
    n = len(levels)
    i = 0
    prev_end_f = 0
    while i < n:
        if not loud[i]:
            i += 1
            continue
        # דרישת מינימום פריימים רועפים רצופים (לסינון קליקים חשמליים)
        j = i
        while j < n and loud[j]:
            j += 1
        if j - i < min_frames:
            i = j
            continue
        noise_f = i
        start_f = max(prev_end_f, noise_f - pre_f)
        last_loud = j - 1
        k = j
        truncated = False
        while True:
            if k >= n:
                end_f = n
                break
            if loud[k]:
                last_loud = k
            if k - last_loud >= tail_f:
                end_f = last_loud + tail_f + 1
                break
            if k - start_f + 1 >= max_f:
                end_f = k + 1
                truncated = True
                break
            k += 1
        end_f = min(end_f, n)
        seg = levels[start_f:end_f]
        avg = 20 * math.log10(max(float(np.sqrt(np.mean(10 ** (seg / 10)))), 1e-6))
        events.append(Event(
            index=len(events) + 1,
            clip_start=start_f * frame_len,
            noise_start=noise_f * frame_len,
            clip_end=min(end_f * frame_len, total),
            peak_db=float(seg.max()),
            avg_db=avg,
            truncated=truncated,
        ))
        prev_end_f = end_f
        i = end_f
    return events


# ---------------------------------------------------------------- כתיבת קליפים
def write_clips(src: AudioSource, events: list[Event], out_dir: str, names: list[str]):
    """מעבר שני: קריאה סדרתית וכתיבת כל קליפ ל-WAV."""
    os.makedirs(out_dir, exist_ok=True)
    block_frames = int(BLOCK_SECONDS * src.rate)
    pos = 0
    ei = 0
    writer: wave.Wave_write | None = None
    for block in src.blocks(block_frames):
        b0, b1 = pos, pos + len(block)
        while ei < len(events):
            ev = events[ei]
            if ev.clip_start >= b1:
                break
            if writer is None:
                writer = wave.open(os.path.join(out_dir, names[ei]), "wb")
                writer.setnchannels(1)
                writer.setsampwidth(2)
                writer.setframerate(src.rate)
            s = max(ev.clip_start, b0) - b0
            e = min(ev.clip_end, b1) - b0
            if e > s:
                writer.writeframes(block[s:e].tobytes())
            if ev.clip_end <= b1:
                writer.close()
                writer = None
                ei += 1
            else:
                break
        pos = b1
        if ei >= len(events):
            break
    if writer is not None:
        writer.close()


# ---------------------------------------------------------------- זמן
def parse_start(text: str) -> dt.datetime:
    for fmt in ("%Y-%m-%d %H:%M:%S", "%Y-%m-%d %H:%M", "%Y-%m-%dT%H:%M:%S", "%Y-%m-%dT%H:%M", "%d/%m/%Y %H:%M:%S", "%d/%m/%Y %H:%M", "%d.%m.%Y %H:%M:%S", "%d.%m.%Y %H:%M"):
        try:
            return dt.datetime.strptime(text, fmt)
        except ValueError:
            pass
    raise SystemExit(f'לא הצלחתי לפענח את זמן ההתחלה "{text}". השתמש בפורמט "2026-09-26 23:10" או "26/09/2026 23:10".')


def start_from_filename(path: str) -> dt.datetime | None:
    base = os.path.basename(path)
    m = re.search(r"(20\d{2})[-_.]?(\d{2})[-_.]?(\d{2})[ _T-]?(\d{2})[-_.:]?(\d{2})(?:[-_.:]?(\d{2}))?", base)
    if not m:
        return None
    try:
        y, mo, d, h, mi = (int(x) for x in m.groups()[:5])
        s = int(m.group(6) or 0)
        return dt.datetime(y, mo, d, h, mi, s)
    except ValueError:
        return None


def hms(seconds: float) -> str:
    seconds = int(round(seconds))
    return f"{seconds // 3600:02d}:{(seconds % 3600) // 60:02d}:{seconds % 60:02d}"


# ---------------------------------------------------------------- main
def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("input", help="קובץ ההקלטה (wav/m4a/mp3/ogg/...)")
    ap.add_argument("--start", help='זמן תחילת ההקלטה, למשל "2026-09-26 23:10". אם חסר: מנסה לקרוא משם הקובץ, ואחרת מזמן השינוי של הקובץ (סוף ההקלטה) פחות אורכה.')
    ap.add_argument("--out", help="תיקיית פלט (ברירת מחדל: <שם הקובץ>_events)")
    ap.add_argument("--threshold", type=float, help="סף ב-dBFS (למשל -40). ברירת מחדל: אוטומטי = רמת רקע + --margin")
    ap.add_argument("--margin", type=float, default=12.0, help="בסף אוטומטי: כמה dB מעל רמת הרקע (ברירת מחדל 12)")
    ap.add_argument("--pre", type=float, default=3.0, help="שניות לפני הרעש שנכללות בקליפ")
    ap.add_argument("--tail", type=float, default=3.0, help="שניות שקט שסוגרות אירוע")
    ap.add_argument("--max-clip", type=float, default=120.0, help="אורך קליפ מרבי בשניות")
    ap.add_argument("--min-ms", type=float, default=0.0, help="משך מינימלי של רעש רצוף כדי להיחשב אירוע (מסנן קליקים)")
    ap.add_argument("--frame-ms", type=float, default=50.0, help="אורך פריים למדידת רמה")
    ap.add_argument("--rate", type=int, default=16000, help="קצב דגימה לפענוח דרך ffmpeg (קבצים שאינם WAV)")
    ap.add_argument("--ffmpeg", help="נתיב ל-ffmpeg")
    ap.add_argument("--no-clips", action="store_true", help="רק CSV וסיכום, בלי לכתוב קליפים")
    args = ap.parse_args(argv)

    if not os.path.isfile(args.input):
        raise SystemExit(f"הקובץ לא נמצא: {args.input}")
    src = AudioSource(args.input, args.ffmpeg, args.rate)
    frame_len = max(1, int(src.rate * args.frame_ms / 1000))

    print(f"סורק את {args.input} ({src.rate} Hz)…", file=sys.stderr)
    levels, total = frame_levels(src, frame_len)
    duration = total / src.rate
    if not len(levels):
        raise SystemExit("לא נמצא אודיו בקובץ")

    floor = float(np.percentile(levels, 50))
    if args.threshold is None:
        threshold = floor + args.margin
        thr_note = f"אוטומטי: רקע (חציון) {floor:.1f} dBFS + {args.margin:.0f}"
    else:
        threshold = args.threshold
        thr_note = f"ידני (רקע חציון {floor:.1f} dBFS)"

    # זמן התחלה
    start_note = ""
    if args.start:
        start = parse_start(args.start)
        start_note = "לפי --start"
    else:
        start = start_from_filename(args.input)
        if start:
            start_note = "נקרא משם הקובץ – ודא שזה נכון"
        else:
            mtime = dt.datetime.fromtimestamp(os.path.getmtime(args.input))
            start = mtime - dt.timedelta(seconds=duration)
            start_note = "אזהרה: חושב מזמן השינוי של הקובץ פחות אורך ההקלטה. עדיף לתת --start"
    print(f"תחילת ההקלטה: {start:%Y-%m-%d %H:%M:%S} ({start_note})", file=sys.stderr)

    min_frames = max(1, int(round(args.min_ms / args.frame_ms))) if args.min_ms > 0 else 1
    events = detect(levels, frame_len, total, src.rate, threshold, args.pre, args.tail, args.max_clip, min_frames)

    out_dir = args.out or (os.path.splitext(os.path.abspath(args.input))[0] + "_events")
    os.makedirs(out_dir, exist_ok=True)
    names = []
    for ev in events:
        t = start + dt.timedelta(seconds=ev.noise_start / src.rate)
        names.append(f"{t:%Y-%m-%d_%H-%M-%S}_ev{ev.index:03d}.wav")

    if events and not args.no_clips:
        print(f"כותב {len(events)} קליפים…", file=sys.stderr)
        write_clips(src, events, os.path.join(out_dir, "clips"), names)

    csv_path = os.path.join(out_dir, "events.csv")
    with open(csv_path, "w", newline="", encoding="utf-8-sig") as f:
        w = csv.writer(f)
        w.writerow(["#", "תאריך", "שעת תחילת הרעש", "תחילת הקליפ", "סיום הקליפ", "משך הקליפ (שניות)", "רמת שיא (dBFS)", "רמה ממוצעת (dBFS)", "היסט בהקלטה המקורית", "קליפ קטוע", "קובץ"])
        for ev, name in zip(events, names):
            t_noise = start + dt.timedelta(seconds=ev.noise_start / src.rate)
            t0 = start + dt.timedelta(seconds=ev.clip_start / src.rate)
            t1 = start + dt.timedelta(seconds=ev.clip_end / src.rate)
            w.writerow([ev.index, f"{t_noise:%d.%m.%Y}", f"{t_noise:%H:%M:%S}", f"{t0:%H:%M:%S}", f"{t1:%H:%M:%S}",
                        f"{(ev.clip_end - ev.clip_start) / src.rate:.1f}", f"{ev.peak_db:.1f}", f"{ev.avg_db:.1f}",
                        hms(ev.noise_start / src.rate), "כן" if ev.truncated else "", "clips/" + name])

    lines = [
        "סיכום חילוץ אירועי רעש",
        f"קובץ מקור: {os.path.abspath(args.input)}",
        f"אורך ההקלטה: {hms(duration)} ({src.rate} Hz)",
        f"תחילת ההקלטה: {start:%d.%m.%Y %H:%M:%S} ({start_note})",
        f"סף: {threshold:.1f} dBFS ({thr_note})",
        f"pre-roll {args.pre:g} שנ׳, זנב שקט {args.tail:g} שנ׳, קליפ מרבי {args.max_clip:g} שנ׳",
        f"נמצאו {len(events)} אירועים",
        "",
    ]
    for ev, name in zip(events, names):
        t_noise = start + dt.timedelta(seconds=ev.noise_start / src.rate)
        lines.append(f"{ev.index:3d}. {t_noise:%d.%m.%Y %H:%M:%S}  שיא {ev.peak_db:6.1f} dBFS  משך {(ev.clip_end - ev.clip_start) / src.rate:5.1f} שנ׳  (בהקלטה: {hms(ev.noise_start / src.rate)}){'  [קטוע]' if ev.truncated else ''}")
    if not events:
        lines.append("לא נמצאו אירועים. נסה --threshold נמוך יותר (למשל " + f"{floor + 6:.0f}" + ") או --margin קטן יותר.")
    with open(os.path.join(out_dir, "summary.txt"), "w", encoding="utf-8") as f:
        f.write("\n".join(lines) + "\n")
    print("\n".join(lines))
    print(f"\nהפלט נכתב אל: {out_dir}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
