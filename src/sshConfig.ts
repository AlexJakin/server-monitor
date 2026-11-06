import { execFile } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/** 读取 ~/.ssh/config 里的 Host 别名，排除通配符与否定模式。 */
export function readSshConfigHosts(): string[] {
  const file = path.join(os.homedir(), '.ssh', 'config');
  let text = '';
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  const hosts = new Set<string>();
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) {
      continue;
    }
    const match = /^Host\s+(.+)$/i.exec(line);
    if (!match) {
      continue;
    }
    for (const token of match[1].split(/\s+/)) {
      if (token && !/[*?!]/.test(token)) {
        hosts.add(token);
      }
    }
  }
  return Array.from(hosts);
}

interface ProcEntry {
  pid: number;
  ppid: number;
  name: string;
  cmd: string;
}

function run(command: string, args: string[]): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    execFile(
      command,
      args,
      { timeout: 8000, maxBuffer: 8 * 1024 * 1024, windowsHide: true, encoding: 'utf8' },
      (error, stdout) => (error ? reject(error) : resolve(String(stdout))),
    );
  });
}

function jsonObject<T>(text: string): T {
  const start = text.search(/[[{]/);
  const end = Math.max(text.lastIndexOf('}'), text.lastIndexOf(']'));
  if (start < 0 || end <= start) {
    throw new Error('empty process list');
  }
  return JSON.parse(text.slice(start, end + 1)) as T;
}

async function windowsProcesses(): Promise<ProcEntry[]> {
  const script = [
    "$ProgressPreference='SilentlyContinue'",
    'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,CommandLine | ConvertTo-Json -Compress -Depth 3',
  ].join('; ');
  const raw = jsonObject<unknown>(await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script]));
  const rows: Record<string, unknown>[] = Array.isArray(raw) ? (raw as Record<string, unknown>[]) : [raw as Record<string, unknown>];
  return rows.map((row) => ({
    pid: Number(row.ProcessId) || 0,
    ppid: Number(row.ParentProcessId) || 0,
    name: String(row.Name || ''),
    cmd: String(row.CommandLine || ''),
  }));
}

async function posixProcesses(): Promise<ProcEntry[]> {
  const text = await run('ps', ['-eo', 'pid=,ppid=,comm=,args=']);
  const rows: ProcEntry[] = [];
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/.exec(line);
    if (match) {
      // args= 是完整命令行（含 ssh 自身），正好交给 sshTargetFromCommand 去掉首个 token。
      rows.push({ pid: Number(match[1]), ppid: Number(match[2]), name: match[3], cmd: match[4] });
    }
  }
  return rows;
}

/** 带值的 ssh 选项，解析命令行时要连同下一个 token 一起跳过。 */
const VALUE_OPTIONS = new Set([
  '-b', '-c', '-D', '-E', '-F', '-i', '-J', '-L', '-l',
  '-m', '-O', '-o', '-p', '-Q', '-R', '-S', '-W', '-w',
]);

/** 从 ssh 命令行里提取 user@host / 别名。仅用于识别，不会把凭据写进配置。 */
export function sshTargetFromCommand(commandLine: string): string | undefined {
  let text = String(commandLine || '').trim();
  if (text.startsWith('"')) {
    const end = text.indexOf('"', 1);
    text = end > 0 ? text.slice(end + 1).trim() : '';
  } else {
    text = text.replace(/^\S+\s*/, '');
  }
  const tokens = text.split(/\s+/).filter(Boolean);
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (VALUE_OPTIONS.has(token)) {
      i += 1;
      continue;
    }
    if (token.startsWith('-')) {
      continue;
    }
    // 目标必须是 user@host / 主机名 / 别名；纯数字（如遗漏的端口）不算。
    return /^[A-Za-z0-9_.@-]+$/.test(token) && !/^\d+$/.test(token) ? token : undefined;
  }
  return undefined;
}

/**
 * 从 IDE 集成终端的进程树里找出正在运行的 ssh 目标。
 *
 * Trae CN / VS Code 的 1.80 公开 API 只能拿到 Terminal.processId，读不到终端里
 * 输入的命令，因此改用系统进程表做子树搜索。找不到时返回 undefined，
 * 上层会保持当前数据源不变（用户仍可手动选择服务器）。
 */
export async function detectSshTarget(terminalPid: number): Promise<string | undefined> {
  if (!terminalPid || terminalPid <= 0) {
    return undefined;
  }
  let procs: ProcEntry[];
  try {
    procs = os.platform() === 'win32' ? await windowsProcesses() : await posixProcesses();
  } catch {
    return undefined;
  }

  const children = new Map<number, ProcEntry[]>();
  const sshProcs: ProcEntry[] = [];
  for (const proc of procs) {
    const list = children.get(proc.ppid) || [];
    list.push(proc);
    children.set(proc.ppid, list);
    if (/^ssh(\.exe)?$/i.test(proc.name) || /(?:^|[\\/])ssh(?:\.exe)?(?:\s|$)/i.test(proc.cmd)) {
      sshProcs.push(proc);
    }
  }
  if (!sshProcs.length) {
    return undefined;
  }

  let frontier = [terminalPid];
  const seen = new Set<number>();
  for (let depth = 0; depth < 6 && frontier.length; depth += 1) {
    const next: number[] = [];
    for (const pid of frontier) {
      if (seen.has(pid)) {
        continue;
      }
      seen.add(pid);
      for (const child of children.get(pid) || []) {
        if (sshProcs.includes(child)) {
          const target = sshTargetFromCommand(child.cmd);
          if (target) {
            return target;
          }
        }
        if (!seen.has(child.pid)) {
          next.push(child.pid);
        }
      }
    }
    frontier = next;
  }

  // 某些终端实现里 ssh 不是 shell 的直接子孙；全局只有一条 ssh 会话时直接采用。
  if (sshProcs.length === 1) {
    return sshTargetFromCommand(sshProcs[0].cmd);
  }
  return undefined;
}
