/**
 * WattWise API Service Layer
 * Bulletproof connection handling with automatic multi-host fallback
 * (127.0.0.1:8000 -> localhost:8000 -> Vite dev proxy '')
 */

const CONFIGURED_URL = (import.meta.env.VITE_API_BASE_URL || 'http://127.0.0.1:8000').replace(/\/+$/, '');

// Candidate hosts to resolve Windows/browser localhost & IPv4/IPv6 discrepancies
const CANDIDATE_HOSTS = Array.from(new Set([
  CONFIGURED_URL,
  'http://127.0.0.1:8000',
  'http://localhost:8000',
  '' // relative proxy via vite.config.js
]));

let workingHost = CONFIGURED_URL;

async function fetchWithFallback(endpointPath, options = {}) {
  const hostsToTry = [workingHost, ...CANDIDATE_HOSTS.filter(h => h !== workingHost)];
  let lastErr = null;

  for (const host of hostsToTry) {
    const url = host ? `${host}${endpointPath}` : endpointPath;
    try {
      const response = await fetch(url, options);
      workingHost = host; // remember working host
      return response;
    } catch (err) {
      lastErr = err;
      // Continue to next candidate host on network/fetch failure
    }
  }

  // If all candidate hosts failed, backend is definitely not running
  const helpfulMsg = 'Backend server is unreachable. Please ensure FastAPI is running on port 8000 (`uvicorn app.main:app --reload --port 8000`).';
  const error = new Error(helpfulMsg);
  error.originalError = lastErr;
  throw error;
}

async function handleResponse(response, fallbackMsg = 'API request failed') {
  if (!response.ok) {
    let detail = fallbackMsg;
    try {
      const errData = await response.json();
      if (errData && errData.detail) {
        detail = typeof errData.detail === 'string' ? errData.detail : JSON.stringify(errData.detail);
      }
    } catch {
      detail = `${fallbackMsg} (Status ${response.status})`;
    }
    const error = new Error(detail);
    error.status = response.status;
    throw error;
  }
  return response.json();
}

/**
 * Health check: GET /health
 */
export async function checkHealth() {
  try {
    const res = await fetchWithFallback('/health', { method: 'GET' });
    return await handleResponse(res, 'Health check failed');
  } catch (err) {
    return { status: 'offline', error: err.message };
  }
}

/**
 * Upload bill (PNG, JPG, PDF, CSV) and run analysis: POST /api/analyze
 */
export async function uploadAndAnalyze(file, {
  electricity_rate = 8.0,
  overnight_start_hour = 0,
  overnight_end_hour = 6,
  anomaly_sigma = 3.0,
  avoidable_percent = 50.0,
  annualize_daily_savings = true
} = {}) {
  const form = new FormData();
  form.append('file', file);
  form.append('electricity_rate', String(electricity_rate));
  form.append('overnight_start_hour', String(overnight_start_hour));
  form.append('overnight_end_hour', String(overnight_end_hour));
  form.append('anomaly_sigma', String(anomaly_sigma));
  form.append('avoidable_percent', String(avoidable_percent));
  form.append('annualize_daily_savings', String(annualize_daily_savings));

  const res = await fetchWithFallback('/api/analyze', {
    method: 'POST',
    body: form,
  });
  return handleResponse(res, 'Analysis failed');
}

/**
 * List recent analyses: GET /api/analyses?limit=...
 */
export async function listAnalyses(limit = 20) {
  const res = await fetchWithFallback(`/api/analyses?limit=${encodeURIComponent(limit)}`, {
    method: 'GET',
  });
  return handleResponse(res, 'Could not fetch analyses history');
}

/**
 * Get single analysis detail: GET /api/analyses/{id}
 */
export async function getAnalysis(analysisId) {
  const res = await fetchWithFallback(`/api/analyses/${encodeURIComponent(analysisId)}`, {
    method: 'GET',
  });
  return handleResponse(res, 'Could not load analysis details');
}

/**
 * Recalculate with updated assumptions: POST /api/analyses/{id}/what-if
 */
export async function runWhatIf(analysisId, payload) {
  const res = await fetchWithFallback(`/api/analyses/${encodeURIComponent(analysisId)}/what-if`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return handleResponse(res, 'What-if simulation failed');
}

/**
 * Request AI explanation: POST /api/analyses/{id}/explain
 */
export async function explainAnalysis(analysisId) {
  const res = await fetchWithFallback(`/api/analyses/${encodeURIComponent(analysisId)}/explain`, {
    method: 'POST',
  });
  return handleResponse(res, 'Nemotron explanation request failed');
}

export { workingHost as BASE_URL };
