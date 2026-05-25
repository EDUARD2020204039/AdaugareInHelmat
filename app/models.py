from typing import Any

from pydantic import BaseModel, Field


class CategoryIn(BaseModel):
    id: int | None = None
    name: str | None = None
    parent_id: int | None = None


class ProductDraft(BaseModel):
    product_id: int | None = None
    title: str
    sku: str | None = None
    category_id: int | None = None
    category_name: str | None = None
    new_category_parent_id: int | None = None
    description: str | None = None
    short_description: str | None = None
    price: float | None = None
    quantity: float | None = None
    image_urls: list[str] = Field(default_factory=list)
    sync_to_swan: bool = False
    publish: bool = True


class PreviewResult(BaseModel):
    mode: str
    warnings: list[str]
    current: dict[str, Any] | None
    proposed: dict[str, Any]


class PromoSlide(BaseModel):
    title: str = "Promotie"
    link: str = "/shop"
    image_url: str | None = None
    attachment_id: int | None = None


class SwanProduct(BaseModel):
    sku: str
    name: str = ""
    price: float = 0.0
    quantity: float = 0.0
