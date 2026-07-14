import { afterEach, vi } from 'vitest';
import { getOrCreateClientId, CLIENT_ID_KEY } from './clientId';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

describe('getOrCreateClientId', () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => vi.restoreAllMocks());

  it('mints and persists a UUID on first call', () => {
    const id = getOrCreateClientId();
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
    expect(localStorage.getItem(CLIENT_ID_KEY)).toBe(id);
  });

  it('returns the same id on subsequent calls', () => {
    const a = getOrCreateClientId();
    const b = getOrCreateClientId();
    expect(b).toBe(a);
  });

  it('returns a preexisting id unchanged', () => {
    localStorage.setItem(CLIENT_ID_KEY, 'preexisting-id');
    expect(getOrCreateClientId()).toBe('preexisting-id');
  });

  it('converges on the read-back value when a racing tab wrote a different id first — §9d', () => {
    // Two racing first-visit tabs each mint a different UUID; writes serialize so the last writer
    // wins. The write-then-read-back must return the WINNING persisted id, not this tab's local
    // mint, so racing tabs converge and a review row stays correlated with its telemetry beacon.
    const racingWinner = '11111111-1111-4111-8111-111111111111';
    vi.spyOn(Storage.prototype, 'getItem')
      .mockReturnValueOnce(null) // first read: no id yet
      .mockReturnValueOnce(racingWinner); // read-back: the other tab's id won the write race
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {});
    const id = getOrCreateClientId();
    expect(setItem).toHaveBeenCalledTimes(1);
    expect(id).toBe(racingWinner);
  });

  it('returns its own freshly-minted id when the read-back is empty (no race) — §9d', () => {
    vi.spyOn(Storage.prototype, 'getItem')
      .mockReturnValueOnce(null) // initial read miss
      .mockReturnValueOnce(null); // read-back also empty (e.g. immediately cleared)
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {});
    expect(getOrCreateClientId()).toMatch(UUID_RE);
  });

  it('falls back to an in-memory UUID when localStorage.getItem throws (Safari Private) — N-15', () => {
    // Safari Private Browsing / storage-disabled: every access throws a SecurityError. The id
    // generator must degrade to a fresh in-memory UUID rather than crash the caller.
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new DOMException('denied', 'SecurityError');
    });
    const id = getOrCreateClientId();
    expect(id).toMatch(UUID_RE);
  });

  it('does not throw when setItem throws (read miss + write denied) — N-15', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockReturnValue(null);
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('denied', 'SecurityError');
    });
    let id = '';
    expect(() => {
      id = getOrCreateClientId();
    }).not.toThrow();
    expect(id).toMatch(UUID_RE);
  });
});
