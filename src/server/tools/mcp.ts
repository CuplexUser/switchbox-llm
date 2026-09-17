import { createHash } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { getDefaultEnvironment, StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { AppSettings, McpServerConfig, McpTestResult } from '../../shared/types.ts';
import { createLogger } from '../log.ts';
import { errorText, type ToolDefinition, type ToolGroup, type ToolResult, type ToolSource } from './types.ts';

const log = createLogger('mcp');
const CONNECT_TIMEOUT_MS = 20_000;
const CALL_TIMEOUT_MS = 120_000;
/** After a failed connection, wait this long before trying the server again. */
const RETRY_AFTER_MS = 60_000;
const MAX_TOOL_NAME = 64;

interface RemoteTool {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

interface Connection {
  fingerprint: string;
  client: Client | null;
  tools: RemoteTool[];
  error: string | null;
  failedAt: number;
  pending: Promise<void> | null;
}

export function groupId(server: Pick<McpServerConfig, 'id'>): string {
  return `mcp:${server.id}`;
}

function slug(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'server';
}

/** Tool names providers accept: letters, digits, _ and -, at most 64 characters, unique per server. */
export function toolName(server: Pick<McpServerConfig, 'id' | 'name'>, tool: string): string {
  const name = `mcp_${slug(server.name)}_${tool.replace(/[^a-zA-Z0-9_-]+/g, '_')}`;
  if (name.length <= MAX_TOOL_NAME) return name;
  const hash = createHash('sha256').update(`${server.id}:${tool}`).digest('hex').slice(0, 8);
  return `${name.slice(0, MAX_TOOL_NAME - 9)}_${hash}`;
}

function fingerprint(server: McpServerConfig): string {
  const { name: _name, enabled: _enabled, useByDefault: _useByDefault, ...connection } = server;
  return JSON.stringify(connection);
}

/** The text a model gets back from an MCP tool result. */
export function resultText(result: { content?: unknown; structuredContent?: unknown }): string {
  const parts: string[] = [];
  for (const item of Array.isArray(result.content) ? (result.content as Record<string, unknown>[]) : []) {
    switch (item.type) {
      case 'text':
        parts.push(String(item.text ?? ''));
        break;
      case 'image':
      case 'audio':
        parts.push(`[${item.type} (${String(item.mimeType ?? 'unknown type')}) not shown]`);
        break;
      case 'resource': {
        const resource = (item.resource ?? {}) as Record<string, unknown>;
        parts.push(typeof resource.text === 'string' ? resource.text : `[resource ${String(resource.uri ?? '')}]`);
        break;
      }
      case 'resource_link':
        parts.push(`[resource ${String(item.uri ?? '')}${item.name ? `: ${String(item.name)}` : ''}]`);
        break;
      default:
        parts.push(JSON.stringify(item));
    }
  }
  if (parts.length === 0 && result.structuredContent !== undefined) parts.push(JSON.stringify(result.structuredContent, null, 2));
  return parts.join('\n\n') || '(The tool returned nothing.)';
}

async function openClient(server: McpServerConfig): Promise<{ client: Client; tools: RemoteTool[] }> {
  const client = new Client({ name: 'switchbox', version: '0.1.0' });
  let stderr = '';
  let transport;
  if (server.transport === 'stdio') {
    if (!server.command.trim()) throw new Error('A stdio server needs a command.');
    const stdio = new StdioClientTransport({
      command: server.command.trim(),
      args: server.args,
      env: { ...getDefaultEnvironment(), ...server.env },
      stderr: 'pipe',
    });
    stdio.stderr?.on('data', (chunk: Buffer) => {
      stderr = (stderr + chunk.toString()).slice(-2000);
    });
    transport = stdio;
  } else {
    if (!server.url.trim()) throw new Error('An HTTP server needs a URL.');
    transport = new StreamableHTTPClientTransport(new URL(server.url.trim()), { requestInit: { headers: server.headers } });
  }

  const timeout = AbortSignal.timeout(CONNECT_TIMEOUT_MS);
  try {
    await Promise.race([
      client.connect(transport),
      new Promise((_, reject) => timeout.addEventListener('abort', () => reject(new Error('Timed out connecting.')), { once: true })),
    ]);
    const tools: RemoteTool[] = [];
    let cursor: string | undefined;
    do {
      const page = await client.listTools(cursor ? { cursor } : undefined, { timeout: CONNECT_TIMEOUT_MS });
      tools.push(...(page.tools as RemoteTool[]));
      cursor = page.nextCursor;
    } while (cursor);
    return { client, tools };
  } catch (error) {
    await client.close().catch(() => {});
    const detail = stderr.trim() ? `\n${stderr.trim().split('\n').slice(-5).join('\n')}` : '';
    throw new Error(`${errorText(error)}${detail}`, { cause: error });
  }
}

/** Connects to the MCP servers in settings when their tools are first needed and keeps them open. */
export class McpManager implements ToolSource {
  private readonly connections = new Map<string, Connection>();

  /** Closes connections to servers that were removed, turned off or changed. */
  async sync(servers: McpServerConfig[]): Promise<void> {
    const wanted = new Map(servers.filter((server) => server.enabled).map((server) => [server.id, fingerprint(server)]));
    for (const [id, connection] of this.connections) {
      if (wanted.get(id) === connection.fingerprint) continue;
      this.connections.delete(id);
      await connection.client?.close().catch(() => {});
    }
  }

  private async connection(server: McpServerConfig): Promise<Connection> {
    const print = fingerprint(server);
    let connection = this.connections.get(server.id);
    if (connection && connection.fingerprint !== print) {
      await connection.client?.close().catch(() => {});
      connection = undefined;
    }
    if (!connection) {
      connection = { fingerprint: print, client: null, tools: [], error: null, failedAt: 0, pending: null };
      this.connections.set(server.id, connection);
    }
    const current = connection;
    const due = !current.client && !current.pending && Date.now() - current.failedAt > RETRY_AFTER_MS;
    if (due) {
      current.pending = openClient(server)
        .then(({ client, tools }) => {
          current.client = client;
          current.tools = tools;
          current.error = null;
          // The SDK client has no addEventListener; onclose is its only close hook.
          // oxlint-disable-next-line unicorn/prefer-add-event-listener
          client.onclose = () => {
            current.client = null;
            current.tools = [];
          };
          log.info('connected', { server: server.name, tools: tools.length });
        })
        .catch((error: unknown) => {
          current.error = errorText(error);
          current.failedAt = Date.now();
          log.warn('could not connect', { server: server.name, error: current.error });
        })
        .finally(() => {
          current.pending = null;
        });
    }
    await current.pending;
    return current;
  }

  async groups(settings: AppSettings): Promise<ToolGroup[]> {
    return settings.mcp.servers
      .filter((server) => server.enabled)
      .map((server) => ({
        id: groupId(server),
        label: server.name || 'MCP server',
        description: `Tools from the ${server.name || 'unnamed'} MCP server.`,
        kind: 'mcp' as const,
        onByDefault: server.useByDefault,
        toggledBy: null,
      }));
  }

  async tools(settings: AppSettings): Promise<ToolDefinition[]> {
    const servers = settings.mcp.servers.filter((server) => server.enabled);
    const lists = await Promise.all(
      servers.map(async (server) => {
        const connection = await this.connection(server);
        return connection.tools.map((tool) => this.definition(server, tool));
      }),
    );
    return lists.flat();
  }

  groupError(id: string): string | null {
    if (!id.startsWith('mcp:')) return null;
    return this.connections.get(id.slice(4))?.error ?? null;
  }

  private definition(server: McpServerConfig, tool: RemoteTool): ToolDefinition {
    return {
      group: groupId(server),
      label: `${server.name}: ${tool.name}`,
      // Outside tools can change things, so they ask first until the user decides otherwise.
      defaultPolicy: 'ask',
      untrusted: true,
      spec: {
        name: toolName(server, tool.name),
        description: (tool.description ?? `The ${tool.name} tool from ${server.name}.`).slice(0, 1024),
        parameters: tool.inputSchema ?? { type: 'object', properties: {} },
      },
      run: async (args, context): Promise<ToolResult> => {
        const connection = await this.connection(server);
        if (!connection.client) return { content: `Error: ${server.name} is not connected: ${connection.error ?? 'unknown error'}`, isError: true };
        const result = await connection.client.callTool({ name: tool.name, arguments: args }, undefined, {
          signal: context.signal,
          timeout: CALL_TIMEOUT_MS,
        });
        const text = resultText(result as { content?: unknown; structuredContent?: unknown });
        return result.isError ? { content: `Error: ${text}`, isError: true } : { content: text, isError: false };
      },
    };
  }

  async test(server: McpServerConfig): Promise<McpTestResult> {
    try {
      const { client, tools } = await openClient(server);
      await client.close().catch(() => {});
      return { ok: true, tools: tools.map((tool) => ({ name: tool.name, description: tool.description ?? '' })), error: null };
    } catch (error) {
      return { ok: false, tools: [], error: errorText(error) };
    }
  }

  async closeAll(): Promise<void> {
    const open = [...this.connections.values()];
    this.connections.clear();
    await Promise.allSettled(open.map((connection) => connection.client?.close()));
  }
}
