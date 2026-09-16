import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

export const FETCH_MAX_CHARS = 20_000;
const FETCH_TIMEOUT_MS = 20_000;
const MAX_BYTES = 3 * 1024 * 1024;
const MAX_REDIRECTS = 5;
const USER_AGENT = 'Mozilla/5.0 (compatible; Switchbox/0.1; +local LLM runner)';

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  mdash: '—',
  ndash: '–',
  hellip: '…',
  rsquo: '’',
  lsquo: '‘',
  rdquo: '”',
  ldquo: '“',
};

export function decodeEntities(text: string): string {
  return text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (match, entity: string) => {
    if (entity.startsWith('#')) {
      const hex = entity[1] === 'x' || entity[1] === 'X';
      const code = hex ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
    }
    return NAMED_ENTITIES[entity.toLowerCase()] ?? match;
  });
}

/** Readable text from HTML. A regex pass is enough here: the model needs the prose, not a DOM. */
export function htmlToText(html: string): { title: string | null; text: string } {
  const titleMatch = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  const title = titleMatch?.[1] ? decodeEntities(titleMatch[1]).replace(/\s+/g, ' ').trim() || null : null;
  const text = decodeEntities(
    html
      .replace(/<(script|style|noscript|svg|template|iframe|head)\b[\s\S]*?<\/\1>/gi, ' ')
      .replace(/<!--[\s\S]*?-->/g, ' ')
      .replace(/<\/?(p|div|section|article|header|footer|main|nav|aside|tr|ul|ol|table|h[1-6]|blockquote|pre)\b[^>]*>/gi, '\n')
      .replace(/<br\b[^>]*>/gi, '\n')
      .replace(/<li\b[^>]*>/gi, '\n- ')
      .replace(/<[^>]+>/g, ''),
  )
    .replace(/[ \t ]+/g, ' ')
    .split('\n')
    .map((line) => line.trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return { title, text };
}

function ipv4ToNumber(address: string): number {
  return address.split('.').reduce((total, part) => total * 256 + Number(part), 0);
}

function inV4Range(address: string, base: string, bits: number): boolean {
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return ((ipv4ToNumber(address) & mask) >>> 0) === ((ipv4ToNumber(base) & mask) >>> 0);
}

const PRIVATE_V4: [string, number][] = [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
];

/** True for loopback, private, link-local, carrier-NAT, multicast and reserved addresses. */
export function isPrivateAddress(address: string): boolean {
  const version = isIP(address);
  if (version === 4) return PRIVATE_V4.some(([base, bits]) => inV4Range(address, base, bits));
  if (version === 6) {
    const lower = address.toLowerCase();
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
    if (mapped?.[1]) return isPrivateAddress(mapped[1]);
    return (
      lower === '::' ||
      lower === '::1' ||
      /^f[cd]/.test(lower) || // unique local fc00::/7
      /^fe[89ab]/.test(lower) || // link-local fe80::/10
      lower.startsWith('ff') // multicast
    );
  }
  return true;
}

/**
 * Refuses URLs that point at this machine or its network. The Switchbox API, local model
 * servers and router admin pages all live there, and a page the model read could be what
 * asked it to go look. Hostnames are resolved so a public name that maps to a private
 * address is caught too.
 */
export async function assertPublicUrl(raw: string): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`"${raw}" is not a valid URL.`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`Only http and https URLs can be fetched (got ${url.protocol}).`);
  }
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) {
    throw new Error(`Refusing to fetch a local address (${url.hostname}).`);
  }
  const addresses = isIP(host) ? [host] : (await lookup(host, { all: true })).map((entry) => entry.address);
  if (addresses.length === 0 || addresses.some(isPrivateAddress)) {
    throw new Error(`Refusing to fetch a private or loopback address (${url.hostname}).`);
  }
  return url;
}

async function readLimited(response: Response): Promise<string> {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let received = 0;
  let text = '';
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    received += value.byteLength;
    text += decoder.decode(value, { stream: true });
    if (received >= MAX_BYTES) {
      await reader.cancel().catch(() => {});
      break;
    }
  }
  return text + decoder.decode();
}

export interface FetchedPage {
  url: string;
  title: string | null;
  text: string;
  truncated: boolean;
}

export async function fetchPage(rawUrl: string, signal?: AbortSignal, maxChars = FETCH_MAX_CHARS): Promise<FetchedPage> {
  const timeout = AbortSignal.timeout(FETCH_TIMEOUT_MS);
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;

  // Redirects are followed by hand so every hop passes the same address check.
  let url = await assertPublicUrl(rawUrl);
  let response: Response | null = null;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    response = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT, Accept: 'text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.5' },
      redirect: 'manual',
      signal: combined,
    });
    const location = response.headers.get('location');
    if (response.status >= 300 && response.status < 400 && location) {
      await response.body?.cancel().catch(() => {});
      url = await assertPublicUrl(new URL(location, url).toString());
      continue;
    }
    break;
  }
  if (!response) throw new Error('No response');
  if (response.status >= 300 && response.status < 400) throw new Error('Too many redirects');
  if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`.trim());

  const contentType = (response.headers.get('content-type') ?? '').toLowerCase();
  const textual = contentType === '' || /text\/|json|xml|javascript/.test(contentType);
  if (!textual) {
    await response.body?.cancel().catch(() => {});
    throw new Error(`Can't read ${contentType.split(';')[0]} content; only web pages and text files are supported.`);
  }

  const body = await readLimited(response);
  const isHtml = contentType.includes('html') || /^\s*<(!doctype|html)/i.test(body);
  const { title, text } = isHtml ? htmlToText(body) : { title: null, text: body.trim() };
  const truncated = text.length > maxChars;
  return { url: url.toString(), title, text: truncated ? text.slice(0, maxChars) : text, truncated };
}
