"""Seed backend/data/fish.json — enrich the shipped catalog to the Aqua Elo schema.

The image files and their attribution (``imageCredit``) are committed source data;
this script only *enriches* each existing entry with the richer domain schema
(scientific name, genre/theme tags, tank parameters, popularity). It reads the
current ``fish.json`` for ``id``/``name``/``image``/``imageCredit`` and rewrites it
in place, so it is idempotent: the enrichment table below is keyed by fish ``id``.

Numeric water parameters and minimum tank sizes are derived from a compact
per-species table (scientific name, genre, adult size, temperament, difficulty,
water type, popularity) so the file stays maintainable rather than hand-tuning
every field. ``popularity`` (a 0-100 keepership/interest proxy) seeds the initial
Elo in ``elo.py``.

Run: ``python -m backend.app.seed``
"""

import json
import math
from pathlib import Path

DATA_DIR = Path(__file__).resolve().parent.parent / "data"
FISH_FILE = DATA_DIR / "fish.json"

# id -> (scientific_name, genre, adult_size_cm, temperament, difficulty, water, popularity, extra_tags)
#   genre      : primary family tag (drives Daily Battle themes when >=10 fish share it)
#   temperament: peaceful | semi-aggressive | aggressive
#   difficulty : beginner | intermediate | advanced
#   water      : soft | neut | hard | brack | warm | cold | coldhard
#   popularity : 0-100 interest proxy -> seeds initial Elo (log-scaled into ~1000-2200)
#   extra_tags : additional controlled tags (planted, centerpiece, ...)
ENRICH = {
    "african-dwarf-frog": ("Hymenochirus boettgeri", "amphibian", 4, "peaceful", "intermediate", "neut", 60, []),
    "amano-shrimp": ("Caridina multidentata", "shrimp", 5, "peaceful", "beginner", "neut", 80, ["planted"]),
    "anomalochromis-thomasi": ("Anomalochromis thomasi", "cichlid", 8, "peaceful", "intermediate", "neut", 55, []),
    "mediterranean-killifish": ("Aphanius fasciatus", "killifish", 6, "semi-aggressive", "advanced", "brack", 25, []),
    "apistogramma-agassizii": ("Apistogramma agassizii", "cichlid", 8, "semi-aggressive", "advanced", "warm", 60, ["planted"]),
    "cockatoo-dwarf-cichlid": ("Apistogramma cacatuoides", "cichlid", 8, "semi-aggressive", "intermediate", "soft", 68, ["planted"]),
    "aplocheilus-lineatus": ("Aplocheilus lineatus", "killifish", 10, "semi-aggressive", "intermediate", "neut", 45, []),
    "scleropages-formosus": ("Scleropages formosus", "oddball", 90, "aggressive", "advanced", "soft", 70, ["centerpiece"]),
    "axolotl": ("Ambystoma mexicanum", "amphibian", 28, "peaceful", "intermediate", "cold", 88, ["centerpiece"]),
    "betta-splendens-female": ("Betta splendens", "betta", 6, "semi-aggressive", "beginner", "neut", 80, []),
    "betta-splendens": ("Betta splendens", "betta", 7, "aggressive", "beginner", "neut", 98, ["centerpiece"]),
    "black-neon-tetra": ("Hyphessobrycon herbertaxelrodi", "tetra", 4, "peaceful", "beginner", "soft", 72, []),
    "black-skirt-tetra": ("Gymnocorymbus ternetzi", "tetra", 6, "peaceful", "beginner", "neut", 74, []),
    "astyanax-jordani": ("Astyanax mexicanus", "tetra", 9, "semi-aggressive", "intermediate", "neut", 60, []),
    "nothobranchius-rachovii": ("Nothobranchius rachovii", "killifish", 5, "semi-aggressive", "advanced", "soft", 55, []),
    "boleophthalmus-boddarti": ("Boleophthalmus boddarti", "goby", 22, "semi-aggressive", "advanced", "brack", 30, ["oddball"]),
    "bolivian-ram": ("Mikrogeophagus altispinosus", "cichlid", 8, "peaceful", "intermediate", "neut", 78, ["planted"]),
    "bristlenose-pleco": ("Ancistrus cirrhosus", "catfish", 12, "peaceful", "beginner", "neut", 88, []),
    "bronze-cory": ("Corydoras aeneus", "catfish", 6, "peaceful", "beginner", "neut", 85, []),
    "psalidodon-anisitsi": ("Psalidodon anisitsi", "tetra", 8, "semi-aggressive", "beginner", "neut", 55, []),
    "bumblebee-goby": ("Brachygobius doriae", "goby", 4, "semi-aggressive", "intermediate", "brack", 45, []),
    "cardinal-tetra": ("Paracheirodon axelrodi", "tetra", 5, "peaceful", "intermediate", "soft", 90, ["planted"]),
    "black-bee-shrimp": ("Caridina cantonensis", "shrimp", 3, "peaceful", "advanced", "soft", 55, ["planted"]),
    "blue-bolt-shrimp": ("Caridina cantonensis", "shrimp", 3, "peaceful", "advanced", "soft", 52, ["planted"]),
    "celestial-pearl-danio": ("Danio margaritatus", "danio", 3, "peaceful", "intermediate", "neut", 80, ["planted"]),
    "cherry-barb": ("Puntius titteya", "barb", 5, "peaceful", "beginner", "neut", 78, []),
    "chili-rasbora": ("Boraras brigittae", "rasbora", 2, "peaceful", "intermediate", "soft", 78, ["planted"]),
    "clown-killifish": ("Epiplatys annulatus", "killifish", 4, "peaceful", "intermediate", "soft", 58, []),
    "clown-loach": ("Chromobotia macracanthus", "loach", 30, "peaceful", "intermediate", "neut", 85, ["centerpiece"]),
    "clown-pleco": ("Panaqolus maccus", "catfish", 9, "peaceful", "beginner", "neut", 72, []),
    "carassius-auratus-auratus": ("Carassius auratus", "goldfish", 25, "peaceful", "beginner", "coldhard", 95, ["centerpiece"]),
    "congo-tetra": ("Phenacogrammus interruptus", "tetra", 8, "peaceful", "intermediate", "soft", 74, []),
    "corydoras-paleatus": ("Corydoras paleatus", "catfish", 6, "peaceful", "beginner", "neut", 80, []),
    "danio-rerio": ("Danio rerio", "danio", 5, "peaceful", "beginner", "neut", 86, []),
    "diamond-tetra": ("Moenkhausia pittieri", "tetra", 6, "peaceful", "beginner", "neut", 65, []),
    "discus": ("Symphysodon aequifasciatus", "cichlid", 20, "peaceful", "advanced", "warm", 85, ["centerpiece"]),
    "eight-banded-lizard-loach": ("Serpenticobitis octozona", "loach", 6, "peaceful", "advanced", "neut", 30, []),
    "electric-yellow-lab": ("Labidochromis caeruleus", "cichlid", 10, "semi-aggressive", "intermediate", "hard", 78, []),
    "ember-tetra": ("Hyphessobrycon amandae", "tetra", 2, "peaceful", "beginner", "soft", 82, ["planted"]),
    "emerald-dwarf-rasbora": ("Danio erythromicron", "rasbora", 3, "peaceful", "intermediate", "neut", 55, []),
    "nematobrycon-palmeri": ("Nematobrycon palmeri", "tetra", 6, "peaceful", "beginner", "soft", 70, []),
    "endler-guppy": ("Poecilia wingei", "livebearer", 3, "peaceful", "beginner", "hard", 76, []),
    "aulonocara-jacobfreibergi": ("Aulonocara jacobfreibergi", "cichlid", 13, "semi-aggressive", "intermediate", "hard", 58, ["centerpiece"]),
    "garra-flavatra": ("Garra flavatra", "loach", 9, "peaceful", "intermediate", "neut", 48, []),
    "glass-catfish": ("Kryptopterus vitreolus", "catfish", 8, "peaceful", "intermediate", "soft", 68, ["schooling"]),
    "danio-tinwini": ("Danio tinwini", "danio", 3, "peaceful", "beginner", "neut", 50, []),
    "gold-spot-pleco": ("Pterygoplichthys joselimaianus", "catfish", 30, "peaceful", "intermediate", "neut", 45, ["centerpiece"]),
    "golden-whiptail": ("Sturisoma aureum", "catfish", 20, "peaceful", "advanced", "soft", 42, []),
    "guppy": ("Poecilia reticulata", "livebearer", 5, "peaceful", "beginner", "hard", 96, []),
    "harlequin-rasbora": ("Trigonostigma heteromorpha", "rasbora", 5, "peaceful", "beginner", "soft", 82, ["planted"]),
    "glowlight-tetra": ("Hemigrammus erythrozonus", "tetra", 4, "peaceful", "beginner", "soft", 76, []),
    "honey-gourami": ("Trichogaster chuna", "gourami", 5, "peaceful", "beginner", "neut", 78, ["planted"]),
    "hyphessobrycon-megalopterus": ("Hyphessobrycon megalopterus", "tetra", 5, "peaceful", "beginner", "soft", 68, []),
    "corydoras-julii": ("Corydoras julii", "catfish", 6, "peaceful", "beginner", "neut", 72, []),
    "kuhli-loach": ("Pangio kuhlii", "loach", 10, "peaceful", "beginner", "soft", 78, []),
    "lemon-tetra": ("Hyphessobrycon pulchripinnis", "tetra", 5, "peaceful", "beginner", "soft", 70, []),
    "marbled-hatchetfish": ("Carnegiella strigata", "hatchetfish", 4, "peaceful", "intermediate", "soft", 62, ["schooling"]),
    "lake-kutubu-rainbowfish": ("Melanotaenia lacustris", "rainbowfish", 11, "peaceful", "intermediate", "hard", 58, []),
    "boesemani-rainbowfish": ("Melanotaenia boesemani", "rainbowfish", 11, "peaceful", "intermediate", "hard", 74, []),
    "molly": ("Poecilia sphenops", "livebearer", 10, "peaceful", "beginner", "hard", 84, []),
    "cherry-shrimp": ("Neocaridina davidi", "shrimp", 3, "peaceful", "beginner", "neut", 90, ["planted"]),
    "neon-blue-goby": ("Stiphodon atropurpureus", "goby", 4, "peaceful", "advanced", "neut", 40, []),
    "neon-tetra": ("Paracheirodon innesi", "tetra", 4, "peaceful", "beginner", "soft", 95, ["planted"]),
    "oscar": ("Astronotus ocellatus", "cichlid", 35, "aggressive", "intermediate", "neut", 82, ["centerpiece"]),
    "otocinclus-macrospilus": ("Otocinclus macrospilus", "catfish", 4, "peaceful", "intermediate", "neut", 62, []),
    "otocinclus": ("Otocinclus vittatus", "catfish", 4, "peaceful", "intermediate", "neut", 70, []),
    "panda-cory": ("Corydoras panda", "catfish", 5, "peaceful", "beginner", "neut", 84, []),
    "pao-palembangensis": ("Pao palembangensis", "puffer", 15, "aggressive", "advanced", "neut", 35, ["centerpiece"]),
    "dwarf-pufferfish": ("Carinotetraodon travancoricus", "puffer", 3, "semi-aggressive", "intermediate", "neut", 74, []),
    "geophagus-brasiliensis": ("Geophagus brasiliensis", "cichlid", 25, "semi-aggressive", "intermediate", "neut", 50, ["centerpiece"]),
    "pelvicachromis-pulcher": ("Pelvicachromis pulcher", "cichlid", 9, "semi-aggressive", "beginner", "neut", 74, ["planted"]),
    "odessa-barb": ("Pethia padamya", "barb", 6, "peaceful", "beginner", "neut", 60, []),
    "platy": ("Xiphophorus maculatus", "livebearer", 5, "peaceful", "beginner", "hard", 88, []),
    "pterophyllum-scalare": ("Pterophyllum scalare", "cichlid", 15, "semi-aggressive", "intermediate", "soft", 90, ["centerpiece"]),
    "puntigrus-tetrazona": ("Puntigrus tetrazona", "barb", 7, "semi-aggressive", "beginner", "neut", 80, []),
    "pygmy-cory": ("Corydoras pygmaeus", "catfish", 3, "peaceful", "beginner", "neut", 72, ["schooling"]),
    "epalzeorhynchos-frenatum": ("Epalzeorhynchos frenatum", "oddball", 15, "aggressive", "intermediate", "neut", 72, ["centerpiece", "bottom-dweller"]),
    "ram-cichlid": ("Mikrogeophagus ramirezi", "cichlid", 6, "peaceful", "advanced", "warm", 84, ["planted"]),
    "procambarus-clarkii": ("Procambarus clarkii", "crayfish", 12, "aggressive", "beginner", "neut", 45, ["oddball"]),
    "red-tailed-silverside": ("Bedotia geayi", "rainbowfish", 9, "peaceful", "intermediate", "hard", 40, []),
    "mesoheros-festae": ("Mesoheros festae", "cichlid", 30, "aggressive", "advanced", "neut", 45, ["centerpiece"]),
    "red-zebra-cichlid": ("Maylandia estherae", "cichlid", 12, "aggressive", "intermediate", "hard", 60, []),
    "myleus-rubripinnis": ("Myloplus rubripinnis", "oddball", 30, "peaceful", "intermediate", "soft", 42, ["centerpiece"]),
    "rosy-barb": ("Pethia conchonius", "barb", 10, "peaceful", "beginner", "neut", 68, []),
    "rosy-tetra": ("Hyphessobrycon rosaceus", "tetra", 4, "peaceful", "beginner", "soft", 62, []),
    "rubber-lip-pleco": ("Chaetostoma milesi", "catfish", 12, "peaceful", "intermediate", "neut", 55, []),
    "rudd": ("Scardinius erythrophthalmus", "minnow", 25, "peaceful", "beginner", "coldhard", 30, []),
    "rummy-nose-tetra": ("Hemigrammus rhodostomus", "tetra", 5, "peaceful", "intermediate", "soft", 82, ["planted"]),
    "hypoptopoma-inexspectatum": ("Hypoptopoma inexspectatum", "catfish", 8, "peaceful", "intermediate", "soft", 40, []),
    "sailfin-pleco": ("Pterygoplichthys gibbiceps", "catfish", 40, "peaceful", "intermediate", "neut", 55, ["centerpiece"]),
    "serpae-tetra": ("Hyphessobrycon eques", "tetra", 4, "semi-aggressive", "beginner", "soft", 70, []),
    "sewellia-lineolata": ("Sewellia lineolata", "loach", 6, "peaceful", "intermediate", "neut", 62, []),
    "siamese-algae-eater": ("Crossocheilus oblongus", "minnow", 15, "peaceful", "intermediate", "neut", 66, ["bottom-dweller"]),
    "aspidoras-pauciradiatus": ("Aspidoras pauciradiatus", "catfish", 3, "peaceful", "intermediate", "soft", 45, []),
    "sparkling-gourami": ("Trichopsis pumila", "gourami", 4, "peaceful", "intermediate", "soft", 66, ["planted"]),
    "splash-tetra": ("Copella arnoldi", "tetra", 8, "peaceful", "intermediate", "soft", 45, []),
    "spotted-blue-eye": ("Pseudomugil gertrudae", "rainbowfish", 4, "peaceful", "intermediate", "soft", 52, []),
    "spotted-green-puffer": ("Dichotomyctere nigroviridis", "puffer", 15, "aggressive", "advanced", "brack", 55, ["centerpiece"]),
    "sterbai-cory": ("Corydoras sterbai", "catfish", 7, "peaceful", "beginner", "neut", 80, ["planted"]),
    "swordtail": ("Xiphophorus hellerii", "livebearer", 12, "peaceful", "beginner", "hard", 82, []),
    "tetraodon-mbu": ("Tetraodon mbu", "puffer", 60, "aggressive", "advanced", "neut", 48, ["centerpiece"]),
    "toxotes-chatareus": ("Toxotes chatareus", "archerfish", 30, "semi-aggressive", "advanced", "brack", 45, ["centerpiece"]),
    "pearl-gourami": ("Trichopodus leerii", "gourami", 12, "peaceful", "beginner", "soft", 80, ["planted"]),
    "three-spot-gourami": ("Trichopodus trichopterus", "gourami", 15, "semi-aggressive", "beginner", "neut", 68, ["centerpiece"]),
    "white-cloud-minnow": ("Tanichthys albonubes", "minnow", 4, "peaceful", "beginner", "cold", 74, ["schooling"]),
    "zebra-loach": ("Botia striata", "loach", 9, "peaceful", "intermediate", "neut", 64, []),
}

# water type -> (ph_low, ph_high, temp_low_c, temp_high_c)
WATER = {
    "soft": (6.0, 7.0, 23, 27),
    "neut": (6.5, 7.5, 23, 27),
    "hard": (7.2, 8.4, 23, 27),
    "brack": (7.5, 8.5, 24, 28),
    "warm": (5.5, 6.8, 28, 30),
    "cold": (6.5, 7.5, 16, 22),
    "coldhard": (7.0, 8.0, 15, 22),
}

SCHOOLING_GENRES = {"tetra", "rasbora", "danio", "barb", "rainbowfish"}


def min_tank_liters(size_cm: float, genre: str) -> int:
    if size_cm <= 3:
        base = 40
    elif size_cm <= 5:
        base = 60
    elif size_cm <= 8:
        base = 90
    elif size_cm <= 12:
        base = 130
    elif size_cm <= 18:
        base = 200
    elif size_cm <= 25:
        base = 300
    elif size_cm <= 35:
        base = 450
    else:
        base = 800
    if genre in SCHOOLING_GENRES:
        base = int(base * 1.3)
    return base


def derive_tags(genre, size, temperament, difficulty, water, extra):
    tags = [genre]
    if size <= 4:
        tags.append("nano")
    if genre in SCHOOLING_GENRES:
        tags.append("schooling")
    if genre in ("catfish", "loach"):
        tags.append("bottom-dweller")
    if water in ("cold", "coldhard"):
        tags.append("coldwater")
    if water == "brack":
        tags.append("brackish-tolerant")
    if temperament == "peaceful" and size <= 12 and genre not in ("puffer", "crayfish"):
        tags.append("community")
    tags.extend(extra)
    if difficulty == "beginner":
        tags.append("beginner")
    elif difficulty == "advanced":
        tags.append("advanced")

    seen, out = set(), []
    for t in tags:
        if t not in seen:
            seen.add(t)
            out.append(t)
    return out[:5]


def enrich():
    with open(FISH_FILE, encoding="utf-8") as f:
        catalog = json.load(f)

    fish_in = catalog.get("fish", [])
    missing = [f["id"] for f in fish_in if f["id"] not in ENRICH]
    if missing:
        raise SystemExit(f"No enrichment data for: {missing}")

    out = []
    for fish in fish_in:
        sci, genre, size, temperament, difficulty, water, pop, extra = ENRICH[fish["id"]]
        ph_lo, ph_hi, t_lo, t_hi = WATER[water]
        entry = {
            "id": fish["id"],
            "name": fish["name"],
            "scientific_name": sci,
            "image": fish.get("image", ""),
            "tags": derive_tags(genre, size, temperament, difficulty, water, extra),
            "min_tank_liters": min_tank_liters(size, genre),
            "temperament": temperament,
            "difficulty": difficulty,
            "ph_range": [ph_lo, ph_hi],
            "temp_range_c": [t_lo, t_hi],
            "adult_size_cm": size,
            "popularity": pop,
        }
        if fish.get("imageCredit"):
            entry["imageCredit"] = fish["imageCredit"]
        out.append(entry)

    with open(FISH_FILE, "w", encoding="utf-8") as f:
        json.dump({"fish": out}, f, ensure_ascii=False, indent=2)
        f.write("\n")

    # Report theme eligibility (>=10 fish sharing a tag can be a Daily Battle theme).
    from collections import Counter

    counts = Counter(t for fish in out for t in fish["tags"])
    print(f"Wrote {len(out)} fish to {FISH_FILE}")
    print("Theme-eligible tags (>=10):")
    for tag, n in counts.most_common():
        if n >= 10:
            print(f"  {n:3}  {tag}")


if __name__ == "__main__":
    enrich()
