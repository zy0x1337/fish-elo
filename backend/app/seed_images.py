"""Generate fish.json from aquaguide species data with image credits."""

import json
import re
import shutil
from pathlib import Path

PROJECT = Path(__file__).resolve().parent.parent.parent
FISH_JSON = PROJECT / "backend" / "data" / "fish.json"
IMAGES_DIR = PROJECT / "frontend" / "images"
AQUA_SPECIES = Path(r"C:\Users\Jeanine\mika\aquaguide\src\data\species")
AQUA_IMAGES = Path(r"C:\Users\Jeanine\mika\aquaguide\public\images\species")


def parse_ts(filepath: Path) -> dict | None:
    raw = filepath.read_text(encoding="utf-8")

    slug_m = re.search(r"slug:\s*'([^']+)'", raw)
    img_m = re.search(r"imageUrl:\s*'([^']+)'", raw)
    cn_m = re.search(r"commonName:\s*'([^']+)'", raw)
    sci_m = re.search(r"scientificName:\s*'([^']+)'", raw)
    family_m = re.search(r"family:\s*'([^']+)'", raw)
    origin_m = re.search(r"origin:\s*'([^']+)'", raw)
    size_m = re.search(r"adultSizeCM:\s*(\d+)", raw)
    diff_m = re.search(r"difficulty:\s*'([^']+)'", raw)
    diet_m = re.search(r"diet:\s*'([^']+)'", raw)
    type_m = re.search(r"type:\s*'([^']+)'", raw)
    zone_m = re.search(r"primary:\s*'([^']+)'", raw)
    tags_m = re.search(r"tags:\s*\[([^\]]+)\]", raw)
    min_group_m = re.search(r"minGroupSize:\s*(\d+)", raw)

    if not slug_m or not img_m or not cn_m:
        return None

    tags = []
    if tags_m:
        tag_raw = tags_m.group(1)
        tags = [t.strip().strip("'") for t in tag_raw.split(",") if t.strip()]
        tags = [t for t in tags if t]

    if diff_m:
        tags.append(diff_m.group(1))
    if diet_m:
        tags.append(diet_m.group(1))
    if type_m and type_m.group(1) != "freshwater":
        tags.append(type_m.group(1))
    if zone_m:
        zone = zone_m.group(1)
        if zone == "bottom":
            tags.append("bottom-dweller")
        elif zone == "surface":
            tags.append("surface-dweller")

    img_filename = img_m.group(1).split("/")[-1]
    src_image = AQUA_IMAGES / img_filename

    credit = None
    credit_block = re.search(r"imageCredit:\s*\{([^}]+)\}", raw)
    if credit_block:
        block = credit_block.group(1)
        photographer = re.search(r"photographer:\s*'([^']*)'", block)
        source_url = re.search(r"sourceUrl:\s*'([^']*)'", block)
        license_ = re.search(r"license:\s*'([^']*)'", block)
        license_url = re.search(r"licenseUrl:\s*'([^']*)'", block)
        credit = {
            "photographer": photographer.group(1) if photographer else "",
            "sourceUrl": source_url.group(1) if source_url else "",
            "license": license_.group(1) if license_ else "",
            "licenseUrl": license_url.group(1) if license_url else "",
        }

    return {
        "id": slug_m.group(1),
        "name": cn_m.group(1),
        "tags": tags[:6],
        "image": f"/images/{img_filename}",
        "src": src_image,
        "filename": img_filename,
        "imageCredit": credit,
    }


def populate():
    fish_list = []

    for ts_file in sorted(AQUA_SPECIES.glob("*.ts")):
        info = parse_ts(ts_file)
        if info is None:
            continue

        src = info.pop("src")
        filename = info.pop("filename")
        credit = info.pop("imageCredit", None)

        dst = IMAGES_DIR / filename
        if src.exists():
            if not dst.exists():
                shutil.copy2(str(src), str(dst))
        else:
            print(f"  WARN: {info['name']} — image missing: {src}")
            info["image"] = ""

        if credit:
            info["imageCredit"] = credit

        fish_list.append(info)
        print(f"  {info['name']} ({info['id']}){' [credited]' if credit else ''}")

    data = {"fish": fish_list}
    with open(FISH_JSON, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)

    credited = sum(1 for f in fish_list if f.get("imageCredit"))
    print(f"\nDone. {len(fish_list)} species, {credited} with imageCredit.")
    print(f"Updated {FISH_JSON}")
    print(f"Images in {IMAGES_DIR}")


if __name__ == "__main__":
    populate()
