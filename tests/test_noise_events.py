#!/usr/bin/env python3
"""בדיקות יחידה לאלגוריתם הזיהוי בכלי הפייתוני. הרצה: python3 tests/test_noise_events.py"""
import os
import sys

import numpy as np

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "tools"))
import noise_events as ne  # noqa: E402

FR = 20  # פריימים לשנייה (50ms)


def levels_fixture():
    lv = np.full(600, -60.0, dtype=np.float32)
    lv[100:103] = -20.0   # דפיקה של 150ms בשנייה 5
    lv[300:390] = -25.0   # רעש רציף 4.5 שניות משנייה 15
    return lv


def test_split_at_max_clip():
    ev = ne.detect(levels_fixture(), frame_len=1, total=600, rate=FR, threshold=-40, pre=1, tail=1, max_clip=4, min_frames=1)
    assert len(ev) == 3, ev
    a, b, c = ev
    assert (a.clip_start, a.noise_start, a.clip_end) == (80, 100, 123), a
    assert (b.clip_start, b.clip_end, b.truncated) == (280, 360, True), b
    assert (c.clip_start, c.clip_end, c.truncated) == (360, 410, False), c
    assert abs(a.peak_db + 20) < 1e-4


def test_min_frames_filters_short_bang():
    ev = ne.detect(levels_fixture(), frame_len=1, total=600, rate=FR, threshold=-40, pre=1, tail=1, max_clip=4, min_frames=4)
    assert len(ev) == 2 and ev[0].noise_start == 300, ev


def test_no_overlap_between_consecutive_events():
    lv = np.full(200, -60.0, dtype=np.float32)
    lv[50:52] = -20.0
    lv[60:62] = -20.0  # 0.5 שניות אחרי – בתוך הזנב של הראשון
    lv[100:102] = -20.0  # 2 שניות אחרי – אירוע נפרד, ה-pre-roll שלו לא חופף
    ev = ne.detect(lv, frame_len=1, total=200, rate=FR, threshold=-40, pre=2, tail=1, max_clip=60, min_frames=1)
    assert len(ev) == 2, ev
    assert ev[0].clip_end == 82 and ev[1].clip_start == 82, ev  # pre-roll נחתך בגבול האירוע הקודם


def test_parse_start_and_filename():
    assert ne.parse_start("2026-09-26 23:10").hour == 23
    assert ne.parse_start("26/09/2026 23:10:05").second == 5
    assert ne.start_from_filename("Recording 2026-09-26 23-10-05.m4a").minute == 10
    assert ne.start_from_filename("Voice 001.m4a") is None


if __name__ == "__main__":
    fails = 0
    for name, fn in list(globals().items()):
        if name.startswith("test_") and callable(fn):
            try:
                fn()
                print("ok  :", name)
            except AssertionError as e:
                fails += 1
                print("FAIL:", name, e)
    print("all passed" if not fails else f"{fails} FAILED")
    sys.exit(1 if fails else 0)
