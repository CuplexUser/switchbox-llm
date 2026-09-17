import type { ToolDefinition, ToolGroup, ToolSource } from './types.ts';

export const TIME_GROUP: ToolGroup = {
  id: 'time',
  label: 'Current time',
  description: 'The date and time, in any time zone.',
  kind: 'builtin',
  onByDefault: true,
  toggledBy: null,
};

export function describeTime(now: Date, timeZone: string): string {
  const date = new Intl.DateTimeFormat('en-US', {
    timeZone,
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  }).format(now);
  const time = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
    timeZoneName: 'shortOffset',
  }).format(now);
  return `${date}, ${time} (${timeZone})\nISO 8601 UTC: ${now.toISOString()}\nUnix time: ${Math.floor(now.getTime() / 1000)}`;
}

export const CURRENT_TIME_TOOL: ToolDefinition = {
  group: 'time',
  label: 'Current time',
  defaultPolicy: 'auto',
  spec: {
    name: 'current_time',
    description:
      'Get the current date and time. Defaults to the time zone of the computer Switchbox runs on. ' +
      'Use it for questions about today, deadlines, or the time somewhere else.',
    parameters: {
      type: 'object',
      properties: {
        time_zone: { type: 'string', description: 'An IANA time zone such as "Europe/Oslo" or "America/New_York"' },
      },
      additionalProperties: false,
    },
  },
  async run(args) {
    const local = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const timeZone = typeof args.time_zone === 'string' && args.time_zone.trim() ? args.time_zone.trim() : local;
    try {
      return { content: describeTime(new Date(), timeZone), isError: false };
    } catch {
      return { content: `Error: "${timeZone}" is not a known time zone. Use an IANA name such as "Europe/Oslo".`, isError: true };
    }
  },
};

export function timeTools(): ToolSource {
  return { groups: async () => [TIME_GROUP], tools: async () => [CURRENT_TIME_TOOL] };
}
