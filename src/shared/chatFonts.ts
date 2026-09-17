import type { ChatFontSize, ChatLineHeight } from './types.ts';

export interface ChatFontOption {
  id: string;
  label: string;
  family: string;
  category: 'serif' | 'sans' | 'mono' | 'display';
}

/**
 * Fonts a user can pick for chat message text. All are self-hosted via @fontsource
 * (imported in client/main.tsx), so there's no runtime dependency on Google's font CDN.
 */
export const CHAT_FONTS: ChatFontOption[] = [
  {
    id: 'source-serif-4',
    label: 'Source Serif 4',
    family: '"Source Serif 4 Variable", Georgia, "Times New Roman", serif',
    category: 'serif',
  },
  { id: 'literata', label: 'Literata', family: '"Literata Variable", Georgia, serif', category: 'serif' },
  { id: 'lora', label: 'Lora', family: '"Lora Variable", Georgia, serif', category: 'serif' },
  { id: 'newsreader', label: 'Newsreader', family: '"Newsreader Variable", Georgia, serif', category: 'serif' },
  {
    id: 'playfair-display',
    label: 'Playfair Display',
    family: '"Playfair Display Variable", Georgia, serif',
    category: 'serif',
  },
  { id: 'inter', label: 'Inter', family: '"Inter Variable", "Segoe UI", system-ui, sans-serif', category: 'sans' },
  {
    id: 'public-sans',
    label: 'Public Sans',
    family: '"Public Sans Variable", "Segoe UI", system-ui, sans-serif',
    category: 'sans',
  },
  {
    id: 'space-grotesk',
    label: 'Space Grotesk',
    family: '"Space Grotesk Variable", "Segoe UI", system-ui, sans-serif',
    category: 'sans',
  },
  { id: 'roboto', label: 'Roboto', family: '"Roboto Variable", "Segoe UI", system-ui, sans-serif', category: 'sans' },
  {
    id: 'open-sans',
    label: 'Open Sans',
    family: '"Open Sans Variable", "Segoe UI", system-ui, sans-serif',
    category: 'sans',
  },
  { id: 'ubuntu', label: 'Ubuntu', family: '"Ubuntu", "Segoe UI", system-ui, sans-serif', category: 'sans' },
  {
    id: 'jetbrains-mono',
    label: 'JetBrains Mono',
    family: '"JetBrains Mono Variable", ui-monospace, "Cascadia Code", Consolas, monospace',
    category: 'mono',
  },
  { id: 'doto', label: 'Doto', family: '"Doto Variable", ui-monospace, monospace', category: 'display' },
];

export const CHAT_FONT_CATEGORY_LABELS: Record<ChatFontOption['category'], string> = {
  serif: 'Serif',
  sans: 'Sans-serif',
  mono: 'Monospace',
  display: 'Display',
};

export const DEFAULT_CHAT_FONT_ID = 'source-serif-4';

const DEFAULT_CHAT_FONT_FAMILY = CHAT_FONTS.find((font) => font.id === DEFAULT_CHAT_FONT_ID)!.family;

export function chatFontFamily(id: string | null | undefined): string {
  return CHAT_FONTS.find((font) => font.id === id)?.family ?? DEFAULT_CHAT_FONT_FAMILY;
}

export interface ChatFontSizeOption {
  id: ChatFontSize;
  label: string;
  value: string;
}

export const CHAT_FONT_SIZES: ChatFontSizeOption[] = [
  { id: 'small', label: 'Small', value: '0.875rem' },
  { id: 'medium', label: 'Medium', value: '1rem' },
  { id: 'large', label: 'Large', value: '1.125rem' },
  { id: 'xlarge', label: 'Extra large', value: '1.25rem' },
];

export const DEFAULT_CHAT_FONT_SIZE: ChatFontSize = 'medium';

const DEFAULT_CHAT_FONT_SIZE_VALUE = CHAT_FONT_SIZES.find((size) => size.id === DEFAULT_CHAT_FONT_SIZE)!.value;

export function chatFontSizeValue(id: ChatFontSize | null | undefined): string {
  return CHAT_FONT_SIZES.find((size) => size.id === id)?.value ?? DEFAULT_CHAT_FONT_SIZE_VALUE;
}

export interface ChatLineHeightOption {
  id: ChatLineHeight;
  label: string;
  value: number;
}

export const CHAT_LINE_HEIGHTS: ChatLineHeightOption[] = [
  { id: 'compact', label: 'Compact', value: 1.45 },
  { id: 'standard', label: 'Standard', value: 1.65 },
  { id: 'relaxed', label: 'Relaxed', value: 1.85 },
];

export const DEFAULT_CHAT_LINE_HEIGHT: ChatLineHeight = 'standard';

const DEFAULT_CHAT_LINE_HEIGHT_VALUE = CHAT_LINE_HEIGHTS.find((lh) => lh.id === DEFAULT_CHAT_LINE_HEIGHT)!.value;

export function chatLineHeightValue(id: ChatLineHeight | null | undefined): number {
  return CHAT_LINE_HEIGHTS.find((lh) => lh.id === id)?.value ?? DEFAULT_CHAT_LINE_HEIGHT_VALUE;
}

export const CHAT_FONT_PREVIEW_TEXT =
  "### Quick preview\nThe quick brown fox jumps over the lazy dog. This paragraph mixes **bold text**, *italics*, and `inline code` so you can compare how each font reads.\n\n- Bullet points look like this\n- And this";
