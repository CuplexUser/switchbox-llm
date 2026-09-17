import KeyboardDoubleArrowLeftRoundedIcon from '@mui/icons-material/KeyboardDoubleArrowLeftRounded';
import SearchRoundedIcon from '@mui/icons-material/SearchRounded';
import AddRoundedIcon from '@mui/icons-material/AddRounded';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import IconButton from '@mui/material/IconButton';
import InputBase from '@mui/material/InputBase';
import Skeleton from '@mui/material/Skeleton';
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';
import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router';
import { useConversations } from '../api/hooks.ts';
import { groupConversations } from '../lib/format.ts';
import { ConversationItem } from './ConversationItem.tsx';
import { SidebarFooter } from './SidebarFooter.tsx';

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

export function Sidebar({ onCollapse, onOpenPalette }: { onCollapse: () => void; onOpenPalette: () => void }) {
  const conversations = useConversations();
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

      <SidebarFooter />
    </Box>
  );
}
