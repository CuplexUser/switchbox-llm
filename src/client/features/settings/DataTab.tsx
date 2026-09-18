import Alert from '@mui/material/Alert';
import Button from '@mui/material/Button';
import { useQueryClient } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import { api } from '../../api/client.ts';
import { ConfirmDialog } from '../../components/ConfirmDialog.tsx';
import { useChatStore } from '../../stores/chat.ts';
import { Panel, SettingRow, SettingsHeader } from './Section.tsx';

export function DataTab() {
  const client = useQueryClient();
  const fileRef = useRef<HTMLInputElement>(null);
  const [status, setStatus] = useState<{ severity: 'success' | 'error'; text: string } | null>(null);
  const [confirmClear, setConfirmClear] = useState(false);

  async function importFile(file: File): Promise<void> {
    try {
      // Exports are ZIP archives now; JSON files from earlier versions still import.
      const archive = file.name.toLowerCase().endsWith('.zip') || file.type.includes('zip');
      const result = archive
        ? await api<{ imported: Record<string, number> }>('/data/import', { method: 'POST', headers: { 'Content-Type': 'application/zip' }, body: file })
        : await api<{ imported: Record<string, number> }>('/data/import', { method: 'POST', json: JSON.parse(await file.text()) as unknown });
      const { conversations = 0, messages = 0, memories = 0, systemPrompts = 0, workspaceFiles = 0 } = result.imported;
      const files = workspaceFiles ? `, ${workspaceFiles} workspace files` : '';
      setStatus({
        severity: 'success',
        text: `Imported ${conversations} chats, ${messages} messages, ${systemPrompts} prompts, ${memories} memories${files}.`,
      });
      await client.invalidateQueries();
    } catch (error) {
      setStatus({ severity: 'error', text: error instanceof Error ? error.message : 'That file could not be imported.' });
    }
  }

  async function clearHistory(): Promise<void> {
    try {
      const { removed } = await api<{ removed: number }>('/data/history', { method: 'DELETE' });
      useChatStore.setState({ conversations: {} });
      await client.invalidateQueries();
      setStatus({ severity: 'success', text: `Deleted ${removed} chats.` });
    } catch (error) {
      setStatus({ severity: 'error', text: error instanceof Error ? error.message : 'History could not be cleared.' });
    }
  }

  return (
    <>
      <SettingsHeader
        title="Data"
        description="Everything is stored in a local SQLite file (data/switchbox.db by default)."
      />
      {status && (
        <Alert severity={status.severity} onClose={() => setStatus(null)} sx={{ mb: 2 }}>
          {status.text}
        </Alert>
      )}
      <Panel>
        <SettingRow
          label="Export"
          description="Download saved chats with their attached files and workspaces, prompts, memories and settings as a ZIP archive. API keys are not included."
        >
          <Button variant="outlined" component="a" href="/api/data/export" download>
            Export
          </Button>
        </SettingRow>
        <SettingRow label="Import" description="Merge an export (a ZIP archive, or JSON from earlier versions) into this database. Items that already exist are skipped.">
          <input
            ref={fileRef}
            type="file"
            accept="application/zip,.zip,application/json,.json"
            hidden
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) void importFile(file);
              event.target.value = '';
            }}
          />
          <Button variant="outlined" onClick={() => fileRef.current?.click()}>
            Import
          </Button>
        </SettingRow>
        <SettingRow label="Delete all chats" description="Removes every chat, message and workspace. Prompts, memories and settings stay.">
          <Button variant="outlined" color="error" onClick={() => setConfirmClear(true)}>
            Delete chats
          </Button>
        </SettingRow>
      </Panel>
      <ConfirmDialog
        open={confirmClear}
        title="Delete all chats?"
        body="Every chat and message will be removed from the database. This can't be undone."
        confirmLabel="Delete all chats"
        destructive
        onClose={() => setConfirmClear(false)}
        onConfirm={() => void clearHistory()}
      />
    </>
  );
}
