const GSM7 = '@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !"#¤%&\'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà';
const GSM7_EXT = '^{}\\[~]|€';

export interface SmsInfo { encoding: 'GSM-7' | 'UCS-2'; units: number; segments: number; perSegment: number }

/** Estimates SMS encoding and segment count (concatenated SMS uses 153 GSM-7 / 67 UCS-2 units per part). */
export function smsSegments(body: string): SmsInfo {
  let units = 0;
  let gsm = true;
  for (const ch of body) {
    if (GSM7.includes(ch)) units += 1;
    else if (GSM7_EXT.includes(ch)) units += 2;
    else { gsm = false; break; }
  }
  if (gsm) {
    const segments = units === 0 ? 0 : units <= 160 ? 1 : Math.ceil(units / 153);
    return { encoding: 'GSM-7', units, segments, perSegment: segments > 1 ? 153 : 160 };
  }
  const u = [...body].reduce((n, c) => n + (c.codePointAt(0)! > 0xffff ? 2 : 1), 0);
  const segments = u <= 70 ? 1 : Math.ceil(u / 67);
  return { encoding: 'UCS-2', units: u, segments, perSegment: segments > 1 ? 67 : 70 };
}
