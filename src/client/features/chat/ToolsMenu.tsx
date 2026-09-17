import BuildOutlinedIcon from '@mui/icons-material/BuildOutlined';
import ErrorOutlineRoundedIcon from '@mui/icons-material/ErrorOutlineRounded';
import Box from '@mui/material/Box';
import ButtonBase from '@mui/material/ButtonBase';
import Checkbox from '@mui/material/Checkbox';
import Divider from '@mui/material/Divider';
import ListItemText from '@mui/material/ListItemText';
import Menu from '@mui/material/Menu';
import MenuItem from '@mui/material/MenuItem';
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';
import { useState } from 'react';
import { Link as RouterLink } from 'react-router';
import type { ConversationDetail, ToolGroupInfo } from '../../../shared/types.ts';
import { useTools, useUpdateConversation } from '../../api/hooks.ts';

export function groupOn(conversation: ConversationDetail, group: ToolGroupInfo): boolean {
  return conversation.toolGroups?.[group.id] ?? group.onByDefault;
}

/** The chat's optional tool groups: run code, search earlier chats, MCP servers and so on. */
export function ToolsMenu({ conversation, compact }: { conversation: ConversationDetail; compact: boolean }) {
  const tools = useTools();
  const update = useUpdateConversation();
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  // Web and memory have their own chips; attachments are only offered when a file is attached.
  const groups = (tools.data ?? []).filter((group) => group.toggledBy === null && group.id !== 'attachments');
  const onCount = groups.filter((group) => groupOn(conversation, group)).length;
  const failing = groups.some((group) => group.error && groupOn(conversation, group));

  function toggle(group: ToolGroupInfo): void {
    update.mutate({ id: conversation.id, toolGroups: { ...conversation.toolGroups, [group.id]: !groupOn(conversation, group) } });
  }

  return (
    <>
      <Tooltip title="Tools models can use in this chat" describeChild>
        <ButtonBase
          onClick={(event) => setAnchor(event.currentTarget)}
          aria-haspopup="menu"
          aria-expanded={Boolean(anchor)}
          sx={{
            gap: 0.75,
            px: 1,
            height: 28,
            borderRadius: '6px',
            fontSize: '0.75rem',
            fontWeight: 550,
            border: '1px solid',
            borderColor: onCount > 0 ? 'var(--sb-border-strong)' : 'var(--sb-border)',
            color: onCount > 0 ? 'var(--sb-text)' : 'var(--sb-text-faint)',
            backgroundColor: onCount > 0 ? 'var(--sb-surface)' : 'transparent',
            '&:hover': { color: 'var(--sb-text)' },
            '&:focus-visible': { outline: '2px solid var(--sb-ink)' },
          }}
        >
          {failing ? <ErrorOutlineRoundedIcon sx={{ fontSize: 15, color: 'error.main' }} /> : <BuildOutlinedIcon sx={{ fontSize: 15 }} />}
          {compact ? '' : groups.length > 0 ? `Tools ${onCount}/${groups.length}` : 'Tools'}
        </ButtonBase>
      </Tooltip>
      <Menu anchorEl={anchor} open={Boolean(anchor)} onClose={() => setAnchor(null)} slotProps={{ paper: { sx: { width: 320 } } }}>
        {groups.length === 0 && (
          <Typography variant="body2" sx={{ px: 2, py: 1, color: 'var(--sb-text-faint)' }}>
            {tools.isLoading ? 'Loading tools…' : 'No optional tools.'}
          </Typography>
        )}
        {groups.map((group) => (
          <MenuItem key={group.id} onClick={() => toggle(group)} sx={{ alignItems: 'flex-start', whiteSpace: 'normal' }}>
            <Checkbox edge="start" size="small" checked={groupOn(conversation, group)} tabIndex={-1} disableRipple sx={{ mt: -0.5 }} />
            <ListItemText
              primary={group.kind === 'mcp' ? `${group.label} (MCP)` : group.label}
              secondary={
                <Box component="span" sx={{ color: group.error ? 'error.main' : undefined }}>
                  {group.error ? `Could not connect: ${group.error.split('\n')[0]}` : group.description}
                </Box>
              }
              slotProps={{ primary: { variant: 'body2', sx: { fontWeight: 550 } }, secondary: { variant: 'caption' } }}
            />
          </MenuItem>
        ))}
        <Divider />
        <MenuItem component={RouterLink} to="/settings/tools" onClick={() => setAnchor(null)}>
          <Typography variant="body2" color="text.secondary">
            Tool settings and approvals…
          </Typography>
        </MenuItem>
      </Menu>
    </>
  );
}
