import { spawn, type ChildProcess } from 'node:child_process';

const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const children: ChildProcess[] = [];

function run(name: string, script: string, color: number): void {
  const child = spawn(npm, ['run', script], { shell: process.platform === 'win32', env: process.env });
  const prefix = `\x1b[${color}m[${name}]\x1b[0m `;
  const pipe = (stream: NodeJS.ReadableStream, out: NodeJS.WriteStream) => {
    let buffer = '';
    stream.on('data', (chunk: Buffer) => {
      buffer += chunk.toString();
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? '';
      for (const line of lines) out.write(prefix + line + '\n');
    });
  };
  if (child.stdout) pipe(child.stdout, process.stdout);
  if (child.stderr) pipe(child.stderr, process.stderr);
  child.on('exit', (code) => {
    process.stdout.write(`${prefix}exited with code ${code}\n`);
    shutdown(code ?? 0);
  });
  children.push(child);
}

let stopping = false;
function shutdown(code: number): void {
  if (stopping) return;
  stopping = true;
  for (const child of children) child.kill();
  process.exit(code);
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

run('server', 'dev:server', 36);
run('client', 'dev:client', 35);
