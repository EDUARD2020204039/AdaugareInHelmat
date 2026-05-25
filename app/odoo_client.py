import base64
import binascii
import mimetypes
import re
import xmlrpc.client
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

import requests

from .models import ProductDraft
from .settings import settings


class OdooError(RuntimeError):
    pass


class OdooClient:
    def __init__(self) -> None:
        if not settings.odoo_password:
            raise OdooError("ODOO_PASSWORD lipseste din .env")
        self.url = settings.odoo_url.rstrip("/")
        self.db = settings.odoo_db
        self.user = settings.odoo_user
        self.password = settings.odoo_password
        self.common = xmlrpc.client.ServerProxy(f"{self.url}/xmlrpc/2/common", allow_none=True)
        self.models = xmlrpc.client.ServerProxy(f"{self.url}/xmlrpc/2/object", allow_none=True)
        self.uid = self.common.authenticate(self.db, self.user, self.password, {})
        if not self.uid:
            raise OdooError("Autentificarea in Odoo a esuat")

    def call(self, model: str, method: str, *args: Any, **kwargs: Any) -> Any:
        return self.models.execute_kw(self.db, self.uid, self.password, model, method, list(args), kwargs or {})

    def search_read(self, model: str, domain: list, fields: list[str], limit: int = 80, order: str | None = None) -> list:
        kwargs: dict[str, Any] = {"fields": fields, "limit": limit}
        if order:
            kwargs["order"] = order
        return self.call(model, "search_read", domain, **kwargs)

    def categories(self) -> list[dict[str, Any]]:
        rows = self.search_read(
            "product.public.category",
            [],
            ["id", "name", "parent_id", "sequence"],
            limit=5000,
            order="parent_id, sequence, name",
        )
        by_id = {row["id"]: row for row in rows}
        for row in rows:
            parent = row.get("parent_id")
            path = [row["name"]]
            while parent:
                parent_id = parent[0] if isinstance(parent, list) else parent
                parent_row = by_id.get(parent_id)
                if not parent_row:
                    break
                path.append(parent_row["name"])
                parent = parent_row.get("parent_id")
            row["full_name"] = " / ".join(reversed(path))
        return sorted(rows, key=lambda r: r["full_name"].lower())

    def products(self, query: str = "", limit: int = 50, include_stock: bool = False) -> list[dict[str, Any]]:
        domain: list[Any] = [("sale_ok", "=", True)]
        if query:
            domain += ["|", "|", ("name", "ilike", query), ("default_code", "ilike", query), ("barcode", "ilike", query)]
        rows = self.search_read(
            "product.template",
            domain,
            ["id", "name", "default_code", "list_price", "public_categ_ids", "image_1920", "website_published"],
            limit=limit,
            order="name",
        )
        for row in rows:
            row["image_url"] = f"/api/products/{row['id']}/image"
            if include_stock:
                row["stock_qty"] = self.stock_for_template(row["id"])
        return rows

    def product_index(self, limit: int = 20000) -> list[dict[str, Any]]:
        rows = self.search_read(
            "product.template",
            [("sale_ok", "=", True)],
            ["id", "name", "default_code", "list_price", "public_categ_ids", "website_published"],
            limit=limit,
            order="name",
        )
        for row in rows:
            row["image_url"] = f"/api/products/{row['id']}/image"
        return rows

    def product(self, product_id: int) -> dict[str, Any]:
        rows = self.search_read(
            "product.template",
            [("id", "=", product_id)],
            [
                "id",
                "name",
                "default_code",
                "list_price",
                "description_sale",
                "website_description",
                "public_categ_ids",
                "website_published",
                "product_variant_id",
            ],
            limit=1,
        )
        if not rows:
            raise OdooError(f"Produsul {product_id} nu exista")
        row = rows[0]
        row["image_url"] = f"/api/products/{row['id']}/image"
        row["stock_qty"] = self.stock_for_template(row["id"])
        row["stock_source"] = f"Odoo stock.quant, locatia {settings.odoo_stock_location_name}"
        return row

    def find_by_sku(self, sku: str) -> dict[str, Any] | None:
        sku = (sku or "").strip()
        if not sku:
            return None
        rows = self.search_read(
            "product.template",
            ["|", ("default_code", "=", sku), ("product_variant_ids.default_code", "=", sku)],
            ["id", "name", "default_code", "list_price", "public_categ_ids", "website_published", "product_variant_id"],
            limit=1,
        )
        if not rows:
            return None
        rows[0]["stock_qty"] = self.stock_for_template(rows[0]["id"])
        rows[0]["stock_source"] = f"Odoo stock.quant, locatia {settings.odoo_stock_location_name}"
        rows[0]["image_url"] = f"/api/products/{rows[0]['id']}/image"
        return rows[0]

    def stock_for_template(self, product_tmpl_id: int) -> float:
        try:
            tmpl = self.search_read("product.template", [("id", "=", product_tmpl_id)], ["product_variant_id"], limit=1)
            if not tmpl or not tmpl[0].get("product_variant_id"):
                return 0.0
            variant_id = tmpl[0]["product_variant_id"][0]
            location_id = self.stock_location_id()
            domain = [("product_id", "=", variant_id), ("location_id", "=", location_id)]
            quants = self.search_read("stock.quant", domain, ["quantity"], limit=1000)
            return float(sum(q.get("quantity") or 0 for q in quants))
        except Exception:
            return 0.0

    def stocks_for_templates(self, product_tmpl_ids: list[int]) -> dict[str, float]:
        if not product_tmpl_ids:
            return {}
        templates = self.search_read(
            "product.template",
            [("id", "in", product_tmpl_ids)],
            ["id", "product_variant_id"],
            limit=len(product_tmpl_ids),
        )
        variant_to_template: dict[int, int] = {}
        for tmpl in templates:
            variant = tmpl.get("product_variant_id")
            if variant:
                variant_to_template[int(variant[0])] = int(tmpl["id"])
        result = {str(pid): 0.0 for pid in product_tmpl_ids}
        if not variant_to_template:
            return result
        location_id = self.stock_location_id()
        quants = self.search_read(
            "stock.quant",
            [("product_id", "in", list(variant_to_template)), ("location_id", "=", location_id)],
            ["product_id", "quantity"],
            limit=5000,
        )
        for quant in quants:
            product = quant.get("product_id")
            if not product:
                continue
            variant_id = int(product[0])
            tmpl_id = variant_to_template.get(variant_id)
            if tmpl_id:
                result[str(tmpl_id)] = result.get(str(tmpl_id), 0.0) + float(quant.get("quantity") or 0)
        return result

    def product_image(self, product_tmpl_id: int) -> tuple[bytes, str] | None:
        rows = self.search_read("product.template", [("id", "=", product_tmpl_id)], ["image_512", "image_1920", "product_variant_id"], limit=1)
        if not rows:
            return None
        image_b64 = rows[0].get("image_512") or rows[0].get("image_1920")
        if not image_b64 and rows[0].get("product_variant_id"):
            variant_id = rows[0]["product_variant_id"][0]
            variants = self.search_read("product.product", [("id", "=", variant_id)], ["image_512", "image_1920"], limit=1)
            if variants:
                image_b64 = variants[0].get("image_512") or variants[0].get("image_1920")
        if not image_b64:
            extras = self.search_read("product.image", [("product_tmpl_id", "=", product_tmpl_id)], ["image_512", "image_1920"], limit=1)
            if extras:
                image_b64 = extras[0].get("image_512") or extras[0].get("image_1920")
        if not image_b64:
            return None
        try:
            data = base64.b64decode(image_b64)
        except (binascii.Error, TypeError):
            return None
        return data, _guess_image_mimetype(data)

    def stock_location_id(self) -> int:
        rows = self.search_read(
            "stock.location",
            ["|", ("complete_name", "=", settings.odoo_stock_location_name), ("name", "=", settings.odoo_stock_location_name)],
            ["id"],
            limit=1,
        )
        if rows:
            return rows[0]["id"]
        rows = self.search_read("stock.location", [("usage", "=", "internal")], ["id"], limit=1)
        if not rows:
            raise OdooError("Nu am gasit locatie interna de stoc in Odoo")
        return rows[0]["id"]

    def ensure_public_category(self, draft: ProductDraft) -> int | None:
        if draft.category_id:
            return draft.category_id
        name = (draft.category_name or "").strip()
        if not name:
            return None
        existing = self.search_read("product.public.category", [("name", "=", name)], ["id"], limit=1)
        if existing:
            return existing[0]["id"]
        vals: dict[str, Any] = {"name": name}
        if draft.new_category_parent_id:
            vals["parent_id"] = draft.new_category_parent_id
        return self.call("product.public.category", "create", vals)

    def preview(self, draft: ProductDraft) -> dict[str, Any]:
        current = self.product(draft.product_id) if draft.product_id else self.find_by_sku(draft.sku or "")
        mode = "update" if current else "create"
        category_id = draft.category_id
        warnings: list[str] = []
        if not category_id and draft.category_name:
            warnings.append(f"Categoria '{draft.category_name}' va fi creata daca nu exista.")
        if not category_id and not draft.category_name and not current:
            warnings.append("Produs nou fara categorie. Alege o categorie existenta sau scrie una noua.")
        proposed = draft.model_dump()
        proposed["category_id"] = category_id
        return {"mode": mode, "warnings": warnings, "current": current, "proposed": proposed}

    def save_product(self, draft: ProductDraft, image_files: list[Path] | None = None) -> dict[str, Any]:
        category_id = self.ensure_public_category(draft)
        current = self.product(draft.product_id) if draft.product_id else self.find_by_sku(draft.sku or "")
        vals: dict[str, Any] = {
            "name": draft.title.strip(),
            "sale_ok": True,
            "website_published": bool(draft.publish),
        }
        if draft.sku:
            vals["default_code"] = draft.sku.strip()
        if draft.price is not None:
            vals["list_price"] = float(draft.price)
        if draft.description:
            vals["description_sale"] = draft.description
            vals["website_description"] = draft.description
        if category_id:
            vals["public_categ_ids"] = [(6, 0, [category_id])]
        if image_files:
            vals["image_1920"] = self._file_to_b64(image_files[0])

        if current:
            product_id = current["id"]
            self.call("product.template", "write", [product_id], vals)
            action = "updated"
        else:
            vals.setdefault("type", "consu")
            vals.setdefault("is_storable", True)
            product_id = self.call("product.template", "create", vals)
            action = "created"

        if image_files:
            self._add_extra_images(product_id, image_files[1:])
        for url in draft.image_urls:
            image_data = self._download_b64(url)
            if image_data:
                if not image_files and url == draft.image_urls[0]:
                    self.call("product.template", "write", [product_id], {"image_1920": image_data})
                else:
                    self._create_product_image(product_id, Path(urlparse(url).path).name or "image.jpg", image_data)
        if draft.quantity is not None:
            self.set_stock(product_id, float(draft.quantity))

        saved = self.product(product_id)
        saved["action"] = action
        return saved

    def set_stock(self, product_tmpl_id: int, quantity: float) -> None:
        tmpl = self.product(product_tmpl_id)
        variant = tmpl.get("product_variant_id")
        if not variant:
            return
        variant_id = variant[0] if isinstance(variant, list) else variant
        location_id = self.stock_location_id()
        domain = [
            ("product_id", "=", variant_id),
            ("location_id", "=", location_id),
            ("lot_id", "=", False),
            ("package_id", "=", False),
            ("owner_id", "=", False),
        ]
        quant_ids = self.call("stock.quant", "search", domain, limit=1)
        vals = {"inventory_quantity": quantity}
        if quant_ids:
            self.call("stock.quant", "write", quant_ids, vals)
            quant_id = quant_ids[0]
        else:
            vals.update({"product_id": variant_id, "location_id": location_id})
            quant_id = self.call("stock.quant", "create", vals)
        self.call("stock.quant", "action_apply_inventory", [quant_id])

    def upload_attachment(self, path: Path, name: str | None = None) -> int:
        mimetype = mimetypes.guess_type(path.name)[0] or "application/octet-stream"
        return self.call(
            "ir.attachment",
            "create",
            {
                "name": name or path.name,
                "type": "binary",
                "datas": self._file_to_b64(path),
                "mimetype": mimetype,
                "public": True,
            },
        )

    def update_promo_view(self, slides: list[dict[str, Any]], view_id: int | None = None) -> None:
        target_id = view_id or settings.promo_view_id
        if not target_id:
            raise OdooError("Seteaza PROMO_VIEW_ID ca sa pot modifica reclama din Odoo.")
        view = self.call("ir.ui.view", "read", [target_id], fields=["arch_db"])[0]
        slides_html = []
        indicators = []
        for idx, slide in enumerate(slides):
            active = "active" if idx == 0 else ""
            img = slide.get("image_url") or f"/web/image/ir.attachment/{slide['attachment_id']}/datas"
            link = slide.get("link") or "/shop"
            title = slide.get("title") or f"Promotie {idx + 1}"
            slides_html.append(
                f'<div class="carousel-item {active}"><a href="{link}" class="helmat-promo-carousel__link">'
                f'<img src="{img}" alt="{title}" class="d-block w-100" loading="lazy"/></a></div>'
            )
            indicators.append(
                f'<button type="button" data-bs-target="#helmatPromoCarousel" data-bs-slide-to="{idx}" '
                f'class="{active}" aria-label="Slide {idx + 1}"/>'
            )
        arch = view["arch_db"]
        arch = re.sub(
            r'(<div class="carousel-inner">).*?(</div>\s*<button class="carousel-control-prev")',
            r"\1" + "\n".join(slides_html) + r"\2",
            arch,
            flags=re.S,
        )
        arch = re.sub(
            r'(<div class="carousel-indicators">).*?(</div>\s*</div>\s*</div>\s*</section>)',
            r"\1" + "\n".join(indicators) + r"\2",
            arch,
            flags=re.S,
        )
        self.call("ir.ui.view", "write", [target_id], {"arch_db": arch})

    def _add_extra_images(self, product_id: int, files: list[Path]) -> None:
        for path in files:
            self._create_product_image(product_id, path.name, self._file_to_b64(path))

    def _create_product_image(self, product_id: int, name: str, image_b64: str) -> None:
        try:
            self.call("product.image", "create", {"name": name, "product_tmpl_id": product_id, "image_1920": image_b64})
        except Exception:
            pass

    @staticmethod
    def _file_to_b64(path: Path) -> str:
        return base64.b64encode(path.read_bytes()).decode("ascii")

    @staticmethod
    def _download_b64(url: str) -> str | None:
        try:
            response = requests.get(url, timeout=20)
            response.raise_for_status()
            return base64.b64encode(response.content).decode("ascii")
        except Exception:
            return None


def _guess_image_mimetype(data: bytes) -> str:
    if data.startswith(b"\xff\xd8\xff"):
        return "image/jpeg"
    if data.startswith(b"\x89PNG\r\n\x1a\n"):
        return "image/png"
    if data.startswith(b"GIF87a") or data.startswith(b"GIF89a"):
        return "image/gif"
    if data.startswith(b"RIFF") and data[8:12] == b"WEBP":
        return "image/webp"
    return "image/png"
