import DeleteOutlineRoundedIcon from '@mui/icons-material/DeleteOutlineRounded';
import EditOutlinedIcon from '@mui/icons-material/EditOutlined';
import HistoryToggleOffRoundedIcon from '@mui/icons-material/HistoryToggleOffRounded';
import MoreHorizRoundedIcon from '@mui/icons-material/MoreHorizRounded';
import PushPinOutlinedIcon from '@mui/icons-material/PushPinOutlined';
import Box from '@mui/material/Box';
import IconButton from '@mui/material/IconButton';
import InputBase from '@mui/material/InputBase';
import ListItemIcon from '@mui/material/ListItemIcon';
import Menu from '@mui/material/Menu';
import MenuItem from '@mui/material/MenuItem';
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';
import { useState } from 'react';
import { NavLink, useMatch, useNavigate } from 'react-router';
import type { Conversation } from '../../shared/types.ts';
import { useDeleteConversation, useUpdateConversation } from '../api/hooks.ts';
import { ConfirmDialog } from '../components/ConfirmDialog.tsx';
import { useChatStore } from '../stores/chat.ts';

/** A chat in the sidebar, with rename, pin and delete. */
export function ConversationItem({ conversation }: { conversation: Conversation }) {
  const navigate = useNavigate();
  const match = useMatch('/c/:conversationId');
  const active = match?.params.conversationId === conversation.id;
  const running = useChatStore((state) => Boolean(state.conversations[conversation.id]?.runId));
  const update = useUpdateConversation();
  const remove = useDeleteConversation();
  const forget = useChatStore((state) => state.forget);
  const [menuAnchor, setMenuAnchor] = useState<HTMLElement | null>(null);
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(conversation.title);
  const [confirming, setConfirming] = useState(false);

  function commitTitle(): void {
    setEditing(false);
    const next = title.trim();
    if (next && next !== conversation.title) update.mutate({ id: conversation.id, title: next });
    else setTitle(conversation.title);
  }

  if (editing) {
    return (
      <InputBase
        autoFocus
        fullWidth
        value={title}
        onChange={(event) => setTitle(event.target.value)}
        onBlur={commitTitle}
        onKeyDown={(event) => {
          if (event.key === 'Enter') commitTitle();
          if (event.key === 'Escape') {
            setTitle(conversation.title);
            setEditing(false);
          }
        }}
        inputProps={{ 'aria-label': 'Conversation title' }}
        sx={{
          fontSize: '0.8125rem',
          px: 1.25,
          py: 0.25,
          borderRadius: '6px',
          border: '1px solid var(--sb-ink)',
          backgroundColor: 'var(--sb-canvas)',
        }}
      />
    );
  }

  return (
    <>
      <Box
        component={NavLink}
        to={`/c/${conversation.id}`}
        onDoubleClick={() => setEditing(true)}
        sx={{
          position: 'relative',
          display: 'flex',
          alignItems: 'center',
          gap: 1,
          pl: 1.25,
          pr: 0.5,
          minHeight: 34,
          borderRadius: '6px',
          color: active ? 'var(--sb-text)' : 'var(--sb-text-muted)',
          backgroundColor: active ? 'action.selected' : 'transparent',
          textDecoration: 'none',
          '&:hover': { backgroundColor: active ? 'action.selected' : 'action.hover', color: 'var(--sb-text)' },
          '&:hover .sb-more, & .sb-more[aria-expanded="true"]': { opacity: 1 },
          '&:focus-visible': { outline: '2px solid var(--sb-ink)', outlineOffset: -2 },
        }}
      >
        {running && (
          <Box
            aria-label="Generating"
            sx={{
              width: 6,
              height: 6,
              borderRadius: '50%',
              flexShrink: 0,
              backgroundColor: 'var(--sb-ink)',
              animation: 'sb-pulse 1.2s ease-in-out infinite',
              '@keyframes sb-pulse': { '50%': { opacity: 0.3 } },
            }}
          />
        )}
        <Typography variant="body2" noWrap sx={{ flex: 1, fontWeight: active ? 550 : 450 }}>
          {conversation.title}
        </Typography>
        {!conversation.persist && (
          <Tooltip title="Temporary: not saved" describeChild>
            <HistoryToggleOffRoundedIcon sx={{ fontSize: 15, color: 'var(--sb-text-faint)' }} />
          </Tooltip>
        )}
        <IconButton
          className="sb-more"
          size="small"
          aria-label={`Options for ${conversation.title}`}
          aria-haspopup="menu"
          aria-expanded={Boolean(menuAnchor)}
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            setMenuAnchor(event.currentTarget);
          }}
          sx={{ opacity: { xs: 1, md: 0 }, p: 0.25, '&:focus-visible': { opacity: 1 } }}
        >
          <MoreHorizRoundedIcon sx={{ fontSize: 18 }} />
        </IconButton>
      </Box>

      <Menu anchorEl={menuAnchor} open={Boolean(menuAnchor)} onClose={() => setMenuAnchor(null)}>
        <MenuItem
          onClick={() => {
            setMenuAnchor(null);
            setEditing(true);
          }}
        >
          <ListItemIcon>
            <EditOutlinedIcon fontSize="small" />
          </ListItemIcon>
          Rename
        </MenuItem>
        <MenuItem
          onClick={() => {
            setMenuAnchor(null);
            update.mutate({ id: conversation.id, pinned: !conversation.pinned });
          }}
        >
          <ListItemIcon>
            <PushPinOutlinedIcon fontSize="small" />
          </ListItemIcon>
          {conversation.pinned ? 'Unpin' : 'Pin'}
        </MenuItem>
        <MenuItem
          onClick={() => {
            setMenuAnchor(null);
            setConfirming(true);
          }}
          sx={{ color: 'error.main' }}
        >
          <ListItemIcon>
            <DeleteOutlineRoundedIcon fontSize="small" />
          </ListItemIcon>
          Delete
        </MenuItem>
      </Menu>

      <ConfirmDialog
        open={confirming}
        title="Delete conversation?"
        body={`“${conversation.title}” and all of its replies will be removed. This can't be undone.`}
        confirmLabel="Delete"
        destructive
        onClose={() => setConfirming(false)}
        onConfirm={() => {
          forget(conversation.id);
          remove.mutate(conversation.id);
          if (active) void navigate('/');
        }}
      />
    </>
  );
}
