# Implementation Plan: Tela de Conferência de Adesões

**Goal:** Create a complete "Conferência de Adesões" screen in the Intranet Rede Saúde portal where Monaliza can see all adhesion data pre-loaded, validated against S4E, and organized by batch (lote), without manual lookup work.

**Workflow:** The system will fetch daily batches from S4E, cross-reference company codes, entry dates, and life parcels with contract data, and display validation status for each batch. Web data goes to the frontend; CRM-specific logic stays in the backend.

---

## 1. Database Schema: Add `adesoes` Table and Validation Status

**What to do:**  
Add a new table `adesoes` to store adhesion batch records with validation metadata. This table will hold the data fetched from S4E (which contains "Entrada de Contratos" batches) plus conferencing results. Columns include: id, lote (batch code), empresa (company), data_entrada (entry date), vidas (life count), valor (value), tipo (web/crm), situacao (status), conference_status (pending/validated/error), conference_result (JSON with findings), conferido_em (timestamp).

**Files to create or modify:**  
- `schema.sql` — Add table definition

**How to verify:**  
Execute `python -c "import sqlite3; conn = sqlite3.connect('portal.db'); cursor = conn.execute(\"PRAGMA table_info(adesoes)\"); print(list(cursor)); conn.close()"` and confirm all columns exist with correct types. Alternatively, open portal.db with SQLite browser and verify the table schema.

---

## 2. Backend: Create S4E Integration Function for Adhesions

**What to do:**  
In `s4e_connector.py`, add a new function `fetch_adesoes_by_day(http_session, date_iso)` that retrieves "Entrada de Contratos" (contract entry) data from S4E for a specific day. The function should parse the S4E report and extract: lote (batch ID), empresa (company name/code), data_entrada (entry date), quantidade_vidas (life count), valor_total (total value), and tipo (WEB or CRM). Follow the existing pattern in `fetch_faturamento_rows()` for HTTP session management and error handling.

**Files to create or modify:**  
- `s4e_connector.py` — Add `fetch_adesoes_by_day()` function

**How to verify:**  
Write a small test in `tests/` (create if needed): call `fetch_adesoes_by_day()` with a known S4E date, confirm it returns a list of dicts with keys: lote, empresa, data_entrada, quantidade_vidas, valor_total, tipo. Check the S4E connector log for successful page parsing.

---

## 3. Backend: Create Conference Validation Logic

**What to do:**  
In a new file `adesoes_validation.py`, implement `validate_adesao(lote, empresa, data_entrada, vidas_count)` that:
- Queries the local contract database (contracts table, if exists) or a CRM endpoint to verify:
  - Company code exists and matches the expected enterprise record
  - Entry date is within acceptable range (±2 days of system date)
  - Life count is reasonable (> 0 and < company threshold)
  - Batch code format is valid
- Returns a dict: `{ "valid": bool, "errors": [list of specific issues], "warnings": [warnings] }`

This validation runs locally/synchronously, no S4E callback.

**Files to create or modify:**  
- `adesoes_validation.py` — New file with validation logic
- `s4e_connector.py` — Add optional validation call after fetch (or leave to endpoint)

**How to verify:**  
Create unit test in `tests/test_adesoes_validation.py`: call with valid and invalid inputs, confirm validation returns correct error messages. Run `pytest tests/test_adesoes_validation.py`.

---

## 4. Backend: Create Endpoints for Adhesion Data

**What to do:**  
Add three new endpoints to `portal_server.py`:

a) **GET /api/adesoes** — List adhesions with optional filters (mes, ano, tipo, conferido). Returns JSON array of adhesions with validation status. Query params:
   - `mes` (1–12), `ano` (YYYY) — optional date filter
   - `tipo` (web/crm/all) — filter by type
   - `conferido` (true/false/all) — filter by conference status
   - `search` — optional company or batch search

b) **POST /api/adesoes/conferir/:id** — Mark a single adhesion as manually reviewed. Payload: `{ "resultado": "válido" | "erro", "notas": "..." }`. Saves to database with timestamp.

c) **POST /api/adesoes/fetch-daily** — Trigger fetch of S4E batches for a specific date (admin only). Payload: `{ "data": "YYYY-MM-DD" }`. Calls S4E connector, validates each batch, stores in DB. Returns list of newly fetched adhesions and validation summary.

**Files to create or modify:**  
- `portal_server.py` — Add three endpoint handlers in the request routing section

**How to verify:**  
Use curl or Postman:
- `curl http://127.0.0.1:5500/api/adesoes?mes=11&ano=2026` — confirm returns JSON with adhesions
- `curl -X POST http://127.0.0.1:5500/api/adesoes/fetch-daily -H "Content-Type: application/json" -d '{"data":"2026-11-17"}'` — confirm fetches from S4E and stores data

---

## 5. Frontend: Create adesoes-conferencia.html Panel

**What to do:**  
Create HTML structure for the adhesion conference screen. Include:
- Hero section with title, description, and last import timestamp
- Filters row: date range picker (mes/ano), type (web/crm), conference status
- Search box for company or batch
- List view with cards/table showing: batch code, company, entry date, life count, value, type, and conference status badge
- Action buttons: "Revisar" (review), "Marcar como conferido" (mark reviewed)
- Loading spinner and empty state
- Modal dialog for detailed review (shows validation warnings, allows manual notes/approval)

Follow the pattern from `apuracao.js` and existing panels. Use semantic HTML and data attributes for JS selectors.

**Files to create or modify:**  
- `index.html` — Add new `<div id="adesoes-conferencia-panel" data-panel="adesoes-conferencia" hidden>` with all HTML structure; add CSS link to `<head>`; add nav link to main menu
- `adesoes-conferencia.css` — Create stylesheet (copy structure from `apuracao.css`)
- `adesoes-conferencia.js` — Will be created in next step

**How to verify:**  
Open `index.html` in browser, check developer console for no JS errors. Verify the "Conferência de Adesões" panel appears in the navigation menu. CSS loads without 404 errors.

---

## 6. Frontend: Create adesoes-conferencia.js Main Logic

**What to do:**  
Implement the screen logic in `adesoes-conferencia.js`:
- On panel load, fetch `/api/adesoes` with current month filters
- Render list of adhesions with status badges (pending/validated/error)
- Implement filter controls: date picker triggers refetch, type filter, search box
- "Revisar" button opens modal with full adhesion details + validation errors/warnings
- Modal form: user can add manual notes, approve or reject, then POST to `/api/adesoes/conferir/:id`
- "Apurar todos" / batch review button calls `/api/adesoes/fetch-daily` to sync latest from S4E
- Loading states and error handling
- Real-time status updates after manual review

Use fetch with `window.PortalAccess.api()` pattern from app.js. Handle auth headers automatically.

**Files to create or modify:**  
- `adesoes-conferencia.js` — New file with full implementation

**How to verify:**  
Open the Conferência de Adesões panel in browser, confirm:
- Adhesion list loads and displays data
- Filters update list on change
- "Revisar" button opens modal dialog
- Form submission updates DB and refreshes list
- No JS errors in console

---

## 7. Frontend: Integrate Panel into Portal Navigation

**What to do:**  
Add "Conferência de Adesões" as a new navigation item in the main portal menu. Register the panel in the HTML structure and ensure it's accessible to the correct user roles (likely "cadastro" or "faturamento" sector, admin+).

In `index.html`, locate the main nav sidebar and add a link that sets `data-panel="adesoes-conferencia"`. Ensure the panel div has the correct `data-panel` attribute and `hidden` state initially.

In `app.js` or `access.js`, if panel access control is enforced, add "adesoes-conferencia" to the allowed screens for the appropriate role/sector.

**Files to create or modify:**  
- `index.html` — Add nav link and panel registration
- `app.js` or `access.js` — Update screen permissions if needed

**How to verify:**  
Log in to portal, navigate the menu, confirm "Conferência de Adesões" appears and can be clicked to show the panel. Verify unauthorized users do not see the option (if role-gated).

---

## 8. Optional: Sync Task from Portal_Server Initialization

**What to do:**  
When the portal starts, ensure the `adesoes` table exists (it will auto-create from schema.sql). Optionally, add a background task that runs daily (or on first access of the day) to fetch S4E adhesions automatically. This can be a simple cron-like check in `task_sync.py` or a lazy load in the endpoint.

For MVP, skip automatic sync—user triggers manually via "Apurar todos" button.

**Files to create or modify:**  
- `task_sync.py` — Optional enhancement (can add later)
- `portal_server.py` — Ensure schema is loaded on startup

**How to verify:**  
Restart portal server, check `portal.db` exists and has the `adesoes` table.

---

## 9. Database Migration & Schema Update

**What to do:**  
Update `schema.sql` to include the `adesoes` table. The Python server will create it on first run if it doesn't exist. Provide a migration script (or just update schema.sql for fresh installs).

**Files to create or modify:**  
- `schema.sql` — Add CREATE TABLE IF NOT EXISTS adesoes (...)

**SQL Definition:**  
```sql
CREATE TABLE IF NOT EXISTS adesoes (
  id TEXT PRIMARY KEY,
  lote TEXT NOT NULL,
  empresa TEXT NOT NULL,
  data_entrada TEXT NOT NULL,
  vidas INTEGER,
  valor REAL,
  tipo TEXT CHECK (tipo IN ('WEB', 'CRM')),
  situacao TEXT DEFAULT 'ativo',
  conferencia_status TEXT DEFAULT 'pendente' CHECK (conferencia_status IN ('pendente', 'validado', 'erro')),
  conferencia_resultado TEXT,  -- JSON
  conferido_em TEXT,
  conferido_por TEXT,
  notas_conferencia TEXT,
  criado_em TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  atualizado_em TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_adesoes_data_entrada ON adesoes(data_entrada);
CREATE INDEX IF NOT EXISTS idx_adesoes_tipo ON adesoes(tipo);
CREATE INDEX IF NOT EXISTS idx_adesoes_conferencia_status ON adesoes(conferencia_status);
```

**How to verify:**  
Restart portal server with fresh `portal.db`, confirm table is created without errors. Query it: `SELECT COUNT(*) FROM adesoes;` returns 0.

---

## Architecture Decision Log

### 1. **WEB vs. CRM Data Split**
- **Decision:** Web panel displays only web-type adhesions; CRM adhesions are fetched but flagged as "CRM" and can be separately reviewed or excluded from this view.
- **Rationale:** User explicitly stated "what is web is web, and what is not web is CRM." This allows future separate UI for CRM or integration with S4E CRM system.
- **Implementation:** `tipo` column in DB; filter UI includes "Web", "CRM", "Todos" radio options.

### 2. **Validation Scope**
- **Decision:** Validation is primarily format/consistency checking (company exists, date range, count > 0). Deep CRM system verification is deferred to manual review or a separate S4E callback.
- **Rationale:** Prevents hard dependency on S4E availability; allows Monaliza to reject questionable data without full CRM sync. Error messages guide her to the specific issue (e.g., "Company code not found," "Date is 5 days old").
- **Implementation:** `validate_adesao()` in `adesoes_validation.py` queries local DB; errors recorded in `conferencia_resultado` JSON; user sees them in review modal.

### 3. **Manual Confirmation vs. Auto-Approval**
- **Decision:** All adhesions require manual review/approval by user (Monaliza). No auto-approval even if validation passes.
- **Rationale:** Monaliza's previous workflow was entirely manual; we're eliminating the *lookup* work, not her judgment. This maintains control and audit trail.
- **Implementation:** `conferencia_status` starts as "pendente"; POST to `/api/adesoes/conferir/:id` sets it to "validado" or "erro"; timestamp + user recorded.

### 4. **Data Source Priority**
- **Decision:** Primary data from S4E (fetch_adesoes_by_day); fallback to local contract DB for validation; no third system consulted unless explicitly requested.
- **Rationale:** S4E is the source of truth for "Entrada de Contratos"; local DB is for cross-reference only. Reduces API calls and latency.

### 5. **Screen Registration & Access Control**
- **Decision:** Panel is registered as a builtin screen (like "Apuração", "Contratos") in BUILTIN_SCREENS; access restricted to "cadastro-faturamento" sector by default, with admin override.
- **Rationale:** Consistent with existing screen pattern. Only users in the correct sector see the option in the menu.
- **Implementation:** Add `("adesoes-conferencia", "Conferência de Adesões", DEFAULT_SECTOR_NAME, "...")` to BUILTIN_SCREENS tuple in portal_server.py.

---

## Testing Checklist

1. **Schema Creation**: Portal starts, `adesoes` table exists in `portal.db`.
2. **S4E Fetch**: Call `fetch_adesoes_by_day(session, "2026-11-17")`, receive list of batches.
3. **Validation**: Call `validate_adesao(...)` with edge cases (invalid date, negative count, unknown company), receive appropriate errors.
4. **Endpoint GET**: `GET /api/adesoes?mes=11&ano=2026` returns JSON with all adhesions for that month.
5. **Endpoint POST Fetch**: `POST /api/adesoes/fetch-daily` with valid date triggers S4E fetch and stores data.
6. **Endpoint POST Review**: `POST /api/adesoes/conferir/:id` updates DB, returns updated record.
7. **Frontend Load**: Panel loads in browser, no console errors, displays list.
8. **Frontend Filters**: Changing date, type, or search updates list in real-time.
9. **Frontend Review**: "Revisar" opens modal, form submission succeeds, list refreshes.
10. **Navigation**: "Conferência de Adesões" appears in main menu for authorized users.

---

## Success Criteria

- ✅ Monaliza opens the "Conferência de Adesões" panel and sees a pre-populated list of today's (or selected day's) adhesion batches.
- ✅ Each batch shows: lote code, company, entry date, life count, value, type (WEB/CRM), and validation status.
- ✅ She can filter by date range, type, or search by company/batch code.
- ✅ She can click "Revisar" on any batch to see validation details and any cross-reference warnings.
- ✅ She can approve or reject the batch with optional notes, which updates the database.
- ✅ No manual S4E lookups, no copy-paste of lote codes or companies—all data is fetched and structured for her.
- ✅ The system runs on the Intranet Rede Saúde portal (web-based) with Python backend for S4E integration.

---

## Files Summary

| File | Type | Purpose |
|------|------|---------|
| `schema.sql` | SQL | Define `adesoes` table schema |
| `s4e_connector.py` | Python | Add `fetch_adesoes_by_day()` function |
| `adesoes_validation.py` | Python | New module with validation logic |
| `portal_server.py` | Python | Add 3 new endpoints for adhesion CRUD |
| `index.html` | HTML | Add panel div and nav link |
| `adesoes-conferencia.css` | CSS | Styling for the panel |
| `adesoes-conferencia.js` | JavaScript | Frontend logic and rendering |

---

## Development Order

1. **Database**: Update schema.sql, restart portal to verify table creation.
2. **S4E Integration**: Implement `fetch_adesoes_by_day()` in s4e_connector.py, test with live S4E session.
3. **Validation**: Create adesoes_validation.py, test validation logic unit tests.
4. **Backend Endpoints**: Add endpoints to portal_server.py, test with curl/Postman.
5. **Frontend HTML**: Add panel structure to index.html, register in nav.
6. **Frontend JS**: Implement adesoes-conferencia.js, connect to endpoints.
7. **Frontend CSS**: Style the panel (adesoes-conferencia.css).
8. **Integration Testing**: Full end-to-end test through portal UI.
9. **Documentation**: Document any configuration or manual setup steps for Monaliza.
