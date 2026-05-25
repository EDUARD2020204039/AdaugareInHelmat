from urllib.parse import urljoin

import requests
from bs4 import BeautifulSoup


def scrape_product_page(url: str) -> dict:
    response = requests.get(url, timeout=30, headers={"User-Agent": "AdaugareInHelmat/1.0"})
    response.raise_for_status()
    soup = BeautifulSoup(response.text, "html.parser")
    title = _first(
        soup.select_one("meta[property='og:title']"),
        soup.select_one("h1"),
        soup.select_one("title"),
        attr="content",
    )
    description = _first(
        soup.select_one("meta[name='description']"),
        soup.select_one("meta[property='og:description']"),
        attr="content",
    )
    images = []
    for selector in ["meta[property='og:image']", "img"]:
        for tag in soup.select(selector):
            src = tag.get("content") or tag.get("src") or tag.get("data-src")
            if src:
                full = urljoin(url, src)
                if full not in images:
                    images.append(full)
            if len(images) >= 8:
                break
    codes = _extract_codes(soup.get_text(" ", strip=True))
    return {"source_url": url, "title": title, "description": description, "image_urls": images, "codes": codes}


def correlate_site_with_codes(url: str, codes: list[str]) -> list[dict]:
    page = scrape_product_page(url)
    text = " ".join([page.get("title") or "", page.get("description") or "", " ".join(page.get("codes") or [])]).lower()
    matches = []
    for code in codes:
        if code and code.lower() in text:
            matches.append({"sku": code, **page})
    return matches


def _first(*tags, attr: str | None = None) -> str:
    for tag in tags:
        if not tag:
            continue
        value = tag.get(attr) if attr and tag.has_attr(attr) else tag.get_text(" ", strip=True)
        if value:
            return " ".join(value.split())
    return ""


def _extract_codes(text: str) -> list[str]:
    import re

    candidates = re.findall(r"\b[A-Z0-9][A-Z0-9._/-]{3,24}\b", text.upper())
    seen = []
    for code in candidates:
        if code not in seen:
            seen.append(code)
    return seen[:100]
