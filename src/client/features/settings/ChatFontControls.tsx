import Box from '@mui/material/Box';
import ListSubheader from '@mui/material/ListSubheader';
import MenuItem from '@mui/material/MenuItem';
import Select from '@mui/material/Select';
import ToggleButton from '@mui/material/ToggleButton';
import ToggleButtonGroup from '@mui/material/ToggleButtonGroup';
import Typography from '@mui/material/Typography';
import {
  CHAT_FONT_CATEGORY_LABELS,
  CHAT_FONT_PREVIEW_TEXT,
  CHAT_FONT_SIZES,
  CHAT_FONTS,
  CHAT_LINE_HEIGHTS,
  chatFontFamily,
  chatFontSizeValue,
  chatLineHeightValue,
  type ChatFontOption,
} from '../../../shared/chatFonts.ts';
import type { AppSettings } from '../../../shared/types.ts';
import { Markdown } from '../../components/Markdown.tsx';

const CATEGORY_ORDER: ChatFontOption['category'][] = ['serif', 'sans', 'mono', 'display'];

type ChatFontValue = Pick<AppSettings['general'], 'chatFont' | 'chatFontSize' | 'chatLineHeight'>;

/** Family, size and line-height pickers for chat message text. */
export function ChatFontFields({
  value,
  onChange,
}: {
  value: ChatFontValue;
  onChange: (patch: Partial<ChatFontValue>) => void;
}) {
  return (
    <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 1.25 }}>
      <Select
        size="small"
        value={value.chatFont}
        onChange={(event) => onChange({ chatFont: event.target.value })}
        aria-label="Chat font family"
        sx={{ minWidth: 190 }}
      >
        {CATEGORY_ORDER.flatMap((category) => [
          <ListSubheader key={category}>{CHAT_FONT_CATEGORY_LABELS[category]}</ListSubheader>,
          ...CHAT_FONTS.filter((font) => font.category === category).map((font) => (
            <MenuItem key={font.id} value={font.id} sx={{ fontFamily: font.family }}>
              {font.label}
            </MenuItem>
          )),
        ])}
      </Select>
      <ToggleButtonGroup
        exclusive
        size="small"
        value={value.chatFontSize}
        onChange={(_event, next: AppSettings['general']['chatFontSize'] | null) => next && onChange({ chatFontSize: next })}
        aria-label="Chat font size"
      >
        {CHAT_FONT_SIZES.map((size) => (
          <ToggleButton key={size.id} value={size.id}>
            {size.id === 'xlarge' ? 'XL' : size.label}
          </ToggleButton>
        ))}
      </ToggleButtonGroup>
      <ToggleButtonGroup
        exclusive
        size="small"
        value={value.chatLineHeight}
        onChange={(_event, next: AppSettings['general']['chatLineHeight'] | null) => next && onChange({ chatLineHeight: next })}
        aria-label="Chat line height"
      >
        {CHAT_LINE_HEIGHTS.map((lh) => (
          <ToggleButton key={lh.id} value={lh.id}>
            {lh.label}
          </ToggleButton>
        ))}
      </ToggleButtonGroup>
    </Box>
  );
}

/**
 * Renders sample chat text with the given font settings applied locally, via the same CSS
 * variables AppShell sets globally — so this preview is pixel-identical to real chat messages.
 */
export function ChatFontPreview({ value }: { value: ChatFontValue }) {
  return (
    <Box
      sx={{
        '--sb-chat-font': chatFontFamily(value.chatFont),
        '--sb-prose-size': chatFontSizeValue(value.chatFontSize),
        '--sb-chat-line-height': chatLineHeightValue(value.chatLineHeight),
        p: 1.75,
        borderRadius: '8px',
        border: '1px solid var(--sb-border)',
        backgroundColor: 'var(--sb-canvas)',
      }}
    >
      <Typography variant="caption" sx={{ display: 'block', mb: 1, color: 'var(--sb-text-faint)', fontWeight: 600 }}>
        Preview
      </Typography>
      <Markdown text={CHAT_FONT_PREVIEW_TEXT} />
    </Box>
  );
}
