let state = { categories: [], products: [], productIndex: [], promo: [], selectedCategory: null, indexLoaded: false, odooUrl: "" };
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
    state.odooUrl = (data.odoo_url || "").replace(/\/$/, "");
    state.categories = data.categories || [];
    state.products = data.products || [];
    state.productIndex = state.products;
    state.promo = data.promo_slides || [];
    renderCategories();
    renderProducts();
    fillCategorySelect();
    renderPromo();
    loadProductIndex();
    loadSwanStatus();
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
    $("productList").innerHTML = '<div class="mini">Scrie minim 2 caractere ca sa caut in catalogul complet.</div>';
  }
  document.querySelectorAll("[data-product]").forEach((el) => (el.onclick = () => loadProduct(el.dataset.product, findIndexedProduct(el.dataset.product))));
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

async function loadProduct(id, seed = null) {
  titleRequestSeq += 1;
  hideSuggestions();
  if (seed?.swan_only) {
    applyProductToForm(seed, true);
    toast("Produs preluat din Swan. Alege categoria si salveaza pentru a-l adauga pe site.");
    return;
  }
  if (seed) {
    applyProductToForm({ ...seed, stock_qty: undefined }, false);
    hydrateSelectedStock(id);
  }
  const p = await api("/api/products/" + id + "?include_stock=false");
  applyProductToForm(p, true);
  hydrateSelectedStock(id);
  toast("Produs incarcat");
}

function applyProductToForm(p, withDetails) {
  $("productId").value = p.swan_only ? "" : p.id;
  $("title").value = p.name || "";
  $("productPublishStatus").textContent = publishStatusText(p);
  $("sku").value = p.default_code || "";
  $("price").value = p.list_price || "";
  $("existingImageNote").textContent = p.swan_only
    ? "Produs din Swan. Adauga imagine daca vrei sa apara pe site."
    : p.id
    ? "Imaginea existenta se pastreaza automat. Incarca o imagine noua doar daca vrei sa o inlocuiesti."
    : "";
  if (p.stock_qty !== undefined) {
    $("quantity").value = p.stock_qty || 0;
    $("stockSource").textContent = p.stock_source || (p.swan_only ? "Stoc citit din Swan" : "Stoc citit din Odoo dupa selectarea produsului");
  } else if (!withDetails) {
    $("quantity").value = "";
    $("stockSource").textContent = "Se incarca stocul Odoo...";
  }
  $("categoryId").value = (p.public_categ_ids && p.public_categ_ids[0]) || "";
  if (withDetails) $("description").value = stripHtml(p.website_description || p.description_sale || "");
  $("preview").innerHTML = card(p);
}

async function hydrateSelectedStock(id) {
  try {
    const data = await api("/api/product-stocks?ids=" + id);
    const qty = data.stocks && data.stocks[String(id)];
    if ($("productId").value !== String(id)) return;
    const source = data.sources?.[String(id)] || data.source || "Odoo WH/Stock";
    $("quantity").value = qty ?? 0;
    $("stockSource").textContent = source;
    const current = {
      id,
      name: $("title").value,
      default_code: $("sku").value,
      list_price: num($("price").value),
      stock_qty: qty ?? 0,
      stock_source: source,
      image_url: `/api/products/${id}/image`,
      description: $("description").value,
    };
    $("preview").innerHTML = card(current);
  } catch {
    if ($("productId").value === String(id)) $("stockSource").textContent = "Stoc indisponibil";
  }
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
  $("productPublishStatus").textContent = "";
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
$("titleSuggestions").addEventListener("pointerdown", (ev) => {
  const item = ev.target.closest("[data-suggest-product]");
  if (!item) return;
  ev.preventDefault();
  ev.stopPropagation();
  hideSuggestions();
  loadProduct(item.dataset.suggestProduct, findIndexedProduct(item.dataset.suggestProduct));
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
    <span><strong>${esc(p.name)}</strong><small>${esc(p.default_code || "fara cod")} - ${p.swan_only ? "Swan" : p.website_published ? "pe site" : "nepublicat"} - pret ${
        p.list_price ?? ""
      } - <span data-suggest-stock="${p.id}">${p.swan_only ? "stoc Swan " + (p.stock_qty ?? 0) : "stoc..."}</span></small></span>
  </div>`
    )
    .join("");
  box.classList.remove("hidden");
  hydrateSuggestionStocks(products.filter((p) => !p.swan_only).map((p) => p.id));
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
        const source = data.sources?.[String(id)] || data.source || "Odoo WH/Stock";
        el.textContent = `${source.startsWith("Swan") ? "stoc Swan" : "stoc Odoo"} ${qty}`;
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
    short_description: $("description").value,
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
  const mode = $("productId").value ? "update" : "create";
  $("preview").innerHTML = card(draft()) + `<div class="diff">Mod ${mode}: se trimite catre site...</div>`;
  const fd = new FormData();
  fd.append("draft_json", JSON.stringify(draft()));
  [...$("images").files].forEach((f) => fd.append("images", f));
  try {
    const res = await api("/api/apply", { method: "POST", body: fd });
    $("productId").value = res.product.id;
    const savedMode = res.product.action === "updated" ? "update" : "create";
    const extra = res.product.stock_error ? `<div class="diff">Produs salvat, dar stocul nu s-a putut actualiza: ${esc(res.product.stock_error)}</div>` : "";
    $("preview").innerHTML = card(res.product) + `<div class="diff">Mod ${savedMode}: succes la trimitere pe site</div>` + extra;
    toast("Produs salvat");
  } catch (err) {
    $("preview").innerHTML = card(draft()) + `<div class="diff">Eroare la trimitere: ${esc(err.message)}</div>`;
    toast("Eroare la salvare");
  }
};

function renderPreview(res) {
  const proposed = {
    ...res.proposed,
    image_url: res.current?.image_url || res.proposed.image_urls?.[0] || "",
    stock_qty: res.current?.stock_qty,
  };
  const warnings = (res.warnings || []).length ? `<div class="diff">${esc(res.warnings.join("\n"))}</div>` : "";
  $("preview").innerHTML = card(proposed) + `<div class="diff">Mod ${res.mode}: succes la preview</div>` + warnings;
}

function card(p) {
  const img = p.image_url || p.image_urls?.[0] || "";
  const stockLabel = p.stock_source ? p.stock_source.replace(" dupa SKU", "") : "Stoc";
  return `<div class="product-card">${img ? `<img src="${esc(img)}">` : ""}<div class="body"><h3>${esc(
    p.name || p.title || ""
  )}</h3><div class="price">${p.list_price ?? p.price ?? ""} lei</div><p>${p.stock_qty !== undefined ? esc(stockLabel) + ": " + p.stock_qty : ""}</p><div>${
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
  $("swanStatus").textContent = "Swan automat: sincronizare manuala in curs...";
  const res = await api("/api/swan/sync", { method: "POST" });
  const updated = res.updated_count ?? res.updated?.length ?? 0;
  const missing = res.missing_count ?? res.missing?.length ?? 0;
  const errors = res.error_count ?? res.errors?.length ?? 0;
  toast(`Swan: ${res.fetched} produse, ${updated} actualizate, ${missing} lipsa, ${errors} erori`);
  loadSwanStatus();
  console.log(res);
};

async function loadSwanStatus() {
  try {
    const res = await api("/api/swan/status");
    const next = res.next_run ? new Date(res.next_run).toLocaleString("ro-RO") : "oprit";
    const last = res.last?.finished_at ? new Date(res.last.finished_at).toLocaleString("ro-RO") : "inca nu a rulat";
    const updated = res.last?.updated_count ?? 0;
    const errors = res.last?.error_count ?? 0;
    $("swanStatus").textContent = `Swan automat: ${res.auto_enabled ? "pornit" : "oprit"} la ${String(res.hour).padStart(2, "0")}:${String(
      res.minute
    ).padStart(2, "0")} ${res.timezone}. Urmatoarea rulare: ${next}. Ultima: ${last}, ${updated} actualizate, ${errors} erori.`;
  } catch (err) {
    $("swanStatus").textContent = "Swan automat: status indisponibil";
  }
}

function renderPromo() {
  $("promoSlides").innerHTML = state.promo
    .map(
      (s, i) => `<div class="promo-row">
    <label>Titlu<input data-promo-title="${i}" value="${esc(s.title || "")}"></label>
    <label>Link<input data-promo-link="${i}" value="${esc(s.link || "/shop")}"></label>
    <label>Imagine<input data-promo-file="${i}" type="file" accept="image/*">
      <span class="promo-note">${promoImageSrc(s.image_url) ? "Imaginea existenta se pastreaza daca nu alegi alta." : "Alege imagine pentru reclama."}</span>
      ${promoImageSrc(s.image_url) ? `<img class="promo-thumb" src="${esc(promoImageSrc(s.image_url))}" alt="">` : ""}
    </label>
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
    if (inp.files[0]) fd.append("images", inp.files[0], `${inp.dataset.promoFile}__${inp.files[0].name}`);
  });
  $("promoResult").innerHTML = '<div class="mini">Se aplica reclamele pe site...</div>';
  try {
    const res = await api("/api/promo/apply", { method: "POST", body: fd });
    state.promo = res.slides || state.promo;
    renderPromo();
    $("promoResult").innerHTML = `<div class="mini">Reclame aplicate pe site. View-uri actualizate: ${esc((res.view_ids || []).join(", "))}</div>`;
    toast("Reclame aplicate");
  } catch (err) {
    $("promoResult").innerHTML = `<div class="mini">Eroare la aplicarea reclamelor: ${esc(err.message)}</div>`;
    toast("Eroare reclame");
  }
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

function findIndexedProduct(id) {
  return state.productIndex.find((p) => String(p.id) === String(id)) || state.products.find((p) => String(p.id) === String(id)) || null;
}

function stripHtml(html) {
  const div = document.createElement("div");
  div.innerHTML = html || "";
  return div.textContent || div.innerText || "";
}

function promoImageSrc(src) {
  if (!src) return "";
  const attachmentMatch = String(src).match(/\/web\/image\/ir\.attachment\/(\d+)\//);
  if (attachmentMatch) return `/api/promo/image/${attachmentMatch[1]}`;
  if (/^https?:\/\//i.test(src)) return src;
  return state.odooUrl ? state.odooUrl + src : src;
}

function publishStatusText(p) {
  if (p.swan_only) return "Produs din Swan: nu este inca publicat pe site.";
  if (!p.id) return "";
  return p.website_published ? "Produs publicat pe site." : "Produs nepublicat pe site.";
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

