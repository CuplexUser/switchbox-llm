type Level = 'debug' | 'info' | 'warn' | 'error';
export type LogFields = Record<string, unknown>;

const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

function threshold(): number {
  const level = (process.env.LOG_LEVEL ?? 'info').toLowerCase() as Level;
  return ORDER[level] ?? ORDER.info;
}

function formatValue(value: unknown): string {
  if (value instanceof Error) return JSON.stringify(value.message);
  if (typeof value === 'string') return /[\s="]/.test(value) ? JSON.stringify(value) : value;
  return JSON.stringify(value) ?? String(value);
}

export interface Logger {
  debug(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
  /** A logger that adds `fields` to every line, e.g. a run id. */
  child(fields: LogFields): Logger;
}

/**
 * Line-oriented logs: `time LEVEL [scope] message key=value`, or one JSON object per line with
 * LOG_FORMAT=json. LOG_LEVEL picks the lowest level written (default info).
 */
export function createLogger(scope: string, base: LogFields = {}): Logger {
  const write = (level: Level, message: string, fields: LogFields = {}) => {
    if (ORDER[level] < threshold()) return;
    const all = { ...base, ...fields };
    const time = new Date().toISOString();
    let line: string;
    if (process.env.LOG_FORMAT === 'json') {
      const entries = Object.entries(all).map(([key, value]) => [key, value instanceof Error ? value.message : value]);
      line = JSON.stringify({ time, level, scope, message, ...Object.fromEntries(entries) });
    } else {
      const pairs = Object.entries(all)
        .filter(([, value]) => value !== undefined)
        .map(([key, value]) => `${key}=${formatValue(value)}`);
      line = [time, level.toUpperCase().padEnd(5), `[${scope}]`, message, ...pairs].join(' ');
    }
    (level === 'warn' || level === 'error' ? process.stderr : process.stdout).write(`${line}\n`);
  };
  return {
    debug: (message, fields) => write('debug', message, fields),
    info: (message, fields) => write('info', message, fields),
    warn: (message, fields) => write('warn', message, fields),
    error: (message, fields) => write('error', message, fields),
    child: (fields) => createLogger(scope, { ...base, ...fields }),
  };
}
