# AdaugareInHelmat

Panou intern pentru completarea produselor din baza `helmat1`: imagini, descrieri, categorii, stoc, import Excel, import dupa site si reclame homepage.

## Pornire locala

```powershell
cd "C:\Users\JGL\Aplicatii HABA\AdaugareInHelmat"
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
Copy-Item .env.example .env
uvicorn app.main:app --host 0.0.0.0 --port 5005 --reload
```

Deschide `http://localhost:5005`.

## Docker

```powershell
docker build -t ghcr.io/unraidg5/adaugareinhelmat:latest .
docker run --env-file .env -p 5005:5005 ghcr.io/unraidg5/adaugareinhelmat:latest
```

Imaginea ceruta de workflow este `ghcr.io/unraidg5/adaugareinhelmat:latest`.

## Variabile importante

- `ODOO_URL`, `ODOO_DB`, `ODOO_USER`, `ODOO_PASSWORD`: conectare Odoo XML-RPC
- `SWAN_API_URL`, `SWAN_BEARER_TOKEN`: citire pret/stoc din Swan
- `SWAN_PUSH_API_URL`, `SWAN_PUSH_BEARER_TOKEN`: endpoint optional pentru impins produse noi spre Swan
- `SWAN_AUTO_SYNC_ENABLED=true`: porneste sincronizarea automata Swan -> Odoo
- `SWAN_AUTO_SYNC_HOUR=3`, `SWAN_AUTO_SYNC_MINUTE=0`, `SWAN_AUTO_SYNC_TIMEZONE=Europe/Bucharest`: ora zilnica de sincronizare
- `PROMO_VIEW_ID`: optional, id-ul view-ului Odoo care contine carousel-ul de reclame
- `ADMIN_TOKEN`: optional, daca e setat trebuie trimis header-ul `X-Admin-Token`

## Sincronizare Swan

Aplicatia ruleaza automat zilnic la `03:00 Europe/Bucharest` sincronizarea Swan -> Odoo. Aceeasi sincronizare poate fi pornita manual din butonul `Sincronizare Swan` sau prin `POST /api/swan/sync`.

Pentru produsele gasite dupa SKU/cod, sincronizarea actualizeaza pretul si stocul in Odoo. Produsele care exista in Swan, dar nu sunt gasite in Odoo, raman in raportul `missing`.

In interfata, stocul afisat in formular si in sugestii prefera Swan dupa SKU. Daca Swan nu este configurat sau SKU-ul nu este gasit in Swan, aplicatia foloseste fallback-ul Odoo `WH/Stock`.

## Excel

Coloane acceptate: `cod`, `sku`, `product_code`, `titlu`, `name`, `descriere`, `description`, `pret`, `price`, `cantitate`, `quantity`, `categorie`, `category`, `brand`, `image_url`.

Importul incearca intai potrivire dupa cod/SKU, apoi dupa titlu. Daca nu gaseste produsul si categoria exista sau este data, poate crea produs nou.
