import AddRoundedIcon from '@mui/icons-material/AddRounded';
import BarChartRoundedIcon from '@mui/icons-material/BarChartRounded';
import ChatBubbleOutlineRoundedIcon from '@mui/icons-material/ChatBubbleOutlineRounded';
import PsychologyAltOutlinedIcon from '@mui/icons-material/PsychologyAltOutlined';
import SearchRoundedIcon from '@mui/icons-material/SearchRounded';
import SettingsOutlinedIcon from '@mui/icons-material/SettingsOutlined';
import TuneRoundedIcon from '@mui/icons-material/TuneRounded';
import Box from '@mui/material/Box';
import Dialog from '@mui/material/Dialog';
import InputBase from '@mui/material/InputBase';
import Typography from '@mui/material/Typography';
import { useMemo, useState, type KeyboardEvent, type ReactNode } from 'react';
import { useNavigate } from 'react-router';
import { useConversations } from '../api/hooks.ts';

interface Command {
  id: string;
  label: string;
  hint?: string;
  icon: ReactNode;
  run: () => void;
}

export function CommandPalette({ open, onClose }: { open: boolean; onClose: () => void }) {
  const navigate = useNavigate();
  const conversations = useConversations();
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);

  const commands = useMemo<Command[]>(() => {
    const go = (path: string) => () => void navigate(path);
    const actions: Command[] = [
      { id: 'new', label: 'New chat', hint: 'Ctrl Shift O', icon: <AddRoundedIcon fontSize="small" />, run: go('/') },
      { id: 'usage', label: 'Usage', icon: <BarChartRoundedIcon fontSize="small" />, run: go('/usage') },
      { id: 'memory', label: 'Memory', icon: <PsychologyAltOutlinedIcon fontSize="small" />, run: go('/memory') },
      { id: 'settings', label: 'Settings', icon: <SettingsOutlinedIcon fontSize="small" />, run: go('/settings/general') },
      { id: 'providers', label: 'Provider settings', icon: <TuneRoundedIcon fontSize="small" />, run: go('/settings/providers') },
      { id: 'prompts', label: 'Profiles', icon: <TuneRoundedIcon fontSize="small" />, run: go('/settings/prompts') },
      { id: 'tools', label: 'Tool settings', icon: <TuneRoundedIcon fontSize="small" />, run: go('/settings/tools') },
    ];
    const chats: Command[] = (conversations.data ?? []).map((conversation) => ({
      id: conversation.id,
      label: conversation.title,
      hint: new Date(conversation.updatedAt).toLocaleDateString(),
      icon: <ChatBubbleOutlineRoundedIcon fontSize="small" />,
      run: go(`/c/${conversation.id}`),
    }));
    const term = query.trim().toLowerCase();
    const all = [...actions, ...chats];
    return (term ? all.filter((command) => command.label.toLowerCase().includes(term)) : all).slice(0, 50);
  }, [conversations.data, navigate, query]);

  function close(): void {
    setQuery('');
    setActive(0);
    onClose();
  }

  function onKeyDown(event: KeyboardEvent): void {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setActive((index) => Math.min(index + 1, commands.length - 1));
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setActive((index) => Math.max(index - 1, 0));
    } else if (event.key === 'Enter') {
      event.preventDefault();
      commands[active]?.run();
      close();
    }
  }

  return (
    <Dialog
      open={open}
      onClose={close}
      fullWidth
      maxWidth="sm"
      slotProps={{ paper: { sx: { alignSelf: 'flex-start', mt: '12vh' } } }}
    >
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.25, px: 2, py: 1.5, borderBottom: '1px solid var(--sb-border)' }}>
        <SearchRoundedIcon sx={{ color: 'var(--sb-text-faint)' }} />
        <InputBase
          autoFocus
          fullWidth
          placeholder="Jump to a chat or action"
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setActive(0);
          }}
          onKeyDown={onKeyDown}
          inputProps={{ 'aria-label': 'Command' }}
          sx={{ fontSize: '0.9375rem' }}
        />
      </Box>
      <Box role="listbox" sx={{ maxHeight: 380, overflowY: 'auto', p: 0.75 }}>
        {commands.length === 0 && (
          <Typography variant="body2" color="text.secondary" sx={{ p: 2, textAlign: 'center' }}>
            Nothing matches “{query}”.
          </Typography>
        )}
        {commands.map((command, index) => (
          <Box
            key={command.id}
            role="option"
            aria-selected={index === active}
            onMouseEnter={() => setActive(index)}
            onClick={() => {
              command.run();
              close();
            }}
            sx={{
              display: 'flex',
              alignItems: 'center',
              gap: 1.25,
              px: 1.25,
              py: 0.875,
              borderRadius: '6px',
              cursor: 'pointer',
              color: index === active ? 'var(--sb-text)' : 'var(--sb-text-muted)',
              backgroundColor: index === active ? 'action.hover' : 'transparent',
            }}
          >
            {command.icon}
            <Typography variant="body2" noWrap sx={{ flex: 1, fontWeight: 500 }}>
              {command.label}
            </Typography>
            {command.hint && (
              <Typography variant="caption" sx={{ color: 'var(--sb-text-faint)' }}>
                {command.hint}
              </Typography>
            )}
          </Box>
        ))}
      </Box>
    </Dialog>
  );
}
