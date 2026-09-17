import CheckRoundedIcon from '@mui/icons-material/CheckRounded';
import ExpandMoreRoundedIcon from '@mui/icons-material/ExpandMoreRounded';
import Box from '@mui/material/Box';
import ButtonBase from '@mui/material/ButtonBase';
import Divider from '@mui/material/Divider';
import ListItemIcon from '@mui/material/ListItemIcon';
import ListItemText from '@mui/material/ListItemText';
import Menu from '@mui/material/Menu';
import MenuItem from '@mui/material/MenuItem';
import { useState } from 'react';
import type { SystemPrompt } from '../../../shared/types.ts';

export function scopeLabel(scope: string | null, profiles: SystemPrompt[]): string {
  if (scope === null) return 'All chats';
  const name = profiles.find((profile) => profile.id === scope)?.name;
  return name ? `Only ${name}` : 'Only one profile';
}

/** Where a memory is used: every chat, or only panes using one profile. */
export function ScopeButton({
  value,
  profiles,
  onChange,
  size = 'small',
}: {
  value: string | null;
  profiles: SystemPrompt[];
  onChange: (scope: string | null) => void;
  size?: 'small' | 'medium';
}) {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const choose = (scope: string | null) => {
    setAnchor(null);
    if (scope !== value) onChange(scope);
  };
  const option = (scope: string | null, primary: string, secondary?: string) => (
    <MenuItem key={scope ?? 'all'} selected={scope === value} onClick={() => choose(scope)}>
      <ListItemIcon>{scope === value && <CheckRoundedIcon fontSize="small" />}</ListItemIcon>
      <ListItemText primary={primary} secondary={secondary} />
    </MenuItem>
  );

  return (
    <>
      <ButtonBase
        onClick={(event) => setAnchor(event.currentTarget)}
        aria-haspopup="menu"
        aria-label={`Used in: ${scopeLabel(value, profiles)}. Change where this memory is used`}
        sx={{
          gap: 0.25,
          pl: 0.875,
          pr: 0.5,
          height: size === 'small' ? 22 : 40,
          minWidth: size === 'small' ? undefined : 150,
          maxWidth: size === 'small' ? 220 : 200,
          flexShrink: 0,
          justifyContent: 'space-between',
          borderRadius: size === 'small' ? '4px' : '6px',
          border: '1px solid',
          borderColor: size === 'small' ? 'var(--sb-border)' : 'var(--sb-border-strong)',
          fontSize: size === 'small' ? '0.75rem' : '0.875rem',
          color: value === null ? 'var(--sb-text-muted)' : 'var(--sb-text)',
          whiteSpace: 'nowrap',
          '&:hover': { borderColor: 'var(--sb-text-faint)' },
          '&:focus-visible': { outline: '2px solid var(--sb-ink)' },
        }}
      >
        <Box component="span" sx={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>
          {scopeLabel(value, profiles)}
        </Box>
        <ExpandMoreRoundedIcon sx={{ fontSize: size === 'small' ? 14 : 18, color: 'var(--sb-text-faint)' }} />
      </ButtonBase>
      <Menu anchorEl={anchor} open={Boolean(anchor)} onClose={() => setAnchor(null)}>
        {option(null, 'All chats', 'Sent in every chat with memory on')}
        {profiles.length > 0 && <Divider />}
        {profiles.map((profile) => option(profile.id, `Only ${profile.name}`))}
      </Menu>
    </>
  );
}
