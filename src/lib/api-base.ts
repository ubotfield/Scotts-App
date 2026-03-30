/**
 * Determines the API base URL.
 *
 * In the browser (served from Cloud Run or local dev), relative paths like
 * "/api/..." work fine because they hit the same origin.
 *
 * In Capacitor (native iOS), the app is served from capacitor://localhost,
 * so relative "/api/..." paths won't reach the Express server. We need
 * an absolute URL pointing to Cloud Run.
 *
 * The API_BASE_URL is baked into the build via Vite's `define`.
 */

declare const __API_BASE_URL__: string;

let _apiBase: string | null = null;

export function getApiBase(): string {
  if (_apiBase !== null) return _apiBase;

  // 1. Check for build-time injected value
  try {
    if (typeof __API_BASE_URL__ === "string" && __API_BASE_URL__) {
      _apiBase = __API_BASE_URL__;
      console.log("[api-base] Using build-time API_BASE_URL:", _apiBase);
      return _apiBase;
    }
  } catch {
    // Not defined
  }

  // 2. Detect Capacitor native — needs absolute URL
  const isCapacitor =
    (window as any).Capacitor?.isNativePlatform?.() ||
    window.location.protocol === "capacitor:";

  if (isCapacitor) {
    // Default to Cloud Run URL if no build-time value
    _apiBase = "https://ais-pre-7huhr6qvfjisfgnfsitrxo-354667129093.us-west2.run.app";
    console.log("[api-base] Capacitor detected, using:", _apiBase);
    return _apiBase;
  }

  // 3. Browser — relative URLs work
  _apiBase = "";
  return _apiBase;
}

/** Build a full API URL from a relative path like "/api/agent/session" */
export function apiUrl(path: string): string {
  return `${getApiBase()}${path}`;
}
