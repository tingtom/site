#!/usr/bin/env python3
"""
Stage 2 of the diagram translation pipeline — apply a label list to a scan.

  python3 draw.py labels.json out.jpg [--source src.jpg] [--dump-dir dir]

Also writes <out>.report.json: what was drawn vs declined, so the runner can
retry a declined label with a fresh box instead of looping forever.

The model does the Japanese -> English translation and returns rough pixel
boxes; this file does the pixels, deterministically:

  * the box is split into INK CLUSTERS (scipy connected components merged by
    proximity) and each cluster is classified on its own with tesseract —
    Japanese ink is erased, printed English (X-05, A-03, 40A B2) beside it is
    protected and neither filled nor overdrawn
  * a cluster classified as English is re-split into single components first,
    because a Japanese glyph sitting within CLUSTER_GAP px of English would
    otherwise ride along protected (that is where stray glyphs came from)
  * only the Japanese ink is painted, so a loose model box can no longer take
    a symbol, a connector outline or a wire with it
  * the English is sized from the ORIGINAL box height, wraps rather than
    shrinking below 9px, and the box grows into verified-empty paper in all
    four directions when the translation needs more room than the Japanese did
  * three phases — plan, fill all, draw all — because filling as we went meant
    each label's box erased the previous label's text

OCR notes: only `eng` is installed, which is fine — we are not translating
with tesseract, just asking whether ink is already readable as English. Real
English comes back at 89-96 confidence, Japanese garbage at 22-35, so a floor
of 60 separates them (verified on wiring-1993-p0025).
"""
import json
import re
import subprocess
import sys
import tempfile
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFont
from scipy import ndimage

FONT_CANDIDATES = [
    "/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
    "/usr/share/fonts/truetype/freefont/FreeSans.ttf",
]
FONT_BOLD_CANDIDATES = [
    "/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
    "/usr/share/fonts/truetype/freefont/FreeSansBold.ttf",
]

MIN_SIZE = 9          # below this the label is unreadable once the page is
                      # shown at ~700 CSS px wide
MAX_SIZE = 30         # never bigger than the Japanese it replaces
DILATE = 2            # px of extra fill around the ink, to kill glyph edges
MAX_EXPAND = 48       # px a box may grow into verified-empty paper, per side.
                      # Growth only makes ROOM for the type — where the text is
                      # drawn is pinned to the Japanese box (see anchor_centre),
                      # so growing no longer drifts labels off their original
                      # position.
EMPTY_DARK = 0.06     # <=6% dark: sparse leader dots are fair game to grow over,
                      # because growing moves text only — the fill is `erase`
INK = 150             # luminance below this counts as ink
CLUSTER_GAP = 9       # px between ink components that still count as one word
OCR_CONF = 60         # tesseract confidence floor for "this is English"


def find_font(cands):
    for c in cands:
        if Path(c).exists():
            return c
    raise SystemExit(f"no font found, looked for: {cands}")


FONT = find_font(FONT_CANDIDATES)
FONT_BOLD = find_font(FONT_BOLD_CANDIDATES)

_OCR_CACHE = {}


def luminance(rgb):
    r, g, b = rgb[:3]
    return 0.2126 * r + 0.7152 * g + 0.0722 * b


def sample_background(img, box, ring=3):
    """The PAPER colour around a box, as the *mode* of the ring.

    A per-channel median of a ring that happens to be full of neighbouring ink
    (dense index rows) came out dark, so the fill painted solid black bars.
    The mode is the paper: the ring is mostly paper even in dense areas, and
    quantising keeps scanner noise from splitting the count.

    The value returned is the AVERAGE of the pixels that fell in the winning
    bin, not the bin floor — returning (248,248,248) for paper that measures
    254 left every fill 6 levels dark, which read as a grey rectangle behind
    the label."""
    x0, y0, x1, y1 = box
    W, H = img.size
    px = img.load()
    counts = {}
    sums = {}

    def note(p):
        key = (p[0] // 8 * 8, p[1] // 8 * 8, p[2] // 8 * 8)
        counts[key] = counts.get(key, 0) + 1
        s = sums.get(key)
        if s is None:
            sums[key] = [p[0], p[1], p[2], 1]
        else:
            s[0] += p[0]; s[1] += p[1]; s[2] += p[2]; s[3] += 1

    for x in range(max(0, x0 - ring), min(W, x1 + ring)):
        for y in (max(0, y0 - ring), min(H - 1, y1 + ring)):
            note(px[x, y])
    for y in range(max(0, y0 - ring), min(H, y1 + ring)):
        for x in range(max(0, x0 - ring), min(W - 1, x1 + ring)):
            note(px[x, y])
    if not counts:
        return (255, 255, 255)
    best = max(counts.items(), key=lambda kv: kv[1])[0]
    s = sums[best]
    return tuple(round(s[i] / s[3]) for i in range(3))


def ink_mask(img, box):
    x0, y0 = max(0, box[0]), max(0, box[1])
    x1, y1 = min(img.width, box[2]), min(img.height, box[3])
    if x1 - x0 < 2 or y1 - y0 < 2:
        return None
    arr = np.asarray(img.crop((x0, y0, x1, y1))).astype(np.int16)
    lum = 0.2126 * arr[:, :, 0] + 0.7152 * arr[:, :, 1] + 0.0722 * arr[:, :, 2]
    return (x0, y0, x1, y1, lum < INK)


def _components(mask, x0, y0, gap):
    lab, n = ndimage.label(mask, structure=np.ones((3, 3)))
    boxes = []
    for i in range(1, n + 1):
        ys, xs = np.where(lab == i)
        if len(xs) < 4:                 # speckle
            continue
        boxes.append([
            x0 + int(xs.min()), y0 + int(ys.min()),
            x0 + int(xs.max()) + 1, y0 + int(ys.max()) + 1,
        ])
    if gap <= 1 or not boxes:
        return [tuple(b) for b in boxes]

    # merge boxes within `gap` px — glyphs of one word
    merged = True
    while merged and len(boxes) > 1:
        merged = False
        for a in range(len(boxes)):
            for b in range(a + 1, len(boxes)):
                A, B = boxes[a], boxes[b]
                if (
                    A[0] - gap <= B[2] and B[0] - gap <= A[2]
                    and A[1] - gap <= B[3] and B[1] - gap <= A[3]
                ):
                    boxes[a] = [min(A[0], B[0]), min(A[1], B[1]), max(A[2], B[2]), max(A[3], B[3])]
                    boxes.pop(b)
                    merged = True
                    break
            if merged:
                break
    return [tuple(b) for b in boxes]


def clusters_in(img, box, gap=CLUSTER_GAP):
    m = ink_mask(img, box)
    if m is None or not m[4].any():
        return []
    return _components(m[4], m[0], m[1], gap)


def single_components(img, box):
    """Individual ink components, unmerged — used to re-examine a cluster
    that read as English but may be hiding a Japanese glyph."""
    m = ink_mask(img, box)
    if m is None or not m[4].any():
        return []
    return _components(m[4], m[0], m[1], gap=1)


def ocr_text(img, box):
    """The confident English tesseract sees in a box ('' when it sees none)."""
    key = tuple(int(v) for v in box)
    if key in _OCR_CACHE:
        return _OCR_CACHE[key]

    x0, y0 = max(0, box[0]), max(0, box[1])
    x1, y1 = min(img.width, box[2]), min(img.height, box[3])
    if x1 - x0 < 4 or y1 - y0 < 4:
        _OCR_CACHE[key] = ""      # no text — must stay a string, not a bool
        return ""

    crop = img.crop((x0, y0, x1, y1))
    if crop.width < 120 or crop.height < 40:
        scale = max(2, min(4, int(140 / max(1, crop.width)) + 1))
        crop = crop.resize((crop.width * scale, crop.height * scale), Image.LANCZOS)
    with tempfile.NamedTemporaryFile(suffix=".png", delete=False) as tmp:
        crop.save(tmp.name)
        tmp_path = tmp.name
    try:
        out = subprocess.run(
            ["tesseract", tmp_path, "stdout", "-l", "eng", "--psm", "7", "tsv"],
            capture_output=True, text=True, timeout=15,
        ).stdout
    except Exception:
        out = ""
    finally:
        Path(tmp_path).unlink(missing_ok=True)

    confident = []
    for line in out.splitlines()[1:]:
        parts = line.split("\t")
        if len(parts) >= 12 and parts[10] and parts[11].strip():
            try:
                conf = float(parts[10])
            except ValueError:
                continue
            text = parts[11].strip()
            if conf >= OCR_CONF and text.isascii():
                confident.append(text)

    joined = " ".join(confident).strip()
    _OCR_CACHE[key] = joined
    return joined


def ocr_english(img, box, known=""):
    """True when this cluster reads as printed Latin at OCR_CONF or better.

    `known` is the model's own text for this label (its en + ja). Two-letter
    codes like MT / AT are protected by the short-code rule — but tesseract
    also "reads" Japanese as 2-4 Latin letters (灰赤 -> hk, IK), and without
    `known` those were classed as PRINTED ENGLISH: protected, never erased,
    and left sitting beside their own translation. A short code only counts
    when it actually appears in what the model says is here."""
    joined = ocr_text(img, box)
    alnum = [c for c in joined if c.isalnum()]
    # Two-letter transmission codes: MT / AT / MT-AT come back as confident
    # Latin, and without this they were treated as ink to erase and then
    # overwritten with a translation of the Japanese beside them.
    short_code = bool(re.fullmatch(r"[A-Za-z]{2,4}(?:[/\-][A-Za-z]{2,4})?", joined))
    if short_code and known:
        norm_known = re.sub(r"[^a-z0-9]", "", known.lower())
        norm_read = re.sub(r"[^a-z0-9]", "", joined.lower())
        short_code = bool(norm_read) and norm_read in norm_known
    return short_code or (len(alnum) >= 3 and (any(c.isdigit() for c in joined) or len(alnum) >= 4))


def union(boxes):
    if not boxes:
        return None
    return (
        min(b[0] for b in boxes), min(b[1] for b in boxes),
        max(b[2] for b in boxes), max(b[3] for b in boxes),
    )


def grow(box, dx, dy, W, H):
    return (max(0, box[0] - dx), max(0, box[1] - dy), min(W, box[2] + dx), min(H, box[3] + dy))


def is_empty(img, box):
    m = ink_mask(img, box)
    if m is None:
        return False
    return float(m[4].mean()) <= EMPTY_DARK


def is_growable(img, box):
    """May the TEXT box extend over this region? (It never affects the fill.)

    Blank paper qualifies, and so does sparse small ink — leader dots measure
    ~15% dark in a narrow strip, which is why `is_empty` alone blocked every
    index row from growing and left the English squeezed to 6px. Real text and
    symbols do not qualify: they are large, non-linear components."""
    m = ink_mask(img, box)
    if m is None:
        return True
    mask = m[4]
    if float(mask.mean()) <= EMPTY_DARK:
        return True
    if float(mask.mean()) > 0.45:
        return False
    lab, n = ndimage.label(mask, structure=np.ones((3, 3)))
    if n == 0:
        return True
    objs = ndimage.find_objects(lab)
    for sl in objs:
        h_ = sl[0].stop - sl[0].start
        w_ = sl[1].stop - sl[1].start
        area = h_ * w_
        if area <= 40:
            continue                      # leader dot / speckle
        if (h_ <= 5 and w_ >= 40) or (w_ >= 40 and h_ <= 5) or w_ >= 200:
            continue                      # wire
        return False                      # text, relay, symbol — stop here
    return True


def lum_array(arr):
    a = arr.astype(np.int16)
    return 0.2126 * a[:, :, 0] + 0.7152 * a[:, :, 1] + 0.0722 * a[:, :, 2]


def long_runs(dark, length=20, axis=1, frac=0.8):
    """Pixels inside a solid dark run of at least `length` px — linework
    (wires, box outlines) as opposed to glyph strokes, which at these label
    sizes never run 20px without a break."""
    filt = ndimage.uniform_filter1d(dark.astype(np.float32), size=length, axis=axis, mode="constant")
    return filt >= frac


def restore_crossing_lines(img, work, placed, dark, line_h, line_v):
    """Put back every wire that crosses a box we just painted.

    A wire label sits ON the wire, so the wire merges into the same ink cluster
    as the Japanese text; the cluster then fails OCR, gets called Japanese and
    is painted out — which is what punched white gaps through the schematic.
    A wire that enters one side of a box and leaves the other is restored from
    the original; a glyph stroke, which starts and ends inside the box, is not.
    """
    orig = np.asarray(img)
    buf = np.array(work)        # copy: np.asarray(PIL) hands back a read-only view
    h, w = dark.shape
    restored = 0

    for entry in placed:
        x0, y0, x1, y1 = entry["erase"]
        if x1 - x0 < 3 or y1 - y0 < 3:
            continue

        # horizontal linework spanning the box
        if x0 >= 6 and x1 + 5 <= w:
            rows = np.where(dark[y0:y1, x0 - 6] & dark[y0:y1, x1 + 5])[0]
            if rows.size:
                band = np.zeros((y1 - y0, x1 - x0), dtype=bool)
                band[rows] = True
                keep = line_h[y0:y1, x0:x1] & band
                if keep.any():
                    region = buf[y0:y1, x0:x1]
                    region[keep] = orig[y0:y1, x0:x1][keep]
                    restored += int(keep.sum())

        # vertical linework spanning the box
        if y0 >= 6 and y1 + 5 <= h:
            cols = np.where(dark[y0 - 6, x0:x1] & dark[y1 + 5, x0:x1])[0]
            if cols.size:
                band = np.zeros((y1 - y0, x1 - x0), dtype=bool)
                band[:, cols] = True
                keep = line_v[y0:y1, x0:x1] & band
                if keep.any():
                    region = buf[y0:y1, x0:x1]
                    region[keep] = orig[y0:y1, x0:x1][keep]
                    restored += int(keep.sum())

    return Image.fromarray(buf), restored


def intersect(a, b):
    ix = max(0, min(a[2], b[2]) - max(a[0], b[0]))
    iy = max(0, min(a[3], b[3]) - max(a[1], b[1]))
    return ix * iy


def wrap(text, font, max_w, draw):
    out = []
    for para in text.split("\n"):
        line = ""
        for word in para.split():
            trial = f"{line} {word}".strip()
            if draw.textlength(trial, font=font) <= max_w or not line:
                line = trial
            else:
                out.append(line)
                line = word
        out.append(line)
    return out or [""]


def fit(text, box_w, box_h, draw, bold=False, cap=MAX_SIZE):
    """Largest size <= cap that fits; never spills out of its box.

    Single line first: the manual's labels are all one line, so a wrapped
    label looks wrong even when it is bigger — try one line at every size
    from the cap down before falling back to wrapping."""
    explicit = text.split("\n")
    if len(explicit) == 1:
        for size in range(cap, MIN_SIZE - 1, -1):
            font = ImageFont.truetype(FONT_BOLD if bold else FONT, size)
            if draw.textlength(text, font=font) <= box_w and size * 1.16 <= box_h:
                return font, [text], size
    for size in range(cap, MIN_SIZE - 1, -1):
        font = ImageFont.truetype(FONT_BOLD if bold else FONT, size)
        lines = wrap(text, font, box_w, draw)
        if max((draw.textlength(ln, font=font) for ln in lines), default=0) <= box_w and size * 1.16 * len(lines) <= box_h:
            return font, lines, size
    for size in range(MIN_SIZE - 1, 5, -1):
        font = ImageFont.truetype(FONT_BOLD if bold else FONT, size)
        lines = wrap(text, font, box_w, draw)
        if max((draw.textlength(ln, font=font) for ln in lines), default=0) <= box_w and size * 1.16 * len(lines) <= box_h:
            return font, lines, size
    font = ImageFont.truetype(FONT_BOLD if bold else FONT, 6)
    return font, wrap(text, font, box_w, draw), 6


def clip_edge(box, edge, amount):
    x0, y0, x1, y1 = box
    if edge == "left":
        x0 = min(x0 + amount, x1 - 4)
    elif edge == "right":
        x1 = max(x1 - amount, x0 + 4)
    elif edge == "top":
        y0 = min(y0 + amount, y1 - 4)
    else:
        y1 = max(y1 - amount, y0 + 4)
    return (x0, y0, x1, y1)


def main():
    if len(sys.argv) < 3:
        raise SystemExit(__doc__)
    labels_path, out_path = sys.argv[1], sys.argv[2]
    source = dump_dir = None
    args = sys.argv[3:]
    i = 0
    while i < len(args):
        if args[i] == "--source":
            source = args[i + 1]
            i += 2
        elif args[i] == "--dump-dir":
            dump_dir = args[i + 1]
            i += 2
        else:
            i += 1

    spec = json.loads(Path(labels_path).read_text())
    src = Path(source or spec["source"])
    img = Image.open(src).convert("RGB")
    probe = ImageDraw.Draw(img)
    W, H = img.size

    items = [it for it in spec["items"] if (it.get("en") or "").strip()]
    skipped = []
    planned = []
    silent = []            # duplicates: erase their Japanese, draw nothing

    # ONE font size for the whole page. The model's boxes are wildly
    # inconsistent — nominal 60x70 for every vertical label next to tight
    # bounding boxes for the rest — and sizing from them put 6px labels beside
    # 24px ones. Measure the actual glyphs instead (the OCR cache makes this
    # second pass nearly free).
    heights = []
    for it in items:
        prow = (int(it["x"]), int(it["y"]), int(it["x"] + it["w"]), int(it["y"] + it["h"]))
        glyphs = []
        for c in clusters_in(img, prow):
            cw, ch = c[2] - c[0], c[3] - c[1]
            if ocr_english(img, c, f'{it.get("en", "")} {it.get("ja", "")}') or cw >= 4 * max(ch, 1) or ch >= 4 * max(cw, 1):
                continue              # English or linework, not a glyph
            glyphs.append(c)
        if glyphs:
            dom = max(glyphs, key=lambda b: (b[2] - b[0]) * (b[3] - b[1]))
            heights.append(dom[3] - dom[1])
    heights.sort()
    reference = heights[len(heights) // 2] if heights else 16
    accepted = []          # (normalised translation, model box) — de-duping
    claimed = []           # ink clusters already owned by some label

    def norm(text):
        return " ".join(str(text).lower().split())

    def base_of(text):
        # "black (f)" -> "black": a trailing harness code is a variant of the
        # same colour, not a different label
        return re.sub(r"\s*\([^)]*\)$", "", norm(text)).strip()

    # One wire often comes back from the model as two items — "Black" and
    # "Black (F)" 75px apart on the same wire. When a suffixed form exists,
    # the bare one is a duplicate of it (and the fuller label is the keeper).
    # Pairs that BOTH carry a suffix, "Black/white (E)" vs "(F)", are separate
    # wires and are untouched by this.
    bases_with_suffix = {
        base_of(it["en"]) for it in items
        if base_of(it["en"]) != norm(it["en"])
    }

    # Suffixed forms ("Black (F)") are processed first so the fuller label is
    # always accepted before its bare variant ("Black") is judged a duplicate —
    # otherwise a bare label could be dropped with nothing drawn in its place.
    order = sorted(range(len(items)), key=lambda i: 0 if base_of(items[i]["en"]) != norm(items[i]["en"]) else 1)

    for n, it in ((i, items[i]) for i in order):
        raw = (int(it["x"]), int(it["y"]), int(it["x"] + it["w"]), int(it["y"] + it["h"]))

        def line_like(b):
            """Wire, leader-dot row, box outline — linework, not text.

            Must stay narrow: a row of katakana is WIDE and SHORT (テール・ライト
            is 56x10), so an aspect test like `w >= 4h` called every index-page
            label "line", excluded it from translation, and left 6px fragments
            behind. Only genuinely thin, long ink counts as linework here.

            The width branch is likewise only for things that SPAN THE PAGE:
            `w >= 200` sent the 500px page title コンビネーション・スイッチ to
            `no-text`, leaving it untranslated, while no rule on the page is
            both that wide and that tall — rules are thin or full-bleed."""
            w_, h_ = b[2] - b[0], b[3] - b[1]
            if h_ <= 5 and w_ >= 40:
                return True      # wire / leader dots: thin and long
            if h_ <= 16 and w_ >= 200:
                return True      # thin full-width rule
            if w_ >= 700:
                return True      # runs across most of the page
            if w_ >= 150 and h_ >= 40:
                # A hollow outline (a connector-table frame) is ONE rectangle:
                # few components and a fraction of its own bounding box filled.
                # Text is many glyphs — the 500x53 page title has 54 components
                # and only 0.10 fill, so fill rate alone called it a frame.
                m = ink_mask(img, b)
                if m is not None and m[4].mean() < 0.15 and len(single_components(img, b)) <= 3:
                    return True
            return False

        def classify(box_):
            """Split the ink in a box into Japanese text and printed English."""
            known = f'{it.get("en", "")} {it.get("ja", "")}'
            jp, en = [], []
            for c in clusters_in(img, box_):
                if ocr_english(img, c, known):
                    # a cluster can hold English AND Japanese that sat within
                    # CLUSTER_GAP px of it — split it and judge each piece
                    parts = single_components(img, c)
                    if len(parts) > 1:
                        for part in parts:
                            (en if ocr_english(img, part, known) else jp).append(part)
                    else:
                        en.append(c)
                elif not line_like(c):
                    jp.append(c)
            return jp, en

        core_jp, core_en = classify(raw)
        japanese = list(core_jp)
        english = list(core_en)

        # Model boxes routinely CUT THROUGH their own label — one covered just
        # the first two glyphs of 室内照明関係, making an 18px anchor for a
        # 96px label and forcing 6px type. So search the neighbourhood every
        # time and merge back whatever sits in the same column (the x-overlap
        # filter keeps neighbouring index rows out) — but never ink another
        # label has already claimed, which is how one wire ended up labelled
        # twice in the translation while the original had a single label.
        search = grow(raw, 14, 18, W, H)
        near_jp, near_en = classify(search)
        in_column = [
            c for c in near_jp
            if min(c[2], raw[2]) - max(c[0], raw[0]) >= 0.4 * (c[2] - c[0])
        ]
        for c in in_column:
            if any(intersect(c, k) > 0 for k in claimed):
                continue
            if any(intersect(c, k) > 0 for k in japanese):
                continue
            japanese.append(c)
        for c in near_en:
            if any(intersect(c, k) > 0 for k in claimed + english):
                continue
            english.append(c)

        if not japanese:
            # Nothing to translate here — and nothing we are allowed to paint
            # out (painting anyway is what ate dots, relays and symbols).
            if True:
                skipped.append({
                    "reason": "printed-english" if english else "no-text",
                    "en": it["en"], "box": list(raw),
                })
                continue

        # A parenthesised kana code often sits directly under the first line,
        # just outside the model's box (黒白 translated while (ト) survived).
        seen = set(japanese) | set(english)
        for extra in classify((raw[0] - 4, raw[1] - 8, raw[2] + 4, raw[3] + 22))[0]:
            if any(intersect(extra, s) > 0 for s in seen):
                continue
            if any(intersect(extra, k) > 0 for k in claimed):
                continue
            japanese.append(extra)
            seen.add(extra)

        # Placement box = the found text itself. The model's raw box is only a
        # search hint: it is often offset (one sat 20px low, on the wire) or
        # over-wide (covering the row's page number), and unioning it in let the
        # protection clip crush labels down to 16px. Text-only anchors are safe
        # now that line_like no longer mistakes katakana rows for wires.
        anchor_clusters = list(core_jp) if core_jp else list(japanese)
        anchor = union(anchor_clusters)
        erase = union(japanese)
        protect = union(english) if english else None
        claimed.extend(japanese)

        # The translation may already be printed on the page: the original
        # carries "Auto stop switch (partial)" while the model returns "Auto
        # stop switch", and drawing it again read as a duplicate label. Erase
        # the Japanese and let the printed English BE the label.
        en_norm = re.sub(r"[^a-z0-9]+", "", it["en"].lower())
        already_printed = False
        if en_norm and english:
            for c in english:
                seen_en = re.sub(r"[^a-z0-9]+", "", ocr_text(img, c).lower())
                if seen_en and (en_norm in seen_en or seen_en in en_norm):
                    already_printed = True
                    break
        if already_printed:
            silent.append({"erase": erase})
            skipped.append({
                "reason": "already-english", "en": it["en"],
                "box": list(erase), "erased_only": True,
            })
            continue

        # The same label comes back from several verification rounds at a
        # slightly different position; drawn twice they read "Red/yellow
        # Red/yellow" stacked over one wire. Judge by overlap of the MODEL'S OWN
        # BOX: it is the one thing that is per-label — derived boxes (anchors,
        # padded erases) merge neighbouring clusters, so comparing those made
        # two different labels look like duplicates of each other.
        key = norm(it["en"])
        base = base_of(it["en"])
        # position of the actual ink (model boxes are often far bigger than the
        # text and made the same-wire test miss by 40px)
        ecx = (erase[0] + erase[2]) // 2
        ecy = (erase[1] + erase[3]) // 2
        # The bare form of a colour is a duplicate only when its fuller variant
        # is drawn ON THE SAME COLUMN close by — that is the "one wire, label
        # written twice" case. Without the positional test, a single "Black (F)"
        # anywhere on the page would delete every bare "Black", including the
        # pin-table cells that each need their own label.
        keeper = None
        for k2, _b2, suffixed, box_a, ax, ay in accepted:
            if k2 == base and suffixed and abs(ax - ecx) <= 25 and abs(ay - ecy) <= 90:
                keeper = (box_a, ax, ay)
                break
        if key == base and keeper:
            # a fuller form of this label exists elsewhere — draw that one once
            silent.append({"erase": union(japanese), "item": it})
            skipped.append({
                "reason": "duplicate", "en": it["en"],
                "box": list(union(japanese)), "erased_only": True,
            })
            continue
        area_new = (raw[2] - raw[0]) * (raw[3] - raw[1])
        dup = False
        for k, _b, _s, box_a, ax, ay in accepted:
            if k != key:
                continue
            # same translation stacked within ~70px: draw it once. A wire
            # colour repeated two or three times in one busy section reads as
            # clutter — but cells further apart are separate labels, so the
            # radius stays tight (200px wiped 63 labels off the pin tables).
            if abs(ax - ecx) < 70 and abs(ay - ecy) < 70:
                dup = True
                break
            area_a = (box_a[2] - box_a[0]) * (box_a[3] - box_a[1])
            if intersect(box_a, erase) > 0.35 * min(area_a, (erase[2] - erase[0]) * (erase[3] - erase[1])):
                dup = True
                break
        if dup:
            # paint it out but draw nothing: one label for the pair, and no
            # Japanese left where the second one was
            silent.append({"erase": erase, "item": it})
            skipped.append({"reason": "duplicate", "en": it["en"], "box": list(erase), "erased_only": True})
            continue
        accepted.append((key, base, key != base, raw, ecx, ecy))

        # Orientation from the largest cluster of the model's own box, not the
        # union: the union of 青緑 stacked over (F) is taller than wide even
        # though the glyphs run left-to-right, and that kept rotating
        # horizontal labels onto their side.
        dominant = max(anchor_clusters, key=lambda b: (b[2] - b[0]) * (b[3] - b[1]))
        aw, ah = anchor[2] - anchor[0], anchor[3] - anchor[1]
        # A stacked two-line label (黒白 over (E)) is ~34px tall and would pass
        # a simple aspect test; a real tategaki run is a long column. Require
        # both the model's flag and real column proportions.
        vertical = bool(it.get("vertical")) and ah >= 45 and aw < 0.7 * max(ah, 1)

        # Two boxes doing two jobs: `box` is where the English is drawn (anchored
        # to the model's region so covering a second line never shifts the text),
        # `erase` is everything painted out (which does include that second line).
        box = grow(anchor, DILATE, DILATE, W, H)

        # Symbols that live beside the label — numbered circles, arrows, the
        # connector boxes — are ink but not this label's ink. Protect them, so
        # the English is clipped away from them instead of printing on top
        # ("...control unit3"). Wire crossings are line-shaped and excluded.
        hood = grow(box, 12, 12, W, H)
        foreign = []
        own = japanese + (english or [])
        for c in clusters_in(img, hood):
            if any(intersect(c, s) > 0 for s in own):
                continue
            cw, ch = c[2] - c[0], c[3] - c[1]
            if (cw >= 28 and ch <= 8) or (ch >= 28 and cw <= 8):
                continue                      # a wire, not a symbol
            foreign.append(c)
        if foreign:
            protect = union(([protect] if protect else []) + foreign)
        # Consistent sizing: ordinary labels take the page reference so they
        # all read at one size; genuinely larger originals (section headings)
        # and the page title keep their own glyph height.
        glyph_h = dominant[3] - dominant[1]
        # One size for ordinary labels, taken from the reference scans the
        # user translated by hand: their English sits at 0.889 of the Japanese
        # height (measured over 334 label pairs) and at 0.948 of its width —
        # i.e. sized to the original's footprint rather than to the box we can
        # grow. Section headings and the page title keep their own height.
        if n == 0 or glyph_h > reference * 1.7:
            cap = max(MIN_SIZE + 2, min(MAX_SIZE, glyph_h))
        else:
            # One size for ordinary labels, set by the page's own glyph height.
            # Calibrated against the user's hand-translated scans: this gives a
            # height ratio of 0.875 where theirs measures 0.889 — a previous
            # 0.89 multiplier on top of the height overshot to 0.778.
            cap = max(17, min(MAX_SIZE, reference))
        bold = n == 0 or glyph_h >= reference * 1.7

        # Grow into verified-empty paper when the English either can't fit at a
        # readable size OR wraps onto a second line the paper could avoid —
        # "20A wiper" was breaking across the wire because the box was only ever
        # grown for the too-small case. Bounded by MAX_EXPAND per side, and
        # never into ink we decided to keep.
        guard = 0

        def trial(b):
            # +6px of height: the text may spill a little past its fill, centred,
            # rather than being squeezed to an unreadable size
            return fit(it["en"], b[2] - b[0], (b[3] - b[1]) + 6, probe, bold, cap)

        state = trial(box)
        # Grow not only when the text is unreadable or wrapped, but whenever the
        # box is squeezing it below the size we asked for — otherwise the floor
        # on `cap` is irrelevant and everything renders at 6-12px.
        while (
            state[2] < MIN_SIZE
            or len(state[1]) > 1
            or state[2] < cap - 2
        ) and guard < MAX_EXPAND:
            grew = False
            for extra in (4, 8, 16, 24):
                if guard + extra > MAX_EXPAND:
                    break
                step = 0
                for side in ("left", "right", "top", "bottom"):
                    if side == "left":
                        cand = (box[0] - extra, box[1], box[0], box[3])
                    elif side == "right":
                        cand = (box[2], box[1], box[2] + extra, box[3])
                    elif side == "top":
                        cand = (box[0], box[1] - extra, box[2], box[1])
                    else:
                        cand = (box[0], box[3], box[2], box[3] + extra)
                    if is_growable(img, cand) and (protect is None or intersect(cand, protect) == 0):
                        if side == "left":
                            box = (max(0, box[0] - extra), box[1], box[2], box[3])
                        elif side == "right":
                            box = (box[0], box[1], min(W, box[2] + extra), box[3])
                        elif side == "top":
                            box = (box[0], max(0, box[1] - extra), box[2], box[3])
                        else:
                            box = (box[0], box[1], box[2], min(H, box[3] + extra))
                        step += extra
                if step:
                    guard += step
                    state = trial(box)
                    grew = True
                    break
            if not grew:
                break

        planned.append({"box": box, "erase": erase, "protect": protect, "item": it, "bold": bold, "cap": cap, "vertical": vertical, "guard": guard, "state": state[2], "lines": len(state[1]), "anchor": anchor})

    # global clip: no two labels share pixels, and none touches kept English
    placed = []
    for entry in sorted(planned, key=lambda e: (e["item"].get("y", 0), e["item"].get("x", 0))):
        box = entry["box"]
        blockers = [p["box"] for p in placed]
        blockers += [p["protect"] for p in placed if p.get("protect")]
        if entry.get("protect"):
            blockers.append(entry["protect"])
        ea = entry.get("anchor") or entry["erase"]
        acx = (ea[0] + ea[2]) / 2
        acy = (ea[1] + ea[3]) / 2
        for _ in range(40):
            # Only a MATERIAL overlap counts: clipping on any contact at all
            # squeezed adjacent index rows down to 4px boxes and 6px type.
            box_area = max(1, (box[2] - box[0]) * (box[3] - box[1]))
            hits = [
                b for b in blockers
                if intersect(box, b) > 0.15 * min(box_area, max(1, (b[2] - b[0]) * (b[3] - b[1])))
            ]
            if not hits:
                break
            best = None
            for edge in ("left", "right", "top", "bottom"):
                for amount in (2, 6, 12, 24):
                    nb = clip_edge(box, edge, amount)
                    if nb == box:
                        continue
                    # never squeeze below a readable box — if the only way to
                    # clear the overlap is to destroy the label, accept a small
                    # overlap instead of rendering 6px type
                    if nb[3] - nb[1] < 12 or nb[2] - nb[0] < 16:
                        continue
                    # the box must keep HOLDING its own label: clipping the left
                    # edge off "Red/blue" put the box in the neighbouring table
                    # cell, and the English was then drawn there while the
                    # Japanese stayed put
                    if not (nb[0] <= acx <= nb[2] and nb[1] <= acy <= nb[3]):
                        continue
                    loss = sum(intersect(nb, b) for b in blockers)
                    if best is None or loss < best[0]:
                        best = (loss, nb)
            if best is None:
                break
            box = best[1]
        if box is None:
            skipped.append({"reason": "overlap", "en": entry["item"]["en"], "box": list(entry["erase"])})
            continue
        placed.append({**entry, "box": box})

    # Final pass on what is actually placed: a bare colour ("Black") whose
    # fuller variant ("Black (F)") sits on the SAME COLUMN is the "one wire
    # labelled twice" case — drop the bare one and paint its Japanese out.
    # Done here rather than during planning so it can't be defeated by label
    # ordering, duplicates or declines.
    def centre(entry):
        b = entry["erase"]
        return ((b[0] + b[2]) // 2, (b[1] + b[3]) // 2)

    final_place, bare_erased = [], 0
    for e in placed:
        b = base_of(e["item"]["en"])
        drop = False
        if True:
            ex, ey = centre(e)
            same_text = norm(e["item"]["en"]) == b   # bare: no harness suffix
            for k in placed:
                if k is e:
                    continue
                kb = base_of(k["item"]["en"])
                k_norm = norm(k["item"]["en"])
                # drop when the other label says the SAME thing (identical
                # text on one column) or is the fuller form of this one —
                # but never when they differ ("Audio system (type 1)" vs
                # "(type 2)" are different labels, however alike)
                same = (k_norm == norm(e["item"]["en"])) or (
                    same_text and kb == b and k_norm != kb
                )
                if not same:
                    continue
                kx, ky = centre(k)
                if abs(kx - ex) <= 25 and abs(ay := abs(ky - ey)) <= 110:
                    drop = True
                    break
        if drop:
            # keep the origin item: without it the mop-up treats this box's own
            # raw region as "somebody else's" and never cleans the Japanese it
            # was dropped over (that is why 灰 and 白青 survived in the legend)
            silent.append({"erase": e["erase"], "item": e["item"]})
            bare_erased += 1
        else:
            final_place.append(e)
    placed = final_place
    if bare_erased:
        skipped.append({"reason": "duplicate", "en": "(bare colour, fuller label kept)", "box": [], "erased_only": True, "count": bare_erased})

    # Mop-up: the model's box routinely CUTS ITS OWN GLYPHS, so a few pixels of
    # Japanese survive just outside the erase (アクセサリ kept its tops, ハザード・
    #ライト kept its tail — 7k-45k ghost px per page). Absorb any small cluster
    # that sits in the label's own band, belongs to nobody else, and is neither
    # linework nor printed English.
    def thin(b):
        w_, h_ = b[2] - b[0], b[3] - b[1]
        if h_ <= 6:
            return True          # leader dots, rules, dot runs — any width.
                                 # Glyph slivers don't arrive alone: clusters_in
                                 # at gap 4 merges them into their own word, so
                                 # an isolated <=6px cluster is linework. Short
                                 # dot runs (w < 40) were slipping through.
        if h_ <= 16 and w_ >= 200:
            return True          # thin full-width rule
        if w_ >= 700:
            return True          # page-spanning linework
        # Size guards: a glyph ROW is short (katakana 18-30px) but can be long
        # (オートストップスイッチ(部分) runs 150px), while symbols are TALL —
        # the relay that got eaten was 104x90. So reject on height, on extreme
        # width, or on area, not on width alone: capping at 120px refused the
        # very long words this pass needs to catch.
        if w_ <= 5 and h_ >= 18:
            return True          # vertical wire stub or box edge
        if h_ > 40 or w_ > 340:
            return True          # too tall/wide to be a run of text
        # A cell border or rule crosses the whole bounding box on at least one
        # row/column; glyph strokes never do (a long katakana bar is ~20px inside
        # a 260px cluster). This must run BEFORE the component test: a legend row
        # has both borders and many glyphs, so it passed the "many components =
        # text" test and the mop-up painted out the table's own hatching.
        # Scoped to w >= 60: inside a 20x18 glyph box a single horizontal stroke
        # is 100% of a row, so the test would reject every sliver on the page.
        m = ink_mask(img, b)
        if m is not None and w_ >= 60 and h_ >= 12:
            mask = m[4]
            if mask.shape[0] and mask.shape[1]:
                if mask.mean(axis=1).max() >= 0.5:
                    return True
        if (w_ * h_) > 6000:
            # Big, but a long Japanese word (オートストップスイッチ(部分) is
            # 150x30) is many glyphs while a symbol or box outline is one
            # drawing — the same discriminator line_like() uses.
            return len(single_components(img, b)) <= 3
        return False

    def nearby(b, box_):
        """b is the REST of this label's own word, not a neighbour's.

        The model's box often covers only part of a word (黄青 came back as a
        box on the 青 half), so requiring horizontal overlap rejected exactly
        the slivers this pass exists for — overlap can be 2px on a 16px glyph.
        Adjacency within the merge gap is the same test clustering itself uses."""
        if b[3] <= box_[1] - 12 or b[1] >= box_[3] + 12:
            return False                      # different row
        gap_x = max(0, box_[0] - b[2], b[0] - box_[2])
        gap_y = max(0, box_[1] - b[3], b[1] - box_[3])
        return gap_x <= 4 and gap_y <= 12

    occupied = [e["erase"] for e in placed]
    occupied += [e["protect"] for e in placed if e.get("protect")]
    occupied += [s["erase"] for s in silent]
    # anything the model put a label on, or that we deliberately left alone
    # (printed-English / no-text declines), is somebody else's business — an
    # adjacent cell's Japanese must not be absorbed and erased untranslated
    occupied += [s["box"] for s in skipped if s.get("box")]
    occupied += [
        (int(it["x"]), int(it["y"]), int(it["x"] + it["w"]), int(it["y"] + it["h"]))
        for it in items
    ]
    mopped = 0
    mopped_boxes = []
    # Both kinds of painted box need mopping: a label dropped as a duplicate is
    # still painted out, and the legend rows got exactly that — the y1947 copy
    # of 灰赤 was erased with an 18px box while the glyphs ran 44px, leaving
    # 灰 and 白青 half-visible next to their English.
    targets = [(e, e["erase"], e["item"]) for e in placed]
    targets += [(s, s["erase"], s.get("item")) for s in silent]
    for entry, box_, it_raw in targets:
        own_raw = None
        if it_raw is not None:
            own_raw = (int(it_raw["x"]), int(it_raw["y"]),
                       int(it_raw["x"] + it_raw["w"]), int(it_raw["y"] + it_raw["h"]))
        # a sliver MERGES with the label's own box (it is the rest of the same
        # word), so only other labels' ink is off-limits — checking against
        # this entry too rejected every sliver and the mop-up did nothing
        others = [k for k in occupied if k != box_ and k != own_raw]
        # Wide halo, but absorption still requires ADJACENCY (gap <= 4px below):
        # a label whose Japanese runs 80px past the model's box is one
        # contiguous word, so it is absorbed, while a neighbour 4px away is
        # caught by the occupied check first. The old 16px halo stopped at
        # "オートストップスイッチ(部分)" halfway through.
        halo = grow(box_, 100, 14, W, H)
        known = f'{(it_raw or {}).get("en", "")} {(it_raw or {}).get("ja", "")}'
        add = []
        for c in clusters_in(img, halo, gap=4):
            area_c = max(1, (c[2] - c[0]) * (c[3] - c[1]))
            # Owned by another label only if it is mostly INSIDE that label's
            # box. Testing `intersect > 0` deadlocked the legend rows: the
            # drawn box [320,1965,380,1990] and the dropped-duplicate box
            # [348,1947,366,1968] both clipped the same 灰赤 glyphs, so each
            # refused the cluster the other one was supposed to clean up.
            if any(intersect(c, k) >= 0.6 * area_c for k in others):
                continue
            # Judge the CLUSTER for English (a band holding printed labels must
            # be skipped whole) but absorb at GLYPH level: a legend row comes
            # back as one 260x30 cluster because gap 4 welds the glyphs to the
            # cell rules, and testing that band as a unit always failed the
            # border check — so 灰 and 白青 were never cleaned up.
            if ocr_english(img, c, known):
                continue
            parts = single_components(img, c)
            for part in (parts if len(parts) > 1 else [c]):
                if not nearby(part, box_) or thin(part) or ocr_english(img, part, known):
                    continue
                area_p = max(1, (part[2] - part[0]) * (part[3] - part[1]))
                if any(intersect(part, k) >= 0.6 * area_p for k in others):
                    continue
                add.append(part)
                mopped_boxes.append({"box": list(part), "en": (it_raw or {}).get("en", "(duplicate)")})
        if add:
            entry["erase"] = union([box_] + add)
            occupied.append(entry["erase"])
            mopped += len(add)

    # phase 2: paint only the Japanese ink
    work = img.copy()
    draw = ImageDraw.Draw(work)
    for entry in placed:
        entry["bg"] = sample_background(img, entry["erase"])
        draw.rectangle(entry["erase"], fill=entry["bg"])
    for entry in silent:
        draw.rectangle(entry["erase"], fill=sample_background(img, entry["erase"]))

    # phase 2b: put back every wire that crosses a painted box — see
    # restore_crossing_lines(). Without this, each label sitting on a wire
    # punched a white gap through the schematic.
    dark = lum_array(np.asarray(img)) < INK
    wires_h = long_runs(dark, 20, axis=1, frac=0.8)
    wires_v = long_runs(dark, 20, axis=0, frac=0.8)
    work, restored_px = restore_crossing_lines(img, work, placed, dark, wires_h, wires_v)
    draw = ImageDraw.Draw(work)   # the old handle is bound to the pre-restore array

    # phase 3: draw the English
    drawn_rects = []          # every text run already on the page, for collisions
    for entry in placed:
        x0, y0, x1, y1 = entry["box"]
        it = entry["item"]
        vertical = bool(entry.get("vertical", it.get("vertical")))

        # Vertical labels run down the page: lay the text out ALONG the box
        # height and wrap it to the box width, then rotate. Fitting it as if it
        # were horizontal wraps to the narrow dimension and clips — that is
        # where "Green" became "Gree".
        #
        # Width is capped at the JAPANESE FOOTPRINT (+8px slack), not at the
        # grown box: the legend cells grew 10px sideways into the next cell's
        # border, so "White/blue" was sized to 76px in a 60px cell and drew
        # straight over the table rules. Their own translations measure 0.948
        # of the Japanese width — the text belongs to that footprint.
        ea_w = entry["erase"][2] - entry["erase"][0]
        ea_h = entry["erase"][3] - entry["erase"][1]
        if vertical:
            # runs along the box HEIGHT, wraps to the box WIDTH
            fw = min((y1 - y0) - 4, ea_h + 8)
            fh = min((x1 - x0) - 4, ea_w + 8)
            font, lines, size = fit(it["en"], fw, fh, draw, entry["bold"], entry["cap"])
        else:
            fw = min(x1 - x0, ea_w + 8)
            fh = y1 - y0
            font, lines, size = fit(it["en"], fw, fh, draw, entry["bold"], entry["cap"])
            # A footprint too narrow for readable type (a 1-char Japanese cell)
            # would drop to the 6px fallback: allow the grown box back in, and
            # let the collision pass handle anything it then touches.
            if size < 12 and (x1 - x0) > fw:
                font, lines, size = fit(it["en"], x1 - x0, fh, draw, entry["bold"], entry["cap"])
        entry["size"] = size
        fg = (17, 17, 17) if luminance(entry["bg"]) >= 120 else (250, 250, 250)
        line_h = size * 1.16
        total_h = line_h * len(lines)
        ty = y0 + max(1, ((y1 - y0) - total_h) / 2)

        if vertical:
            widest = max(draw.textlength(ln, font=font) for ln in lines)
            # canvas holds the run horizontally: width = length of the longest
            # line, height = the stacked lines. (These were swapped, which drew
            # "Green" into a 59px-wide canvas and clipped the n off.)
            tmp = Image.new("RGBA", (int(widest) + 8, int(total_h) + 8), (0, 0, 0, 0))
            td = ImageDraw.Draw(tmp)
            for idx, ln in enumerate(lines):
                td.text((4, 4 + idx * line_h), ln, font=font, fill=fg)
            tmp = tmp.rotate(-90, expand=True)
            # centre the rotated run inside the box — sliding along the box if
            # another label already owns that spot
            px0 = x0 + max(0, ((x1 - x0) - tmp.width) // 2)
            cands = [y0 + max(0, ((y1 - y0) - tmp.height) // 2), y0, y1 - tmp.height]
            chosen_py, best_loss = None, None
            for py in cands:
                if py < y0 or py + tmp.height > y1:
                    continue
                rect = [px0, py, px0 + tmp.width, py + tmp.height]
                loss = sum(max(0, min(rect[2], r[2]) - max(rect[0], r[0])) *
                           max(0, min(rect[3], r[3]) - max(rect[1], r[1]))
                           for r in drawn_rects)
                if loss == 0:
                    chosen_py, best_loss = py, 0
                    break
                if best_loss is None or loss < best_loss:
                    chosen_py, best_loss = py, loss
            if chosen_py is None:
                chosen_py = y0 + max(0, ((y1 - y0) - tmp.height) // 2)
            work.paste(tmp, (px0, chosen_py), tmp)
            entry["rects"] = [[px0, chosen_py, px0 + tmp.width, chosen_py + tmp.height]]
            drawn_rects.extend(entry["rects"])
        else:
            # The anchor box often includes the wire the label sits next to
            # (they cluster together), so centring would park the English on
            # the wire — the original 20A ワイパ sat above it. Slide the run to
            # whichever side of a crossing wire has the room.
            band_h = wires_h[y0:y1, x0:x1]
            wire_rows = np.where(band_h.sum(axis=1) > 0.6 * (x1 - x0))[0] if x1 > x0 else np.array([])
            wr = None
            if wire_rows.size:
                wr = int(np.median(wire_rows)) + y0

            # Centre the run on the ORIGINAL Japanese box, not on the grown
            # box: the reference translations sit exactly where the Japanese
            # was (measured dx/dy of 0), and centring in a box grown for width
            # was sliding labels sideways. Clamped so it never leaves the box.
            ea = entry.get("anchor") or (x0, y0, x1, y1)   # per-label: a bare
            # `anchor` here is a leftover from the planning loop and pinned the
            # text to whatever label happened to be planned last (labels landing
            # hundreds of px from their own box).
            acx = (ea[0] + ea[2]) / 2
            acy = (ea[1] + ea[3]) / 2
            ty = acy - total_h / 2
            ty = max(y0 + 1, min(ty, y1 - total_h - 1)) if y1 - total_h - 1 > y0 + 1 else ty
            if wr is not None:
                above, below = wr - y0, y1 - wr
                # Prefer the side with the room, as the original label did —
                # and take 2px of slack, because demanding an exact fit pushed
                # "Wiper" onto the wire it was meant to sit above.
                if above >= total_h - 2 and above >= below:
                    ty = y0 + max(1, above - total_h)
                elif below >= total_h - 2:
                    ty = min(wr + 2, y1 - total_h)

            # Slots stay inside the label's OWN row: the grown box is often
            # much taller than the text (a table cell grown upward), and free
            # roam across it let the picker park "Red/blue" in the cell above
            # because that slot happened to clear the table rule.
            band_lo = max(y0 + 1, ea[1])
            band_hi = min(y1 - total_h - 1, ea[3] - total_h)
            if band_hi < band_lo:
                band_lo, band_hi = y0 + 1, y1 - total_h - 1
            if band_hi < band_lo:
                band_lo = band_hi = (y0 + y1) / 2 - total_h / 2
            ty = max(band_lo, min(ty, band_hi))

            # Candidate slots, best first: where the Japanese was (the pin),
            # then the wire-avoiding slot, then the plain box centres. The
            # first slot with clear pixels wins, so two labels drawn from the
            # same dense area can never land on each other.
            pin_x = acx
            box_cx = (x0 + x1) / 2
            cands = []
            # denser vertical steps (half a line at a time) so a label can
            # slide off a restored wire instead of settling for a slot that
            # grazes it — the picker scores wire coverage, but only across the
            # slots it is offered
            step = max(2.0, line_h / 2)
            ys = [ty]
            for k in range(1, 200):
                up, down = ty - k * step, ty + k * step
                if down <= band_hi:
                    ys.append(down)
                if up >= band_lo:
                    ys.append(up)
                if up < band_lo and down > band_hi:
                    break
            if len(ys) < 3:      # band too short to slide: centre it
                ys = [(band_lo + band_hi) / 2]
            for cx in (pin_x, box_cx):
                for cy in ys:
                    cands.append((cx, cy))
            chosen, best_score = None, None
            for ci, (cx, cy) in enumerate(cands):
                rects = []
                base = cy - total_h / 2
                base = max(band_lo, min(base, band_hi)) if band_hi > band_lo else base
                for idx, ln in enumerate(lines):
                    lw = draw.textlength(ln, font=font)
                    tx = cx - lw / 2
                    tx = max(x0 + 1, min(tx, x1 - lw - 1)) if x1 - lw - 1 > x0 + 1 else tx
                    # stack from ONE clamped base: clamping each line separately
                    # put every line on the same y when the box was too short,
                    # drawing a 3-line label three times over itself
                    yy = base + idx * line_h
                    rects.append([tx, yy, tx + lw, yy + line_h])
                loss = 0
                worst_line = 0
                for r in rects:
                    r_loss = 0
                    for o in drawn_rects:
                        ov = max(0, min(r[2], o[2]) - max(r[0], o[0])) * \
                             max(0, min(r[3], o[3]) - max(r[1], o[1]))
                        r_loss += ov
                        # vs the SMALLER of the two runs: measuring only against
                        # this run let a 6px label sit on a 14px one (the big
                        # run dilutes the fraction on its own side)
                        smaller = min((r[2] - r[0]) * (r[3] - r[1]),
                                      (o[2] - o[0]) * (o[3] - o[1]))
                        if smaller > 0:
                            worst_line = max(worst_line, ov / smaller)
                    loss += r_loss
                    r_area = max(1, (r[2] - r[0]) * (r[3] - r[1]))
                    worst_line = max(worst_line, r_loss / r_area)
                if worst_line > 0.15:
                    continue            # text-on-text: slot not usable at all
                # Slot is text-clear — now prefer the one that covers fewest
                # wire pixels. Without this the pin slot won every tie and the
                # English sat on the very wire the Japanese sat beside.
                wire_px = 0
                total_px = 0
                for r in rects:
                    rx0, ry0, rx1, ry1 = (int(max(0, r[0])), int(max(0, r[1])),
                                          int(r[2]), int(r[3]))
                    if rx1 <= rx0 or ry1 <= ry0:
                        continue
                    seg_h = wires_h[ry0:ry1, rx0:rx1]
                    seg_v = wires_v[ry0:ry1, rx0:rx1]
                    n = (ry1 - ry0) * (rx1 - rx0)
                    total_px += n
                    if seg_h.size:
                        wire_px += int(np.count_nonzero(seg_h | seg_v))
                wire_frac = wire_px / max(1, total_px)
                # wire coverage decides; preference order (pin slot first, then
                # nearest) only breaks ties within 1%
                score = (wire_frac, ci)
                if best_score is None or \
                        score[0] < best_score[0] - 0.01 or \
                        (abs(score[0] - best_score[0]) <= 0.01 and score[1] < best_score[1]):
                    chosen, best_score = rects, score
            if chosen is None:
                # every slot had text on text — erase only, draw nothing
                skipped.append({"reason": "overlap", "en": it["en"],
                                "box": list(entry["erase"]), "erased_only": True})
                continue
            for idx, r in enumerate(chosen):
                draw.text((r[0], r[1]), lines[idx], font=font, fill=fg)
            entry["rects"] = chosen
            drawn_rects.extend(chosen)

    out = Path(out_path)
    out.parent.mkdir(parents=True, exist_ok=True)
    work.save(out, quality=90, subsampling=0)

    Path(str(out) + ".report.json").write_text(json.dumps({
        "drawn": [
            {"en": e["item"]["en"], "box": list(e["erase"]), "size": e.get("size"),
             "vertical": bool(e.get("vertical")), "w": e["box"][2] - e["box"][0],
             "h": e["box"][3] - e["box"][1], "cap": e.get("cap"), "guard": e.get("guard"),
             "lines": e.get("lines"), "rects": e.get("rects"), "gbox": list(e["box"]),
             "anchor": list(e.get("anchor") or ())}
            for e in placed
        ],
        "skipped": skipped,
        "mopped": mopped,
        "mopped_boxes": mopped_boxes,
    }, indent=2))

    if dump_dir:
        d = Path(dump_dir)
        d.mkdir(parents=True, exist_ok=True)
        img.save(d / "before.jpg", quality=90)
        work.save(d / "after.jpg", quality=90)

    reasons = {}
    for s in skipped:
        key = s["reason"] + (" (erased only)" if s.get("erased_only") else "")
        reasons[key] = reasons.get(key, 0) + 1
    detail = ", ".join(f"{v} {k}" for k, v in sorted(reasons.items()))
    print(
        f"{src.name} -> {out}  ({len(placed)} drawn of {len(items)}"
        f"{'; ' + detail if detail else ''}; {restored_px} wire px restored)"
    )


if __name__ == "__main__":
    main()
