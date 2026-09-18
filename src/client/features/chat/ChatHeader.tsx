import AddRoundedIcon from '@mui/icons-material/AddRounded';
import CheckRoundedIcon from '@mui/icons-material/CheckRounded';
import FolderOpenOutlinedIcon from '@mui/icons-material/FolderOpenOutlined';
import FolderOutlinedIcon from '@mui/icons-material/FolderOutlined';
import HistoryToggleOffRoundedIcon from '@mui/icons-material/HistoryToggleOffRounded';
import PsychologyAltOutlinedIcon from '@mui/icons-material/PsychologyAltOutlined';
import PublicRoundedIcon from '@mui/icons-material/PublicRounded';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import ButtonBase from '@mui/material/ButtonBase';
import IconButton from '@mui/material/IconButton';
import InputBase from '@mui/material/InputBase';
import Tooltip from '@mui/material/Tooltip';
import { useState, type ReactNode } from 'react';
import { MAX_PANES } from '../../../shared/defaults.ts';
import type { ConversationDetail } from '../../../shared/types.ts';
import { useUpdateConversation, useWorkspaceFiles } from '../../api/hooks.ts';
import { ChatActionsMenu } from './ChatActionsMenu.tsx';
import { ToolsMenu } from './ToolsMenu.tsx';
import { WorkspacePanel } from './WorkspacePanel.tsx';

function ToggleChip({
  on,
  onClick,
  icon,
  label,
  tooltip,
}: {
  on: boolean;
  onClick: () => void;
  icon: ReactNode;
  label: string;
  tooltip: string;
}) {
  return (
    <Tooltip title={tooltip} describeChild>
      <ButtonBase
        onClick={onClick}
        aria-pressed={on}
        sx={{
          gap: 0.75,
          px: 1,
          height: 28,
          borderRadius: '6px',
          fontSize: '0.75rem',
          fontWeight: 550,
          border: '1px solid',
          borderColor: on ? 'var(--sb-border-strong)' : 'var(--sb-border)',
          color: on ? 'var(--sb-text)' : 'var(--sb-text-faint)',
          backgroundColor: on ? 'var(--sb-surface)' : 'transparent',
          '&:hover': { color: 'var(--sb-text)' },
          '&:focus-visible': { outline: '2px solid var(--sb-ink)' },
        }}
      >
        {icon}
        {label}
      </ButtonBase>
    </Tooltip>
  );
}

function TitleField({ conversation }: { conversation: ConversationDetail }) {
  const update = useUpdateConversation();
  const [value, setValue] = useState(conversation.title);

  function commit(): void {
    const next = value.trim();
    if (next && next !== conversation.title) update.mutate({ id: conversation.id, title: next });
    else setValue(conversation.title);
  }

  return (
    <InputBase
      value={value}
      onChange={(event) => setValue(event.target.value)}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === 'Enter') (event.target as HTMLInputElement).blur();
        if (event.key === 'Escape') {
          setValue(conversation.title);
          (event.target as HTMLInputElement).blur();
        }
      }}
      inputProps={{ 'aria-label': 'Conversation title' }}
      sx={{
        flex: 1,
        minWidth: 80,
        fontWeight: 600,
        fontSize: '0.9375rem',
        '& input': { px: 0.75, py: 0.5, borderRadius: '6px', textOverflow: 'ellipsis' },
        '& input:hover': { backgroundColor: 'action.hover' },
        '& input:focus': { backgroundColor: 'var(--sb-canvas)', outline: '1px solid var(--sb-ink)' },
      }}
    />
  );
}

/** The workspace switch, and a button for its files once there is anything to see. */
function WorkspaceControls({ data, narrow }: { data: ConversationDetail; narrow: boolean }) {
  const updateConversation = useUpdateConversation();
  const listing = useWorkspaceFiles(data.id);
  const [open, setOpen] = useState(false);
  const count = listing.data?.files.length ?? 0;
  const showFiles = data.workspace || Boolean(listing.data?.exists);

  return (
    <>
      <ToggleChip
        on={data.workspace}
        onClick={() => updateConversation.mutate({ id: data.id, workspace: !data.workspace })}
        icon={<FolderOutlinedIcon sx={{ fontSize: 15 }} />}
        label={narrow ? '' : data.workspace ? 'Files on' : 'Files off'}
        tooltip={
          data.workspace
            ? 'Models can create, read and edit files in this chat’s workspace. Click to turn off; the files are kept.'
            : 'Give this chat a workspace folder that models can keep files in. Running commands is a separate tool in the Tools menu.'
        }
      />
      {showFiles && (
        <Tooltip title={count ? `Workspace: ${count} ${count === 1 ? 'file' : 'files'}` : 'Workspace files'}>
          <IconButton size="small" onClick={() => setOpen(true)} aria-label="Show workspace files" sx={{ width: 28, height: 28 }}>
            <FolderOpenOutlinedIcon sx={{ fontSize: 17 }} />
          </IconButton>
        </Tooltip>
      )}
      <WorkspacePanel conversation={data} open={open} onClose={() => setOpen(false)} />
    </>
  );
}

/** The chat's title, its saved, memory, web and workspace switches, its menus and the Add model button. */
export function ChatHeader({
  data,
  narrow,
  running,
  onAddModel,
}: {
  data: ConversationDetail;
  narrow: boolean;
  running: boolean;
  onAddModel: (anchor: HTMLElement) => void;
}) {
  const updateConversation = useUpdateConversation();
  const panes = data.panes;

  function togglePersist(detail: ConversationDetail): void {
    // The server writes what was said so far when a temporary chat is saved.
    updateConversation.mutate({ id: detail.id, persist: !detail.persist });
  }

  return (
    <Box
      component="header"
      sx={{
        display: 'flex',
        alignItems: 'center',
        gap: 1,
        height: 52,
        flexShrink: 0,
        pl: 'calc(var(--sb-shell-inset) + 12px)',
        pr: 1.5,
        borderBottom: '1px solid var(--sb-border)',
        backgroundColor: 'var(--sb-canvas)',
      }}
    >
      <TitleField key={data.title} conversation={data} />
      <ToggleChip
        on={data.persist}
        onClick={() => togglePersist(data)}
        icon={data.persist ? <CheckRoundedIcon sx={{ fontSize: 15 }} /> : <HistoryToggleOffRoundedIcon sx={{ fontSize: 15 }} />}
        label={data.persist ? 'Saved' : 'Temporary'}
        tooltip={
          data.persist
            ? 'Messages are saved to the database. Click to stop saving.'
            : 'Nothing is saved; this chat disappears when the server restarts. Click to save it.'
        }
      />
      <ToggleChip
        on={data.useMemory}
        onClick={() => updateConversation.mutate({ id: data.id, useMemory: !data.useMemory })}
        icon={<PsychologyAltOutlinedIcon sx={{ fontSize: 15 }} />}
        label={narrow ? '' : data.useMemory ? 'Memory on' : 'Memory off'}
        tooltip={
          data.useMemory
            ? 'Saved memories are added to the system prompt. Click to turn off for this chat.'
            : 'Memories are not used in this chat. Click to turn on.'
        }
      />
      <ToggleChip
        on={data.webAccess}
        onClick={() => updateConversation.mutate({ id: data.id, webAccess: !data.webAccess })}
        icon={<PublicRoundedIcon sx={{ fontSize: 15 }} />}
        label={narrow ? '' : data.webAccess ? 'Web on' : 'Web off'}
        tooltip={
          data.webAccess
            ? 'Models can search the web and read pages. Click to turn off for this chat.'
            : 'Models answer without web access. Click to turn on.'
        }
      />
      <WorkspaceControls data={data} narrow={narrow} />
      <ToolsMenu conversation={data} compact={narrow} />
      <ChatActionsMenu conversation={data} />
      <Tooltip title={panes.length >= MAX_PANES ? `Up to ${MAX_PANES} models per chat` : 'Add a model to compare'}>
        <span>
          <Button
            size="small"
            variant="outlined"
            startIcon={<AddRoundedIcon />}
            disabled={panes.length >= MAX_PANES || running}
            onClick={(event) => onAddModel(event.currentTarget)}
            sx={{ height: 28, whiteSpace: 'nowrap' }}
          >
            {narrow ? 'Model' : 'Add model'}
          </Button>
        </span>
      </Tooltip>
    </Box>
  );
}
