import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import type { ReactNode } from 'react';

export function SettingsHeader({ title, description }: { title: string; description?: ReactNode }) {
  return (
    <Box sx={{ mb: 3 }}>
      <Typography variant="h2" sx={{ mb: 0.5 }}>
        {title}
      </Typography>
      {description && (
        <Typography variant="body2" color="text.secondary" sx={{ maxWidth: 600 }}>
          {description}
        </Typography>
      )}
    </Box>
  );
}

/** A labeled settings row: text on the left, control on the right. Stacks on narrow screens. */
export function SettingRow({
  label,
  description,
  children,
  htmlFor,
}: {
  label: string;
  description?: ReactNode;
  children: ReactNode;
  htmlFor?: string;
}) {
  return (
    <Box
      sx={{
        display: 'flex',
        alignItems: { xs: 'flex-start', sm: 'center' },
        flexDirection: { xs: 'column', sm: 'row' },
        gap: { xs: 1, sm: 3 },
        py: 2,
        borderBottom: '1px solid var(--sb-border)',
        '&:last-of-type': { borderBottom: 'none' },
      }}
    >
      <Box sx={{ flex: 1, minWidth: 0 }}>
        <Typography variant="body2" component={htmlFor ? 'label' : 'div'} htmlFor={htmlFor} sx={{ fontWeight: 600, display: 'block' }}>
          {label}
        </Typography>
        {description && (
          <Typography variant="body2" color="text.secondary" sx={{ mt: 0.25 }}>
            {description}
          </Typography>
        )}
      </Box>
      <Box sx={{ flexShrink: 0 }}>{children}</Box>
    </Box>
  );
}

export function Panel({ children }: { children: ReactNode }) {
  return (
    <Box
      sx={{
        px: 2.5,
        border: '1px solid var(--sb-border)',
        borderRadius: '10px',
        backgroundColor: 'var(--sb-surface)',
      }}
    >
      {children}
    </Box>
  );
}
