import CloseRoundedIcon from '@mui/icons-material/CloseRounded';
import DeleteOutlineRoundedIcon from '@mui/icons-material/DeleteOutlineRounded';
import DownloadRoundedIcon from '@mui/icons-material/DownloadRounded';
import InsertDriveFileOutlinedIcon from '@mui/icons-material/InsertDriveFileOutlined';
import UploadRoundedIcon from '@mui/icons-material/UploadRounded';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import ButtonBase from '@mui/material/ButtonBase';
import Drawer from '@mui/material/Drawer';
import IconButton from '@mui/material/IconButton';
import LinearProgress from '@mui/material/LinearProgress';
import Skeleton from '@mui/material/Skeleton';
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';
import useMediaQuery from '@mui/material/useMediaQuery';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState, type DragEvent } from 'react';
import type { ConversationDetail, WorkspaceFile } from '../../../shared/types.ts';
import { keys, useDeleteWorkspaceFile, useUploadWorkspaceFile, useWorkspaceFiles, workspaceFileUrl } from '../../api/hooks.ts';
import { ConfirmDialog } from '../../components/ConfirmDialog.tsx';
import { Markdown } from '../../components/Markdown.tsx';
import { formatBytes } from '../../lib/files.ts';
import { useChatStore } from '../../stores/chat.ts';
import { fonts } from '../../theme/theme.ts';

/** Tools that change the workspace, so the file list is reloaded when one finishes. */
const WORKSPACE_TOOLS = new Set(['write_file', 'edit_file', 'delete_file', 'move_file', 'run_command']);
const IMAGE = /\.(png|jpe?g|gif|webp|bmp|ico)$/i;
const PREVIEW_LIMIT = 512 * 1024;
const LANGUAGES: Record<string, string> = {
  js: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  ts: 'typescript',
  tsx: 'tsx',
  jsx: 'jsx',
  py: 'python',
  rb: 'ruby',
  rs: 'rust',
  cs: 'csharp',
  kt: 'kotlin',
  h: 'c',
  hpp: 'cpp',
  cc: 'cpp',
  sh: 'bash',
  ps1: 'powershell',
  bat: 'bat',
  yml: 'yaml',
  md: 'markdown',
  txt: 'text',
  log: 'text',
};

function languageOf(path: string): string {
  const extension = path.includes('.') ? (path.split('.').pop() ?? '').toLowerCase() : '';
  return LANGUAGES[extension] ?? (extension || 'text');
}

/**
 * Reloads the file list while models work: whenever a file or command tool finishes in this chat,
 * and when a reply ends.
 */
function useRefreshOnToolRuns(conversationId: string): void {
  const client = useQueryClient();
  const signature = useChatStore((state) => {
    const runtime = state.conversations[conversationId];
    if (!runtime) return '';
    const finished = Object.values(runtime.panes)
      .flatMap((pane) => pane.live?.activity ?? [])
      .filter((item) => item.kind === 'tool' && item.done && WORKSPACE_TOOLS.has(item.name)).length;
    return `${runtime.runId ?? 'idle'}:${finished}`;
  });
  useEffect(() => {
    if (signature) void client.invalidateQueries({ queryKey: keys.workspace(conversationId) });
  }, [client, conversationId, signature]);
}

function Preview({ conversationId, file }: { conversationId: string; file: WorkspaceFile }) {
  const image = IMAGE.test(file.path);
  const tooLarge = file.size > PREVIEW_LIMIT;
  // modifiedAt is in the key, so the preview reloads when a model changes the file.
  const content = useQuery({
    queryKey: [...keys.workspace(conversationId), 'preview', file.path, file.modifiedAt],
    queryFn: async ({ signal }): Promise<string | null> => {
      const response = await fetch(workspaceFileUrl(conversationId, file.path), { signal });
      if (!response.ok) throw new Error(`Request failed (${response.status})`);
      return (response.headers.get('content-type') ?? '').startsWith('text/') ? response.text() : null;
    },
    enabled: !image && !tooLarge,
    staleTime: Infinity,
  });
  const text = content.data ?? null;
  const binary = content.isError || content.data === null;

  if (image) {
    return (
      <Box
        component="img"
        src={`${workspaceFileUrl(conversationId, file.path)}&v=${encodeURIComponent(file.modifiedAt)}`}
        alt={file.path}
        sx={{ maxWidth: '100%', borderRadius: '6px', border: '1px solid var(--sb-border)' }}
      />
    );
  }
  if (tooLarge || binary) {
    return (
      <Typography variant="body2" sx={{ color: 'var(--sb-text-faint)' }}>
        {binary ? 'This file is not text, so it can’t be shown here.' : `This file is ${formatBytes(file.size)}, too large to preview.`} Download it to open it.
      </Typography>
    );
  }
  if (text === null) return <Skeleton variant="rounded" height={120} />;

  // A fence longer than any run of backticks in the file, so the file can't close it early.
  const fence = '`'.repeat(Math.max(3, ...[...text.matchAll(/`+/g)].map((match) => match[0].length + 1)));
  return <Markdown text={`${fence}${languageOf(file.path)}\n${text}\n${fence}`} />;
}

function FileRow({
  conversationId,
  file,
  selected,
  onSelect,
  onDelete,
}: {
  conversationId: string;
  file: WorkspaceFile;
  selected: boolean;
  onSelect: () => void;
  onDelete: () => void;
}) {
  const slash = file.path.lastIndexOf('/');
  return (
    <Box
      sx={{
        display: 'flex',
        alignItems: 'center',
        gap: 0.5,
        pr: 0.5,
        borderRadius: '6px',
        backgroundColor: selected ? 'action.selected' : 'transparent',
        '&:hover': { backgroundColor: selected ? 'action.selected' : 'action.hover' },
        '&:hover .file-actions, &:focus-within .file-actions': { opacity: 1 },
      }}
    >
      <ButtonBase
        onClick={onSelect}
        aria-pressed={selected}
        sx={{ flex: 1, minWidth: 0, justifyContent: 'flex-start', gap: 1, px: 1, py: 0.625, borderRadius: '6px', textAlign: 'left' }}
      >
        <InsertDriveFileOutlinedIcon sx={{ fontSize: 16, color: 'var(--sb-text-faint)', flexShrink: 0 }} />
        <Box component="span" sx={{ flex: 1, minWidth: 0, fontFamily: fonts.mono, fontSize: '0.8125rem', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {slash >= 0 && (
            <Box component="span" sx={{ color: 'var(--sb-text-faint)' }}>
              {file.path.slice(0, slash + 1)}
            </Box>
          )}
          {file.path.slice(slash + 1)}
        </Box>
        <Box component="span" sx={{ fontSize: '0.75rem', color: 'var(--sb-text-faint)', flexShrink: 0 }}>
          {formatBytes(file.size)}
        </Box>
      </ButtonBase>
      <Box className="file-actions" sx={{ display: 'flex', opacity: { xs: 1, md: 0 }, transition: 'opacity 120ms' }}>
        <Tooltip title="Download">
          <IconButton size="small" component="a" href={workspaceFileUrl(conversationId, file.path, true)} aria-label={`Download ${file.path}`}>
            <DownloadRoundedIcon sx={{ fontSize: 17 }} />
          </IconButton>
        </Tooltip>
        <Tooltip title="Delete">
          <IconButton size="small" onClick={onDelete} aria-label={`Delete ${file.path}`}>
            <DeleteOutlineRoundedIcon sx={{ fontSize: 17 }} />
          </IconButton>
        </Tooltip>
      </Box>
    </Box>
  );
}

/** The chat's workspace files: what models have written, with previews, uploads, downloads and deletes. */
export function WorkspacePanel({ conversation, open, onClose }: { conversation: ConversationDetail; open: boolean; onClose: () => void }) {
  const id = conversation.id;
  const wide = useMediaQuery('(min-width:900px)');
  const listing = useWorkspaceFiles(id, open);
  const upload = useUploadWorkspaceFile(id);
  const remove = useDeleteWorkspaceFile(id);
  const inputRef = useRef<HTMLInputElement>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<string | null | undefined>(undefined);
  const [dragging, setDragging] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useRefreshOnToolRuns(id);

  const files = listing.data?.files ?? [];
  const current = files.find((file) => file.path === selected) ?? null;
  const usage = listing.data?.usage ?? 0;
  const quota = listing.data?.quota ?? 1;

  async function uploadAll(list: FileList | null): Promise<void> {
    setError(null);
    for (const file of Array.from(list ?? [])) {
      try {
        await upload.mutateAsync({ file, path: file.name });
      } catch (reason) {
        setError(reason instanceof Error ? reason.message : `${file.name} could not be uploaded.`);
        return;
      }
    }
  }

  function onDrop(event: DragEvent): void {
    event.preventDefault();
    setDragging(false);
    void uploadAll(event.dataTransfer.files);
  }

  async function confirmDelete(): Promise<void> {
    const path = confirm ?? null;
    setConfirm(undefined);
    setError(null);
    try {
      await remove.mutateAsync(path);
      if (path === null || path === selected) setSelected(null);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'That could not be deleted.');
    }
  }

  return (
    <Drawer
      anchor="right"
      open={open}
      onClose={onClose}
      slotProps={{ paper: { sx: { width: wide ? 560 : '100%', backgroundColor: 'var(--sb-canvas)' } } }}
    >
      <Box
        onDragOver={(event) => {
          event.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
        sx={{ display: 'flex', flexDirection: 'column', height: '100%', outline: dragging ? '2px dashed var(--sb-ink)' : 'none', outlineOffset: -6 }}
      >
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, px: 2, height: 52, borderBottom: '1px solid var(--sb-border)', flexShrink: 0 }}>
          <Typography sx={{ fontWeight: 600, flex: 1 }}>Workspace</Typography>
          <input ref={inputRef} type="file" multiple hidden onChange={(event) => void uploadAll(event.target.files).finally(() => (event.target.value = ''))} />
          <Button size="small" variant="outlined" startIcon={<UploadRoundedIcon />} onClick={() => inputRef.current?.click()} disabled={upload.isPending}>
            Upload
          </Button>
          <Tooltip title="Download every file as a ZIP archive">
            <span>
              <IconButton size="small" component="a" href={`/api/conversations/${id}/files/archive`} disabled={files.length === 0} aria-label="Download all files">
                <DownloadRoundedIcon sx={{ fontSize: 19 }} />
              </IconButton>
            </span>
          </Tooltip>
          <Tooltip title="Delete the workspace">
            <span>
              <IconButton size="small" onClick={() => setConfirm(null)} disabled={!listing.data?.exists} aria-label="Delete the workspace">
                <DeleteOutlineRoundedIcon sx={{ fontSize: 19 }} />
              </IconButton>
            </span>
          </Tooltip>
          <IconButton size="small" onClick={onClose} aria-label="Close">
            <CloseRoundedIcon sx={{ fontSize: 19 }} />
          </IconButton>
        </Box>

        <Box sx={{ px: 2, pt: 1.5, pb: 1, flexShrink: 0 }}>
          <Box sx={{ display: 'flex', justifyContent: 'space-between', mb: 0.5 }}>
            <Typography variant="caption" sx={{ color: 'var(--sb-text-faint)' }}>
              {files.length} {files.length === 1 ? 'file' : 'files'}
            </Typography>
            <Typography variant="caption" sx={{ color: usage > quota ? 'error.main' : 'var(--sb-text-faint)' }}>
              {formatBytes(usage)} of {formatBytes(quota)}
            </Typography>
          </Box>
          <LinearProgress
            variant="determinate"
            value={Math.min(100, (usage / quota) * 100)}
            color={usage > quota ? 'error' : 'primary'}
            sx={{ height: 4, borderRadius: 2 }}
          />
          {!conversation.workspace && (
            <Alert severity="info" sx={{ mt: 1.5 }}>
              The workspace is off, so models in this chat can’t see these files. Turn it on with the Files switch in the header.
            </Alert>
          )}
          {error && (
            <Alert severity="error" onClose={() => setError(null)} sx={{ mt: 1.5 }}>
              {error}
            </Alert>
          )}
        </Box>

        <Box sx={{ flex: current ? '0 1 40%' : 1, minHeight: 0, overflowY: 'auto', px: 1, pb: 1 }}>
          {listing.isLoading && <Skeleton variant="rounded" height={80} sx={{ mx: 1 }} />}
          {listing.data && files.length === 0 && (
            <Typography variant="body2" sx={{ px: 1, py: 3, textAlign: 'center', color: 'var(--sb-text-faint)' }}>
              No files yet. Ask a model to create some, or drop files here.
            </Typography>
          )}
          {files.map((file) => (
            <FileRow
              key={file.path}
              conversationId={id}
              file={file}
              selected={file.path === selected}
              onSelect={() => setSelected(file.path === selected ? null : file.path)}
              onDelete={() => setConfirm(file.path)}
            />
          ))}
        </Box>

        {current && (
          <Box sx={{ flex: 1, minHeight: 0, overflowY: 'auto', borderTop: '1px solid var(--sb-border)', px: 2, py: 1.5 }}>
            <Typography variant="caption" component="div" sx={{ fontFamily: fonts.mono, color: 'var(--sb-text-muted)', mb: 1, overflowWrap: 'anywhere' }}>
              {current.path} · {formatBytes(current.size)} · changed {new Date(current.modifiedAt).toLocaleString()}
            </Typography>
            <Preview conversationId={id} file={current} />
          </Box>
        )}
      </Box>

      <ConfirmDialog
        open={confirm !== undefined}
        title={confirm === null ? 'Delete the workspace?' : 'Delete this file?'}
        body={
          confirm === null
            ? 'Every file in this chat’s workspace is deleted. The chat itself stays.'
            : `${confirm ?? ''} is deleted from the workspace. This can’t be undone.`
        }
        confirmLabel="Delete"
        destructive
        onConfirm={() => void confirmDelete()}
        onClose={() => setConfirm(undefined)}
      />
    </Drawer>
  );
}
