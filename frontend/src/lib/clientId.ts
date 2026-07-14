/**
 * Anonymous, cross-session correlation id (FE §3.2). Client-minted with crypto.randomUUID()
 * on first visit, persisted to localStorage, reused thereafter. Not a credential (the cookie is);
 * clearing site data simply mints a new one. Shipped on POST /api/reviews and /api/telemetry.
 */
export const CLIENT_ID_KEY = 'tako.client_id';

// In-memory fallback for environments where localStorage throws on access (Safari Private
// Browsing, storage disabled). Lasts the page lifetime — good enough for cross-request
// correlation within a session when persistence is unavailable.
let inMemoryId: string | null = null;

export function getOrCreateClientId(): string {
  try {
    const existing = localStorage.getItem(CLIENT_ID_KEY);
    if (existing) return existing;
    const id = crypto.randomUUID();
    localStorage.setItem(CLIENT_ID_KEY, id);
    // Write-then-read-back: two racing first-visit tabs each mint a different UUID, but localStorage
    // writes serialize, so the LAST writer wins. Re-reading after the write makes racing tabs
    // converge on that single winning id instead of each persisting (and beaconing) its own — which
    // would de-correlate a review row from its telemetry (§9d). Fall back to the just-minted id if
    // the read-back somehow returns nothing.
    return localStorage.getItem(CLIENT_ID_KEY) ?? id;
  } catch {
    // Storage unavailable — mint once and reuse the in-memory id for the rest of the session.
    inMemoryId ??= crypto.randomUUID();
    return inMemoryId;
  }
}
