import { describe, it, expect } from 'vitest';
import { parseChangelog } from './changelog';

const SAMPLE = `# Novidades

Texto de abertura que descreve o arquivo, não uma versão.

## 1.10.0 — 2026-07-27

### Alterado

- item

## 1.0.36 — 2026-06-25

_Cobre as versões 1.0.16 a 1.0.36._

- outro item
`;

describe('parseChangelog', () => {
  it('keeps file order (newest first) and splits version from date', () => {
    const e = parseChangelog(SAMPLE);
    expect(e.map((x) => x.version)).toEqual(['1.10.0', '1.0.36']);
    expect(e[0].date).toBe('2026-07-27');
  });

  it('drops the preamble — it describes the file, not a release', () => {
    expect(parseChangelog(SAMPLE)[0].body.startsWith('### Alterado')).toBe(true);
    expect(parseChangelog(SAMPLE).some((x) => x.body.includes('Texto de abertura'))).toBe(false);
  });

  it('accepts a heading with no date rather than dropping the version', () => {
    const [e] = parseChangelog('## 2.0.0\n\n- item\n');
    expect(e).toEqual({ version: '2.0.0', date: '', body: '- item' });
  });

  it('returns nothing for a file with no version headings', () => {
    expect(parseChangelog('# Só um título\n\ntexto\n')).toEqual([]);
  });
});
