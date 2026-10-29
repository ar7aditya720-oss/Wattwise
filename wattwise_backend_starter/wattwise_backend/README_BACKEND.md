# WattWise Backend Starter

FastAPI + SQLite backend around the previously supplied deterministic energy calculation engine. Intended to sit beside the existing React + Vite frontend; it does not replace the UI.

## Run on Windows PowerShell

```powershell
py -m venv .venv
.venv\Scripts\Activate.ps1
pip install -r requirements.txt
uvicorn app.main:app --reload
```

If PowerShell activation is blocked, use `.venv\Scripts\python.exe -m pip install -r requirements.txt` and `.venv\Scripts\python.exe -m uvicorn app.main:app --reload`.
Open http://127.0.0.1:8000/docs.

## API routes
- `GET /health` — health check
- `POST /api/analyze` — multipart CSV upload and calculation; saves result to SQLite
- `GET /api/analyses?limit=20` — recent history
- `GET /api/analyses/{id}` — stored result
- `POST /api/analyses/{id}/what-if` — recalculate same CSV with updated assumptions
- `POST /api/analyses/{id}/explain` — optional Nebius/Nemotron explanation

CSV required columns: `timestamp,kwh`; optional: `meter_id`.

## React integration example

```js
const form = new FormData();
form.append('file', csvFile);
form.append('electricity_rate', String(electricityRate));
form.append('overnight_start_hour', '0');
form.append('overnight_end_hour', '6');
form.append('avoidable_percent', String(avoidablePercent));
const response = await fetch('http://127.0.0.1:8000/api/analyze', { method: 'POST', body: form });
if (!response.ok) { const error = await response.json(); throw new Error(error.detail || 'Analysis failed'); }
const { id, result } = await response.json();
// Render result.summary, result.overnight_analysis, result.anomalies,
// result.what_if and result.daily_energy in the existing UI components.
```

## Nebius
Set `NEBIUS_API_KEY`, `NEBIUS_BASE_URL`, and `NEBIUS_MODEL` in backend environment. The model identifier must match one available in your Nebius Token Factory account. Never expose this key in Vite `VITE_*` variables. Without a key, calculations still work; only the explain endpoint is unavailable.

## Important
- This starter has no authentication. Do not expose it publicly with confidential industrial data until access control is added.
- CORS defaults to Vite localhost origins; set `WATTWISE_CORS_ORIGINS` to the deployed frontend origin for deployment.
- Potential excess is a proxy for possible waste, not proof of waste. Annual savings are projections.
- Confirm source timestamps/timezone and that `kwh` means interval energy, not instantaneous kW.
- The supplied engine may need dataset-specific calibration before judging.
