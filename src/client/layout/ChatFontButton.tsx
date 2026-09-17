import TextFieldsRoundedIcon from '@mui/icons-material/TextFieldsRounded';
import Box from '@mui/material/Box';
import IconButton from '@mui/material/IconButton';
import Popover from '@mui/material/Popover';
import Skeleton from '@mui/material/Skeleton';
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';
import { useState } from 'react';
import { useSettings, useUpdateSettings } from '../api/hooks.ts';
import { ChatFontFields, ChatFontPreview } from '../features/settings/ChatFontControls.tsx';

/** Quick-access popover for chat font settings, so they can be changed without leaving the chat. */
export function ChatFontButton() {
  const settings = useSettings();
  const update = useUpdateSettings();
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);

  if (!settings.data) return <Skeleton variant="circular" width={34} height={34} />;
  const general = settings.data.general;

  return (
    <>
      <Tooltip title="Chat font">
        <IconButton aria-label="Chat font" onClick={(event) => setAnchor(event.currentTarget)}>
          <TextFieldsRoundedIcon fontSize="small" />
        </IconButton>
      </Tooltip>
      <Popover
        open={Boolean(anchor)}
        anchorEl={anchor}
        onClose={() => setAnchor(null)}
        anchorOrigin={{ vertical: 'top', horizontal: 'right' }}
        transformOrigin={{ vertical: 'bottom', horizontal: 'left' }}
      >
        <Box sx={{ p: 2, width: 340, display: 'flex', flexDirection: 'column', gap: 1.5 }}>
          <Typography variant="subtitle2">Chat font</Typography>
          <ChatFontFields
            value={general}
            onChange={(patch) => update.mutate({ section: 'general', value: { ...general, ...patch } })}
          />
          <ChatFontPreview value={general} />
        </Box>
      </Popover>
    </>
  );
}
