import CloseRoundedIcon from '@mui/icons-material/CloseRounded';
import Box from '@mui/material/Box';
import ButtonBase from '@mui/material/ButtonBase';
import IconButton from '@mui/material/IconButton';
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';
import { useState } from 'react';
import type { ModelRef } from '../../shared/types.ts';
import { ModelPicker } from './ModelPicker.tsx';
import { ProviderMark } from './ProviderMark.tsx';

/** A settings field showing the chosen model, which opens the model picker. */
export function ModelButton({
  value,
  onChange,
  placeholder = 'Choose a model',
  warn = false,
  clearLabel,
}: {
  value: ModelRef | null;
  onChange: (value: ModelRef | null) => void;
  placeholder?: string;
  /** Shows the placeholder as a warning, for settings that don't work without a model. */
  warn?: boolean;
  /** When set, a button clears the choice. */
  clearLabel?: string;
}) {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  return (
    <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
      <ButtonBase
        onClick={(event) => setAnchor(event.currentTarget)}
        sx={{
          gap: 1,
          px: 1.5,
          height: 40,
          minWidth: 220,
          maxWidth: 300,
          justifyContent: 'flex-start',
          borderRadius: '6px',
          border: '1px solid var(--sb-border-strong)',
          '&:hover': { borderColor: 'var(--sb-text-faint)' },
          '&:focus-visible': { outline: '2px solid var(--sb-ink)' },
        }}
      >
        {value ? (
          <>
            <ProviderMark provider={value.provider} />
            <Box sx={{ minWidth: 0, textAlign: 'left' }}>
              <Typography variant="body2" noWrap sx={{ fontWeight: 550 }}>
                {value.model}
              </Typography>
            </Box>
          </>
        ) : (
          <Typography variant="body2" sx={{ color: warn ? 'warning.main' : 'var(--sb-text-faint)' }}>
            {placeholder}
          </Typography>
        )}
      </ButtonBase>
      {value && clearLabel && (
        <Tooltip title={clearLabel}>
          <IconButton size="small" aria-label={clearLabel} onClick={() => onChange(null)}>
            <CloseRoundedIcon sx={{ fontSize: 18 }} />
          </IconButton>
        </Tooltip>
      )}
      <ModelPicker open={Boolean(anchor)} anchorEl={anchor} onClose={() => setAnchor(null)} selected={value} onSelect={onChange} />
    </Box>
  );
}
