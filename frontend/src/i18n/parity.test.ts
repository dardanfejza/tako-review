import en from './en.json';
import ja from './ja.json';

type Catalog = Record<string, unknown>;

function flatten(obj: Catalog, prefix = ''): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (typeof v === 'string') out[key] = v;
    else if (v && typeof v === 'object') Object.assign(out, flatten(v as Catalog, key));
  }
  return out;
}

function placeholders(s: string): string[] {
  return [...s.matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1]!).sort();
}

describe('i18n catalog parity (EN ⇄ JA — FE §14)', () => {
  const enFlat = flatten(en as Catalog);
  const jaFlat = flatten(ja as Catalog);

  it('has identical key sets in both locales', () => {
    expect(Object.keys(jaFlat).sort()).toEqual(Object.keys(enFlat).sort());
  });

  it('has matching interpolation placeholders per key', () => {
    for (const key of Object.keys(enFlat)) {
      expect({ key, ph: placeholders(jaFlat[key] ?? '') }).toEqual({
        key,
        ph: placeholders(enFlat[key]!),
      });
    }
  });
});
