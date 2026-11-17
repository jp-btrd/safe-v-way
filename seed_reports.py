"""
seed_reports.py - replaces data/reports.json with 3 sample PENDING reports.
Run it with Flask STOPPED:   python seed_reports.py
Safe to re-run any time you want a fresh demo (it resets all report statuses to pending).
Placeholder photos are drawn with Pillow (already installed with OSMnx/matplotlib).
If you have real photos, you can instead submit reports through the resident form.
"""
import json
import os
from datetime import datetime, timezone

from PIL import Image, ImageDraw, ImageFont

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
UPLOAD_DIR = os.path.join(BASE_DIR, "uploads")
REPORTS_PATH = os.path.join(BASE_DIR, "data", "reports.json")
os.makedirs(UPLOAD_DIR, exist_ok=True)

# Locations are only hints. In Step 5B the admin clicks the exact alley to block.
SEEDS = [
    {"lat": 14.684000, "lon": 120.989000, "color": (84, 110, 122),
     "label": "SAMPLE PHOTO: fallen post",
     "description": "Fallen electrical post blocking the alley near the Tañada covered court."},
    {"lat": 14.685000, "lon": 120.991000, "color": (183, 80, 40),
     "label": "SAMPLE PHOTO: smoke / fire",
     "description": "Smoke and burning smell coming from a house in the alley. Residents are avoiding it."},
    {"lat": 14.683500, "lon": 120.990500, "color": (110, 110, 110),
     "label": "SAMPLE PHOTO: unverified",
     "description": "Someone told me this alley is blocked, but I have not seen it myself."},
]


def make_photo(path, label, color):
    img = Image.new("RGB", (800, 500), color)
    draw = ImageDraw.Draw(img)
    try:
        font = ImageFont.load_default(size=40)      # Pillow 10.1 or newer
    except TypeError:
        font = ImageFont.load_default()             # older Pillow: small text, still works
    draw.text((40, 220), label, fill="white", font=font)
    img.save(path, "JPEG", quality=85)


def main():
    now = datetime.now(timezone.utc).isoformat(timespec="seconds")
    reports = []
    for i, s in enumerate(SEEDS, start=1):
        photo_name = f"seed_{i}.jpg"
        make_photo(os.path.join(UPLOAD_DIR, photo_name), s["label"], s["color"])
        reports.append({
            "id": i, "lat": s["lat"], "lon": s["lon"], "description": s["description"],
            "photo": photo_name, "status": "pending", "created_at": now, "seed": True,
        })
    with open(REPORTS_PATH, "w", encoding="utf-8") as f:
        json.dump(reports, f, indent=2, ensure_ascii=False)
    print(f"Wrote {len(reports)} pending sample reports to {REPORTS_PATH}")


if __name__ == "__main__":
    main()