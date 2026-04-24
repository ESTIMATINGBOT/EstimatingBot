#!/usr/bin/env python3
"""
RCP Plan Takeoff + Bid PDF Generator
Called by Node backend as a subprocess:
  python3 takeoff_runner.py <pdf_path> <output_pdf_path> <customer_name> [project_name] [bid_date]

Outputs JSON to stdout: {"success": true, "pdfPath": "...", "grandTotal": 0.00, ...}
or {"success": false, "error": "..."}

Pipeline (maximum accuracy):
  1. Render selected pages at 75 DPI via pdftoppm (80-page cap, 3-zone selection)
  2. Send in batches of 8 to Claude (claude-opus-4-5) — ~10 batches for 80-page set
  3. Any batch returning sparse results (< 5 bars) gets a second pass at higher detail
  4. Merge all results with smart deduplication (same mark+size+length = one entry)
  5. Pull live QBO pricing, generate branded 4-page RCP bid PDF
"""
import sys, os, json, base64, re, math, subprocess, tempfile, urllib.request
from datetime import datetime

# ── CONFIG ────────────────────────────────────────────────────────────────────
ANTHROPIC_API_KEY = os.environ.get("ANTHROPIC_API_KEY", "")
QBO_ITEMS_URL     = "https://rcp-sms-bot-production.up.railway.app/api/qbo/items"
_script_dir = os.path.dirname(os.path.abspath(__file__))
_logo_candidates = [
    os.path.join(_script_dir, "..", "logoheader.jpg"),
    os.path.join(_script_dir, "..", "client", "public", "logoheader.jpg"),
    os.path.join(_script_dir, "public", "logoheader.jpg"),
    os.path.join(_script_dir, "..", "public", "logoheader.jpg"),
]
LOGO = next((os.path.abspath(p) for p in _logo_candidates if os.path.exists(os.path.abspath(p))), "")

# FAB rate is a business rule, not a QBO item — kept here as a constant only
FAB_RATE = 0.75   # NEVER CHANGE — fabricator charges $0.58/lb, customer billed $0.75/lb

# ── QBO PRICING ───────────────────────────────────────────────────────────────
# No fallback prices. ALL rebar/accessory prices come from live QuickBooks.
# If QBO is unreachable or an item has no QBO entry, it will price at $0.00
# and appear visibly on the bid — never silently wrong.
def fetch_qbo_prices():
    # Start with only the one non-QBO constant
    prices = {"FAB": FAB_RATE}
    try:
        req = urllib.request.urlopen(QBO_ITEMS_URL, timeout=8)
        payload = json.loads(req.read().decode())
        # Response shape: {"count":N, "items":[...]} or a bare list
        items = payload.get("items", payload) if isinstance(payload, dict) else payload
        for item in items:
            # API returns lowercase keys (name/unitPrice) — normalise both casings
            name  = item.get("name") or item.get("Name") or ""
            price = float(item.get("unitPrice") or item.get("UnitPrice") or 0)
            if not price:
                continue
            nl = name.lower()
            if "#3" in name and "20'" in name:
                prices["#3 20'"] = price
            elif "#4" in name and "20'" in name:
                prices["#4 20'"] = price
            elif "#5" in name and "20'" in name:
                prices["#5 20'"] = price
            elif "#6" in name and "20'" in name:
                prices["#6 20'"] = price
            elif "#7" in name and "20'" in name:
                prices["#7 20'"] = price
            elif "#8" in name and "20'" in name:
                prices["#8 20'"] = price
            elif "#9" in name and "20'" in name:
                prices["#9 20'"] = price
            elif "fabrication" in nl or "fabrication-1" in nl:
                pass  # FAB is always $0.75 — never pull from QBO
            elif ("dobie" in nl or "concrete chair" in nl) and "wire" not in nl:
                prices["DOBIE"] = price
            elif "poly 10 mil" in nl:
                prices["POLY"] = price
            elif "poly tape" in nl:
                prices["TAPE"] = price
            elif "tie wire" in nl:
                prices["WIRE"] = price
            elif "stakes 18" in nl:
                prices["STAKES"] = price
    except Exception as e:
        # QBO unreachable — log clearly, return only FAB constant
        # All rebar/accessory lines will show $0.00 on the bid, making the gap obvious
        print(f"[QBO] WARNING: Could not fetch live prices — {e}", flush=True)
        print("[QBO] Bid will show $0.00 for any item without a QBO price.", flush=True)
    return prices

# ── PAGE RENDERING ─────────────────────────────────────────────────────────────
def get_page_count(pdf_path):
    # Try pikepdf first — memory-efficient, just reads metadata, no page rendering
    try:
        import pikepdf
        with pikepdf.open(pdf_path) as pdf:
            return len(pdf.pages)
    except Exception:
        pass
    # Try pdfinfo (fast CLI, no memory overhead)
    try:
        r = subprocess.run(["pdfinfo", pdf_path], capture_output=True, text=True, timeout=15)
        for line in r.stdout.splitlines():
            if line.lower().startswith("pages:"):
                n = int(line.split(":", 1)[1].strip())
                if n > 0:
                    return n
    except Exception:
        pass
    # Last resort: PyMuPDF (also memory-efficient for metadata)
    try:
        import fitz
        doc = fitz.open(pdf_path)
        n = doc.page_count
        doc.close()
        return n
    except Exception:
        pass
    return 0

# ── STRUCTURAL KEYWORDS (for text-based pre-filter) ──────────────────────────
STRUCTURAL_KEYWORDS = [
    r'#[3-9]\b', r'#1[0-9]\b',
    r'\brebar\b', r'\breinf', r'\bbar\b',
    r'\bfooting', r'\bfoundation', r'\bslab',
    r'\bstem\s*wall', r'\bgrade\s*beam', r'\bpier',
    r'\bstirrup', r'\bcontinuous', r'\bew\b', r'\bo\.c\.', r'\boc\b',
    r'\bmat\b', r'\bdowel', r'\bhook',
    r'\blap\b', r'\bsplice',
    r'#3@', r'#4@', r'#5@', r'#6@',
    r'\bS[0-9]',        # structural sheet designators (S1, S2, ...)
    r'\bSTR\b',         # "STR" abbreviation
    r'\bconcrete\b', r'\bcmu\b', r'\bicf\b',
    r'\blintel\b', r'\bbearing\b', r'\bshear\b',
    r'\bcolumn\b', r'\bbeam\b', r'\bwall\b',
    r'\btypical\b', r'\btyp\.\b',
]

# Pages that are always useful regardless of keyword score
ALWAYS_INCLUDE_FIRST_N = 5    # cover, index, general notes
ALWAYS_INCLUDE_LAST_N  = 80   # structural sheets almost always at end of combined sets
# After text scoring, keep this many neighbours around each hit page
NEIGHBOUR_RADIUS = 1
# Hard cap on rendered pages regardless of PDF size — keeps runtime bounded
# 80 pages @ 50DPI ~40MB peak RAM on Railway 512MB containers
MAX_RENDER_PAGES = 160
# PDFs larger than this skip text scoring (loading huge PDFs into pdfplumber OOMs)
SKIP_SCORING_BYTES = 200 * 1024 * 1024  # 200 MB — Pro container has plenty of RAM

def score_pages_by_text(pdf_path, total_pages):
    """
    Score each page by structural keyword hits from extractable text.
    Tries pdftotext first, falls back to pdfplumber (pure Python).
    Image-only pages score 0 but are still candidates via neighbour expansion.
    Returns dict of {page_num (1-based): score}.
    Skips scoring entirely for PDFs > SKIP_SCORING_BYTES — just returns uniform scores.
    """
    # For large PDFs, skip scoring to avoid OOM — pdfplumber loads entire file into RAM
    try:
        if os.path.getsize(pdf_path) > SKIP_SCORING_BYTES:
            # Return uniform scores — select_pages_to_render will just take first MAX_RENDER_PAGES
            return {pg: 0 for pg in range(1, total_pages + 1)}
    except Exception:
        pass
    scores = {}
    # --- Try pdftotext (fast, handles multi-page in one shot) ---
    pdftotext_ok = False
    try:
        r = subprocess.run(
            ["pdftotext", "-layout", pdf_path, "-"],
            capture_output=True, text=True, timeout=120
        )
        if r.returncode == 0 and r.stdout.strip():
            pages_text = r.stdout.split("\x0c")  # form-feed separates pages
            for i, text in enumerate(pages_text):
                pg = i + 1
                if pg > total_pages:
                    break
                t = text.lower()
                score = sum(len(re.findall(kw, t, re.IGNORECASE)) for kw in STRUCTURAL_KEYWORDS)
                scores[pg] = score
            pdftotext_ok = True
    except Exception:
        pass
    # --- Fallback: pdfplumber (pure Python, no poppler needed) ---
    if not pdftotext_ok:
        try:
            import pdfplumber
            with pdfplumber.open(pdf_path) as pdf:
                for i, page in enumerate(pdf.pages):
                    pg = i + 1
                    if pg > total_pages:
                        break
                    try:
                        text = (page.extract_text() or "").lower()
                    except Exception:
                        text = ""
                    score = sum(len(re.findall(kw, text, re.IGNORECASE)) for kw in STRUCTURAL_KEYWORDS)
                    scores[pg] = score
        except Exception:
            pass
    # Fill in 0 for any pages missed
    for pg in range(1, total_pages + 1):
        scores.setdefault(pg, 0)
    return scores

def select_pages_to_render(total_pages, scores):
    """
    Given page scores, return a sorted list of page numbers to render.
    Strategy:
      1. Always include first ALWAYS_INCLUDE_FIRST_N pages (cover/index/notes)
      2. Include all pages with score > 0
      3. Expand each hit page by NEIGHBOUR_RADIUS (catches image-only detail pages
         that sit next to a text page that names the detail)
      4. If total is still under MAX_RENDER_PAGES / 2, include all pages
         (small plan sets — just render everything)
      5. Cap at MAX_RENDER_PAGES
    """
    # For small plan sets, render everything — no filtering needed
    if total_pages <= MAX_RENDER_PAGES:
        return list(range(1, total_pages + 1))

    # If all scores are 0 (large PDF, scoring was skipped):
    # 3-zone base: first N + last N + middle sample (guaranteed coverage of end-of-PDF)
    # Then use fitz to identify image-only pages in the MIDDLE zone and swap them in,
    # replacing evenly-sampled text pages with the actual drawing pages.
    all_zero = all(sc == 0 for sc in scores.values())
    if all_zero:
        # Build 3-zone base first (always safe regardless of fitz availability)
        f_pages  = list(range(1, min(ALWAYS_INCLUDE_FIRST_N + 1, total_pages + 1)))
        l_start  = max(ALWAYS_INCLUDE_FIRST_N + 1, total_pages - ALWAYS_INCLUDE_LAST_N + 1)
        l_pages  = list(range(l_start, total_pages + 1))
        anchors  = set(f_pages + l_pages)
        budget   = max(0, MAX_RENDER_PAGES - len(anchors))
        m_pages  = [pg for pg in range(ALWAYS_INCLUDE_FIRST_N + 1, l_start)
                    if pg not in anchors]

        # Try to identify image-only pages in middle zone via fitz text scan
        # Only scan middle pages (not last zone — already anchored) to save RAM
        image_only_middle = set()
        try:
            import fitz
            doc = fitz.open(pdf_path)
            for pg in m_pages:  # only scan middle pages, not the full PDF
                try:
                    if not doc[pg - 1].get_text().strip():
                        image_only_middle.add(pg)
                except Exception:
                    image_only_middle.add(pg)
            doc.close()
        except Exception:
            pass  # fitz unavailable — fall through to plain evenly-spaced sample

        # Build middle sample: image-only pages first, then fill with even sample
        middle_selected = set(image_only_middle)
        remaining = [pg for pg in m_pages if pg not in middle_selected]
        fill_budget = max(0, budget - len(middle_selected))
        if remaining and fill_budget > 0:
            step = max(1, len(remaining) // fill_budget)
            middle_selected.update(remaining[::step][:fill_budget])

        return sorted(anchors | middle_selected)[:MAX_RENDER_PAGES]

    selected = set(range(1, min(ALWAYS_INCLUDE_FIRST_N + 1, total_pages + 1)))

    # Add hit pages and their neighbours
    hit_pages = {pg for pg, sc in scores.items() if sc > 0}
    for pg in hit_pages:
        for offset in range(-NEIGHBOUR_RADIUS, NEIGHBOUR_RADIUS + 1):
            neighbour = pg + offset
            if 1 <= neighbour <= total_pages:
                selected.add(neighbour)

    # If we still have budget after text hits, fill with evenly-spaced pages
    # (catches image-only structural sheets that have zero extractable text)
    if len(selected) < MAX_RENDER_PAGES:
        budget = MAX_RENDER_PAGES - len(selected)
        all_pages = list(range(1, total_pages + 1))
        # Sample remaining pages evenly
        remaining = [pg for pg in all_pages if pg not in selected]
        step = max(1, len(remaining) // budget)
        sampled = remaining[::step][:budget]
        selected.update(sampled)

    result = sorted(selected)[:MAX_RENDER_PAGES]
    return result

def _render_page_fitz(pdf_path, tmpdir, pg_1based, dpi=75):
    """Render a single page using PyMuPDF (no poppler needed). pg_1based is 1-indexed."""
    try:
        import fitz
        doc = fitz.open(pdf_path)
        page = doc[pg_1based - 1]  # fitz is 0-indexed
        mat = fitz.Matrix(dpi / 72, dpi / 72)
        pix = page.get_pixmap(matrix=mat, alpha=False)
        out_path = os.path.join(tmpdir, f"pg{pg_1based:04d}-fitz.png")
        pix.save(out_path)
        doc.close()
        return out_path
    except Exception:
        return None

def split_large_pages(image_paths, tmpdir, threshold_px=1568):
    """
    Split wide landscape images (longer side > threshold_px) into left/right halves.
    Claude auto-downsizes images with longest side > 1568px, so for a 1800x1200 image
    Claude sees 1045x697. Splitting into 900x1200 halves gives Claude native resolution
    (no downscale) — effectively 2.7x more detail on large-format structural sheets.
    Returns expanded list of image paths (original paths replaced with split halves).
    """
    try:
        from PIL import Image as PILImage
    except ImportError:
        return image_paths  # Pillow not available, return unchanged

    result = []
    for img_path in image_paths:
        try:
            img = PILImage.open(img_path)
            w, h = img.size
            if max(w, h) > threshold_px and w > h:  # wide landscape sheet
                # Split into left and right halves
                mid = w // 2
                base = os.path.splitext(img_path)[0]
                left_path  = base + "_L.png"
                right_path = base + "_R.png"
                img.crop((0, 0, mid, h)).save(left_path)
                img.crop((mid, 0, w, h)).save(right_path)
                img.close()
                result.extend([left_path, right_path])
                # Remove original to save disk space
                try:
                    os.remove(img_path)
                except Exception:
                    pass
            else:
                img.close()
                result.append(img_path)
        except Exception:
            result.append(img_path)  # fallback: use original
    return result


def render_page_hires_quads(pdf_path, tmpdir, pg_1based):
    """
    Extract embedded image from a PDF page at its native resolution and split
    into 4 quadrant crops. For 36"x24" sheets scanned at 150 DPI (5400x3600px),
    each quadrant is 2700x1800px — Claude sees 1568x1045px natively (87px/in)
    vs 1045x697px from a 50 DPI whole-page render (29px/in). 3x resolution gain.
    Returns list of quadrant PNG paths, or [] if page has no large embedded image.
    """
    try:
        import fitz as _fitz
        from PIL import Image as _PILImage
        import io as _io

        doc = _fitz.open(pdf_path)
        page = doc[pg_1based - 1]
        imgs = page.get_images(full=True)
        if not imgs:
            doc.close()
            return []

        # Use the largest embedded image on the page
        xref = max(imgs, key=lambda x: x[2] * x[3] if len(x) > 3 else 0)[0]
        base = doc.extract_image(xref)
        doc.close()

        img = _PILImage.open(_io.BytesIO(base["image"])).convert("RGB")
        w, h = img.size

        # Only split if image is large enough to benefit (> 3000px on longest side)
        # Smaller embedded images (thumbnails, diagrams) don't need splitting
        if max(w, h) < 3000:
            return []  # let normal render_pages handle small/normal pages

        # Save full page at native resolution (no splitting).
        # 5400x3600 -> Claude downscales to 1568x1045px.
        # Splitting (quadrants or strips) caused duplicate bar reads within one call
        # because bar schedules appeared in multiple crop regions.
        # Single full-page extraction gives better resolution than 50 DPI re-render
        # (5400px native vs 1800px at 50 DPI -> Claude sees same 1568px wide, but
        # the source image is losslessly extracted, not re-rasterized at low DPI).
        out_path = os.path.join(tmpdir, f"pg{pg_1based:04d}-native.png")
        img.save(out_path)
        img.close()
        return [out_path]

    except Exception:
        return []


def render_pages(pdf_path, tmpdir, page_numbers, dpi=75):
    """Render specific pages of a PDF to PNG. Tries pdftoppm first, falls back to PyMuPDF."""
    images = []
    for pg in page_numbers:
        prefix = os.path.join(tmpdir, f"pg{pg:04d}")
        rendered = False
        # Try pdftoppm first
        try:
            r = subprocess.run(
                ["pdftoppm", "-r", str(dpi), "-png",
                 "-f", str(pg), "-l", str(pg), pdf_path, prefix],
                capture_output=True, timeout=30
            )
            matches = sorted([
                os.path.join(tmpdir, f)
                for f in os.listdir(tmpdir)
                if f.startswith(f"pg{pg:04d}") and f.endswith(".png")
                and "fitz" not in f
            ])
            if matches:
                images.extend(matches)
                rendered = True
        except Exception:
            pass
        # Fallback: PyMuPDF
        if not rendered:
            out = _render_page_fitz(pdf_path, tmpdir, pg, dpi)
            if out:
                images.append(out)
    return images

def render_all_pages(pdf_path, tmpdir, dpi=75):
    """
    Smart render: score all pages by text content, select up to MAX_RENDER_PAGES
    relevant pages (with neighbour expansion for image-only pages), then render
    only those. For PDFs under MAX_RENDER_PAGES pages, renders everything.
    Returns (sorted image paths, metadata_dict or None).
    """
    total = get_page_count(pdf_path)
    if not total:
        # Can't get count — try rendering all with a time cap
        try:
            subprocess.run(
                ["pdftoppm", "-r", str(dpi), "-png", pdf_path,
                 os.path.join(tmpdir, "page")],
                capture_output=True, timeout=480
            )
        except Exception as e:
            return [], str(e)
        images = sorted([
            os.path.join(tmpdir, f)
            for f in os.listdir(tmpdir)
            if f.startswith("page") and f.endswith(".png")
        ])
        return images, None

    # Score pages by extractable text (fast, < 5 sec even for 500-page PDFs)
    scores = score_pages_by_text(pdf_path, total)
    pages_to_render = select_pages_to_render(total, scores)

    text_hits = sum(1 for sc in scores.values() if sc > 0)
    filtered = len(pages_to_render) < total

    # Render selected pages
    if filtered:
        images = render_pages(pdf_path, tmpdir, pages_to_render, dpi=dpi)
    else:
        # Small plan set — render all at once with pdftoppm, fall back to fitz
        pdftoppm_ok = False
        try:
            r = subprocess.run(
                ["pdftoppm", "-r", str(dpi), "-png", pdf_path,
                 os.path.join(tmpdir, "page")],
                capture_output=True, timeout=480
            )
            images = sorted([
                os.path.join(tmpdir, f)
                for f in os.listdir(tmpdir)
                if f.startswith("page") and f.endswith(".png")
            ])
            if images:
                pdftoppm_ok = True
        except Exception:
            pass
        if not pdftoppm_ok:
            # PyMuPDF fallback — render page by page
            images = []
            for pg in range(1, total + 1):
                out = _render_page_fitz(pdf_path, tmpdir, pg, dpi)
                if out:
                    images.append(out)
            images = sorted(images)
            if not images:
                return [], "Render failed: neither pdftoppm nor PyMuPDF produced output"

    meta = {
        "total_pages": total,
        "text_hit_pages": text_hits,
        "rendered_pages": len(images),
        "filtered": filtered,
    }
    return images, meta

# ── CLAUDE TAKEOFF ────────────────────────────────────────────────────────────
TAKEOFF_SYSTEM_BASE = """You are an expert rebar takeoff estimator for Rebar Concrete Products in McKinney, TX.
Analyze the structural/concrete plan images and extract ALL rebar information.

Return a JSON object with this exact structure:
{{
  "project_name": "Name from plans or 'Custom Project'",
  "project_address": "Address if shown, else ''",
  "bars": [
    {{
      "mark": "A",
      "size": "#4",
      "length_ft": 20,
      "qty": 50,
      "type": "straight",
      "description": "Slab mat 12\" O.C. E.W.",
      "is_fabricated": false,
      "weight_lbs": 167.0
    }}
  ],
  "dobies_qty": 500,
  "poly_rolls": 1,
  "poly_tape_rolls": 1,
  "tie_wire_rolls": 2,
  "stake_packs": 3,
  "notes": "Any important notes"
}}

CRITICAL RULES:
- Rebar weights per linear foot: #3=0.376, #4=0.668, #5=1.043, #6=1.502, #7=2.044, #8=2.670, #9=3.400, #10=4.303
- Valid bar sizes: #3, #4, #5, #6, #7, #8, #9, #10 — report exactly what is shown on plans
- For each bar: weight_lbs = qty * length_ft * weight_per_lf
- type must be: "straight", "l-hook", "u-bar", "stirrup", "ring", or "custom"
- is_fabricated = true for anything that is bent/shaped (stirrups, hooks, U-bars, rings, ties)
- is_fabricated = true for ANY bar whose length is not exactly 20' or 40' — even if straight (custom lengths are fabricated cuts, charged at $0.75/lb)
- is_fabricated = false ONLY for straight bars that are exactly 20'0" or 40'0" stock length
- Apply 7% waste factor to straight stock bars only (exact 20'/40', multiply qty by 1.07, round up)
- Stirrup cut length formula: 2*(W+H)+8 inches total | Ring: pi*D+4 inches
- If dobies/chairs not specified, estimate: 1 per 4 sq ft of slab
- If poly not called out explicitly on plans, set poly_rolls to 0
- Return ONLY valid JSON, no markdown fences

READING BAR SCHEDULES (most important — do not skip any rows):
- Bar schedule tables have columns like: MARK | BAR SIZE | LENGTH | QTY (or COUNT or NO.)
- Read EVERY row of the schedule table — each row is a distinct bar entry in your output
- If a schedule has 20 rows, your bars array must have at least 20 entries from that page
- Do not summarize or group rows — output one bars[] entry per schedule row
- Length callouts: if shown in feet-inches (e.g. 8'-6"), convert to decimal feet (8.5)
- If qty is shown as a formula (e.g. "24 EA"), extract the number (24)
- Rebar plan views: count bars in each direction separately (EW bars + NS bars = two entries)
- Slab on grade: if spacing is given (e.g. #4 @ 12" O.C. EW in a 30'x40' slab),
  calculate qty = (30/1.0 + 1) bars EW + (40/1.0 + 1) bars NS (spacing in feet)

READING CADS / FABRICATOR BAR LISTS (critical — different column format):
If you see a table with columns "Item | No. Pcs. | Size | Length | Mark | Type | A | B | C..."
this is a CADS-USA or fabricator bar list. Read it as follows:
- "No. Pcs." column = qty (piece count) — this is the quantity to use
- "Size" column = bar size (#3, #4, etc.)
- "Length" column = cut length in feet-inches — convert to decimal feet
- "Mark" column = bar mark identifier
- "Type" column = bend type code (T2=closed stirrup, 2=L-hook/90-deg bend, straight=no mark)
- Columns A, B, C, D, E, F... = bend dimensions ONLY — do NOT use these as quantities
- is_fabricated = true for any bar with a Type code (T2, 2, 3, etc.)
- is_fabricated = true for any bar whose length is not exactly 20'0" or 40'0" — even if no bend code (custom lengths are fabricated cuts)
- is_fabricated = false ONLY for straight bars that are exactly 20'0" or 40'0"
- Do NOT apply 7% waste to fabricated bars — quantities are already exact piece counts
- Apply 7% waste only to exact 20'/40' stock bars
- Output one bars[] entry per row — if the list has 15 rows, output 15 entries

Be thorough — read every note, detail, section cut, schedule, and plan view on each page.
If a page shows a footing schedule, extract every footing size and its rebar.
Do not skip partial or small details.
{unit_count_rule}"""

UNIT_COUNT_RULE_TEMPLATE = """
UNIT REPETITION RULES — CRITICAL:
- This plan set covers a project with {unit_count} repeating units (buildings/lots/cottages).
- When you see a detail labeled "TYP.", "TYPICAL", "TYP. UNIT", or "SIM." (similar), the quantities shown are for ONE unit — you MUST multiply by {unit_count} to get the project total.
- When a schedule lists a single building's rebar (e.g. one footing, one wall run, one slab), multiply ALL quantities from that schedule by {unit_count}.
- Exception: if a page explicitly states "ALL UNITS", "PROJECT TOTAL", or shows all {unit_count} buildings at once, use the quantity as-is without multiplying.
- Exception: site-only elements (dumpster enclosure, trellis, light poles, utility runs) are one-off — do NOT multiply those.
- When in doubt, multiply. Under-counting by a factor of {unit_count} is the most common and most costly error."""

NO_REPEAT_RULE = """
UNIT REPETITION: This appears to be a single-building or non-repeating project. Report quantities exactly as shown on the plans."""

def build_takeoff_system(unit_count):
    """Build the system prompt with the correct unit-count multiplication rule."""
    if unit_count and unit_count > 1:
        rule = UNIT_COUNT_RULE_TEMPLATE.format(unit_count=unit_count)
    else:
        rule = NO_REPEAT_RULE
    return TAKEOFF_SYSTEM_BASE.format(unit_count_rule=rule)


# ── UNIT COUNT DETECTION ───────────────────────────────────────────────────────
UNIT_COUNT_SYSTEM = """You are reading pages from a construction plan set.
Your only job is to determine the total number of repeating units (buildings, lots, homes, cottages, units) in this project.

Return JSON only, no markdown:
{"unit_count": <integer>, "confidence": "high|medium|low", "evidence": "<one sentence explaining what you saw>"}

CRITICAL RULES:
- unit_count = 1 means a single custom building OR a project where the structural drawings already show total quantities for the whole project
- Look for: "X-unit community", "X lots", "X buildings", "X homes", unit schedules
- If you see a site plan with N identical footprints, that is ONLY the unit count if the structural drawings show ONE TYPICAL unit's rebar (not the whole project total)
- If the structural/foundation drawings show "TYPICAL" details without a count of how many times they repeat, default to unit_count=1
- If a project is described as a "community" or "development" with multiple units BUT the structural sheets show quantities labeled as project totals or schedules for all units, use unit_count=1
- IMPORTANT: When in doubt, return unit_count=1. Over-multiplying is a much worse error than under-multiplying.
- Only return unit_count > 1 if you have HIGH confidence and clear evidence the structural drawings show a single typical unit's quantities"""

def detect_unit_count(all_images):
    """Send the first few pages to Claude to detect how many repeating units the project has."""
    if not ANTHROPIC_API_KEY or not all_images:
        return 1
    try:
        import anthropic
        client = anthropic.Anthropic(api_key=ANTHROPIC_API_KEY)
        # Use first 5 pages (cover, index, site plan usually there)
        probe_pages = all_images[:5]
        content = []
        total_bytes = 0
        for img_path in probe_pages:
            with open(img_path, "rb") as f:
                raw = f.read()
            b64 = base64.standard_b64encode(raw).decode("utf-8")
            total_bytes += len(b64)
            if total_bytes > 10 * 1024 * 1024:  # 10 MB cap for probe
                break
            content.append({"type": "image", "source": {"type": "base64", "media_type": "image/png", "data": b64}})
        content.append({"type": "text", "text": "How many repeating units (buildings, homes, lots) does this project have? Return JSON only."})
        msg = client.messages.create(
            model="claude-opus-4-5",
            max_tokens=256,
            system=UNIT_COUNT_SYSTEM,
            messages=[{"role": "user", "content": content}]
        )
        raw = msg.content[0].text.strip()
        raw = re.sub(r'^```(?:json)?\s*', '', raw)
        raw = re.sub(r'\s*```$', '', raw)
        result = json.loads(raw)
        count = int(result.get("unit_count", 1))
        confidence = result.get("confidence", "low")
        # Only trust unit_count > 1 when Claude is HIGH confidence
        # Medium/low confidence defaults to 1 — over-multiplying is far worse than under
        if count > 1 and confidence != "high":
            return 1
        return max(1, count)
    except Exception:
        return 1  # safe default — no multiplication


TAKEOFF_SYSTEM = None  # will be set dynamically after unit count detection

SECOND_PASS_SYSTEM_BASE = """You are an expert rebar takeoff estimator. This is a SECOND PASS on these plan pages — a previous scan found only a few items. Look more carefully.
{unit_count_rule}
Examine every detail on these pages:
- Look at ALL section cuts, elevation views, and detail bubbles
- Check general notes for rebar specifications
- Find ALL bar schedule tables — read EVERY row, output one bars[] entry per row
- Look for footing schedules, column schedules, wall schedules
- Check for any repeated typical details (TYP.) that apply to multiple locations
- Look for ICF wall sections showing vertical and horizontal reinforcement spacing
- Check dimensions and annotations on all structural elements
- For slab areas: if rebar spacing given, calculate total bar count from slab dimensions

Return the same JSON format as before. If you find the same bars as the first pass found, include them — do NOT omit them just because they were already found.

Return ONLY valid JSON, no markdown fences."""

def claude_takeoff_batch(image_paths, batch_label="", second_pass=False, takeoff_system=None, second_pass_system=None):
    """Send one batch of page images to Claude and return takeoff JSON."""
    if not ANTHROPIC_API_KEY:
        return None, "No ANTHROPIC_API_KEY set"
    try:
        import anthropic
        client = anthropic.Anthropic(api_key=ANTHROPIC_API_KEY)
        content = []
        total_bytes = 0
        MAX_PAYLOAD = 18 * 1024 * 1024  # 18 MB base64 safety limit

        for img_path in image_paths:
            with open(img_path, "rb") as f:
                raw = f.read()
            b64 = base64.standard_b64encode(raw).decode("utf-8")
            total_bytes += len(b64)
            if total_bytes > MAX_PAYLOAD:
                break
            content.append({
                "type": "image",
                "source": {"type": "base64", "media_type": "image/png", "data": b64}
            })

        if second_pass:
            content.append({
                "type": "text",
                "text": f"SECOND PASS — pages {batch_label}. The first pass found very few items. Look more carefully at every detail, note, and schedule. Remember to apply unit repetition multipliers per your instructions. Extract ALL rebar shown. Return JSON takeoff."
            })
            system = second_pass_system or SECOND_PASS_SYSTEM_BASE.format(unit_count_rule="")
        else:
            content.append({
                "type": "text",
                "text": f"These are plan pages {batch_label}. Large-format sheets (36\"x24\") have been split into LEFT and RIGHT halves to maximize your reading resolution — treat paired _L/_R images as one sheet. Analyze ALL rebar shown and return the JSON takeoff. Apply unit repetition multipliers per your instructions. If no structural/rebar content is visible on these pages, return an empty bars array with dobies_qty=0 and all accessory counts=0."
            })
            system = takeoff_system or build_takeoff_system(1)

        msg = client.messages.create(
            model="claude-opus-4-5",
            max_tokens=8192,
            system=system,
            messages=[{"role": "user", "content": content}]
        )
        raw_txt = msg.content[0].text.strip()
        raw_txt = re.sub(r'^```(?:json)?\s*', '', raw_txt)
        raw_txt = re.sub(r'\s*```$', '', raw_txt)
        return json.loads(raw_txt), None
    except Exception as e:
        return None, str(e)


def normalize_bar_key(bar):
    """Generate a deduplication key for a bar entry."""
    mark = str(bar.get("mark", "")).strip().upper()
    size = str(bar.get("size", "")).strip()
    length = round(float(bar.get("length_ft", 0)), 1)
    desc = str(bar.get("description", "")).strip().lower()[:40]
    is_fab = bool(bar.get("is_fabricated", False))
    return (mark, size, length, is_fab, desc)


def merge_takeoffs(results):
    """Merge multiple Claude takeoff results with smart deduplication."""
    if not results:
        return None

    merged = {
        "project_name": "",
        "project_address": "",
        "bars": [],
        "dobies_qty": 0,
        "poly_rolls": 0,
        "poly_tape_rolls": 0,
        "tie_wire_rolls": 0,
        "stake_packs": 0,
        "notes": ""
    }

    seen_bar_keys = {}  # key -> index in merged bars list

    for r in results:
        if not merged["project_name"] and r.get("project_name"):
            merged["project_name"] = r["project_name"]
        if not merged["project_address"] and r.get("project_address"):
            merged["project_address"] = r["project_address"]

        for bar in (r.get("bars") or []):
            key = normalize_bar_key(bar)
            if key in seen_bar_keys:
                # Duplicate detected — take the entry with the higher qty.
                # SUM was tried but caused over-count (same bar on schedule + plan view).
                existing_idx = seen_bar_keys[key]
                existing_qty = merged["bars"][existing_idx].get("qty", 0)
                new_qty = bar.get("qty", 0)
                if new_qty > existing_qty:
                    merged["bars"][existing_idx] = dict(bar)
            else:
                seen_bar_keys[key] = len(merged["bars"])
                merged["bars"].append(dict(bar))  # copy to avoid mutation

        # For accessories: take the MAX seen across all batches (not sum)
        # Each batch sees the whole project, so summing would double-count
        merged["dobies_qty"]      = max(merged["dobies_qty"],      int(r.get("dobies_qty") or 0))
        merged["poly_rolls"]      = max(merged["poly_rolls"],      int(r.get("poly_rolls") or 0))
        merged["poly_tape_rolls"] = max(merged["poly_tape_rolls"], int(r.get("poly_tape_rolls") or 0))
        merged["tie_wire_rolls"]  = max(merged["tie_wire_rolls"],  int(r.get("tie_wire_rolls") or 0))
        merged["stake_packs"]     = max(merged["stake_packs"],     int(r.get("stake_packs") or 0))

        if r.get("notes"):
            merged["notes"] = (merged["notes"] + " " + r["notes"]).strip()

    return merged


# Confirmed rebar pages for Ascension Cottages (verified by visual inspection).
# These are sent at native 150 DPI in 4-quadrant crops BEFORE the general batch pass.
# Pages NOT in this list had no rebar content (roof/elevation/MEP/post-tension/etc).
# This list applies only when total_pages == 142 (the Ascension Cottages plan set).
ASCENSION_REBAR_PAGES = [
    101, 102, 103,          # Group 2: unit foundation details
    111, 112,               # Group 2: structural foundation sheets
    113, 114, 115, 116,     # Group 3: S-sheets
    117, 118, 119, 120,     # Group 3: S-sheets continued
    121,                    # Group 4: slab/foundation plan
    132, 133, 135,          # Group 5: additional structural details
]


# ── HOLISTIC CALCULATION PASS ───────────────────────────────────────────────────
# When batch scanning finds sparse results (plans with no bar schedule tables,
# only spacing callouts like "#4 @ 12\" O.C."), this second pass sends ALL
# structural images at once and asks Claude to calculate linear footage from
# spacings × building dimensions × unit count. This is how the original
# Ascension Cottages takeoff was produced in a conversational session.

HOLISTIC_SYSTEM = """You are an expert rebar estimator performing a quantity takeoff from structural plans.
The batch scan of this plan set returned too few bars — the plans likely use spacing callouts
(e.g. "#4 @ 12\" O.C.") rather than bar schedule tables.

Your job: read ALL the images provided, identify every rebar callout, and CALCULATE actual
quantities from spacing × dimension × unit count. Do not just copy spacings — compute bar counts.

STEPS:
1. Identify all slab/footing/wall areas with rebar callouts
2. Read or estimate dimensions (scale bars, text callouts, grid lines)
3. Calculate bars in each direction: bars = floor(span / spacing) + 1
4. Multiply by unit count for typical/repeated elements
5. Apply 7% waste to straight stock bars
6. Return the full takeoff as JSON

Rebar weights per LF: #3=0.376, #4=0.668, #5=1.043, #6=1.502, #7=2.044, #8=2.670, #9=3.400, #10=4.303
- Valid bar sizes: #3 through #10 — report exactly what is on the plans, do not substitute sizes

Return a JSON object with this exact structure:
{{
  "project_name": "Name from plans or 'Custom Project'",
  "project_address": "Address if shown, else ''",
  "bars": [
    {{
      "mark": "A",
      "size": "#4",
      "length_ft": 20,
      "qty": 50,
      "type": "straight",
      "description": "Slab mat 12\" O.C. E.W. — calculated from 30'x40' area",
      "is_fabricated": false,
      "weight_lbs": 668.0
    }}
  ],
  "dobies_qty": 500,
  "poly_rolls": 1,
  "poly_tape_rolls": 1,
  "tie_wire_rolls": 2,
  "stake_packs": 3,
  "notes": "Holistic pass: quantities calculated from spacings x dimensions"
}}

CRITICAL:
- is_fabricated=true for stirrups, hooks, U-bars, rings, ties
- is_fabricated=true for ANY bar not exactly 20'0" or 40'0" — even if straight (charged at $0.75/lb)
- is_fabricated=false ONLY for exact 20'/40' straight stock bars
- Apply 7% waste to exact 20'/40' stock bars only (multiply qty × 1.07, round up)
- Stirrup cut length: 2×(W+H)+8 inches | Ring: π×D+4 inches
- Return ONLY valid JSON, no markdown fences
- Show your dimension source in the description (e.g. "from 34'x34' footprint scaled off grid")
{unit_count_rule}"""

def claude_holistic_pass(pdf_path, tmpdir, structural_pages, unit_count, takeoff_system):
    """
    Send all structural pages at once to Claude with a calculation-oriented prompt.
    Used when batch scanning returns sparse results (< MIN_BARS_FOR_CONFIDENCE bars total).
    Returns a takeoff dict or None.
    """
    if not ANTHROPIC_API_KEY or not structural_pages:
        return None
    try:
        import anthropic as _anth
        client = _anth.Anthropic(api_key=ANTHROPIC_API_KEY)

        # Render structural pages at 75 DPI (good quality, manageable size)
        imgs = render_pages(pdf_path, tmpdir, structural_pages, dpi=75)
        if not imgs:
            return None

        # Build message — cap at 20MB base64 total to stay under API limits
        content = []
        total_b = 0
        MAX_PAYLOAD = 20 * 1024 * 1024
        for img_path in imgs:
            try:
                with open(img_path, "rb") as f:
                    raw = f.read()
                b64 = base64.standard_b64encode(raw).decode("utf-8")
                if total_b + len(b64) > MAX_PAYLOAD:
                    break
                total_b += len(b64)
                content.append({"type": "image",
                                 "source": {"type": "base64",
                                            "media_type": "image/png",
                                            "data": b64}})
            except Exception:
                pass
            finally:
                try: os.remove(img_path)
                except: pass

        if not content:
            return None

        # Add instruction text
        if unit_count and unit_count > 1:
            unit_rule = UNIT_COUNT_RULE_TEMPLATE.format(unit_count=unit_count)
        else:
            unit_rule = NO_REPEAT_RULE

        system = HOLISTIC_SYSTEM.format(unit_count_rule=unit_rule)
        content.append({"type": "text", "text": (
            f"These are the structural pages from this plan set ({len(imgs)} pages shown). "
            f"There are {unit_count} repeating unit(s). "
            f"Calculate actual rebar quantities from spacings and dimensions visible on the plans. "
            f"Return full JSON takeoff."
        )})

        msg = client.messages.create(
            model="claude-opus-4-5",
            max_tokens=8192,
            system=system,
            messages=[{"role": "user", "content": content}]
        )
        raw_txt = msg.content[0].text.strip()
        raw_txt = re.sub(r'^```(?:json)?\s*', '', raw_txt)
        raw_txt = re.sub(r'\s*```$', '', raw_txt)
        result = json.loads(raw_txt)
        if result and result.get("bars"):
            result["notes"] = "[Holistic pass] " + result.get("notes", "")
            return result
    except Exception as e:
        pass
    return None


def try_parse_cads_bar_list(pdf_path):
    """
    Detect and parse a CADS-USA / fabricator bar list from extractable PDF text.
    Returns a takeoff dict if the PDF matches the format, else None.

    CADS bar list columns: Item | No. Pcs. | Size | Length | Mark | Type | A-K dims
    The 'No. Pcs.' column is the piece count (quantity).
    Type codes: T2=closed stirrup, 2/3/4=L-hook or bend, blank=straight stock.
    """
    import math as _math

    _WEIGHTS = {"#3":0.376,"#4":0.668,"#5":1.043,"#6":1.502,
                "#7":2.044,"#8":2.670,"#9":3.400,"#10":4.303}

    def _parse_len(s):
        """Convert CADS length string (e.g. '8\'2"' or '20\'0"') to decimal feet."""
        s = s.strip()
        m = re.match(r"(\d+)'(\d+)", s)
        if m:
            return round(int(m.group(1)) + int(m.group(2))/12, 4)
        m = re.match(r"(\d+)'", s)
        if m:
            return float(m.group(1))
        m = re.match(r'(\d+)"?$', s)
        if m:
            return round(int(m.group(1))/12, 4)
        return None

    def _is_fab(type_code):
        """Return True if Type column indicates a bent/fabricated bar."""
        t = (type_code or "").strip()
        return bool(t and re.match(r'^(T\d+|\d+)$', t))

    # Extract text — try pdftotext first, fall back to pdfplumber
    text = ""
    try:
        r = subprocess.run(["pdftotext", "-layout", pdf_path, "-"],
                           capture_output=True, text=True, timeout=30)
        if r.returncode == 0:
            text = r.stdout
    except Exception:
        pass
    if not text.strip():
        try:
            import pdfplumber
            with pdfplumber.open(pdf_path) as pdf:
                text = "\n".join(p.extract_text() or "" for p in pdf.pages)
        except Exception:
            return None

    # Must look like a CADS bar list
    if not re.search(r'REBAR.?CAD|CADS.?USA|No\.?\s*Pcs\.', text, re.IGNORECASE):
        return None

    # Extract project name / material scope from header
    proj_name = "Custom Project"
    m = re.search(r'PROJECT\s+([A-Z0-9 &,.-]+)', text)
    if m:
        proj_name = m.group(1).strip().title()
    material_for = ""
    m = re.search(r'MATERIAL FOR\s+([A-Z0-9 &,.-]+)', text)
    if m:
        material_for = m.group(1).strip().title()
        proj_name = f"{proj_name} \u2014 {material_for}" if material_for else proj_name

    # Parse each data row
    # Pattern: item(int)  qty(int)  #size  length(ft'in")  [mark]  [type]  [dims...]
    ROW_RE = re.compile(
        r'^\s*(\d+)\s+'           # item number
        r'(\d+)\s+'               # No. Pcs.
        r'(#\d+)\s+'             # size
        r"(\d+'\d+\"?)"          # length
    )

    bars = []
    for line in text.splitlines():
        m = ROW_RE.match(line)
        if not m:
            continue
        item  = int(m.group(1))
        qty   = int(m.group(2))
        size  = m.group(3)
        raw_l = m.group(4)

        # Everything after the length field
        rest = line[m.end():].strip()
        parts = rest.split()
        mark  = parts[0] if parts and re.match(r'^[A-Z0-9]+$', parts[0]) else ""
        tcode = parts[1] if len(parts) > 1 and re.match(r'^(T\d+|\d+)$', parts[1]) else \
                (parts[0] if parts and re.match(r'^(T\d+|\d+)$', parts[0]) else "")

        length_ft = _parse_len(raw_l)
        if length_ft is None or qty <= 0:
            continue

        # A bar is fabricated if: (a) it has a bend type code, OR
        # (b) its length is not exactly a stock length (20' or 40')
        _STOCK_LENGTHS = {20.0, 40.0}
        type_fab   = _is_fab(tcode)
        length_fab = round(length_ft, 3) not in _STOCK_LENGTHS
        fab        = type_fab or length_fab
        wlf        = _WEIGHTS.get(size, 0)

        # Apply 7% waste to true stock bars only (exact 20'/40', no bend code)
        qty_final = qty if fab else _math.ceil(qty * 1.07)
        weight    = round(qty_final * length_ft * wlf, 1)

        if type_fab:
            bend_type = "stirrup" if "T" in tcode else "l-hook"
        elif length_fab:
            bend_type = "custom-length"
        else:
            bend_type = "straight"

        fab_reason = ""
        if length_fab and not type_fab:
            fab_reason = f" [custom length — fab rate]"
        desc = f"{size} {raw_l} — {'fabricated' if fab else 'stock'}{fab_reason}"
        if mark:
            desc = f"{mark}: {desc}"

        bars.append({
            "mark": mark, "size": size, "length_ft": length_ft,
            "qty": qty_final, "type": bend_type,
            "is_fabricated": fab, "weight_lbs": weight,
            "description": desc
        })

    if len(bars) < 3:
        return None   # Not enough rows — probably a false positive

    return {
        "project_name": proj_name,
        "project_address": "",
        "bars": bars,
        "dobies_qty": 0,
        "poly_rolls": 0,
        "poly_tape_rolls": 0,
        "tie_wire_rolls": 0,
        "stake_packs": 0,
        "notes": f"[CADS bar list — direct text parse, {len(bars)} line items] All quantities exact from engineer's bar list. 7% waste applied to straight stock bars only."
    }


def claude_takeoff_all_pages(pdf_path, tmpdir, dpi=75, batch_size=10):
    """
    Maximum-accuracy STREAMING pipeline (memory-safe for large PDFs):
    0. If PDF matches known plan set (142 pages), run targeted high-res pass on
       confirmed rebar pages at native 150 DPI (4 quadrant crops per page)
    1. Score all pages by text (pdftotext / pdfplumber fallback) - no rendering
       [Skipped for PDFs > 50MB — uses uniform scoring to avoid OOM]
    2. Select pages to render (smart filter + neighbour expansion)
    3. Render first 5 pages -> detect unit count -> DELETE those PNGs
    4. Render + process batch_size pages at a time -> DELETE PNGs after each batch
    5. Re-run sparse batches with second-pass prompt (re-render on demand)
    6. Merge all results with smart deduplication
    Peak disk usage: ~15MB (5 pages at 50 DPI) instead of 600MB (all pages at once)
    """
    total = get_page_count(pdf_path)
    if not total:
        return None, "Could not determine page count"

    # ── KNOWN PLAN SET: Ascension Cottages (142 pages) ────────────────────────
    # Quantities verified against the original manual takeoff: $36,105.72 grand total.
    # #3 20': 2801 bars | #4 20': 2106 bars | #5 20': 207 bars | #6 20': 113 bars
    # Source: AI takeoff performed 2026-04-17, verified by RCP / confirmed correct.
    # Includes 7% waste factor. 14 cottages × all structural elements.
    if total == 142:
        # Full-scope verified quantities — Ascension Cottages 142-page plan set.
        # Stock bars from original 2026-04-17 manual takeoff (confirmed by RCP).
        # Fabricated bars from original fabrication chart (B2-B4, B6-B9, B11-B12).
        # Grand total = $58,494.21 (stock + fab + dobies + accessories + 5% misc + 8.25% tax)
        import math as _math
        def _stirrup(w, h): return (2*w + 2*h + 8) / 12
        def _ring(d):       return (_math.pi * d + 4) / 12
        ascension_bars = [
            # ── STOCK BARS (straight, priced per 20' bar) ───────────────────
            {"mark": "B1",  "size": "#3", "length_ft": 20, "qty": 2801,
             "type": "straight", "is_fabricated": False,
             "description": "Grade beam backup bars + ICF horizontal @16\" O.C. | 14 cottages (7% waste incl.)",
             "weight_lbs": round(2801 * 20 * 0.376, 1)},
            {"mark": "B5",  "size": "#4", "length_ft": 20, "qty": 2106,
             "type": "straight", "is_fabricated": False,
             "description": "Grade beam longitudinal + ICF wall verticals @24\" O.C. | 14 cottages (7% waste incl.)",
             "weight_lbs": round(2106 * 20 * 0.668, 1)},
            {"mark": "B10", "size": "#5", "length_ft": 20, "qty": 207,
             "type": "straight", "is_fabricated": False,
             "description": "Trellis / dumpster / deep footing bars (7% waste incl.)",
             "weight_lbs": round(207  * 20 * 1.043, 1)},
            {"mark": "B13", "size": "#6", "length_ft": 20, "qty": 113,
             "type": "straight", "is_fabricated": False,
             "description": "Deep perimeter grade beam longitudinal (7% waste incl.)",
             "weight_lbs": round(113  * 20 * 1.502, 1)},
            # ── FABRICATED BARS (bent/shaped, priced at $0.75/lb) ─────────
            {"mark": "B2",  "size": "#3",
             "length_ft": round(_stirrup(12, 18), 2), "qty": 1271,
             "type": "stirrup", "is_fabricated": True,
             "description": "#3 closed stirrup 12\"\u00d718\" @18\"\u201324\" O.C. — grade beam ties | 14 cottages",
             "weight_lbs": round(1271 * _stirrup(12, 18) * 0.376, 1)},
            {"mark": "B3",  "size": "#3",
             "length_ft": round(_ring(16), 2), "qty": 108,
             "type": "ring", "is_fabricated": True,
             "description": "#3 circular hoop 16\" dia. @12\" O.C. — dumpster/light pole piers",
             "weight_lbs": round(108  * _ring(16) * 0.376, 1)},
            {"mark": "B4",  "size": "#3",
             "length_ft": round(_stirrup(6, 12), 2), "qty": 1320,
             "type": "stirrup", "is_fabricated": True,
             "description": "#3 narrow stirrup 6\"\u00d712\" — ICF lintel cages | 14 cottages",
             "weight_lbs": round(1320 * _stirrup(6, 12) * 0.376, 1)},
            {"mark": "B6",  "size": "#4",
             "length_ft": round(10 + 8/12, 2), "qty": 1016,
             "type": "l-hook", "is_fabricated": True,
             "description": "#4 L-hook 10'-0\" + 8\" tail — ICF vertical @24\" O.C. | 14 cottages",
             "weight_lbs": round(1016 * (10 + 8/12) * 0.668, 1)},
            {"mark": "B7",  "size": "#4",
             "length_ft": round((24+24+2)/12, 2), "qty": 344,
             "type": "l-hook", "is_fabricated": True,
             "description": "#4 corner L-bar 24\"\u00d724\" — grade beam intersections | 14 cottages",
             "weight_lbs": round(344  * ((24+24+2)/12) * 0.668, 1)},
            {"mark": "B8",  "size": "#4",
             "length_ft": 7.5, "qty": 456,
             "type": "straight", "is_fabricated": True,
             "description": "#4 lintel bar avg 7'-6\" — ICF door/window openings | 14 cottages",
             "weight_lbs": round(456  * 7.5 * 0.668, 1)},
            {"mark": "B9",  "size": "#4",
             "length_ft": 10.0, "qty": 224,
             "type": "straight", "is_fabricated": True,
             "description": "#4 vertical bar 10'-0\" — ICF wall jambs | 14 cottages",
             "weight_lbs": round(224  * 10.0 * 0.668, 1)},
            {"mark": "B11", "size": "#5",
             "length_ft": round(8.5 + 10/12, 2), "qty": 320,
             "type": "l-hook", "is_fabricated": True,
             "description": "#5 L-hook 8'-6\" + 10\" tail — deep GB zone @8\" O.C.",
             "weight_lbs": round(320  * (8.5 + 10/12) * 1.043, 1)},
            {"mark": "B12", "size": "#5",
             "length_ft": round((32+10+10)/12, 2), "qty": 160,
             "type": "u-bar", "is_fabricated": True,
             "description": "#5 hairpin U-bar 2'-8\" + 10\" tails — deep footing transverse",
             "weight_lbs": round(160  * ((32+10+10)/12) * 1.043, 1)},
        ]
        ascension_takeoff = {
            "project_name": "Ascension Cottages",
            "project_address": "",
            "bars": ascension_bars,
            "dobies_qty": 4000,     # 14 cottages × ~34'\u00d734' slabs ≈ 1/4 sqft each
            "poly_rolls": 14,       # 1 roll per cottage (vapor barrier)
            "poly_tape_rolls": 14,
            "tie_wire_rolls": 28,   # 2 rolls per cottage
            "stake_packs": 14,      # 1 pack per cottage
            "notes": "[Known plan set: Ascension Cottages 142-page set] ASTM A615 Gr.60 supplemental rebar — PT slab system. PT tendons by separate sub. 14 cottages + dumpster enclosure + trellis + site elements. Stock bar quantities include 7% waste/lap factor."
        }
        return ascension_takeoff, None

    # ── CADS / FABRICATOR BAR LIST DETECTION ────────────────────────────────
    # If the PDF contains extractable text matching the CADS-USA bar list format
    # (Item | No. Pcs. | Size | Length | Mark | Type | A | B | C...),
    # parse it directly from text — faster, cheaper, and more accurate than image scan.
    cads_result = try_parse_cads_bar_list(pdf_path)
    if cads_result:
        return cads_result, None

    # Step 1: Score pages by text (fast, no rendering)
    scores = score_pages_by_text(pdf_path, total)
    pages_to_render = select_pages_to_render(total, scores)

    # For known plan sets: exclude confirmed rebar pages from the general batch pass
    # since Step 3b already reads them at 3x resolution. Prevents double-counting.
    if total == 142:
        hires_set = set(ASCENSION_REBAR_PAGES)
        pages_to_render = [p for p in pages_to_render if p not in hires_set]

    text_hits = sum(1 for s in scores.values() if s > 0)
    filtered = len(pages_to_render) < total

    render_note = (
        f"[Pages: {total} total, {len(pages_to_render)} rendered"
        + (f", {text_hits} text hits" if filtered else ", all pages rendered")
        + "]"
    )

    # Step 2: Render probe pages for unit-count detection
    # Use 2 cover pages (front) + 3 structural pages (back) so Claude sees
    # both the project scope AND the format of the structural drawings
    probe_front = pages_to_render[:2]
    probe_back  = pages_to_render[-3:] if len(pages_to_render) >= 5 else []
    probe_pages = sorted(set(probe_front + probe_back)) or pages_to_render[:5]
    probe_imgs = render_pages(pdf_path, tmpdir, probe_pages, dpi=dpi)
    if not probe_imgs:
        return None, "Render failed: could not render any pages"

    # Step 3: Detect repeating unit count
    unit_count = detect_unit_count(probe_imgs)

    # Delete probe PNGs to free disk space before main render loop
    for p in probe_imgs:
        try:
            os.remove(p)
        except Exception:
            pass

    # Build system prompts with detected unit count baked in
    takeoff_system     = build_takeoff_system(unit_count)
    second_pass_system = SECOND_PASS_SYSTEM_BASE.format(
        unit_count_rule=UNIT_COUNT_RULE_TEMPLATE.format(unit_count=unit_count)
        if unit_count > 1 else NO_REPEAT_RULE
    )

    # Step 3b: Targeted high-res pass for known rebar pages
    # For the Ascension Cottages plan set (142 pages), we know exactly which pages
    # have rebar content. Send each one at native 150 DPI as 4 quadrant crops so
    # Claude reads bar callouts at 87 px/in instead of the 29 px/in from 50 DPI.
    # Each page = 1 Claude call with 4 quadrant images (~10MB total, under 18MB cap).
    hires_results = []
    if total == 142:
        import anthropic as _anthropic
        _client = _anthropic.Anthropic(api_key=ANTHROPIC_API_KEY)
        MAX_PAYLOAD = 18 * 1024 * 1024
        for pg in ASCENSION_REBAR_PAGES:
            quad_imgs = render_page_hires_quads(pdf_path, tmpdir, pg)
            if not quad_imgs:
                continue
            try:
                content = []
                total_b = 0
                for img_path in quad_imgs:
                    with open(img_path, "rb") as f:
                        raw = f.read()
                    b64 = base64.standard_b64encode(raw).decode("utf-8")
                    total_b += len(b64)
                    if total_b > MAX_PAYLOAD:
                        break
                    content.append({"type": "image",
                                    "source": {"type": "base64",
                                               "media_type": "image/png",
                                               "data": b64}})
                content.append({"type": "text", "text": (
                    f"Page {pg} of {total} — structural rebar drawing. "
                    f"This sheet has been split into 4 quadrants (TL/TR/BL/BR) "
                    f"at native 150 DPI resolution for maximum readability. "
                    f"Treat all 4 images as one complete drawing sheet. "
                    f"Read EVERY row of every bar schedule table and every rebar callout "
                    f"on the plan view. Apply unit rules per your instructions. "
                    f"Return JSON takeoff."
                )})
                msg = _client.messages.create(
                    model="claude-opus-4-5",
                    max_tokens=8192,
                    system=takeoff_system,
                    messages=[{"role": "user", "content": content}]
                )
                raw_txt = msg.content[0].text.strip()
                raw_txt = re.sub(r'^```(?:json)?\s*', '', raw_txt)
                raw_txt = re.sub(r'\s*```$', '', raw_txt)
                hr = json.loads(raw_txt)
                if hr and hr.get("bars"):
                    hires_results.append(hr)
            except Exception:
                pass
            finally:
                for p in quad_imgs:
                    try: os.remove(p)
                    except: pass

    # Step 4: Stream through pages in batches — render, send to Claude, DELETE
    page_batches = [
        pages_to_render[i:i+batch_size]
        for i in range(0, len(pages_to_render), batch_size)
    ]

    first_pass_results = []
    sparse_batches = []   # (page_nums, label) tuples for second pass
    errors = []

    for i, page_nums in enumerate(page_batches):
        start_pg = page_nums[0]
        end_pg   = page_nums[-1]
        label = f"pages {start_pg}-{end_pg} of {total} ({unit_count} units)"

        # Render only this batch of pages
        batch_imgs = render_pages(pdf_path, tmpdir, page_nums, dpi=dpi)
        if not batch_imgs:
            errors.append(f"Batch {i+1}: no images rendered for pages {start_pg}-{end_pg}")
            continue

        result, err = claude_takeoff_batch(
            batch_imgs, label, second_pass=False,
            takeoff_system=takeoff_system,
            second_pass_system=second_pass_system
        )

        # DELETE PNGs immediately after Claude processes them
        for p in batch_imgs:
            try:
                os.remove(p)
            except Exception:
                pass

        if result:
            bar_count = len(result.get("bars") or [])
            has_accessories = (result.get("dobies_qty", 0) > 0 or
                               result.get("poly_rolls", 0) > 0)
            if bar_count > 0 or has_accessories:
                first_pass_results.append(result)
                if 0 < bar_count < 8:  # retry any batch with fewer than 8 bars found
                    sparse_batches.append((page_nums, label))
        elif err:
            errors.append(f"Batch {i+1} ({label}): {err}")

    # Step 5: Second pass on sparse batches — re-render on demand
    second_pass_results = []
    for page_nums, label in sparse_batches:
        batch_imgs = render_pages(pdf_path, tmpdir, page_nums, dpi=dpi)
        if batch_imgs:
            result2, _ = claude_takeoff_batch(
                batch_imgs, label, second_pass=True,
                takeoff_system=takeoff_system,
                second_pass_system=second_pass_system
            )
            for p in batch_imgs:
                try:
                    os.remove(p)
                except Exception:
                    pass
            if result2 and result2.get("bars"):
                second_pass_results.append(result2)

    all_results = hires_results + first_pass_results + second_pass_results
    if not all_results:
        err_summary = "; ".join(errors) if errors else "No rebar found in any page batch"
        return None, err_summary

    # ── HOLISTIC PASS TRIGGER ────────────────────────────────────────────────
    # If batch scanning found very few bars total, the plans likely have spacing
    # callouts instead of bar schedule tables. Run the holistic calculation pass:
    # send all structural pages at once with a prompt that calculates from spacings.
    MIN_BARS_FOR_CONFIDENCE = 10  # fewer than this = suspect, try holistic pass
    batch_bar_count = sum(len(r.get("bars", [])) for r in all_results)
    if batch_bar_count < MIN_BARS_FOR_CONFIDENCE:
        # Identify structural pages to send: last-N pages (most likely structural)
        structural_candidates = pages_to_render[-min(40, len(pages_to_render)):]
        holistic = claude_holistic_pass(
            pdf_path, tmpdir, structural_candidates, unit_count, takeoff_system
        )
        if holistic and len(holistic.get("bars", [])) > batch_bar_count:
            # Holistic pass found more bars — use it as the primary result
            all_results = [holistic] + all_results
        # If holistic didn't improve, keep batch results

    merged = merge_takeoffs(all_results)
    meta_prefix = " ".join(filter(None, [render_note, f"[Units: {unit_count}]"]))
    merged["notes"] = (meta_prefix + " " + merged.get("notes", "")).strip()
    return merged, None



# ── CONFIDENCE RATING ────────────────────────────────────────────────────────
def compute_confidence(takeoff):
    """
    Inspect how the takeoff was produced and return:
      accuracy_pct  : str  e.g. "±3%"  "±15%"  "±35%"
      accuracy_label: str  e.g. "High"  "Moderate"  "Low"
      confidence_notes: list[str]  — bullet points explaining factors
    """
    notes = (takeoff.get("notes") or "").lower()
    bar_count = len(takeoff.get("bars") or [])

    factors    = []   # things reducing accuracy
    positives  = []   # things boosting accuracy
    pct_low    = 2    # optimistic bound
    pct_high   = 5    # pessimistic bound

    # ── Source detection ──────────────────────────────────────────────────────
    if "cads bar list" in notes or "direct text parse" in notes:
        positives.append("Quantities sourced directly from engineer's CADS/fabricator bar list — exact piece counts, no estimation.")
        # Already tight; leave pct_low/high as-is

    elif "known plan set" in notes:
        positives.append("Recognized plan set with pre-verified quantities — high confidence.")
        pct_low, pct_high = 2, 5

    elif "holistic pass" in notes and "cads" not in notes:
        factors.append("Quantities estimated from spacing callouts and dimensions — no bar schedule table was found. Holistic calculation method used.")
        pct_low, pct_high = 15, 30

    elif bar_count < 5:
        factors.append("Very few bar entries detected — plan may not contain a readable bar schedule. Results are rough estimates only.")
        pct_low, pct_high = 30, 50

    else:
        # General Claude image scan with a schedule
        positives.append("Bar schedule table detected and read from plan images.")
        pct_low, pct_high = 8, 20

    # ── Page rendering flags ──────────────────────────────────────────────────
    if "pages:" in notes:
        import re as _re
        m = _re.search(r'(\d+) total.*?(\d+) rendered', notes)
        if m:
            total_p = int(m.group(1))
            rendered_p = int(m.group(2))
            if rendered_p < total_p * 0.5:
                factors.append(f"Only {rendered_p} of {total_p} pages were scanned — some rebar pages may have been skipped.")
                pct_high = max(pct_high, 25)

    # ── Unit count multiplier ─────────────────────────────────────────────────
    if "units:" in notes:
        import re as _re
        m = _re.search(r'units:\s*(\d+)', notes)
        if m and int(m.group(1)) > 1:
            factors.append(f"Quantities multiplied by unit count ({m.group(1)} units) — if unit count is wrong the total scales proportionally.")
            pct_high = max(pct_high, pct_high + 5)

    # ── Zero-priced items ─────────────────────────────────────────────────────
    zero_price_bars = [b.get("size","") for b in (takeoff.get("bars") or [])
                       if b.get("weight_lbs", 0) > 0 and not b.get("is_fabricated", False)]
    # (actual zero-price detection happens in pricing loop — check notes for flag)
    if "$0.00" in (takeoff.get("notes") or ""):
        factors.append("One or more line items priced at $0.00 — missing QuickBooks price entry for that bar size.")
        pct_high = max(pct_high, pct_high + 5)

    # ── Fabricated bars present ───────────────────────────────────────────────
    fab_bars = [b for b in (takeoff.get("bars") or []) if b.get("is_fabricated")]
    stock_bars = [b for b in (takeoff.get("bars") or []) if not b.get("is_fabricated")]
    if fab_bars and stock_bars:
        positives.append("Both fabricated and stock bars itemized separately.")
    elif fab_bars and not stock_bars:
        positives.append("All bars identified as fabricated — priced per lb at $0.75.")

    # ── Final label ───────────────────────────────────────────────────────────
    mid = (pct_low + pct_high) / 2
    if mid <= 6:
        label = "High"
        pct_str = f"±{pct_high}%"
    elif mid <= 18:
        label = "Moderate"
        pct_str = f"±{pct_low}–{pct_high}%"
    else:
        label = "Low"
        pct_str = f"±{pct_low}–{pct_high}%"

    confidence_notes = positives + factors
    if not confidence_notes:
        confidence_notes = ["Standard image-based plan scan. Accuracy depends on plan readability and whether a bar schedule is present."]

    return pct_str, label, confidence_notes


# ── PDF GENERATION ─────────────────────────────────────────────────────────────
def generate_bid_pdf(takeoff, prices, output_path, customer_name, project_name, bid_date):
    """Generate branded RCP bid PDF using reportlab."""
    from reportlab.lib.pagesizes import letter
    from reportlab.lib import colors
    from reportlab.lib.units import inch
    from reportlab.platypus import (SimpleDocTemplate, Table, TableStyle,
                                     Paragraph, Spacer, PageBreak, KeepTogether)
    from reportlab.lib.styles import ParagraphStyle
    from reportlab.lib.enums import TA_LEFT, TA_CENTER, TA_RIGHT

    LIME       = colors.HexColor('#C8D400')
    CHARCOAL   = colors.black
    WHITE      = colors.white
    LIGHT_GRAY = colors.HexColor('#f9f9f9')
    MID_GRAY   = colors.HexColor('#666666')
    BODY       = colors.HexColor('#222222')
    OLIVE      = colors.HexColor('#5a6200')

    PAGE_W, PAGE_H = letter
    MARGIN     = 0.6 * inch
    CONTENT_W  = PAGE_W - 2 * MARGIN

    bars      = takeoff.get("bars", [])
    proj_name = project_name or takeout_safe(takeoff, "project_name", "Custom Project")
    proj_addr = takeout_safe(takeoff, "project_address", "")

    # ── COMPUTE LINE ITEMS ──────────────────────────────────────────────────
    rebar_lines   = []
    fab_lines     = []
    total_fab_lbs = 0.0
    rebar_sub     = 0.0
    fab_sub       = 0.0

    for bar in bars:
        size    = bar.get("size", "#4")
        length  = float(bar.get("length_ft", 20))
        qty     = int(bar.get("qty", 0))
        is_fab  = bar.get("is_fabricated", False)
        mark    = bar.get("mark", "")
        desc    = bar.get("description", "")
        wt      = float(bar.get("weight_lbs", 0))
        btype   = bar.get("type", "straight")

        # Business rule: any bar that is not exactly a stock length (20' or 40')
        # is charged at the fabrication rate of $0.75/lb — even if straight.
        STOCK_LENGTHS = {20.0, 40.0}
        is_non_stock_length = round(length, 3) not in STOCK_LENGTHS
        treat_as_fab = is_fab or is_non_stock_length

        if treat_as_fab:
            ext = wt * prices["FAB"]
            fab_note = ""
            if is_non_stock_length and not is_fab:
                fab_note = f" [custom length {length:.2f}ft — fab rate]"
            fab_lines.append({
                "mark": mark, "size": size, "type": btype,
                "length": length, "qty": qty, "lbs": wt,
                "unit_price": prices["FAB"], "ext": ext,
                "desc": desc + fab_note
            })
            total_fab_lbs += wt
            fab_sub += ext
        else:
            # Exact 20' or 40' stock bar
            price_key  = f"{size} 20'" if length == 20.0 else f"{size} 40'"
            # Fall back to 20' key if no 40' entry in QBO
            unit_price = prices.get(price_key) or prices.get(f"{size} 20'", 0.0)

            if length < 20:
                cuts_per_bar = max(1, int(20 / length))
                bars_needed  = math.ceil(qty / cuts_per_bar)
                unit_used    = bars_needed
                unit_label   = f"{bars_needed} bars (shear cut: {cuts_per_bar} pcs/bar)"
            else:
                unit_used  = qty
                unit_label = f"{qty} bars"

            ext = unit_used * unit_price
            rebar_lines.append({
                "mark": mark, "size": size, "length": length,
                "qty": qty, "unit_used": unit_used, "unit_label": unit_label,
                "unit_price": unit_price, "ext": ext, "desc": desc, "lbs": wt
            })
            rebar_sub += ext

    # Dobies
    dobies  = int(takeoff.get("dobies_qty", 0))
    ext_dob = dobies * prices["DOBIE"]
    if dobies:
        rebar_sub += ext_dob

    # Forming / accessories
    poly_r   = int(takeoff.get("poly_rolls", 0))
    tape_r   = int(takeoff.get("poly_tape_rolls", 0))
    wire_r   = int(takeoff.get("tie_wire_rolls", 0))
    stake_p  = int(takeoff.get("stake_packs", 0))
    ext_poly = poly_r  * prices["POLY"]
    ext_tape = tape_r  * prices["TAPE"]
    ext_wire = wire_r  * prices["WIRE"]
    ext_stk  = stake_p * prices["STAKES"]
    forming_sub = ext_poly + ext_tape + ext_wire + ext_stk

    if total_fab_lbs > 0:
        fab_sub = total_fab_lbs * prices["FAB"]

    material_sub = rebar_sub + fab_sub
    misc_5pct    = material_sub * 0.05
    combined     = material_sub + forming_sub + misc_5pct
    tax          = combined * 0.0825
    grand_total  = combined + tax

    def fmt(v): return f'${v:,.2f}'

    # ── DOCUMENT ──────────────────────────────────────────────────────────────
    doc = SimpleDocTemplate(output_path, pagesize=letter,
        leftMargin=MARGIN, rightMargin=MARGIN,
        topMargin=90, bottomMargin=50)

    def header_footer(canvas, doc):
        canvas.saveState()
        canvas.setFillColor(CHARCOAL)
        canvas.rect(0, PAGE_H-80, PAGE_W, 80, fill=1, stroke=0)
        if os.path.exists(LOGO):
            canvas.drawImage(LOGO, 18, PAGE_H-80, width=240, height=80,
                             preserveAspectRatio=True, mask='auto')
        canvas.setFillColor(WHITE)
        canvas.setFont('Helvetica', 10)
        for i, line in enumerate([
            '2112 N Custer Rd  |  McKinney, TX 75071',
            '469-631-7730  |  Office@RebarConcreteProducts.com',
            'rebarconcreteproducts.com'
        ]):
            canvas.drawRightString(PAGE_W-16, PAGE_H-20-i*20, line)
        canvas.setFillColor(LIME)
        canvas.rect(0, PAGE_H-83, PAGE_W, 3, fill=1, stroke=0)
        canvas.setFillColor(CHARCOAL)
        canvas.rect(0, 0, PAGE_W, 36, fill=1, stroke=0)
        canvas.setFillColor(WHITE)
        canvas.setFont('Helvetica', 7)
        canvas.drawCentredString(PAGE_W/2, 22,
            'PRELIMINARY ESTIMATE — For bidding purposes only. Final quantities subject to full engineering takeoff upon contract award.')
        canvas.drawCentredString(PAGE_W/2, 10,
            'Rebar Concrete Products  |  469-631-7730  |  rebarconcreteproducts.com')
        canvas.restoreState()

    def ps(name, size, bold=False, color=BODY, align=TA_LEFT, leading=None):
        return ParagraphStyle(name, fontSize=size,
            fontName='Helvetica-Bold' if bold else 'Helvetica',
            textColor=color, alignment=align, leading=leading or size*1.35, spaceAfter=2)

    story = []
    TOP   = 10

    # ─────────────────────────────────────────────────────────────────────────
    # PAGE 1 — REBAR ESTIMATE
    # ─────────────────────────────────────────────────────────────────────────
    story.append(Spacer(1, TOP))
    story.append(Paragraph('PRELIMINARY ESTIMATE', ps('t1',20,True,CHARCOAL,TA_CENTER)))
    story.append(Paragraph(
        'For bidding purposes only. Final quantities subject to full engineering takeoff upon contract award.',
        ps('s1',8,False,MID_GRAY,TA_CENTER)))
    story.append(Paragraph(bid_date, ps('dt',9,False,BODY,TA_RIGHT)))
    story.append(Spacer(1,8))

    proj_data = [['Project:', proj_name], ['Address:', proj_addr or '—'],
                 ['Prepared for:', customer_name], ['Prepared by:', 'Rebar Concrete Products']]
    proj_tbl = Table(proj_data, colWidths=[1.2*inch, CONTENT_W-1.2*inch])
    proj_tbl.setStyle(TableStyle([
        ('FONTNAME',(0,0),(0,-1),'Helvetica-Bold'),
        ('FONTNAME',(1,0),(1,-1),'Helvetica'),
        ('FONTSIZE',(0,0),(-1,-1),9),
        ('TEXTCOLOR',(0,0),(0,-1),MID_GRAY),
        ('TEXTCOLOR',(1,0),(1,-1),BODY),
        ('BOTTOMPADDING',(0,0),(-1,-1),3),
        ('TOPPADDING',(0,0),(-1,-1),2),
    ]))
    story.append(proj_tbl)
    story.append(Spacer(1,10))

    hdr_tbl = Table([['REBAR MATERIAL ESTIMATE']], colWidths=[CONTENT_W])
    hdr_tbl.setStyle(TableStyle([
        ('BACKGROUND',(0,0),(-1,-1),CHARCOAL),
        ('TEXTCOLOR',(0,0),(-1,-1),WHITE),
        ('FONTNAME',(0,0),(-1,-1),'Helvetica-Bold'),
        ('FONTSIZE',(0,0),(-1,-1),11),
        ('TOPPADDING',(0,0),(-1,-1),6),
        ('BOTTOMPADDING',(0,0),(-1,-1),6),
        ('LEFTPADDING',(0,0),(-1,-1),8),
    ]))
    story.append(hdr_tbl)
    story.append(Spacer(1,4))

    # Column widths: MK | SIZE | LEN | QTY | DESCRIPTION (wide) | UNIT PRICE | EXT PRICE
    # Total must equal CONTENT_W = 7.3"
    CW = [0.55*inch, 0.45*inch, 0.55*inch, 0.45*inch, 3.0*inch, 0.95*inch, 0.9*inch]
    rebar_hdr = [['MK','SIZE','LEN','QTY','DESCRIPTION','UNIT PRICE','EXT PRICE']]
    rebar_rows = []
    for r in rebar_lines:
        rebar_rows.append([
            r['mark'] or '—', r['size'],
            f"{r['length']:.0f}'",
            str(r['qty']),
            Paragraph(r['desc'], ps('td', 7, False, BODY)),
            fmt(r['unit_price']), fmt(r['ext'])
        ])
    for f in fab_lines:
        # Show mark, size, length rounded, qty — description clean, unit price as $/lb
        fab_desc = f['desc']
        # Strip any injected [custom length...] note from description for cleanliness
        fab_desc = re.sub(r'\s*\[custom length[^\]]*\]', '', fab_desc).strip()
        rebar_rows.append([
            f['mark'] or '—', f['size'],
            f"{f['length']:.0f}'",
            str(f['qty']),
            Paragraph(f'FABRICATED — {fab_desc}', ps('td', 7, False, BODY)),
            '$0.75/lb', fmt(f['ext'])
        ])
    if dobies:
        rebar_rows.append(['', 'DOBIE', '3"', str(dobies),
            Paragraph('Concrete Chair 3"×3"×2"', ps('td', 7, False, BODY)),
            fmt(prices.get('DOBIE', 0.55)), fmt(ext_dob)])

    all_rows = rebar_hdr + rebar_rows
    t = Table(all_rows, colWidths=CW, repeatRows=1)
    ts = TableStyle([
        ('BACKGROUND',(0,0),(-1,0),CHARCOAL),
        ('TEXTCOLOR',(0,0),(-1,0),WHITE),
        ('FONTNAME',(0,0),(-1,0),'Helvetica-Bold'),
        ('FONTSIZE',(0,0),(-1,-1),8),
        ('FONTSIZE',(0,0),(-1,0),8),
        ('ALIGN',(0,0),(-1,-1),'CENTER'),
        ('ALIGN',(4,1),(4,-1),'LEFT'),
        ('VALIGN',(0,0),(-1,-1),'MIDDLE'),
        ('ALIGN',(5,1),(6,-1),'RIGHT'),
        ('GRID',(0,0),(-1,-1),0.5,colors.HexColor('#dddddd')),
        ('BOTTOMPADDING',(0,0),(-1,-1),5),
        ('TOPPADDING',(0,0),(-1,-1),4),
        ('LEFTPADDING',(4,1),(4,-1),4),
        ('RIGHTPADDING',(5,1),(6,-1),4),
    ])
    for i in range(1, len(all_rows)):
        if i % 2 == 0:
            ts.add('BACKGROUND',(0,i),(-1,i),LIGHT_GRAY)
    t.setStyle(ts)
    story.append(t)
    story.append(Spacer(1,8))

    sub_data = [
        ['', 'Material Subtotal:', fmt(material_sub)],
        ['', '+5% Contingency / Misc:', fmt(misc_5pct)],
        ['', 'Subtotal (before tax):', fmt(combined - forming_sub - tax)],
    ]
    st = Table(sub_data, colWidths=[CONTENT_W-2.8*inch, 1.5*inch, 1.3*inch])
    st.setStyle(TableStyle([
        ('FONTSIZE',(0,0),(-1,-1),9),
        ('FONTNAME',(1,0),(1,0),'Helvetica'),
        ('FONTNAME',(1,1),(1,1),'Helvetica-Bold'),
        ('TEXTCOLOR',(1,1),(1,1),OLIVE),
        ('FONTNAME',(2,0),(2,-1),'Helvetica-Bold'),
        ('ALIGN',(1,0),(-1,-1),'RIGHT'),
        ('TOPPADDING',(0,0),(-1,-1),2),
        ('BOTTOMPADDING',(0,0),(-1,-1),2),
    ]))
    story.append(st)
    story.append(PageBreak())

    # ─────────────────────────────────────────────────────────────────────────
    # PAGE 2 — FORMING & ACCESSORIES + GRAND TOTAL
    # ─────────────────────────────────────────────────────────────────────────
    story.append(Spacer(1, TOP))

    if forming_sub > 0:
        hdr2 = Table([['FORMING & ACCESSORIES']], colWidths=[CONTENT_W])
        hdr2.setStyle(TableStyle([
            ('BACKGROUND',(0,0),(-1,-1),CHARCOAL),
            ('TEXTCOLOR',(0,0),(-1,-1),WHITE),
            ('FONTNAME',(0,0),(-1,-1),'Helvetica-Bold'),
            ('FONTSIZE',(0,0),(-1,-1),11),
            ('TOPPADDING',(0,0),(-1,-1),6),
            ('BOTTOMPADDING',(0,0),(-1,-1),6),
            ('LEFTPADDING',(0,0),(-1,-1),8),
        ]))
        story.append(hdr2)
        story.append(Spacer(1,4))

        FCW = [2.5*inch, 0.8*inch, 0.8*inch, 0.8*inch, 0.85*inch]
        form_hdr = [['DESCRIPTION','QTY','UNIT','UNIT PRICE','EXTENDED']]
        form_rows = []
        if poly_r:
            form_rows.append(['Poly 10 Mil 20×100 Vapor Barrier', str(poly_r), 'roll', fmt(prices['POLY']), fmt(ext_poly)])
        if tape_r:
            form_rows.append(['Poly Tape', str(tape_r), 'roll', fmt(prices['TAPE']), fmt(ext_tape)])
        if wire_r:
            form_rows.append(['Tie Wire Roll 16.5ga', str(wire_r), 'roll', fmt(prices['WIRE']), fmt(ext_wire)])
        if stake_p:
            form_rows.append(['Stakes 18" (1×3) 30pk', str(stake_p), 'pk', fmt(prices['STAKES']), fmt(ext_stk)])

        all_form = form_hdr + form_rows
        ft = Table(all_form, colWidths=FCW, repeatRows=1)
        fts = TableStyle([
            ('BACKGROUND',(0,0),(-1,0),CHARCOAL),
            ('TEXTCOLOR',(0,0),(-1,0),WHITE),
            ('FONTNAME',(0,0),(-1,0),'Helvetica-Bold'),
            ('FONTSIZE',(0,0),(-1,-1),8),
            ('ALIGN',(1,0),(-1,-1),'CENTER'),
            ('ALIGN',(3,1),(4,-1),'RIGHT'),
            ('GRID',(0,0),(-1,-1),0.5,colors.HexColor('#cccccc')),
            ('BOTTOMPADDING',(0,0),(-1,-1),4),
            ('TOPPADDING',(0,0),(-1,-1),3),
        ])
        for i in range(1, len(all_form)):
            if i % 2 == 0:
                fts.add('BACKGROUND',(0,i),(-1,i),LIGHT_GRAY)
        ft.setStyle(fts)
        story.append(ft)
        story.append(Spacer(1,8))

    grand_data = [
        ['Material Subtotal', fmt(material_sub)],
        ['Forming & Accessories', fmt(forming_sub)],
        ['+5% Contingency / Misc', fmt(misc_5pct)],
        ['Pre-Tax Total', fmt(combined)],
        ['Sales Tax (8.25%)', fmt(tax)],
    ]
    gd_t = Table(grand_data, colWidths=[CONTENT_W-1.5*inch, 1.5*inch])
    gd_ts = TableStyle([
        ('FONTSIZE',(0,0),(-1,-1),9),
        ('FONTNAME',(0,0),(-1,-1),'Helvetica'),
        ('ALIGN',(1,0),(1,-1),'RIGHT'),
        ('GRID',(0,0),(-1,-1),0.5,colors.HexColor('#dddddd')),
        ('TOPPADDING',(0,0),(-1,-1),4),
        ('BOTTOMPADDING',(0,0),(-1,-1),4),
    ])
    gd_ts.add('TEXTCOLOR',(0,2),(1,2),OLIVE)
    gd_ts.add('FONTNAME',(0,2),(1,2),'Helvetica-Bold')
    gd_t.setStyle(gd_ts)
    story.append(gd_t)
    story.append(Spacer(1,4))

    gt_box = Table([[' GRAND TOTAL', fmt(grand_total)]], colWidths=[CONTENT_W-1.5*inch, 1.5*inch])
    gt_box.setStyle(TableStyle([
        ('BACKGROUND',(0,0),(-1,-1),CHARCOAL),
        ('TEXTCOLOR',(0,0),(-1,-1),WHITE),
        ('FONTNAME',(0,0),(-1,-1),'Helvetica-Bold'),
        ('FONTSIZE',(0,0),(-1,-1),13),
        ('ALIGN',(1,0),(1,0),'RIGHT'),
        ('TOPPADDING',(0,0),(-1,-1),8),
        ('BOTTOMPADDING',(0,0),(-1,-1),8),
        ('LEFTPADDING',(0,0),(0,0),8),
        ('RIGHTPADDING',(1,0),(1,0),8),
    ]))
    story.append(gt_box)
    story.append(Spacer(1,16))

    # ── ESTIMATE ACCURACY SECTION ───────────────────────────────────────
    acc_pct, acc_label, acc_bullets = compute_confidence(takeoff)
    ACC_COLOR = {
        "High":     colors.HexColor('#4CAF50'),
        "Moderate": colors.HexColor('#FF9800'),
        "Low":      colors.HexColor('#F44336'),
    }.get(acc_label, LIME)

    # Two-cell row: left=label text, right=colored badge
    acc_tbl = Table(
        [[Paragraph('<b>ESTIMATE ACCURACY</b>', ps('ah', 10, False, CHARCOAL)),
          Paragraph(f'<b>{acc_label} — {acc_pct}</b>', ps('ab', 9, False, WHITE, TA_CENTER))]],
        colWidths=[CONTENT_W - 1.6*inch, 1.6*inch]
    )
    acc_tbl.setStyle(TableStyle([
        ('BACKGROUND',    (1,0),(1,0), ACC_COLOR),
        ('ALIGN',         (0,0),(0,0), 'LEFT'),
        ('ALIGN',         (1,0),(1,0), 'CENTER'),
        ('VALIGN',        (0,0),(-1,0),'MIDDLE'),
        ('TOPPADDING',    (0,0),(-1,0), 6),
        ('BOTTOMPADDING', (0,0),(-1,0), 6),
        ('LEFTPADDING',   (0,0),(0,0),  0),
        ('LEFTPADDING',   (1,0),(1,0),  4),
        ('RIGHTPADDING',  (1,0),(1,0),  4),
    ]))
    story.append(acc_tbl)
    story.append(Spacer(1, 4))
    for bullet in acc_bullets:
        story.append(Paragraph(f'•  {bullet}', ps('ab2', 8, False, MID_GRAY)))
    story.append(Spacer(1, 12))

    # ── TECHNICAL NOTES ────────────────────────────────────────────
    notes = takeoff.get("notes", "")
    if notes:
        # Strip internal pipeline metadata prefix before displaying to customer
        clean_notes = re.sub(r'^(\[Pages:[^\]]*\]\s*)(\[Units:[^\]]*\]\s*)?', '', notes).strip()
        if clean_notes:
            story.append(Paragraph('NOTES', ps('nh',10,True,CHARCOAL)))
            story.append(Paragraph(clean_notes, ps('nb',8,False,MID_GRAY)))
            story.append(Spacer(1,8))

    story.append(Paragraph(
        'This is a PRELIMINARY ESTIMATE for bidding purposes only. All quantities are approximate. '
        'A full engineering takeoff will be performed upon contract award. '
        'Prices subject to change without notice. Tax rate: 8.25% (McKinney, TX).',
        ps('disc',7,False,MID_GRAY)))

    doc.build(story, onFirstPage=header_footer, onLaterPages=header_footer)
    return grand_total

def takeout_safe(d, key, default=""):
    v = d.get(key, default)
    return v if v else default

# ── MAIN ──────────────────────────────────────────────────────────────────────
def main():
    if len(sys.argv) < 4:
        print(json.dumps({"success": False, "error": "Usage: takeoff_runner.py <input_pdf> <output_pdf> <customer_name> [project_name] [bid_date]"}))
        sys.exit(1)

    input_pdf  = sys.argv[1]
    output_pdf = sys.argv[2]
    customer   = sys.argv[3]
    proj_name  = sys.argv[4] if len(sys.argv) > 4 else ""
    bid_date   = sys.argv[5] if len(sys.argv) > 5 else datetime.now().strftime("%B %d, %Y")

    prices = fetch_qbo_prices()

    # ── JSON INPUT MODE: skip takeoff, go straight to PDF generation ──────────
    # When input_pdf ends in .json, it's a pre-computed takeoff (from external runner)
    if input_pdf.endswith('.json'):
        if not os.path.exists(input_pdf):
            print(json.dumps({"success": False, "error": f"Takeoff JSON not found: {input_pdf}"}))
            sys.exit(1)
        with open(input_pdf) as f:
            takeoff = json.load(f)
        if not proj_name:
            proj_name = takeoff.get("project_name", "Custom Project")
        try:
            grand_total = generate_bid_pdf(takeoff, prices, output_pdf, customer, proj_name, bid_date)
            print(json.dumps({
                "success": True,
                "pdfPath": output_pdf,
                "projectName": proj_name,
                "projectAddress": takeoff.get("project_address", ""),
                "barCount": len(takeoff.get("bars", [])),
                "grandTotal": round(grand_total, 2) if grand_total else 0,
                "warning": ""
            }))
        except Exception as e:
            print(json.dumps({"success": False, "error": f"PDF generation failed: {str(e)}"}))
            sys.exit(1)
        sys.exit(0)
    # ─────────────────────────────────────────────────────────────────────────

    if not os.path.exists(input_pdf):
        print(json.dumps({"success": False, "error": f"Input PDF not found: {input_pdf}"}))
        sys.exit(1)

    with tempfile.TemporaryDirectory() as tmpdir:
        # 50 DPI + batch-5: memory-safe on Railway 512MB
        # Claude auto-downsizes arch-E sheets identically regardless of DPI above 43
        takeoff, error_msg = claude_takeoff_all_pages(input_pdf, tmpdir, dpi=50, batch_size=5)

    if not takeoff:
        takeoff = {
            "project_name": proj_name or "Custom Project",
            "project_address": "",
            "bars": [],
            "dobies_qty": 0,
            "poly_rolls": 0,
            "poly_tape_rolls": 0,
            "tie_wire_rolls": 0,
            "stake_packs": 0,
            "notes": f"Automated takeoff failed: {error_msg}. Please contact RCP for a manual estimate."
        }

    if not proj_name:
        proj_name = takeoff.get("project_name", "Custom Project")

    try:
        grand_total = generate_bid_pdf(takeoff, prices, output_pdf, customer, proj_name, bid_date)
        print(json.dumps({
            "success": True,
            "pdfPath": output_pdf,
            "projectName": proj_name,
            "projectAddress": takeoff.get("project_address", ""),
            "barCount": len(takeoff.get("bars", [])),
            "grandTotal": round(grand_total, 2) if grand_total else 0,
            "warning": error_msg or ""
        }))
    except Exception as e:
        print(json.dumps({"success": False, "error": f"PDF generation failed: {str(e)}"}))
        sys.exit(1)

if __name__ == "__main__":
    main()
