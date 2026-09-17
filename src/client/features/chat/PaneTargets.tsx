import Box from '@mui/material/Box';
import ButtonBase from '@mui/material/ButtonBase';
import Tooltip from '@mui/material/Tooltip';
import type { Pane } from '../../../shared/types.ts';
import { shortModel } from '../../lib/format.ts';
import { channelSoftVar, channelVar } from '../../theme/theme.ts';

/** One chip per pane under the composer, to choose which panes a message goes to. */
export function PaneTargets({
  panes,
  excluded,
  readyModels,
  onToggle,
}: {
  panes: Pane[];
  excluded: Set<string>;
  /** provider:model keys the model lists know; models missing from them are dimmed. */
  readyModels: Set<string>;
  onToggle: (paneId: string) => void;
}) {
  return panes.map((pane, index) => {
    const on = !excluded.has(pane.id);
    const known = readyModels.size === 0 || readyModels.has(`${pane.provider}:${pane.model}`);
    return (
      <Tooltip key={pane.id} describeChild title={on ? 'Sending to this pane. Click to skip it.' : 'Skipping this pane. Click to include it.'}>
        <ButtonBase
          aria-pressed={on}
          onClick={() => onToggle(pane.id)}
          sx={{
            gap: 0.75,
            px: 1,
            height: 26,
            maxWidth: 200,
            borderRadius: '13px',
            fontSize: '0.75rem',
            fontWeight: 550,
            color: on ? 'var(--sb-text)' : 'var(--sb-text-faint)',
            backgroundColor: on ? channelSoftVar(index) : 'transparent',
            border: '1px solid',
            borderColor: on ? 'transparent' : 'var(--sb-border)',
            textDecoration: on ? 'none' : 'line-through',
            opacity: known ? 1 : 0.8,
            '&:focus-visible': { outline: '2px solid var(--sb-ink)' },
          }}
        >
          <Box
            sx={{
              width: 8,
              height: 8,
              borderRadius: '50%',
              flexShrink: 0,
              backgroundColor: on ? channelVar(index) : 'var(--sb-border-strong)',
            }}
          />
          <Box component="span" sx={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {shortModel(pane.model)}
          </Box>
        </ButtonBase>
      </Tooltip>
    );
  });
}
