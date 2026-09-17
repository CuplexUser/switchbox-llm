import AddRoundedIcon from '@mui/icons-material/AddRounded';
import DeleteOutlineRoundedIcon from '@mui/icons-material/DeleteOutlineRounded';
import EditOutlinedIcon from '@mui/icons-material/EditOutlined';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import FormControlLabel from '@mui/material/FormControlLabel';
import IconButton from '@mui/material/IconButton';
import MenuItem from '@mui/material/MenuItem';
import Skeleton from '@mui/material/Skeleton';
import Switch from '@mui/material/Switch';
import TextField from '@mui/material/TextField';
import ToggleButton from '@mui/material/ToggleButton';
import ToggleButtonGroup from '@mui/material/ToggleButtonGroup';
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';
import { useState } from 'react';
import type { AppSettings, KeepToolResults, McpServerConfig, ToolGroupInfo, ToolInfo, ToolPolicy } from '../../../shared/types.ts';
import { useSettings, useTestMcpServer, useTools, useUpdateSettings } from '../../api/hooks.ts';
import { ConfirmDialog } from '../../components/ConfirmDialog.tsx';
import { clampInt } from '../../lib/format.ts';
import { fonts } from '../../theme/theme.ts';
import { Panel, SettingRow, SettingsHeader } from './Section.tsx';

const KEEP_OPTIONS: { value: KeepToolResults; label: string }[] = [
  { value: 'summary', label: 'Shortened' },
  { value: 'full', label: 'In full' },
  { value: 'off', label: 'Not kept' },
];

const POLICY_HELP: Record<ToolPolicy, string> = {
  auto: 'Runs without asking',
  ask: 'Asks you before each call',
  off: 'Not offered to models',
};

function SectionTitle({ children, description }: { children: string; description?: string }) {
  return (
    <Box sx={{ mt: 4, mb: 1.5 }}>
      <Typography variant="h3">{children}</Typography>
      {description && (
        <Typography variant="body2" color="text.secondary" sx={{ mt: 0.25, maxWidth: 620 }}>
          {description}
        </Typography>
      )}
    </Box>
  );
}

function ToolRow({ tool, onPolicy }: { tool: ToolInfo; onPolicy: (policy: ToolPolicy) => void }) {
  return (
    <Box sx={{ display: 'flex', gap: 2, alignItems: { xs: 'flex-start', sm: 'center' }, flexDirection: { xs: 'column', sm: 'row' }, py: 1.25 }}>
      <Box sx={{ flex: 1, minWidth: 0 }}>
        <Box sx={{ display: 'flex', alignItems: 'baseline', gap: 1, flexWrap: 'wrap' }}>
          <Typography variant="body2" sx={{ fontWeight: 600 }}>
            {tool.label}
          </Typography>
          <Typography variant="caption" sx={{ fontFamily: fonts.mono, color: 'var(--sb-text-faint)' }}>
            {tool.name}
          </Typography>
        </Box>
        <Typography variant="body2" color="text.secondary" sx={{ fontSize: '0.8125rem', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>
          {tool.description}
        </Typography>
      </Box>
      <ToggleButtonGroup
        exclusive
        size="small"
        value={tool.policy}
        onChange={(_event, value: ToolPolicy | null) => value && onPolicy(value)}
        aria-label={`Policy for ${tool.label}`}
      >
        {(['auto', 'ask', 'off'] as const).map((policy) => (
          <Tooltip key={policy} title={`${POLICY_HELP[policy]}${policy === tool.defaultPolicy ? ' (default)' : ''}`}>
            <ToggleButton value={policy} sx={{ px: 1.25, textTransform: 'none' }}>
              {policy === 'auto' ? 'Auto' : policy === 'ask' ? 'Ask' : 'Off'}
            </ToggleButton>
          </Tooltip>
        ))}
      </ToggleButtonGroup>
    </Box>
  );
}

function GroupCard({ group, onPolicy }: { group: ToolGroupInfo; onPolicy: (name: string, policy: ToolPolicy) => void }) {
  return (
    <Box sx={{ px: 2.5, py: 1.5, border: '1px solid var(--sb-border)', borderRadius: '10px', backgroundColor: 'var(--sb-surface)' }}>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, flexWrap: 'wrap' }}>
        <Typography variant="body2" sx={{ fontWeight: 650 }}>
          {group.label}
        </Typography>
        {group.kind === 'mcp' && (
          <Typography variant="caption" sx={{ px: 0.75, borderRadius: '4px', border: '1px solid var(--sb-border)', color: 'var(--sb-text-muted)' }}>
            MCP
          </Typography>
        )}
        <Typography variant="caption" sx={{ color: 'var(--sb-text-faint)' }}>
          {group.toggledBy === 'webAccess'
            ? 'Follows each chat’s Web toggle'
            : group.toggledBy === 'useMemory'
              ? 'Follows each chat’s Memory toggle'
              : group.onByDefault
                ? 'On in new chats'
                : 'Off in new chats'}
        </Typography>
      </Box>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 0.5 }}>
        {group.description}
      </Typography>
      {group.error && (
        <Alert severity="error" variant="outlined" sx={{ my: 1, whiteSpace: 'pre-wrap', fontSize: '0.8125rem' }}>
          Could not connect: {group.error}
        </Alert>
      )}
      {group.tools.length === 0 && !group.error && (
        <Typography variant="body2" sx={{ py: 1, color: 'var(--sb-text-faint)' }}>
          No tools yet. MCP servers connect the first time their tools are needed.
        </Typography>
      )}
      <Box sx={{ '& > :not(:last-child)': { borderBottom: '1px solid var(--sb-border)' } }}>
        {group.tools.map((tool) => (
          <ToolRow key={tool.name} tool={tool} onPolicy={(policy) => onPolicy(tool.name, policy)} />
        ))}
      </Box>
    </Box>
  );
}

const EMPTY_SERVER: McpServerConfig = {
  id: '',
  name: '',
  transport: 'stdio',
  command: '',
  args: [],
  env: {},
  url: '',
  headers: {},
  enabled: true,
  useByDefault: false,
};

function toLines(record: Record<string, string>, separator: string): string {
  return Object.entries(record)
    .map(([key, value]) => `${key}${separator}${value}`)
    .join('\n');
}

function fromLines(text: string, separator: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const index = line.indexOf(separator);
    if (index <= 0) continue;
    result[line.slice(0, index).trim()] = line.slice(index + separator.length).trim();
  }
  return result;
}

function ServerDialog({ server, onClose, onSave }: { server: McpServerConfig; onClose: () => void; onSave: (server: McpServerConfig) => void }) {
  const test = useTestMcpServer();
  const [draft, setDraft] = useState(server);
  const [args, setArgs] = useState(server.args.join('\n'));
  const [env, setEnv] = useState(toLines(server.env, '='));
  const [headers, setHeaders] = useState(toLines(server.headers, ': '));

  const built: McpServerConfig = {
    ...draft,
    name: draft.name.trim(),
    command: draft.command.trim(),
    url: draft.url.trim(),
    args: args.split('\n').map((line) => line.trim()).filter(Boolean),
    env: fromLines(env, '='),
    headers: fromLines(headers, ':'),
  };
  const valid = built.name && (built.transport === 'stdio' ? built.command : /^https?:\/\//.test(built.url));

  return (
    <Dialog open onClose={onClose} maxWidth="sm" fullWidth>
      <DialogTitle>{server.id ? 'Edit MCP server' : 'Add an MCP server'}</DialogTitle>
      <DialogContent sx={{ display: 'flex', flexDirection: 'column', gap: 2, pt: '8px !important' }}>
        <TextField label="Name" required value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} helperText="Shown in chats and used in tool names." />
        <TextField
          select
          label="Connection"
          value={draft.transport}
          onChange={(event) => setDraft({ ...draft, transport: event.target.value as McpServerConfig['transport'] })}
        >
          <MenuItem value="stdio">Command on this computer (stdio)</MenuItem>
          <MenuItem value="http">Streamable HTTP URL</MenuItem>
        </TextField>
        {draft.transport === 'stdio' ? (
          <>
            <TextField label="Command" required placeholder="npx" value={draft.command} onChange={(event) => setDraft({ ...draft, command: event.target.value })} />
            <TextField
              label="Arguments, one per line"
              multiline
              minRows={2}
              placeholder={'-y\n@modelcontextprotocol/server-filesystem\nC:\\Users\\me\\Documents'}
              value={args}
              onChange={(event) => setArgs(event.target.value)}
              slotProps={{ htmlInput: { style: { fontFamily: fonts.mono, fontSize: '0.8125rem' } } }}
            />
            <TextField
              label="Environment variables, NAME=value per line"
              multiline
              minRows={2}
              value={env}
              onChange={(event) => setEnv(event.target.value)}
              slotProps={{ htmlInput: { style: { fontFamily: fonts.mono, fontSize: '0.8125rem' } } }}
            />
            <Alert severity="warning" variant="outlined">
              The command runs on this computer with your user account. Only add servers you trust.
            </Alert>
          </>
        ) : (
          <>
            <TextField label="URL" required placeholder="https://example.com/mcp" value={draft.url} onChange={(event) => setDraft({ ...draft, url: event.target.value })} />
            <TextField
              label="Headers, Name: value per line"
              multiline
              minRows={2}
              placeholder="Authorization: Bearer …"
              value={headers}
              onChange={(event) => setHeaders(event.target.value)}
              slotProps={{ htmlInput: { style: { fontFamily: fonts.mono, fontSize: '0.8125rem' } } }}
            />
          </>
        )}
        <FormControlLabel
          control={<Switch checked={draft.useByDefault} onChange={(event) => setDraft({ ...draft, useByDefault: event.target.checked })} />}
          label={<Typography variant="body2">Turn on in new chats</Typography>}
        />
        <Box>
          <Button variant="outlined" size="small" disabled={!valid || test.isPending} onClick={() => test.mutate(built)}>
            {test.isPending ? 'Connecting…' : 'Test connection'}
          </Button>
          {test.data?.ok && (
            <Alert severity="success" sx={{ mt: 1.5 }}>
              Connected. {test.data.tools.length === 0 ? 'The server offers no tools.' : `Tools: ${test.data.tools.map((tool) => tool.name).join(', ')}`}
            </Alert>
          )}
          {test.data && !test.data.ok && (
            <Alert severity="error" sx={{ mt: 1.5, whiteSpace: 'pre-wrap' }}>
              {test.data.error}
            </Alert>
          )}
          {test.error && (
            <Alert severity="error" sx={{ mt: 1.5 }}>
              {test.error.message}
            </Alert>
          )}
        </Box>
      </DialogContent>
      <DialogActions sx={{ px: 3, pb: 2.5 }}>
        <Button color="inherit" onClick={onClose}>
          Cancel
        </Button>
        <Button variant="contained" disabled={!valid} onClick={() => onSave({ ...built, id: built.id || crypto.randomUUID() })}>
          Save
        </Button>
      </DialogActions>
    </Dialog>
  );
}

export function ToolsTab() {
  const settings = useSettings();
  const tools = useTools();
  const update = useUpdateSettings();
  const [editing, setEditing] = useState<McpServerConfig | null>(null);
  const [removing, setRemoving] = useState<McpServerConfig | null>(null);
  if (!settings.data) return <Skeleton variant="rounded" height={420} />;
  const { agent, mcp } = settings.data;

  function setAgent<K extends keyof AppSettings['agent']>(key: K, value: AppSettings['agent'][K]): void {
    update.mutate({ section: 'agent', value: { ...agent, [key]: value } });
  }

  function setPolicy(name: string, policy: ToolPolicy): void {
    const tool = tools.data?.flatMap((group) => group.tools).find((entry) => entry.name === name);
    const policies = { ...agent.policies };
    if (tool && policy === tool.defaultPolicy) delete policies[name];
    else policies[name] = policy;
    setAgent('policies', policies);
  }

  function saveServers(servers: McpServerConfig[]): void {
    update.mutate({ section: 'mcp', value: { servers } });
  }

  return (
    <>
      <SettingsHeader
        title="Tools"
        description="What models can do besides writing: search, run code, use memory, and call tools from MCP servers. Chats turn optional tools on and off from their header."
      />

      <Panel>
        <SettingRow
          label="Tool rounds per reply"
          description="How many rounds of tool calls a model gets before it has to answer. Each round is a separate, billed request. Profiles can set their own."
          htmlFor="max-rounds"
        >
          <TextField
            id="max-rounds"
            type="number"
            value={agent.maxToolRounds}
            onChange={(event) => setAgent('maxToolRounds', clampInt(event.target.value, 1, 50, agent.maxToolRounds))}
            slotProps={{ htmlInput: { min: 1, max: 50 } }}
            sx={{ width: 110 }}
          />
        </SettingRow>
        <SettingRow label="Tool calls at once" description="Calls from one round that run at the same time. Lower it if a server rate limits you." htmlFor="parallel">
          <TextField
            id="parallel"
            type="number"
            value={agent.maxParallelTools}
            onChange={(event) => setAgent('maxParallelTools', clampInt(event.target.value, 1, 10, agent.maxParallelTools))}
            slotProps={{ htmlInput: { min: 1, max: 10 } }}
            sx={{ width: 110 }}
          />
        </SettingRow>
        <SettingRow
          label="Tool results in later messages"
          description="What a model still sees of earlier searches, pages and tool output when you ask a follow-up. Keeping them in full costs more tokens."
          htmlFor="keep-results"
        >
          <TextField
            id="keep-results"
            select
            value={agent.keepToolResults}
            onChange={(event) => setAgent('keepToolResults', event.target.value as KeepToolResults)}
            sx={{ width: 150 }}
          >
            {KEEP_OPTIONS.map((option) => (
              <MenuItem key={option.value} value={option.value}>
                {option.label}
              </MenuItem>
            ))}
          </TextField>
        </SettingRow>
      </Panel>

      <SectionTitle description="Auto runs a tool without asking, Ask shows you each call to allow or decline, and Off hides the tool from models.">
        Available tools
      </SectionTitle>
      {tools.isLoading && <Skeleton variant="rounded" height={240} />}
      {tools.error && <Alert severity="error">{tools.error.message}</Alert>}
      <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1.5 }}>
        {tools.data?.map((group) => (
          <GroupCard key={group.id} group={group} onPolicy={setPolicy} />
        ))}
      </Box>

      <SectionTitle description="Model Context Protocol servers add tools such as file access, GitHub or databases. Their tools ask for approval by default.">
        MCP servers
      </SectionTitle>
      <Panel>
        {mcp.servers.length === 0 && (
          <Typography variant="body2" sx={{ py: 2, color: 'var(--sb-text-faint)' }}>
            No servers yet.
          </Typography>
        )}
        {mcp.servers.map((server) => (
          <SettingRow
            key={server.id}
            label={server.name}
            description={
              <Box component="span" sx={{ fontFamily: fonts.mono, fontSize: '0.75rem', overflowWrap: 'anywhere' }}>
                {server.transport === 'stdio' ? [server.command, ...server.args].join(' ') : server.url}
              </Box>
            }
          >
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
              <Tooltip title={server.enabled ? 'On. Click to turn off everywhere.' : 'Off everywhere. Click to turn on.'}>
                <Switch
                  checked={server.enabled}
                  onChange={(event) => saveServers(mcp.servers.map((entry) => (entry.id === server.id ? { ...entry, enabled: event.target.checked } : entry)))}
                  slotProps={{ input: { 'aria-label': `Use ${server.name}` } }}
                />
              </Tooltip>
              <IconButton size="small" aria-label={`Edit ${server.name}`} onClick={() => setEditing(server)}>
                <EditOutlinedIcon fontSize="small" />
              </IconButton>
              <IconButton size="small" aria-label={`Remove ${server.name}`} onClick={() => setRemoving(server)}>
                <DeleteOutlineRoundedIcon fontSize="small" />
              </IconButton>
            </Box>
          </SettingRow>
        ))}
      </Panel>
      <Button startIcon={<AddRoundedIcon />} variant="outlined" sx={{ mt: 1.5 }} onClick={() => setEditing(EMPTY_SERVER)}>
        Add server
      </Button>

      {editing && (
        <ServerDialog
          server={editing}
          onClose={() => setEditing(null)}
          onSave={(server) => {
            const exists = mcp.servers.some((entry) => entry.id === server.id);
            saveServers(exists ? mcp.servers.map((entry) => (entry.id === server.id ? server : entry)) : [...mcp.servers, server]);
            setEditing(null);
          }}
        />
      )}
      <ConfirmDialog
        open={Boolean(removing)}
        title="Remove this server?"
        body={`${removing?.name ?? 'The server'} and its tools will be removed from every chat.`}
        confirmLabel="Remove server"
        destructive
        onClose={() => setRemoving(null)}
        onConfirm={() => removing && saveServers(mcp.servers.filter((entry) => entry.id !== removing.id))}
      />
    </>
  );
}
