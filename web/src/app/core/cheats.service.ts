import { Injectable } from '@angular/core';
import type { Cheat } from './models';

/**
 * Cheats now come only from the GameDB, either the per-CRC `.s2pkg` bundle's `cheats` member or the
 * catalog reserved from the CRC lookup (Entry.dbCheats). This service no longer fetches the legacy
 * site `/cheats/<CRC>.yml`; it just PARSES/SERIALIZES the GameHacking YAML the firmware round-trips
 * (a sequence of { Name, Enabled, Code:[...] }), the same shape written to /sd2snes/cheats/.
 */
@Injectable({ providedIn: 'root' })
export class CheatsService {
  /** Parse an on-card / reserved cheats YAML string into Cheat[]. */
  parse(text: string): Cheat[] {
    return parseCheatsYaml(text);
  }

  /** Serialize a cheat list to the GameHacking YAML the firmware reads. */
  serialize(cheats: Cheat[], comment?: string): string {
    const out: string[] = ['---'];
    if (comment) out.push('# ' + comment);
    for (const c of cheats) {
      const name = (c.name || '').replace(/"/g, "'").trim();
      out.push(`- Name: "${name}"`);
      out.push(`  Enabled: ${c.on ? 'true' : 'false'}`);
      out.push('  Code:');
      for (const code of c.codes ?? []) {
        if (code) out.push(`  - "${code.toUpperCase()}"`);
      }
    }
    return out.join('\n') + '\n';
  }

  /** Flip the `Enabled:` flag of the `index`-th cheat in raw YAML, leaving every
   *  other byte (names, codes, comments, indentation) untouched. */
  setEnabled(raw: string, index: number, enabled: boolean): string {
    const lines = raw.split(/\r?\n/);
    let entry = -1;
    for (let i = 0; i < lines.length; i++) {
      if (/^-\s*Name:/.test(lines[i])) {
        entry++;
        continue;
      }
      if (entry === index && /^\s+Enabled\s*:/i.test(lines[i])) {
        lines[i] = lines[i].replace(/(Enabled\s*:\s*)(true|false)/i, `$1${enabled ? 'true' : 'false'}`);
        break;
      }
      if (entry > index) break;
    }
    return lines.join('\n');
  }
}

/** Decode HTML entities in cheat names (the export encodes `"` `'` `&` etc.). */
function htmlDecode(s: string): string {
  if (!s.includes('&')) return s;
  const el = document.createElement('textarea');
  el.innerHTML = s;
  return el.value;
}

function unquote(s: string): string {
  const t = s.trim();
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
    return t.slice(1, -1);
  }
  return t;
}

/**
 * Parse the constrained GameHacking YAML the firmware's parser also reads:
 *   - Name: "<name>"
 *     Enabled: true|false
 *     Code:
 *     - "xxxxxxxx"
 * `#` comment lines are ignored. Robust to the loose comments between entries.
 */
export function parseCheatsYaml(text: string): Cheat[] {
  const out: Cheat[] = [];
  let cur: Cheat | null = null;
  let inCode = false;

  for (const line of text.split(/\r?\n/)) {
    if (!line.trim() || line.trim() === '---' || /^\s*#/.test(line)) continue;

    const nameM = line.match(/^-\s*Name:\s*(.*)$/);
    if (nameM) {
      if (cur) out.push(cur);
      cur = { name: htmlDecode(unquote(nameM[1])), on: false, codes: [] };
      inCode = false;
      continue;
    }
    if (!cur) continue;

    const enM = line.match(/^\s+Enabled:\s*(true|false)/i);
    if (enM) {
      cur.on = enM[1].toLowerCase() === 'true';
      inCode = false;
      continue;
    }
    if (/^\s+Code:\s*$/.test(line)) {
      inCode = true;
      continue;
    }
    const codeM = line.match(/^\s+-\s*(.*)$/);
    if (inCode && codeM) {
      const code = unquote(codeM[1]);
      if (code) cur.codes!.push(code);
    }
  }
  if (cur) out.push(cur);
  return out;
}
