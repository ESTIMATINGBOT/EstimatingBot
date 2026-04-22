#!/usr/bin/env python3
"""
RCP Plan Takeoff + Bid PDF Generator
Called by Node backend as a subprocess:
  python3 takeoff_runner.py <pdf_path> <output_pdf_path> <customer_name> <project_name> <bid_date>

Outputs JSON to stdout: {"success": true, "pdfPath": "/tmp/bid_xxx.pdf", "summary": "..."}
or {"success": false, "error": "..."}

Flow:
  1. Render plan PDF pages to images (poppler pdftoppm)
  2. Send images to Claude for rebar takeoff
  3. Use live QBO pricing to build line items
  4. Generate branded 4-page RCP bid PDF via reportlab
  5. Print JSON result to stdout
"""
import sys, os, json, base64, re, math, subprocess, tempfile, urllib.request
from datetime import datetime

# ── CONFIG ────────────────────────────────────────────────────────────────────
ANTHROPIC_API_KEY = os.environ.get("ANTHROPIC_API_KEY", "")
QBO_ITEMS_URL     = "https://rcp-sms-bot-production.up.railway.app/api/qbo/items"
# Try multiple possible logo locations (dev vs production)
_script_dir = os.path.dirname(os.path.abspath(__file__))
_logo_candidates = [
    os.path.join(_script_dir, "..", "logoheader.jpg"),           # dev: server/../logoheader.jpg
    os.path.join(_script_dir, "..", "client", "public", "logoheader.jpg"),  # dev alt
    os.path.join(_script_dir, "public", "logoheader.jpg"),       # prod: dist/public/logoheader.jpg
    os.path.join(_script_dir, "..", "public", "logoheader.jpg"), # prod alt
]
LOGO = next((os.path.abspath(p) for p in _logo_candidates if os.path.exists(os.path.abspath(p))), "")

# Fallback hardcoded prices if QBO endpoint is unreachable
FALLBACK_PRICES = {
    "#3 20'":  4.28195,
    "#4 20'":  7.367,
    "#5 20'":  11.6146,
    "#6 20'":  16.397,
    "FAB":     0.75,       # NEVER CHANGE
    "DOBIE":   0.55,
    "POLY":    95.50,
    "TAPE":    27.25,
    "WIRE":    4.99,
    "STAKES":  24.90,
}

# ── QBO PRICING ───────────────────────────────────────────────────────────────
def fetch_qbo_prices():
    try:
        req = urllib.request.urlopen(QBO_ITEMS_URL, timeout=8)
        items = json.loads(req.read().decode())
        prices = dict(FALLBACK_PRICES)
        for item in items:
            name = item.get("Name", "")
            price = float(item.get("UnitPrice", 0) or 0)
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
            elif "fabrication" in nl or "fabrication-1" in nl:
                pass  # NEVER update FAB from QBO — always $0.75
            elif "dobie" in nl or "concrete chair" in nl:
                prices["DOBIE"] = price
            elif "poly 10 mil" in nl:
                prices["POLY"] = price
            elif "poly tape" in nl:
                prices["TAPE"] = price
            elif "tie wire" in nl:
                prices["WIRE"] = price
            elif "stakes 18" in nl:
                prices["STAKES"] = price
        return prices
    except Exception as e:
        return dict(FALLBACK_PRICES)

# ── PDF → IMAGES ──────────────────────────────────────────────────────────────
# Keywords that indicate a page contains structural/rebar content
STRUCTURAL_KEYWORDS = [
    r'#[3-9]\b', r'#1[0-9]\b',          # rebar sizes: #3 #4 #5 etc
    r'\brebar\b', r'\breinf', r'\bbar\b',
    r'\bfooting', r'\bfoundation', r'\bslab',
    r'\bstem\s*wall', r'\bgrade\s*beam', r'\bpier',
    r'\bstirrup', r'\bcontinuous', r'\bew\b', r'\bo\.c\.', r'\boc\b',
    r'\bmat\b', r'\bdowel', r'\bhook', r'\btyp\b',
    r'\blap\b', r'\bsplice',
    r"#3@", r"#4@", r"#5@", r"#6@",
]

def get_page_count(pdf_path):
    """Return total number of pages in PDF."""
    try:
        r = subprocess.run(["pdfinfo", pdf_path], capture_output=True, text=True, timeout=15)
        for line in r.stdout.splitlines():
            if line.lower().startswith("pages:"):
                return int(line.split(":",1)[1].strip())
    except Exception:
        pass
    return 0

def score_pages_by_text(pdf_path, total_pages):
    """Extract text from all pages and score each by structural keyword hits.
    Returns list of (page_num_1based, score) sorted by score desc."""
    scores = {}
    try:
        # pdftotext can dump all pages with page separators
        r = subprocess.run(
            ["pdftotext", "-layout", pdf_path, "-"],
            capture_output=True, text=True, timeout=90
        )
        pages_text = r.stdout.split("\x0c")  # form-feed separates pages
        for i, text in enumerate(pages_text):
            page_num = i + 1
            if page_num > total_pages:
                break
            t = text.lower()
            score = 0
            for kw in STRUCTURAL_KEYWORDS:
                score += len(re.findall(kw, t, re.IGNORECASE))
            scores[page_num] = score
    except Exception:
        pass
    return sorted(scores.items(), key=lambda x: x[1], reverse=True)

def render_pages(pdf_path, tmpdir, page_numbers, dpi=150):
    """Render specific pages of a PDF to PNG images. Returns list of image paths."""
    images = []
    for pg in page_numbers:
        prefix = os.path.join(tmpdir, f"pg{pg:04d}")
        try:
            subprocess.run(
                ["pdftoppm", "-r", str(dpi), "-png",
                 "-f", str(pg), "-l", str(pg), pdf_path, prefix],
                capture_output=True, timeout=30
            )
            # pdftoppm appends -1 or the page number to the prefix
            matches = sorted([
                os.path.join(tmpdir, f)
                for f in os.listdir(tmpdir)
                if f.startswith(f"pg{pg:04d}") and f.endswith(".png")
            ])
            images.extend(matches)
        except Exception:
            pass
    return images

def pdf_to_images(pdf_path, tmpdir, max_pages=8):
    """Smart page selection: score all pages by structural keywords,
    render top structural pages at full res. Falls back to first N pages."""
    total = get_page_count(pdf_path)
    if total == 0:
        total = max_pages  # fallback

    # For small docs, just render all pages
    if total <= 20:
        try:
            subprocess.run(
                ["pdftoppm", "-r", "100", "-png", pdf_path,
                 os.path.join(tmpdir, "page")],
                capture_output=True, timeout=120
            )
            return sorted([
                os.path.join(tmpdir, f)
                for f in os.listdir(tmpdir)
                if f.startswith("page") and f.endswith(".png")
            ])
        except Exception:
            return []

    # Large doc: score pages by text content, pick top structural pages
    scored = score_pages_by_text(pdf_path, total)

    # Take pages with score > 0, up to 20; fall back to first 12 if nothing scores
    structural_pages = [pg for pg, sc in scored if sc > 0][:12]
    if not structural_pages:
        structural_pages = list(range(1, min(total+1, 13)))  # first 12

    # Always include first 2 pages (title sheet often has project name)
    for p in [1, 2]:
        if p not in structural_pages and p <= total:
            structural_pages.append(p)

    structural_pages = sorted(set(structural_pages))
    return render_pages(pdf_path, tmpdir, structural_pages, dpi=100)

# ── CLAUDE TAKEOFF ────────────────────────────────────────────────────────────
TAKEOFF_SYSTEM = """You are an expert rebar takeoff estimator for Rebar Concrete Products in McKinney, TX.
Analyze the structural/concrete plan images and extract ALL rebar information.

Return a JSON object with this exact structure:
{
  "project_name": "Name from plans or 'Custom Project'",
  "project_address": "Address if shown, else ''",
  "bars": [
    {
      "mark": "A",
      "size": "#4",
      "length_ft": 20,
      "qty": 50,
      "type": "straight",
      "description": "Slab mat 12\" O.C. E.W.",
      "is_fabricated": false,
      "weight_lbs": 167.0
    }
  ],
  "dobies_qty": 500,
  "poly_rolls": 1,
  "poly_tape_rolls": 1,
  "tie_wire_rolls": 2,
  "stake_packs": 3,
  "notes": "Any important notes"
}

CRITICAL RULES:
- Rebar weights per linear foot: #3=0.376, #4=0.668, #5=1.043, #6=1.502, #7=2.044, #8=2.670
- For each bar: weight_lbs = qty * length_ft * weight_per_lf
- type must be: "straight", "l-hook", "u-bar", "stirrup", "ring", or "custom"
- is_fabricated = true for anything that is bent/shaped (not straight 20' stock bars)
- Apply 7% waste factor to straight bar quantities (multiply qty by 1.07, round up)
- Stirrup cut length formula: 2*(W+H)+8 inches total | Ring: pi*D+4 inches
- If dobies/chairs not specified, estimate: 1 per 4 sq ft of slab
- If poly not called out, set poly_rolls to 0
- Return ONLY valid JSON, no markdown fences"""

def claude_takeoff(image_paths):
    """Send plan images to Claude for takeoff extraction."""
    if not ANTHROPIC_API_KEY:
        return None, "No ANTHROPIC_API_KEY set"
    
    try:
        import anthropic
        client = anthropic.Anthropic(api_key=ANTHROPIC_API_KEY)
        
        content = []
        total_b64_bytes = 0
        MAX_PAYLOAD = 18 * 1024 * 1024  # 18 MB base64 safety limit
        for img_path in image_paths[:12]:  # Up to 12 structural pages
            with open(img_path, "rb") as f:
                raw_bytes = f.read()
            img_b64 = base64.standard_b64encode(raw_bytes).decode("utf-8")
            total_b64_bytes += len(img_b64)
            if total_b64_bytes > MAX_PAYLOAD:
                break  # stop adding pages once payload limit reached
            content.append({
                "type": "image",
                "source": {"type": "base64", "media_type": "image/png", "data": img_b64}
            })
        
        content.append({
            "type": "text",
            "text": "Analyze all rebar shown in these plan pages and return the JSON takeoff."
        })
        
        msg = client.messages.create(
            model="claude-opus-4-5",
            max_tokens=8192,
            system=TAKEOFF_SYSTEM,
            messages=[{"role": "user", "content": content}]
        )
        
        raw = msg.content[0].text.strip()
        # Strip markdown fences if present
        raw = re.sub(r'^```(?:json)?\s*', '', raw)
        raw = re.sub(r'\s*```$', '', raw)
        
        data = json.loads(raw)
        return data, None
        
    except Exception as e:
        return None, str(e)

# ── PDF GENERATION ────────────────────────────────────────────────────────────
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

    bars     = takeoff.get("bars", [])
    proj_name = project_name or takeout_safe(takeoff, "project_name", "Custom Project")
    proj_addr = takeout_safe(takeoff, "project_address", "")

    # ── COMPUTE LINE ITEMS ──────────────────────────────────────────────────
    rebar_lines  = []
    fab_lines    = []
    total_fab_lbs = 0.0
    rebar_sub    = 0.0
    fab_sub      = 0.0

    for bar in bars:
        size    = bar.get("size", "#4")
        length  = float(bar.get("length_ft", 20))
        qty     = int(bar.get("qty", 0))
        is_fab  = bar.get("is_fabricated", False)
        mark    = bar.get("mark", "")
        desc    = bar.get("description", "")
        wt      = float(bar.get("weight_lbs", 0))
        btype   = bar.get("type", "straight")

        if is_fab:
            # Fabricated bars priced per lb at $0.75 — NEVER CHANGE
            ext = wt * prices["FAB"]
            fab_lines.append({
                "mark": mark, "size": size, "type": btype,
                "length": length, "qty": qty, "lbs": wt,
                "unit_price": prices["FAB"], "ext": ext, "desc": desc
            })
            total_fab_lbs += wt
            fab_sub += ext
        else:
            # Straight stock bars — priced by 20' bar
            price_key = f"{size} 20'"
            unit_price = prices.get(price_key, prices.get("#4 20'", 7.37))

            if length < 20:
                # Shear cut rule: how many cuts fit per 20' bar?
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
    dobies    = int(takeoff.get("dobies_qty", 0))
    ext_dob   = dobies * prices["DOBIE"]
    if dobies:
        rebar_sub += ext_dob

    # Forming / accessories
    poly_r    = int(takeoff.get("poly_rolls", 0))
    tape_r    = int(takeoff.get("poly_tape_rolls", 0))
    wire_r    = int(takeoff.get("tie_wire_rolls", 0))
    stake_p   = int(takeoff.get("stake_packs", 0))
    ext_poly  = poly_r  * prices["POLY"]
    ext_tape  = tape_r  * prices["TAPE"]
    ext_wire  = wire_r  * prices["WIRE"]
    ext_stk   = stake_p * prices["STAKES"]
    forming_sub = ext_poly + ext_tape + ext_wire + ext_stk

    # Fabrication sub
    if total_fab_lbs > 0:
        fab_sub = total_fab_lbs * prices["FAB"]

    material_sub = rebar_sub + fab_sub
    misc_5pct    = material_sub * 0.05
    combined     = material_sub + forming_sub + misc_5pct
    tax          = combined * 0.0825
    grand_total  = combined + tax

    def fmt(v): return f'${v:,.2f}'

    # ── DOCUMENT ─────────────────────────────────────────────────────────────
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

    # Project info block
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

    # Section header
    story.append(Paragraph('REBAR MATERIAL ESTIMATE', ps('sh',11,True,WHITE,TA_LEFT)))
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

    # Rebar table
    CW = [0.35*inch, 0.5*inch, 0.7*inch, 0.75*inch, 1.9*inch, 0.85*inch, 0.85*inch]
    rebar_hdr = [['MK','SIZE','LENGTH','QTY','DESCRIPTION','UNIT PRICE','EXT PRICE']]
    rebar_rows = []
    for r in rebar_lines:
        rebar_rows.append([
            r['mark'], r['size'], f"{r['length']:.0f}'", str(r['qty']),
            r['desc'][:38], fmt(r['unit_price']), fmt(r['ext'])
        ])

    # Fabricated bars in rebar section
    for f in fab_lines:
        rebar_rows.append([
            f['mark'], f['size'], f"{f['length']:.0f}'", str(f['qty']),
            f"FABRICATED – {f['desc'][:28]}", fmt(f['unit_price'])+'/lb', fmt(f['ext'])
        ])

    # Dobies
    if dobies:
        rebar_rows.append(['', 'DOBIE', '3"', str(dobies),
            'Concrete Chair 3"×3"×2"', fmt(prices['DOBIE']), fmt(ext_dob)])

    all_rows = rebar_hdr + rebar_rows
    t = Table(all_rows, colWidths=CW, repeatRows=1)
    ts = TableStyle([
        ('BACKGROUND',(0,0),(-1,0),CHARCOAL),
        ('TEXTCOLOR',(0,0),(-1,0),WHITE),
        ('FONTNAME',(0,0),(-1,0),'Helvetica-Bold'),
        ('FONTSIZE',(0,0),(-1,-1),8),
        ('ALIGN',(0,0),(-1,-1),'CENTER'),
        ('ALIGN',(4,1),(4,-1),'LEFT'),
        ('ALIGN',(5,1),(6,-1),'RIGHT'),
        ('GRID',(0,0),(-1,-1),0.5,colors.HexColor('#cccccc')),
        ('BOTTOMPADDING',(0,0),(-1,-1),4),
        ('TOPPADDING',(0,0),(-1,-1),3),
    ])
    for i in range(1, len(all_rows)):
        if i % 2 == 0:
            ts.add('BACKGROUND',(0,i),(-1,i),LIGHT_GRAY)
    t.setStyle(ts)
    story.append(t)
    story.append(Spacer(1,8))

    # Subtotal block
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

    # Grand Total box
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
    # Highlight misc row
    gd_ts.add('TEXTCOLOR',(0,2),(1,2),OLIVE)
    gd_ts.add('FONTNAME',(0,2),(1,2),'Helvetica-Bold')
    gd_t.setStyle(gd_ts)
    story.append(gd_t)
    story.append(Spacer(1,4))

    # Grand total row
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

    # Notes
    notes = takeoff.get("notes", "")
    if notes:
        story.append(Paragraph('NOTES', ps('nh',10,True,CHARCOAL)))
        story.append(Paragraph(notes, ps('nb',8,False,MID_GRAY)))
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

    input_pdf    = sys.argv[1]
    output_pdf   = sys.argv[2]
    customer     = sys.argv[3]
    proj_name    = sys.argv[4] if len(sys.argv) > 4 else ""
    bid_date     = sys.argv[5] if len(sys.argv) > 5 else datetime.now().strftime("%B %d, %Y")

    if not os.path.exists(input_pdf):
        print(json.dumps({"success": False, "error": f"Input PDF not found: {input_pdf}"}))
        sys.exit(1)

    # Fetch QBO prices
    prices = fetch_qbo_prices()

    # Render PDF to images
    with tempfile.TemporaryDirectory() as tmpdir:
        images = pdf_to_images(input_pdf, tmpdir)

        if not images:
            # Can't render pages — build a placeholder bid
            takeoff = {
                "project_name": proj_name or "Custom Project",
                "project_address": "",
                "bars": [],
                "dobies_qty": 0,
                "poly_rolls": 0,
                "poly_tape_rolls": 0,
                "tie_wire_rolls": 0,
                "stake_packs": 0,
                "notes": "Plan could not be processed. Please contact Rebar Concrete Products for a manual takeoff."
            }
            error_msg = "Could not render plan pages. A manual takeoff is required."
        else:
            # Claude takeoff
            takeoff, error_msg = claude_takeoff(images)
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

        # Generate PDF
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
