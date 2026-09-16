import Box from '@mui/material/Box';
import Tab from '@mui/material/Tab';
import Tabs from '@mui/material/Tabs';
import Typography from '@mui/material/Typography';
import useMediaQuery from '@mui/material/useMediaQuery';
import { Navigate, useNavigate, useParams } from 'react-router';
import { DataTab } from './DataTab.tsx';
import { GeneralTab } from './GeneralTab.tsx';
import { GenerationTab } from './GenerationTab.tsx';
import { MemoryTab } from './MemoryTab.tsx';
import { PromptsTab } from './PromptsTab.tsx';
import { ProvidersTab } from './ProvidersTab.tsx';
import { WebTab } from './WebTab.tsx';

const TABS = [
  { id: 'general', label: 'General', element: <GeneralTab /> },
  { id: 'providers', label: 'Providers', element: <ProvidersTab /> },
  { id: 'web', label: 'Web search', element: <WebTab /> },
  { id: 'generation', label: 'Generation', element: <GenerationTab /> },
  { id: 'prompts', label: 'System prompts', element: <PromptsTab /> },
  { id: 'memory', label: 'Memory', element: <MemoryTab /> },
  { id: 'data', label: 'Data', element: <DataTab /> },
] as const;

export function SettingsPage() {
  const { tab } = useParams();
  const navigate = useNavigate();
  const wide = useMediaQuery('(min-width: 900px)');
  const current = TABS.find((entry) => entry.id === tab);
  if (!current) return <Navigate to="/settings/general" replace />;

  return (
    <Box sx={{ flex: 1, overflowY: 'auto' }}>
      <Box sx={{ maxWidth: 1040, mx: 'auto', px: { xs: 2, md: 4 }, pt: { xs: 8, md: 6 }, pb: 8 }}>
        <Typography variant="h1" sx={{ mb: 3 }}>
          Settings
        </Typography>
        <Box sx={{ display: 'flex', flexDirection: wide ? 'row' : 'column', gap: wide ? 5 : 2 }}>
          <Tabs
            orientation={wide ? 'vertical' : 'horizontal'}
            variant={wide ? 'standard' : 'scrollable'}
            value={current.id}
            onChange={(_event, value: string) => void navigate(`/settings/${value}`)}
            sx={{
              flexShrink: 0,
              width: wide ? 190 : 'auto',
              borderBottom: wide ? 'none' : '1px solid var(--sb-border)',
              '& .MuiTabs-indicator': wide ? { left: 0, right: 'auto', width: 2 } : {},
              '& .MuiTab-root': wide ? { alignItems: 'flex-start', pl: 2, minHeight: 38 } : {},
            }}
          >
            {TABS.map((entry) => (
              <Tab key={entry.id} value={entry.id} label={entry.label} />
            ))}
          </Tabs>
          <Box sx={{ flex: 1, minWidth: 0, maxWidth: 760 }}>{current.element}</Box>
        </Box>
      </Box>
    </Box>
  );
}
