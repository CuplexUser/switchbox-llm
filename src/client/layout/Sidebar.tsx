import DarkModeOutlinedIcon from '@mui/icons-material/DarkModeOutlined';
import DeleteOutlineRoundedIcon from '@mui/icons-material/DeleteOutlineRounded';
import EditOutlinedIcon from '@mui/icons-material/EditOutlined';
import HistoryToggleOffRoundedIcon from '@mui/icons-material/HistoryToggleOffRounded';
import KeyboardDoubleArrowLeftRoundedIcon from '@mui/icons-material/KeyboardDoubleArrowLeftRounded';
import LightModeOutlinedIcon from '@mui/icons-material/LightModeOutlined';
import MoreHorizRoundedIcon from '@mui/icons-material/MoreHorizRounded';
import PsychologyAltOutlinedIcon from '@mui/icons-material/PsychologyAltOutlined';
import PushPinOutlinedIcon from '@mui/icons-material/PushPinOutlined';
import SearchRoundedIcon from '@mui/icons-material/SearchRounded';
import SettingsOutlinedIcon from '@mui/icons-material/SettingsOutlined';
import AddRoundedIcon from '@mui/icons-material/AddRounded';
import BarChartRoundedIcon from '@mui/icons-material/BarChartRounded';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import IconButton from '@mui/material/IconButton';
import InputBase from '@mui/material/InputBase';
import ListItemIcon from '@mui/material/ListItemIcon';
import Menu from '@mui/material/Menu';
import MenuItem from '@mui/material/MenuItem';
import Skeleton from '@mui/material/Skeleton';
import { useColorScheme } from '@mui/material/styles';
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';
import { useMemo, useState } from 'react';
import { NavLink, useMatch, useNavigate } from 'react-router';
import type { Conversation } from '../../shared/types.ts';
import {
  useConversations,
  useDeleteConversation,
  usePendingMemoryCount,
  useSettings,
  useUpdateConversation,
  useUpdateSettings,
} from '../api/hooks.ts';
import { ConfirmDialog } from '../components/ConfirmDialog.tsx';
import { groupConversations } from '../lib/format.ts';
import { useChatStore } from '../stores/chat.ts';

export const SIDEBAR_WIDTH = 272;

function Wordmark() {
  return (
    <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.25 }}>
      <Box aria-hidden sx={{ display: 'flex', alignItems: 'flex-end', gap: '2.5px', height: 18 }}>
        {[14, 10, 18, 8].map((height, index) => (
          <Box
            key={index}
            sx={{ width: 3.5, height, borderRadius: 2, backgroundColor: `var(--sb-ch-${index})` }}
          />
        ))}
      </Box>
      <Typography sx={{ fontWeight: 650, fontSize: '1.0625rem', letterSpacing: '-0.02em' }}>Switchbox</Typography>
    </Box>
  );
}

function ConversationItem({ conversation }: { conversation: Conversation }) {
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

function FooterLink({ to, icon, label, badge }: { to: string; icon: React.ReactNode; label: string; badge?: number }) {
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

export function Sidebar({ onCollapse, onOpenPalette }: { onCollapse: () => void; onOpenPalette: () => void }) {
  const conversations = useConversations();
  const pending = usePendingMemoryCount();
  const navigate = useNavigate();
  const [search, setSearch] = useState('');

  const groups = useMemo(() => {
    const term = search.trim().toLowerCase();
    const list = (conversations.data ?? []).filter(
      (conversation) => !conversation.archived && (!term || conversation.title.toLowerCase().includes(term)),
    );
    return groupConversations(list);
  }, [conversations.data, search]);

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', pl: 2, pr: 1, pt: 1.75, pb: 1.5 }}>
        <Wordmark />
        <Tooltip title="Hide sidebar (Ctrl+\)">
          <IconButton size="small" aria-label="Hide sidebar" onClick={onCollapse}>
            <KeyboardDoubleArrowLeftRoundedIcon fontSize="small" />
          </IconButton>
        </Tooltip>
      </Box>

      <Box sx={{ px: 1.5, display: 'flex', flexDirection: 'column', gap: 1 }}>
        <Button
          variant="outlined"
          startIcon={<AddRoundedIcon />}
          onClick={() => void navigate('/')}
          sx={{ justifyContent: 'flex-start', backgroundColor: 'var(--sb-canvas)' }}
        >
          New chat
        </Button>
        <Box
          sx={{
            display: 'flex',
            alignItems: 'center',
            gap: 1,
            px: 1.25,
            height: 34,
            borderRadius: '6px',
            backgroundColor: 'var(--sb-sunken)',
          }}
        >
          <SearchRoundedIcon sx={{ fontSize: 17, color: 'var(--sb-text-faint)' }} />
          <InputBase
            fullWidth
            placeholder="Search chats"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            inputProps={{ 'aria-label': 'Search chats' }}
            sx={{ fontSize: '0.8125rem' }}
          />
          <Tooltip title="Command palette" describeChild>
            <Box
              component="button"
              type="button"
              onClick={onOpenPalette}
              sx={{
                border: '1px solid var(--sb-border-strong)',
                borderRadius: '4px',
                background: 'none',
                color: 'var(--sb-text-faint)',
                fontSize: '0.6875rem',
                fontFamily: 'inherit',
                px: 0.5,
                py: 0.125,
                cursor: 'pointer',
                whiteSpace: 'nowrap',
              }}
            >
              Ctrl K
            </Box>
          </Tooltip>
        </Box>
      </Box>

      <Box sx={{ flex: 1, overflowY: 'auto', px: 1, pt: 1.5, pb: 1 }}>
        {conversations.isLoading &&
          Array.from({ length: 5 }, (_, index) => <Skeleton key={index} height={34} sx={{ mx: 0.5 }} />)}
        {conversations.isSuccess && groups.length === 0 && (
          <Typography variant="body2" sx={{ px: 1.25, py: 2, color: 'var(--sb-text-faint)' }}>
            {search ? 'No chats match your search.' : 'Your chats will show up here.'}
          </Typography>
        )}
        {groups.map((group) => (
          <Box key={group.label} sx={{ mb: 1.5 }}>
            <Typography variant="caption" component="h2" sx={{ display: 'block', px: 1.25, pb: 0.5, color: 'var(--sb-text-faint)', fontWeight: 600 }}>
              {group.label}
            </Typography>
            {group.items.map((conversation) => (
              <ConversationItem key={conversation.id} conversation={conversation} />
            ))}
          </Box>
        ))}
      </Box>

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
          <ThemeToggle />
        </Box>
      </Box>
    </Box>
  );
}
