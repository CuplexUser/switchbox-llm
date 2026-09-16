import { alpha, createTheme } from '@mui/material/styles';

/**
 * Tokens. Neutrals are cool graphite; the only saturated colors are the ink accent (interactive
 * elements) and the four channel colors that identify panes.
 */
export const tokens = {
  light: {
    canvas: '#F5F6F8',
    surface: '#FFFFFF',
    raised: '#FFFFFF',
    sunken: '#EDEFF3',
    border: '#DDE1E8',
    borderStrong: '#C6CCD6',
    text: '#1B2130',
    textMuted: '#5C6577',
    textFaint: '#8A92A2',
    ink: '#3A55D4',
  },
  dark: {
    canvas: '#12151C',
    surface: '#181C25',
    raised: '#1F2430',
    sunken: '#0E1117',
    border: '#2A303D',
    borderStrong: '#3A4252',
    text: '#E6E9EF',
    textMuted: '#9AA3B4',
    textFaint: '#6B7486',
    ink: '#8CA0FF',
  },
} as const;

export const CHANNELS = {
  light: ['#0E8A76', '#B7790B', '#8144C2', '#C93A57'],
  dark: ['#2CC3A6', '#EDB441', '#B58BEA', '#F07A92'],
} as const;

export const CHANNEL_NAMES = ['Teal', 'Amber', 'Violet', 'Rose'] as const;

export function channelVar(index: number): string {
  return `var(--sb-ch-${index % 4})`;
}

export function channelSoftVar(index: number): string {
  return `var(--sb-ch-${index % 4}-soft)`;
}

export const fonts = {
  ui: '"Instrument Sans Variable", "Segoe UI", system-ui, sans-serif',
  prose: '"Source Serif 4 Variable", Georgia, "Times New Roman", serif',
  mono: '"JetBrains Mono Variable", ui-monospace, "Cascadia Code", Consolas, monospace',
};

function cssTokens(mode: 'light' | 'dark'): Record<string, string> {
  const t = tokens[mode];
  const vars: Record<string, string> = {
    '--sb-canvas': t.canvas,
    '--sb-surface': t.surface,
    '--sb-raised': t.raised,
    '--sb-sunken': t.sunken,
    '--sb-border': t.border,
    '--sb-border-strong': t.borderStrong,
    '--sb-text': t.text,
    '--sb-text-muted': t.textMuted,
    '--sb-text-faint': t.textFaint,
    '--sb-ink': t.ink,
  };
  CHANNELS[mode].forEach((color, index) => {
    vars[`--sb-ch-${index}`] = color;
    vars[`--sb-ch-${index}-soft`] = alpha(color, mode === 'light' ? 0.1 : 0.14);
  });
  return vars;
}

export const globalStyles = {
  ':root': cssTokens('light'),
  '[data-mui-color-scheme="dark"]': cssTokens('dark'),
  'html, body, #root': { height: '100%' },
  body: { margin: 0, background: 'var(--sb-canvas)', WebkitFontSmoothing: 'antialiased' },
  '::selection': { background: 'color-mix(in srgb, var(--sb-ink) 28%, transparent)' },
  '*::-webkit-scrollbar': { width: 10, height: 10 },
  '*::-webkit-scrollbar-thumb': {
    background: 'var(--sb-border)',
    borderRadius: 10,
    border: '3px solid transparent',
    backgroundClip: 'content-box',
  },
  '*::-webkit-scrollbar-thumb:hover': { background: 'var(--sb-border-strong)', backgroundClip: 'content-box' },
  '.shiki, .shiki span': { color: 'var(--shiki-light)', background: 'transparent !important' },
  '[data-mui-color-scheme="dark"] .shiki, [data-mui-color-scheme="dark"] .shiki span': { color: 'var(--shiki-dark)' },
  '@media (prefers-reduced-motion: reduce)': {
    '*, *::before, *::after': { animationDuration: '0.01ms !important', transitionDuration: '0.01ms !important' },
  },
};

function palette(mode: 'light' | 'dark') {
  const t = tokens[mode];
  return {
    mode,
    primary: { main: t.ink, contrastText: mode === 'light' ? '#FFFFFF' : '#10131A' },
    secondary: { main: t.textMuted },
    error: { main: mode === 'light' ? '#C2334D' : '#F27089' },
    warning: { main: mode === 'light' ? '#A86A00' : '#EDB441' },
    success: { main: mode === 'light' ? '#0E8A5F' : '#3CCB8F' },
    background: { default: t.canvas, paper: t.surface },
    text: { primary: t.text, secondary: t.textMuted, disabled: t.textFaint },
    divider: t.border,
    action: {
      hover: alpha(t.text, 0.05),
      selected: alpha(t.ink, mode === 'light' ? 0.09 : 0.14),
      focus: alpha(t.ink, 0.16),
    },
  };
}

export const theme = createTheme({
  cssVariables: { colorSchemeSelector: 'data-mui-color-scheme' },
  colorSchemes: { light: { palette: palette('light') }, dark: { palette: palette('dark') } },
  shape: { borderRadius: 6 },
  typography: {
    fontFamily: fonts.ui,
    fontSize: 14,
    h1: { fontSize: '1.75rem', fontWeight: 600, letterSpacing: '-0.02em', lineHeight: 1.2 },
    h2: { fontSize: '1.375rem', fontWeight: 600, letterSpacing: '-0.015em', lineHeight: 1.25 },
    h3: { fontSize: '1.125rem', fontWeight: 600, letterSpacing: '-0.01em', lineHeight: 1.3 },
    h4: { fontSize: '1rem', fontWeight: 600, lineHeight: 1.4 },
    subtitle1: { fontSize: '0.9375rem', fontWeight: 550, lineHeight: 1.45 },
    subtitle2: { fontSize: '0.8125rem', fontWeight: 600, lineHeight: 1.4 },
    body1: { fontSize: '0.9375rem', lineHeight: 1.55 },
    body2: { fontSize: '0.8125rem', lineHeight: 1.5 },
    caption: { fontSize: '0.75rem', lineHeight: 1.4 },
    button: { textTransform: 'none', fontWeight: 550, letterSpacing: 0 },
    overline: { textTransform: 'none', letterSpacing: 0, fontWeight: 600, fontSize: '0.75rem' },
  },
  components: {
    MuiCssBaseline: { styleOverrides: globalStyles },
    MuiButtonBase: { defaultProps: { disableRipple: true } },
    MuiButton: {
      defaultProps: { disableElevation: true },
      styleOverrides: {
        root: {
          borderRadius: 6,
          paddingInline: 12,
          '&:focus-visible': { outline: '2px solid var(--sb-ink)', outlineOffset: 2 },
        },
        outlined: { borderColor: 'var(--sb-border-strong)', color: 'var(--sb-text)' },
        sizeSmall: { paddingInline: 10, minHeight: 30 },
      },
    },
    MuiIconButton: {
      styleOverrides: {
        root: {
          borderRadius: 6,
          color: 'var(--sb-text-muted)',
          '&:hover': { color: 'var(--sb-text)' },
          '&:focus-visible': { outline: '2px solid var(--sb-ink)', outlineOffset: 1 },
        },
      },
    },
    MuiPaper: {
      defaultProps: { elevation: 0 },
      styleOverrides: {
        root: { backgroundImage: 'none' },
        outlined: { borderColor: 'var(--sb-border)' },
      },
    },
    MuiPopover: {
      styleOverrides: {
        paper: {
          border: '1px solid var(--sb-border)',
          borderRadius: 10,
          boxShadow: '0 12px 32px -12px rgba(16, 20, 32, 0.28)',
          backgroundColor: 'var(--sb-raised)',
        },
      },
    },
    MuiMenu: { styleOverrides: { paper: { minWidth: 180 }, list: { padding: 4 } } },
    MuiMenuItem: {
      styleOverrides: {
        root: { borderRadius: 6, fontSize: '0.8125rem', minHeight: 34, gap: 10 },
      },
    },
    MuiListItemIcon: { styleOverrides: { root: { minWidth: '0 !important', color: 'inherit' } } },
    MuiDialog: {
      styleOverrides: {
        paper: {
          borderRadius: 14,
          border: '1px solid var(--sb-border)',
          backgroundColor: 'var(--sb-raised)',
          boxShadow: '0 24px 64px -24px rgba(16, 20, 32, 0.45)',
        },
      },
    },
    MuiDialogTitle: { styleOverrides: { root: { fontSize: '1.0625rem', fontWeight: 600, paddingBottom: 8 } } },
    MuiBackdrop: { styleOverrides: { root: { backgroundColor: 'rgba(12, 15, 22, 0.45)' } } },
    MuiTooltip: {
      defaultProps: { enterDelay: 400, arrow: false },
      styleOverrides: {
        tooltip: {
          fontSize: '0.75rem',
          fontWeight: 500,
          backgroundColor: 'var(--sb-text)',
          color: 'var(--sb-surface)',
          borderRadius: 6,
          padding: '5px 8px',
        },
      },
    },
    MuiOutlinedInput: {
      styleOverrides: {
        root: {
          borderRadius: 6,
          backgroundColor: 'var(--sb-surface)',
          '& .MuiOutlinedInput-notchedOutline': { borderColor: 'var(--sb-border-strong)' },
          '&:hover .MuiOutlinedInput-notchedOutline': { borderColor: 'var(--sb-text-faint)' },
        },
      },
    },
    MuiTextField: { defaultProps: { size: 'small' } },
    MuiSelect: { defaultProps: { size: 'small' } },
    MuiChip: {
      styleOverrides: {
        root: { borderRadius: 6, fontWeight: 550 },
        sizeSmall: { height: 24, fontSize: '0.75rem' },
      },
    },
    MuiSwitch: {
      styleOverrides: {
        root: { width: 42, height: 24, padding: 0, margin: 8 },
        switchBase: {
          padding: 3,
          '&.Mui-checked': { transform: 'translateX(18px)', color: '#fff' },
          '&.Mui-checked + .MuiSwitch-track': { opacity: 1, backgroundColor: 'var(--sb-ink)' },
          '&.Mui-focusVisible .MuiSwitch-thumb': { outline: '2px solid var(--sb-ink)', outlineOffset: 2 },
        },
        thumb: { width: 18, height: 18, boxShadow: 'none', color: '#fff' },
        track: { borderRadius: 12, opacity: 1, backgroundColor: 'var(--sb-border-strong)' },
      },
    },
    MuiTab: {
      styleOverrides: {
        root: { textTransform: 'none', minHeight: 40, fontWeight: 550, paddingInline: 12, minWidth: 0 },
      },
    },
    MuiTabs: { styleOverrides: { root: { minHeight: 40 }, indicator: { height: 2, borderRadius: 2 } } },
    MuiSkeleton: { styleOverrides: { root: { backgroundColor: 'var(--sb-sunken)' } } },
    MuiAlert: { styleOverrides: { root: { borderRadius: 8, alignItems: 'center' } } },
  },
});
