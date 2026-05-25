import json
from datetime import datetime

import requests

from .models import ProductDraft, SwanProduct
from .settings import settings


class SwanClient:
    def configured(self) -> bool:
        return bool(settings.swan_api_url and settings.swan_bearer_token)

    def fetch_products(self, since: str = "2000-01-01 00:00:00") -> list[SwanProduct]:
        if not self.configured():
            return []
        payload = {"name": "get_api_pret_stoc", "param": {"data_insert": since, "data_update": since}}
        headers = {
            "Authorization": settings.swan_bearer_token,
            "Content-Type": "application/json",
            "Accept": "application/json",
            "User-Agent": "AdaugareInHelmat",
            "Connection": "close",
        }
        response = requests.post(settings.swan_api_url, data=json.dumps(payload), headers=headers, timeout=(10, 45))
        response.raise_for_status()
        data = response.json()
        products: list[SwanProduct] = []
        if not isinstance(data, list):
            return products
        for item in data:
            sku = str(item.get("product_code") or "").strip()
            if not sku:
                continue
            products.append(
                SwanProduct(
                    sku=sku,
                    name=(item.get("product_name") or "").strip(),
                    price=_float(item.get("pret_vanzare")),
                    quantity=_float(item.get("cantitate")),
                )
            )
        return products

    def by_sku(self, sku: str) -> SwanProduct | None:
        sku = (sku or "").strip()
        if not sku:
            return None
        for item in self.fetch_products():
            if item.sku == sku:
                return item
        return None

    def push_product(self, draft: ProductDraft, odoo_product_id: int | None = None) -> dict:
        if not settings.swan_push_api_url:
            return {"skipped": True, "reason": "SWAN_PUSH_API_URL nu este setat"}
        token = settings.swan_push_bearer_token or settings.swan_bearer_token
        payload = {
            "source": "AdaugareInHelmat",
            "sent_at": datetime.now().isoformat(),
            "odoo_product_id": odoo_product_id,
            "sku": draft.sku,
            "name": draft.title,
            "category": draft.category_name,
            "price": draft.price,
            "quantity": draft.quantity,
            "description": draft.description,
        }
        headers = {"Content-Type": "application/json", "Accept": "application/json"}
        if token:
            headers["Authorization"] = token
        response = requests.post(settings.swan_push_api_url, json=payload, headers=headers, timeout=(10, 45))
        response.raise_for_status()
        try:
            return response.json()
        except ValueError:
            return {"ok": True, "body": response.text[:1000]}


def _float(value: object) -> float:
    try:
        return float(value or 0)
    except (TypeError, ValueError):
        return 0.0
