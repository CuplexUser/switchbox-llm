import CompareArrowsRoundedIcon from '@mui/icons-material/CompareArrowsRounded';
import DescriptionOutlinedIcon from '@mui/icons-material/DescriptionOutlined';
import HtmlOutlinedIcon from '@mui/icons-material/HtmlOutlined';
import MoreHorizRoundedIcon from '@mui/icons-material/MoreHorizRounded';
import Divider from '@mui/material/Divider';
import IconButton from '@mui/material/IconButton';
import ListItemIcon from '@mui/material/ListItemIcon';
import ListItemText from '@mui/material/ListItemText';
import Menu from '@mui/material/Menu';
import MenuItem from '@mui/material/MenuItem';
import Tooltip from '@mui/material/Tooltip';
import { useState } from 'react';
import type { ConversationDetail } from '../../../shared/types.ts';
import { downloadText, safeFilename } from '../../lib/files.ts';
import { messagesByPaneOf, useChatStore } from '../../stores/chat.ts';
import { CompareDialog } from './CompareDialog.tsx';

/** Compare replies and export the chat. */
export function ChatActionsMenu({ conversation }: { conversation: ConversationDetail }) {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const [comparing, setComparing] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);
  const hasMessages = useChatStore((state) => Object.values(state.conversations[conversation.id]?.panes ?? {}).some((pane) => pane.messages.length > 0));

  async function exportAs(format: 'markdown' | 'html'): Promise<void> {
    setAnchor(null);
    setExportError(null);
    try {
      // Loaded on demand: rendering HTML pulls in React's server renderer.
      const { toHtml, toMarkdown } = await import('../../lib/export.ts');
      const messages = messagesByPaneOf(useChatStore.getState().conversations[conversation.id]);
      const name = safeFilename(conversation.title);
      if (format === 'markdown') downloadText(`${name}.md`, toMarkdown(conversation, messages), 'text/markdown');
      else downloadText(`${name}.html`, toHtml(conversation, messages), 'text/html');
    } catch (error) {
      setExportError(error instanceof Error ? error.message : String(error));
    }
  }

  return (
    <>
      <Tooltip title={exportError ? `Export failed: ${exportError}` : 'Compare and export'}>
        <IconButton
          size="small"
          aria-label="Compare and export"
          aria-haspopup="menu"
          onClick={(event) => setAnchor(event.currentTarget)}
          sx={{ color: exportError ? 'error.main' : undefined }}
        >
          <MoreHorizRoundedIcon sx={{ fontSize: 20 }} />
        </IconButton>
      </Tooltip>
      <Menu anchorEl={anchor} open={Boolean(anchor)} onClose={() => setAnchor(null)}>
        <MenuItem
          disabled={conversation.panes.length < 2 || !hasMessages}
          onClick={() => {
            setAnchor(null);
            setComparing(true);
          }}
        >
          <ListItemIcon>
            <CompareArrowsRoundedIcon fontSize="small" />
          </ListItemIcon>
          <ListItemText primary="Compare replies" secondary={conversation.panes.length < 2 ? 'Add a second model first' : 'Stats, totals and differences'} />
        </MenuItem>
        <Divider />
        <MenuItem disabled={!hasMessages} onClick={() => void exportAs('markdown')}>
          <ListItemIcon>
            <DescriptionOutlinedIcon fontSize="small" />
          </ListItemIcon>
          <ListItemText primary="Export as Markdown" />
        </MenuItem>
        <MenuItem disabled={!hasMessages} onClick={() => void exportAs('html')}>
          <ListItemIcon>
            <HtmlOutlinedIcon fontSize="small" />
          </ListItemIcon>
          <ListItemText primary="Export as HTML page" secondary="Replies side by side, in one file" />
        </MenuItem>
      </Menu>
      <CompareDialog conversation={conversation} open={comparing} onClose={() => setComparing(false)} />
    </>
  );
}
