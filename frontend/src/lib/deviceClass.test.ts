import { formatDeviceClass, detectBrowser } from './deviceClass';

describe('formatDeviceClass (coarse, non-invasive — FE §6.4)', () => {
  it('formats a full device descriptor', () => {
    expect(
      formatDeviceClass({ webgpu: true, vendor: 'apple', memBucket: 'high', browser: 'chrome' }),
    ).toBe('webgpu;vendor=apple;mem=high;chrome');
  });

  it('omits missing segments but preserves order', () => {
    expect(formatDeviceClass({ webgpu: true, browser: 'firefox' })).toBe('webgpu;firefox');
  });

  it('returns no-webgpu when webgpu is false', () => {
    expect(formatDeviceClass({ webgpu: false })).toBe('no-webgpu');
  });
});

describe('detectBrowser', () => {
  it('detects edge before chrome (Edge UA contains Chrome)', () => {
    expect(detectBrowser('Mozilla/5.0 Chrome/120.0 Safari/537.36 Edg/120.0')).toBe('edge');
  });
  it('detects chrome', () => {
    expect(detectBrowser('Mozilla/5.0 Chrome/120.0 Safari/537.36')).toBe('chrome');
  });
  it('detects safari when there is no chrome token', () => {
    expect(detectBrowser('Mozilla/5.0 Version/17.0 Safari/605.1.15')).toBe('safari');
  });
  it('detects firefox', () => {
    expect(detectBrowser('Mozilla/5.0 Firefox/121.0')).toBe('firefox');
  });
  it('falls back to other', () => {
    expect(detectBrowser('curl/8.4')).toBe('other');
  });
});
