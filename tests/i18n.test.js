'use strict';

const fs   = require('fs');
const path = require('path');

const LOCALES_DIR = path.join(__dirname, '../src/public/locales');

function readJson(filename) {
  return JSON.parse(fs.readFileSync(path.join(LOCALES_DIR, filename), 'utf8'));
}

// Returns every dot-path to a leaf string value, e.g. 'detail.fields.source'
function flatKeys(obj, prefix = '') {
  return Object.entries(obj).flatMap(([k, v]) => {
    const full = prefix ? `${prefix}.${k}` : k;
    return typeof v === 'object' && v !== null ? flatKeys(v, full) : [full];
  });
}

function getAtPath(obj, dotPath) {
  return dotPath.split('.').reduce((o, k) => o && o[k], obj);
}

// Returns sorted list of {param} names found in a string
function interpolationParams(str) {
  return [...str.matchAll(/\{(\w+)\}/g)].map(m => m[1]).sort();
}

// ─── fixtures ─────────────────────────────────────────────────────────────────

const registry = readJson('registry.json');
const en       = readJson('en.json');
const enKeys   = flatKeys(en).sort();

// ─── registry.json ────────────────────────────────────────────────────────────

describe('registry.json', () => {
  test('is a non-empty array', () => {
    expect(Array.isArray(registry)).toBe(true);
    expect(registry.length).toBeGreaterThan(0);
  });

  test('every entry has a non-empty code, label, and flag', () => {
    for (const entry of registry) {
      expect(typeof entry.code).toBe('string');
      expect(entry.code.trim().length).toBeGreaterThan(0);
      expect(typeof entry.label).toBe('string');
      expect(entry.label.trim().length).toBeGreaterThan(0);
      expect(typeof entry.flag).toBe('string');
      expect(entry.flag.trim().length).toBeGreaterThan(0);
    }
  });

  test('locale codes are unique', () => {
    const codes = registry.map(l => l.code);
    expect(new Set(codes).size).toBe(codes.length);
  });

  test('en is registered', () => {
    expect(registry.some(l => l.code === 'en')).toBe(true);
  });

  test('every registered locale has a corresponding JSON file', () => {
    for (const { code } of registry) {
      expect(fs.existsSync(path.join(LOCALES_DIR, `${code}.json`))).toBe(true);
    }
  });
});

// ─── en.json structure ────────────────────────────────────────────────────────

describe('en.json', () => {
  test('has all required top-level sections', () => {
    const required = ['nav', 'page', 'endpoint', 'controls', 'table', 'empty', 'detail', 'footer'];
    for (const key of required) {
      expect(en).toHaveProperty(key);
    }
  });

  test('nav has brand, pageTitle, live, disconnected', () => {
    expect(en.nav).toMatchObject({
      brand:        expect.any(String),
      pageTitle:    expect.any(String),
      live:         expect.any(String),
      disconnected: expect.any(String),
    });
  });

  test('page has descriptionPrefix, reportTo, reportUri', () => {
    expect(en.page).toMatchObject({
      descriptionPrefix: expect.any(String),
      reportTo:          expect.any(String),
      reportUri:         expect.any(String),
    });
  });

  test('detail.fields has all nine field labels', () => {
    const required = [
      'documentUri', 'blockedUri', 'violatedDirective', 'effectiveDirective',
      'originalPolicy', 'source', 'referrer', 'statusCode', 'receivedAt',
    ];
    for (const f of required) {
      expect(en.detail.fields).toHaveProperty(f);
      expect(typeof en.detail.fields[f]).toBe('string');
    }
  });

  describe('pluralization', () => {
    test('controls.violations has exactly three pipe-separated forms (zero | one | other)', () => {
      const forms = en.controls.violations.split('|').map(s => s.trim());
      expect(forms).toHaveLength(3);
    });

    test('controls.violations singular form contains {n}', () => {
      const singular = en.controls.violations.split('|')[1].trim();
      expect(singular).toContain('{n}');
    });

    test('controls.violations plural form contains {n}', () => {
      const plural = en.controls.violations.split('|')[2].trim();
      expect(plural).toContain('{n}');
    });
  });

  describe('interpolation placeholders', () => {
    test('footer contains {year}', () => {
      expect(interpolationParams(en.footer)).toContain('year');
    });

    test('empty.noViolations contains {date}', () => {
      expect(interpolationParams(en.empty.noViolations)).toContain('date');
    });

    test('detail.title contains {id}', () => {
      expect(interpolationParams(en.detail.title)).toContain('id');
    });
  });

  test('no leaf value is blank', () => {
    for (const key of enKeys) {
      const val = getAtPath(en, key);
      expect(typeof val).toBe('string');
      expect(val.trim().length).toBeGreaterThan(0);
    }
  });
});

// ─── completeness tests for every non-English locale ─────────────────────────

const otherLocales = registry
  .filter(l => l.code !== 'en')
  .map(l => [l.code, l.label, l.flag]);

if (otherLocales.length > 0) {
  describe.each(otherLocales)('%s %s (%s)', (code) => {
    const locale = readJson(`${code}.json`);
    const localeKeys = flatKeys(locale).sort();

    test('has the exact same set of keys as en.json', () => {
      expect(localeKeys).toEqual(enKeys);
    });

    test('no leaf value is blank', () => {
      for (const key of localeKeys) {
        const val = getAtPath(locale, key);
        expect(typeof val).toBe('string');
        expect(val.trim().length).toBeGreaterThan(0);
      }
    });

    test('every string has the same interpolation params as en.json', () => {
      for (const key of enKeys) {
        const enParams     = interpolationParams(getAtPath(en, key));
        const localeParams = interpolationParams(getAtPath(locale, key));
        expect(localeParams).toEqual(enParams);
      }
    });

    test('controls.violations has the same number of plural forms as en.json', () => {
      const enCount     = en.controls.violations.split('|').length;
      const localeCount = locale.controls.violations.split('|').length;
      expect(localeCount).toBe(enCount);
    });
  });
}
