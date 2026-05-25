import json
from pathlib import Path

from .models import PromoSlide
from .settings import DATA_DIR


PROMO_FILE = DATA_DIR / "promo_slides.json"


def load_slides() -> list[PromoSlide]:
    if not PROMO_FILE.exists():
        return [
            PromoSlide(title="Promotie 1", link="/shop"),
            PromoSlide(title="Promotie 2", link="/shop"),
            PromoSlide(title="Promotie 3", link="/shop"),
        ]
    data = json.loads(PROMO_FILE.read_text(encoding="utf-8"))
    return [PromoSlide(**item) for item in data]


def save_slides(slides: list[PromoSlide]) -> None:
    PROMO_FILE.write_text(json.dumps([s.model_dump() for s in slides], ensure_ascii=False, indent=2), encoding="utf-8")
