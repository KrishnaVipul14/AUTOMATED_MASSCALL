import { normalisePhone } from './phone';

export interface ExtractedContact {
  phoneE164: string;
  name?: string;
}

/**
 * Extracts phone numbers and optional names from diverse inputs:
 * 1. SQL INSERT statements (e.g. INSERT INTO ... VALUES ('9876543210', 'Rahul'))
 * 2. JSON arrays (e.g. [{"phone": "9876543210", "name": "Rahul"}])
 * 3. CSV/TSV lines (e.g. 9876543210, Rahul)
 * 4. Plain lists of phone numbers separated by newlines or commas
 */
export function extractContactsFromSqlOrText(input: string): ExtractedContact[] {
  if (!input || typeof input !== 'string') return [];
  const text = input.trim();
  if (!text) return [];

  const seen = new Set<string>();
  const results: ExtractedContact[] = [];

  const addIfValid = (rawPhone: string, rawName?: string) => {
    const phone = normalisePhone(rawPhone);
    if (phone && !seen.has(phone)) {
      seen.add(phone);
      const name = rawName?.trim().replace(/^['"]|['"]$/g, '').slice(0, 100);
      results.push({ phoneE164: phone, name: name || undefined });
    }
  };

  // 1. Try parsing as JSON array
  if (text.startsWith('[') && text.endsWith(']')) {
    try {
      const arr = JSON.parse(text);
      if (Array.isArray(arr)) {
        for (const item of arr) {
          if (typeof item === 'string') {
            addIfValid(item);
          } else if (item && typeof item === 'object') {
            const phone = item.phone || item.mobile || item.phone_number || item.contact || item.number;
            const name = item.name || item.fullName || item.full_name || item.citizen;
            if (phone) addIfValid(String(phone), name ? String(name) : undefined);
          }
        }
        if (results.length > 0) return results;
      }
    } catch {
      // Not JSON, continue to SQL/text matching
    }
  }

  // 2. Check for SQL INSERT VALUES syntax: (... , ...)
  // Example: ('+919876543210', 'Rahul Sharma', ...), ('9876543211', 'Priya')
  const tupleRegex = /\(([^)]+)\)/g;
  let tupleMatch: RegExpExecArray | null;
  let foundSqlTuples = false;

  while ((tupleMatch = tupleRegex.exec(text)) !== null) {
    foundSqlTuples = true;
    const inner = tupleMatch[1];
    // Split by comma taking into account quoted strings
    const parts = inner.split(/,(?=(?:[^'"]*['"][^'"]*['"])*[^'"]*$)/).map((p) => p.trim());
    let phoneFound: string | null = null;
    let nameFound: string | undefined = undefined;

    for (const part of parts) {
      const cleaned = part.replace(/^['"]|['"]$/g, '').trim();
      const p = normalisePhone(cleaned);
      if (p && !phoneFound) {
        phoneFound = p;
      } else if (!nameFound && cleaned.length > 1 && !/^\d+$/.test(cleaned) && isNaN(Number(cleaned))) {
        nameFound = cleaned;
      }
    }
    if (phoneFound) {
      addIfValid(phoneFound, nameFound);
    }
  }

  if (foundSqlTuples && results.length > 0) {
    return results;
  }

  // 3. Fallback: line-by-line / CSV / phone regex extraction
  const lines = text.split(/[\r\n]+/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('--') || trimmed.startsWith('/*')) continue;

    const parts = trimmed.split(/[,;\t]/).map((s) => s.trim().replace(/^['"]|['"]$/g, ''));
    let linePhone: string | null = null;
    let lineName: string | undefined = undefined;

    for (const p of parts) {
      const norm = normalisePhone(p);
      if (norm && !linePhone) {
        linePhone = norm;
      } else if (!lineName && p.length > 1 && isNaN(Number(p))) {
        lineName = p;
      }
    }

    if (linePhone) {
      addIfValid(linePhone, lineName);
    }
  }

  // 4. As final fallback, regex search for any 10-13 digit phone numbers
  if (results.length === 0) {
    const rawNumbers = text.match(/(?:\+?\d{1,3}[-.\s]?)?\(?\d{3,4}\)?[-.\s]?\d{3}[-.\s]?\d{4}/g) || [];
    for (const num of rawNumbers) {
      addIfValid(num);
    }
  }

  return results;
}
