let state = { categories: [], products: [], productIndex: [], promo: [], selectedCategory: null, indexLoaded: false };
let titleRequestSeq = 0;
let stockRequestSeq = 0;
const $ = (id) => document.getElementById(id);

function toast(msg) {
  const t = $("toast");
  t.textContent = msg;
  t.classList.add("show");
  setTimeout(() => t.classList.remove("show"), 3600);
}

function status(msg, type = "warn") {
  const box = $("statusBox");
  box.textContent = msg;
  box.className = `status ${type}`;
}

function clearStatus() {
  const box = $("statusBox");
  box.textContent = "";
  box.className = "status hidden";
}

async function api(path, opts = {}) {
  const r = await fetch(path, opts);
  if (!r.ok) {
    let e;
    try {
      e = await r.json();
    } catch {
      e = { detail: r.statusText };
    }
    throw new Error(e.detail || r.statusText);
  }
  return r.json();
}

function debounce(fn, wait = 220) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), wait);
  };
}

async function init() {
  try {
    const data = await api("/api/bootstrap");
    clearStatus();
    $("dbBadge").textContent = data.db;
    state.categories = data.categories || [];
    state.products = data.products || [];
    state.productIndex = state.products;
    state.promo = data.promo_slides || [];
    renderCategories();
    renderProducts();
    fillCategorySelect();
    renderPromo();
    loadProductIndex();
  } catch (e) {
    status(
      "Nu pot incarca datele din Odoo: " +
        e.message +
        ". Verifica in container variabilele ODOO_URL, ODOO_DB, ODOO_USER si ODOO_PASSWORD."
    );
    $("categoryCount").textContent = "0 categorii incarcate";
    $("productCount").textContent = "0 produse incarcate";
    toast(e.message);
  }
}

document.querySelectorAll("nav button[data-tab]").forEach((btn) =>
  btn.addEventListener("click", () => {
    document.querySelectorAll("nav button[data-tab]").forEach((b) => b.classList.remove("active"));
    document.querySelectorAll(".tab").forEach((t) => t.classList.remove("active"));
    btn.classList.add("active");
    $("tab-" + btn.dataset.tab).classList.add("active");
  })
);

function renderCategories() {
  const q = ($("categorySearch").value || "").toLowerCase();
  const filtered = state.categories.filter((c) => (c.full_name || c.name).toLowerCase().includes(q));
  $("categoryCount").textContent = `${filtered.length} / ${state.categories.length} categorii`;
  $("categoryList").innerHTML = filtered
    .slice(0, 260)
    .map(
      (c) =>
        `<div class="item" data-cat="${c.id}"><strong>${esc(c.name)}</strong><small>${esc(
          c.full_name || ""
        )}</small></div>`
    )
    .join("");
  if (!filtered.length) {
    $("categoryList").innerHTML =
      '<div class="mini">Nu am gasit categorii. Daca lista e goala complet, lipsesc datele Odoo din container.</div>';
  }
  document.querySelectorAll("[data-cat]").forEach((el) => {
    el.onclick = () => {
      state.selectedCategory = Number(el.dataset.cat);
      $("categoryId").value = state.selectedCategory;
      toast("Categorie selectata");
    };
  });
}

function fillCategorySelect() {
  $("categoryId").innerHTML =
    '<option value="">Alege categoria</option>' +
    state.categories.map((c) => `<option value="${c.id}">${esc(c.full_name || c.name)}</option>`).join("");
}

function renderProducts(products = state.products) {
  $("productCount").textContent = `${products.length} produse afisate`;
  $("productList").innerHTML = products
    .map(
      (p) =>
        `<div class="item" data-product="${p.id}"><strong>${esc(p.name)}</strong><small>${esc(
          p.default_code || "fara cod"
        )}${p.stock_qty === undefined ? "" : " - stoc Odoo " + p.stock_qty}</small></div>`
    )
    .join("");
  if (!products.length) {
    $("productList").innerHTML = '<div class="mini">Scrie minim 2 caractere ca sa caut in produsele de pe site.</div>';
  }
  document.querySelectorAll("[data-product]").forEach((el) => (el.onclick = () => loadProduct(Number(el.dataset.product))));
}

async function loadProductIndex() {
  $("productCount").textContent = `${state.products.length} produse afisate - se incarca indexul complet...`;
  try {
    const data = await api("/api/product-index");
    state.productIndex = data.products || [];
    state.indexLoaded = true;
    $("productCount").textContent = `${state.productIndex.length} produse in index`;
    const q = $("productSearch").value.trim();
    renderProducts(q.length >= 2 ? localProductSearch(q, 120) : state.productIndex.slice(0, 120));
  } catch (err) {
    status("Nu pot incarca indexul complet de produse: " + err.message);
  }
}

function localProductSearch(query, limit = 40) {
  const q = normalize(query);
  if (!q) return state.productIndex.slice(0, limit);
  const tokens = q.split(" ").filter(Boolean);
  const scored = [];
  for (const product of state.productIndex) {
    const hay = normalize(`${product.name || ""} ${product.default_code || ""}`);
    if (!tokens.every((token) => hay.includes(token))) continue;
    let score = 0;
    if (normalize(product.name || "").startsWith(q)) score += 60;
    if (hay.includes(q)) score += 30;
    score -= Math.min(hay.length, 240) / 240;
    scored.push([score, product]);
  }
  return scored.sort((a, b) => b[0] - a[0] || String(a[1].name).localeCompare(String(b[1].name))).slice(0, limit).map((row) => row[1]);
}

async function loadProduct(id) {
  titleRequestSeq += 1;
  hideSuggestions();
  const p = await api("/api/products/" + id);
  $("productId").value = p.id;
  $("title").value = p.name || "";
  $("sku").value = p.default_code || "";
  $("price").value = p.list_price || "";
  $("quantity").value = p.stock_qty || 0;
  $("stockSource").textContent = p.stock_source || "Stoc citit din Odoo dupa selectarea produsului";
  $("categoryId").value = (p.public_categ_ids && p.public_categ_ids[0]) || "";
  $("shortDescription").value = p.description_sale || "";
  $("description").value = p.website_description || "";
  $("preview").innerHTML = card(p);
  toast("Produs incarcat");
}

$("categorySearch").addEventListener("input", renderCategories);
$("productSearch").addEventListener(
  "input",
  debounce((e) => {
    const q = e.target.value.trim();
    if (q.length < 2) {
      renderProducts((state.indexLoaded ? state.productIndex : state.products).slice(0, 120));
      return;
    }
    renderProducts(localProductSearch(q, 120));
  }, 80)
);

const titleSearch = debounce(async () => {
  const q = $("title").value.trim();
  const seq = ++titleRequestSeq;
  $("productId").value = "";
  if (q.length < 2) {
    hideSuggestions();
    return;
  }
  if (seq !== titleRequestSeq || $("title").value.trim() !== q) return;
  renderTitleSuggestions(localProductSearch(q, 25));
}, 70);

$("title").addEventListener("input", titleSearch);
$("title").addEventListener("focus", () => {
  if ($("title").value.trim().length >= 2) titleSearch();
});
$("title").addEventListener("keydown", (ev) => {
  if (ev.key === "Escape") hideSuggestions();
});
document.addEventListener("click", (ev) => {
  if (!ev.target.closest(".suggest-wrap")) hideSuggestions();
});

function renderTitleSuggestions(products) {
  const box = $("titleSuggestions");
  if (!products.length) {
    box.innerHTML = '<div class="mini">Nu exista produs cu acest titlu. Poti crea unul nou.</div>';
    box.classList.remove("hidden");
    return;
  }
  box.innerHTML = products
    .map(
      (p) => `<div class="suggest-item" data-suggest-product="${p.id}">
    <img src="${esc(p.image_url || "")}" alt="" onerror="this.style.visibility='hidden'">
    <span><strong>${esc(p.name)}</strong><small>${esc(p.default_code || "fara cod")} - pret ${p.list_price ?? ""} - <span data-suggest-stock="${p.id}">stoc...</span></small></span>
  </div>`
    )
    .join("");
  box.classList.remove("hidden");
  document
    .querySelectorAll("[data-suggest-product]")
    .forEach((el) => (el.onclick = () => {
      hideSuggestions();
      loadProduct(Number(el.dataset.suggestProduct));
    }));
  hydrateSuggestionStocks(products.map((p) => p.id));
}

function hideSuggestions() {
  $("titleSuggestions").classList.add("hidden");
}

async function hydrateSuggestionStocks(ids) {
  const seq = ++stockRequestSeq;
  const unique = [...new Set(ids)].slice(0, 25);
  if (!unique.length) return;
  try {
    const data = await api("/api/product-stocks?ids=" + unique.join(","));
    if (seq !== stockRequestSeq) return;
    for (const [id, qty] of Object.entries(data.stocks || {})) {
      document.querySelectorAll(`[data-suggest-stock="${id}"]`).forEach((el) => {
        el.textContent = `stoc Odoo ${qty}`;
      });
    }
  } catch {
    if (seq !== stockRequestSeq) return;
    unique.forEach((id) => {
      document.querySelectorAll(`[data-suggest-stock="${id}"]`).forEach((el) => {
        el.textContent = "stoc indisponibil";
      });
    });
  }
}

function draft() {
  return {
    product_id: num($("productId").value),
    title: $("title").value.trim(),
    sku: $("sku").value.trim() || null,
    category_id: num($("categoryId").value),
    category_name: $("categoryName").value.trim() || null,
    description: $("description").value,
    short_description: $("shortDescription").value,
    price: num($("price").value),
    quantity: num($("quantity").value),
    image_urls: $("imageUrls").value.split(/\n+/).map((x) => x.trim()).filter(Boolean),
    sync_to_swan: $("syncToSwan").checked,
    publish: $("publish").checked,
  };
}

$("previewBtn").onclick = async () => {
  const res = await api("/api/preview", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(draft()),
  });
  renderPreview(res);
};

$("productForm").onsubmit = async (ev) => {
  ev.preventDefault();
  const fd = new FormData();
  fd.append("draft_json", JSON.stringify(draft()));
  [...$("images").files].forEach((f) => fd.append("images", f));
  const res = await api("/api/apply", { method: "POST", body: fd });
  $("productId").value = res.product.id;
  $("preview").innerHTML =
    card(res.product) + `<div class="diff">Salvat: ${res.product.action}${res.swan ? "\\nSwan: " + JSON.stringify(res.swan, null, 2) : ""}</div>`;
  toast("Produs salvat");
};

function renderPreview(res) {
  $("preview").innerHTML = card(res.proposed) + `<div class="diff">Mod: ${res.mode}\n${res.warnings.join("\n")}\n\nCurent:\n${JSON.stringify(res.current, null, 2)}</div>`;
}

function card(p) {
  const img = p.image_url || p.image_urls?.[0] || "";
  return `<div class="product-card">${img ? `<img src="${esc(img)}">` : ""}<div class="body"><h3>${esc(
    p.name || p.title || ""
  )}</h3><div class="price">${p.list_price ?? p.price ?? ""} lei</div><p>${p.stock_qty !== undefined ? "Stoc Odoo: " + p.stock_qty : ""}</p><div>${
    p.website_description || p.description || ""
  }</div></div></div>`;
}

$("excelPreviewBtn").onclick = () => excel("/api/excel/preview");
$("excelApplyBtn").onclick = () => excel("/api/excel/apply");
async function excel(url) {
  const f = $("excelFile").files[0];
  if (!f) return toast("Alege fisier Excel");
  const fd = new FormData();
  fd.append("file", f);
  const res = await api(url, { method: "POST", body: fd });
  $("excelResult").innerHTML = `<pre>${esc(JSON.stringify(res, null, 2))}</pre>`;
}

$("siteScrapeBtn").onclick = async () => {
  const res = await api("/api/site/scrape", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url: $("siteUrl").value, codes: $("siteCodes").value }),
  });
  $("siteResult").innerHTML = `<pre>${esc(JSON.stringify(res, null, 2))}</pre>`;
  const first = res.matches?.[0] || res;
  if (first.title) {
    $("title").value = first.title;
    $("description").value = first.description || "";
    $("imageUrls").value = (first.image_urls || []).join("\n");
    toast("Datele au fost puse in formularul manual");
  }
};

$("syncSwanBtn").onclick = async () => {
  const res = await api("/api/swan/sync", { method: "POST" });
  toast(`Swan: ${res.fetched} produse, ${res.matched.length} gasite, ${res.missing.length} lipsa`);
  console.log(res);
};

function renderPromo() {
  $("promoSlides").innerHTML = state.promo
    .map(
      (s, i) => `<div class="promo-row">
    <label>Titlu<input data-promo-title="${i}" value="${esc(s.title || "")}"></label>
    <label>Link<input data-promo-link="${i}" value="${esc(s.link || "/shop")}"></label>
    <label>Imagine<input data-promo-file="${i}" type="file" accept="image/*"></label>
  </div>`
    )
    .join("");
}

$("promoSaveBtn").onclick = async () => {
  const slides = readPromo();
  await api("/api/promo", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(slides) });
  toast("Reclame salvate local");
};

$("promoApplyBtn").onclick = async () => {
  const fd = new FormData();
  fd.append("slides_json", JSON.stringify(readPromo()));
  document.querySelectorAll("[data-promo-file]").forEach((inp) => {
    if (inp.files[0]) fd.append("images", inp.files[0]);
  });
  const res = await api("/api/promo/apply", { method: "POST", body: fd });
  $("promoResult").innerHTML = `<pre>${esc(JSON.stringify(res, null, 2))}</pre>`;
  toast("Reclame aplicate");
};

function readPromo() {
  return state.promo.map((s, i) => ({
    title: document.querySelector(`[data-promo-title="${i}"]`).value,
    link: document.querySelector(`[data-promo-link="${i}"]`).value,
    image_url: s.image_url,
    attachment_id: s.attachment_id,
  }));
}

function num(v) {
  return v === "" || v === null ? null : Number(v);
}

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (m) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[m]));
}

function normalize(s) {
  return String(s || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

init();

