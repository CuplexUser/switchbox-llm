import BarChartRoundedIcon from '@mui/icons-material/BarChartRounded';
import DarkModeOutlinedIcon from '@mui/icons-material/DarkModeOutlined';
import LightModeOutlinedIcon from '@mui/icons-material/LightModeOutlined';
import PsychologyAltOutlinedIcon from '@mui/icons-material/PsychologyAltOutlined';
import SettingsOutlinedIcon from '@mui/icons-material/SettingsOutlined';
import Box from '@mui/material/Box';
import IconButton from '@mui/material/IconButton';
import { useColorScheme } from '@mui/material/styles';
import Tooltip from '@mui/material/Tooltip';
import type { ReactNode } from 'react';
import { NavLink } from 'react-router';
import { usePendingMemoryCount, useSettings, useUpdateSettings } from '../api/hooks.ts';
import { ChatFontButton } from './ChatFontButton.tsx';

function ThemeToggle() {
  const { colorScheme } = useColorScheme();
  const settings = useSettings();
  const updateSettings = useUpdateSettings();
  const dark = colorScheme === 'dark';
  return (
    <Tooltip title={dark ? 'Use light theme' : 'Use dark theme'}>
      <IconButton
        aria-label={dark ? 'Use light theme' : 'Use dark theme'}
        onClick={() => {
          if (!settings.data) return;
          updateSettings.mutate({
            section: 'general',
            value: { ...settings.data.general, theme: dark ? 'light' : 'dark' },
          });
        }}
      >
        {dark ? <LightModeOutlinedIcon fontSize="small" /> : <DarkModeOutlinedIcon fontSize="small" />}
      </IconButton>
    </Tooltip>
  );
}

function FooterLink({ to, icon, label, badge }: { to: string; icon: ReactNode; label: string; badge?: number }) {
  return (
    <Box
      component={NavLink}
      to={to}
      sx={{
        display: 'flex',
        alignItems: 'center',
        gap: 1.25,
        px: 1.25,
        minHeight: 34,
        borderRadius: '6px',
        color: 'var(--sb-text-muted)',
        textDecoration: 'none',
        fontSize: '0.8125rem',
        fontWeight: 500,
        '&:hover': { backgroundColor: 'action.hover', color: 'var(--sb-text)' },
        '&.active': { backgroundColor: 'action.selected', color: 'var(--sb-text)' },
        '&:focus-visible': { outline: '2px solid var(--sb-ink)', outlineOffset: -2 },
      }}
    >
      {icon}
      <Box sx={{ flex: 1 }}>{label}</Box>
      {badge ? (
        <Box
          aria-label={`${badge} waiting for review`}
          sx={{
            minWidth: 20,
            height: 20,
            px: 0.75,
            borderRadius: 10,
            display: 'grid',
            placeItems: 'center',
            fontSize: '0.6875rem',
            fontWeight: 650,
            color: 'primary.contrastText',
            backgroundColor: 'var(--sb-ink)',
          }}
        >
          {badge}
        </Box>
      ) : null}
    </Box>
  );
}

/** Links to Usage, Memory and Settings, and the theme switch. */
export function SidebarFooter() {
  const pending = usePendingMemoryCount();
  return (
    <Box sx={{ borderTop: '1px solid var(--sb-border)', p: 1, display: 'flex', flexDirection: 'column', gap: 0.25 }}>
      <FooterLink to="/usage" icon={<BarChartRoundedIcon sx={{ fontSize: 18 }} />} label="Usage" />
      <FooterLink
        to="/memory"
        icon={<PsychologyAltOutlinedIcon sx={{ fontSize: 18 }} />}
        label="Memory"
        badge={pending.data}
      />
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
        <Box sx={{ flex: 1 }}>
          <FooterLink to="/settings" icon={<SettingsOutlinedIcon sx={{ fontSize: 18 }} />} label="Settings" />
        </Box>
        <ChatFontButton />
        <ThemeToggle />
      </Box>
    </Box>
  );
}
