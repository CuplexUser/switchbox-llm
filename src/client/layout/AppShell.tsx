import MenuRoundedIcon from '@mui/icons-material/MenuRounded';
import Box from '@mui/material/Box';
import Drawer from '@mui/material/Drawer';
import IconButton from '@mui/material/IconButton';
import { useColorScheme } from '@mui/material/styles';
import useMediaQuery from '@mui/material/useMediaQuery';
import { useEffect, useState } from 'react';
import { Outlet, useLocation, useNavigate } from 'react-router';
import { useSettings } from '../api/hooks.ts';
import { CommandPalette } from './CommandPalette.tsx';
import { Sidebar, SIDEBAR_WIDTH } from './Sidebar.tsx';

export function AppShell() {
  const settings = useSettings();
  const { setMode } = useColorScheme();
  const navigate = useNavigate();
  const location = useLocation();
  const wide = useMediaQuery('(min-width: 900px)');
  const [collapsed, setCollapsed] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);

  const theme = settings.data?.general.theme;
  useEffect(() => {
    if (theme) setMode(theme);
  }, [theme, setMode]);

  // Close the mobile drawer after navigating (adjusting state during render, not in an effect).
  const [lastPath, setLastPath] = useState(location.pathname);
  if (location.pathname !== lastPath) {
    setLastPath(location.pathname);
    setMobileOpen(false);
  }

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent): void {
      const mod = event.ctrlKey || event.metaKey;
      if (mod && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setPaletteOpen((open) => !open);
      } else if (mod && event.shiftKey && event.key.toLowerCase() === 'o') {
        event.preventDefault();
        void navigate('/');
      } else if (mod && event.key === '\\') {
        event.preventDefault();
        setCollapsed((value) => !value);
      }
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [navigate]);

  const density = settings.data?.general.density ?? 'comfortable';
  const sidebar = (
    <Sidebar onCollapse={wide ? () => setCollapsed(true) : () => setMobileOpen(false)} onOpenPalette={() => setPaletteOpen(true)} />
  );

  return (
    <Box
      sx={{
        display: 'flex',
        height: '100dvh',
        overflow: 'hidden',
        '--sb-prose-size': density === 'compact' ? '0.9375rem' : '1rem',
        '--sb-gap': density === 'compact' ? '14px' : '22px',
      }}
    >
      {wide ? (
        <Box
          component="nav"
          aria-label="Conversations"
          sx={{
            width: collapsed ? 0 : SIDEBAR_WIDTH,
            flexShrink: 0,
            overflow: 'hidden',
            transition: 'width 180ms ease',
            borderRight: collapsed ? 'none' : '1px solid var(--sb-border)',
            backgroundColor: 'var(--sb-surface)',
          }}
        >
          <Box sx={{ width: SIDEBAR_WIDTH, height: '100%' }}>{sidebar}</Box>
        </Box>
      ) : (
        <Drawer
          open={mobileOpen}
          onClose={() => setMobileOpen(false)}
          slotProps={{ paper: { sx: { width: SIDEBAR_WIDTH, backgroundColor: 'var(--sb-surface)' } } }}
        >
          {sidebar}
        </Drawer>
      )}

      <Box component="main" sx={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', position: 'relative' }}>
        {(!wide || collapsed) && (
          <IconButton
            aria-label="Show sidebar"
            onClick={() => (wide ? setCollapsed(false) : setMobileOpen(true))}
            sx={{ position: 'absolute', top: 10, left: 10, zIndex: 3 }}
          >
            <MenuRoundedIcon fontSize="small" />
          </IconButton>
        )}
        <Box
          sx={{
            flex: 1,
            minHeight: 0,
            display: 'flex',
            flexDirection: 'column',
            '--sb-shell-inset': !wide || collapsed ? '52px' : '0px',
          }}
        >
          <Outlet />
        </Box>
      </Box>

      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} />
    </Box>
  );
}
