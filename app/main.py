import json
import shutil
import threading
import time
from pathlib import Path
from typing import Annotated

from fastapi import Depends, FastAPI, File, Form, Header, HTTPException, UploadFile
from fastapi.responses import FileResponse, Response
from fastapi.staticfiles import StaticFiles

from .excel_importer import parse_excel
from .models import ProductDraft, PromoSlide
from .odoo_client import OdooClient, OdooError
from .promo_store import load_slides, save_slides
from .scraper import correlate_site_with_codes, scrape_product_page
from .settings import BASE_DIR, UPLOAD_DIR, settings
from .swan_client import SwanClient

app = FastAPI(title="AdaugareInHelmat", version="1.0.0")
app.mount("/static", StaticFiles(directory=BASE_DIR / "app" / "static"), name="static")

_PRODUCT_INDEX_CACHE: dict = {"at": 0.0, "products": []}
_PRODUCT_INDEX_TTL = 900


def require_admin(x_admin_token: Annotated[str | None, Header()] = None) -> None:
    if settings.admin_token and x_admin_token != settings.admin_token:
        raise HTTPException(status_code=401, detail="Token administrare invalid")


def odoo() -> OdooClient:
    try:
        return OdooClient()
    except OdooError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc


@app.get("/")
def index() -> FileResponse:
    return FileResponse(BASE_DIR / "app" / "static" / "index.html")


@app.get("/health")
def health() -> dict:
    return {"ok": True, "db": settings.odoo_db, "port": settings.app_port}


@app.get("/api/bootstrap")
def bootstrap(_: None = Depends(require_admin), client: OdooClient = Depends(odoo)) -> dict:
    categories = client.categories()
    products = client.products(limit=40, include_stock=False)
    return {
        "odoo_url": settings.odoo_url,
        "db": settings.odoo_db,
        "categories": categories,
        "products": products,
        "swan_configured": SwanClient().configured(),
        "promo_slides": _current_promo_slides(client),
    }


@app.get("/api/categories")
def categories(_: None = Depends(require_admin), client: OdooClient = Depends(odoo)) -> list:
    return client.categories()


@app.get("/api/products")
def products(
    q: str = "",
    limit: int = 80,
    include_stock: bool = False,
    _: None = Depends(require_admin),
    client: OdooClient = Depends(odoo),
) -> list:
    return client.products(q, limit=max(1, min(limit, 500)), include_stock=include_stock)


@app.get("/api/product-index")
def product_index(_: None = Depends(require_admin), client: OdooClient = Depends(odoo)) -> dict:
    products = _get_product_index(client)
    return {"count": len(products), "products": products}


@app.get("/api/products/{product_id}")
def product(
    product_id: int,
    include_stock: bool = False,
    _: None = Depends(require_admin),
    client: OdooClient = Depends(odoo),
) -> dict:
    return client.product(product_id, include_stock=include_stock)


@app.get("/api/product-stocks")
def product_stocks(
    ids: str,
    _: None = Depends(require_admin),
    client: OdooClient = Depends(odoo),
) -> dict:
    product_ids = []
    for raw in ids.split(","):
        try:
            product_ids.append(int(raw.strip()))
        except ValueError:
            continue
    product_ids = product_ids[:50]
    return {"stocks": client.stocks_for_templates(product_ids), "source": "Odoo stock.quant, locatia WH/Stock"}


@app.get("/api/products/{product_id}/image")
def product_image(product_id: int, client: OdooClient = Depends(odoo)) -> Response:
    image = client.product_image(product_id)
    if not image:
        raise HTTPException(status_code=404, detail="Produs fara imagine")
    data, mimetype = image
    return Response(content=data, media_type=mimetype, headers={"Cache-Control": "public, max-age=3600"})


@app.get("/api/promo/image/{attachment_id}")
def promo_image(attachment_id: int, client: OdooClient = Depends(odoo)) -> Response:
    image = client.attachment_image(attachment_id)
    if not image:
        raise HTTPException(status_code=404, detail="Reclama fara imagine")
    data, mimetype = image
    return Response(content=data, media_type=mimetype, headers={"Cache-Control": "public, max-age=3600"})


@app.get("/api/swan/stock/{sku}")
def swan_stock(sku: str, _: None = Depends(require_admin)) -> dict:
    item = SwanClient().by_sku(sku)
    if not item:
        return {"found": False, "sku": sku}
    return {"found": True, **item.model_dump()}


@app.post("/api/swan/sync")
def sync_swan(_: None = Depends(require_admin), client: OdooClient = Depends(odoo)) -> dict:
    swan = SwanClient()
    items = swan.fetch_products()
    matched = []
    missing = []
    for item in items:
        product = client.find_by_sku(item.sku)
        row = item.model_dump()
        if product:
            row["odoo_product_id"] = product["id"]
            row["odoo_name"] = product["name"]
            matched.append(row)
        else:
            missing.append(row)
    return {"fetched": len(items), "matched": matched[:500], "missing": missing[:500]}


@app.post("/api/preview")
def preview(draft: ProductDraft, _: None = Depends(require_admin), client: OdooClient = Depends(odoo)) -> dict:
    return client.preview(draft)


@app.post("/api/apply")
async def apply_product(
    draft_json: Annotated[str, Form()],
    images: Annotated[list[UploadFile], File()] = [],
    _: None = Depends(require_admin),
    client: OdooClient = Depends(odoo),
) -> dict:
    draft = ProductDraft(**json.loads(draft_json))
    image_paths = await _save_uploads(images)
    saved = client.save_product(draft, image_paths)
    swan_result = None
    if draft.sync_to_swan:
        swan_result = SwanClient().push_product(draft, saved.get("id"))
    return {"product": saved, "swan": swan_result}


@app.post("/api/excel/preview")
async def excel_preview(
    file: UploadFile,
    _: None = Depends(require_admin),
    client: OdooClient = Depends(odoo),
) -> dict:
    path = await _save_upload(file)
    rows = parse_excel(path)
    previews = []
    for row in rows[:200]:
        draft = ProductDraft(
            title=row.get("title") or row.get("sku") or "Produs fara titlu",
            sku=row.get("sku"),
            category_name=row.get("category_name"),
            description=row.get("description"),
            short_description=row.get("short_description"),
            price=row.get("price"),
            quantity=row.get("quantity"),
            image_urls=row.get("image_urls") or [],
        )
        previews.append(client.preview(draft))
    return {"rows": len(rows), "previews": previews}


@app.post("/api/excel/apply")
async def excel_apply(
    file: UploadFile,
    _: None = Depends(require_admin),
    client: OdooClient = Depends(odoo),
) -> dict:
    path = await _save_upload(file)
    rows = parse_excel(path)
    saved = []
    errors = []
    for row in rows:
        try:
            draft = ProductDraft(
                title=row.get("title") or row.get("sku") or "Produs fara titlu",
                sku=row.get("sku"),
                category_name=row.get("category_name"),
                description=row.get("description"),
                short_description=row.get("short_description"),
                price=row.get("price"),
                quantity=row.get("quantity"),
                image_urls=row.get("image_urls") or [],
                sync_to_swan=False,
            )
            saved.append(client.save_product(draft))
        except Exception as exc:
            errors.append({"row": row, "error": str(exc)})
    return {"saved": saved, "errors": errors}


@app.post("/api/site/scrape")
def site_scrape(payload: dict, _: None = Depends(require_admin)) -> dict:
    url = payload.get("url")
    if not url:
        raise HTTPException(status_code=400, detail="Lipseste url")
    codes = payload.get("codes") or []
    if isinstance(codes, str):
        codes = [c.strip() for c in codes.replace("\n", ",").split(",") if c.strip()]
    if codes:
        return {"matches": correlate_site_with_codes(url, codes)}
    return scrape_product_page(url)


@app.get("/api/promo")
def promo_get(_: None = Depends(require_admin), client: OdooClient = Depends(odoo)) -> list[dict]:
    return _current_promo_slides(client)


@app.post("/api/promo")
def promo_save(slides: list[PromoSlide], _: None = Depends(require_admin)) -> dict:
    save_slides(slides)
    return {"ok": True, "slides": [slide.model_dump() for slide in slides]}


@app.post("/api/promo/apply")
async def promo_apply(
    slides_json: Annotated[str, Form()],
    images: Annotated[list[UploadFile], File()] = [],
    _: None = Depends(require_admin),
    client: OdooClient = Depends(odoo),
) -> dict:
    slides = [PromoSlide(**item) for item in json.loads(slides_json)]
    image_paths = await _save_uploads(images)
    for fallback_idx, path in enumerate(image_paths):
        idx = _promo_upload_index(path.name, fallback_idx)
        if idx < len(slides):
            slides[idx].attachment_id = client.upload_attachment(path, slides[idx].title)
            slides[idx].image_url = None
    result = client.update_promo_view([slide.model_dump() for slide in slides])
    resolved_slides = [PromoSlide(**item) for item in result["slides"]]
    save_slides(resolved_slides)
    return {"ok": True, "slides": [slide.model_dump() for slide in resolved_slides], "view_ids": result["view_ids"]}


async def _save_upload(file: UploadFile) -> Path:
    target = UPLOAD_DIR / file.filename.replace("\\", "_").replace("/", "_")
    with target.open("wb") as handle:
        shutil.copyfileobj(file.file, handle)
    return target


async def _save_uploads(files: list[UploadFile]) -> list[Path]:
    paths = []
    for file in files:
        if file.filename:
            paths.append(await _save_upload(file))
    return paths


def _get_product_index(client: OdooClient) -> list[dict]:
    now = time.time()
    products = _PRODUCT_INDEX_CACHE.get("products") or []
    if products and now - float(_PRODUCT_INDEX_CACHE.get("at") or 0) < _PRODUCT_INDEX_TTL:
        return products
    products = client.product_index()
    _PRODUCT_INDEX_CACHE["products"] = products
    _PRODUCT_INDEX_CACHE["at"] = now
    return products


def _promo_upload_index(filename: str, fallback: int) -> int:
    prefix = filename.split("__", 1)[0]
    return int(prefix) if prefix.isdigit() else fallback


def _current_promo_slides(client: OdooClient) -> list[dict]:
    slides = client.promo_slides()
    if slides:
        parsed = [PromoSlide(**slide) for slide in slides]
        save_slides(parsed)
        return [slide.model_dump() for slide in parsed]
    return [slide.model_dump() for slide in load_slides()]


@app.on_event("startup")
def warm_product_index() -> None:
    def run() -> None:
        try:
            _get_product_index(OdooClient())
        except Exception:
            pass

    threading.Thread(target=run, daemon=True).start()
