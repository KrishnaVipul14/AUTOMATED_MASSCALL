import type { Contact } from './contacts';

export function fillTemplate(template: string, contact: Pick<Contact, 'name' | 'phone' | 'category' | 'vars'>): string {
  const values: Record<string, string> = {
    ...contact.vars,
    name: contact.name,
    phone: contact.phone,
    category: contact.category,
  };
  return template.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (whole, key: string) => {
    const v = values[key.toLowerCase()];
    return v !== undefined && v !== '' ? v : whole;
  });
}

export function templateKeys(contacts: Pick<Contact, 'vars'>[]): string[] {
  const keys = new Set<string>(['name', 'phone', 'category']);
  for (const c of contacts) for (const k of Object.keys(c.vars)) keys.add(k);
  return [...keys].filter((k) => k.length <= 30).sort();
}

export function whatsappLink(phoneE164: string, message: string): string {
  const phone = phoneE164.replace(/[^0-9]/g, '');
  const params = message ? `?text=${encodeURIComponent(message)}` : '';
  return `https://wa.me/${phone}${params}`;
}

export function telLink(phoneE164: string): string {
  return `tel:${phoneE164.trim()}`;
}

export function clipboardUrlHint(): string {
  return 'WhatsApp opens the chat with your message pre-filled. You press the send button yourself. Nothing is sent automatically.';
}
