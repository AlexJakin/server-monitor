import { execFile } from 'child_process';
import * as fs from 'fs';
import { ProcessMetric } from './metrics';

/**
 * Linux 本机指标采集：全部读 /proc 与系统自带命令，不依赖 PowerShell、不装 agent。
 * 与 Windows 采集返回同一种 SystemInfo，上层 localSource.ts 无需区分平台。
 */
export interface SystemInfo {
  diskUsedGb: number;
  diskTotalGb: number;
  diskReadBps: number;
  diskWriteBps: number;
  netRxBps: number;
  netTxBps: number;
  processes: ProcessMetric[];
  /** Linux 下用 MemAvailable 计算，比 os.freemem() 更贴近实际占用。 */
  memoryUsedMb?: number;
  memoryTotalMb?: number;
}

interface DiskBytes {
  read: number;
  write: number;
}

interface NetBytes {
  rx: number;
  tx: number;
}

interface Sample {
  t: number;
  disk: DiskBytes;
  net: NetBytes;
}

const toNum = (value: string | undefined): number => {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
};

function run(command: string, args: string[]): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    execFile(
      command,
      args,
      { timeout: 8000, maxBuffer: 2 * 1024 * 1024, encoding: 'utf8' },
      (error, stdout) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(String(stdout));
      },
    );
  });
}

function readProc(file: string): string {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return '';
  }
}

interface CpuTick {
  idle: number;
  total: number;
}

export interface ProcStat {
  total: CpuTick;
  cores: CpuTick[];
}

function statTicks(fields: number[]): CpuTick {
  return {
    total: fields.reduce((a, b) => a + b, 0),
    idle: (fields[3] || 0) + (fields[4] || 0), // idle + iowait
  };
}

/** /proc/stat：解析 cpu 聚合行与 cpuN 每核行，供两次采样差分算使用率。 */
export function parseProcStat(text: string): ProcStat {
  let total: CpuTick = { idle: 0, total: 0 };
  const cores: CpuTick[] = [];
  for (const line of text.split(/\r?\n/)) {
    const f = line.trim().split(/\s+/);
    if (f[0] === 'cpu') {
      total = statTicks(f.slice(1).map(toNum));
    } else if (/^cpu\d+$/.test(f[0])) {
      cores[Number(f[0].slice(3))] = statTicks(f.slice(1).map(toNum));
    }
  }
  for (let i = 0; i < cores.length; i += 1) {
    if (!cores[i]) {
      cores[i] = { idle: 0, total: 0 };
    }
  }
  if (!total.total && cores.length) {
    total = cores.reduce(
      (a, c) => ({ idle: a.idle + c.idle, total: a.total + c.total }),
      { idle: 0, total: 0 },
    );
  }
  return { total, cores };
}

/** 两次 /proc/stat 差分：返回总使用率与每核使用率（0–100）。 */
export function cpuDelta(prev: ProcStat, cur: ProcStat): { cpu: number; cpuPerCore: number[] } {
  const pct = (a: CpuTick, b: CpuTick): number => {
    const dTotal = b.total - a.total;
    const dIdle = b.idle - a.idle;
    return dTotal > 0 ? Math.max(0, Math.min(100, 100 * (1 - dIdle / dTotal))) : 0;
  };
  const cpuPerCore = cur.cores.map((c, i) => pct(prev.cores[i] || { idle: 0, total: 0 }, c));
  const cpu = cpuPerCore.length
    ? cpuPerCore.reduce((a, b) => a + b, 0) / cpuPerCore.length
    : pct(prev.total, cur.total);
  return { cpu, cpuPerCore };
}

/** /proc/meminfo，单位 kB。MemAvailable 不存在时退化为 free + cached + buffers。 */
export function parseMeminfo(text: string): { usedMb: number; totalMb: number } {
  const totalKb = toNum(/^MemTotal:\s+(\d+)/m.exec(text)?.[1]);
  const freeKb = toNum(/^MemFree:\s+(\d+)/m.exec(text)?.[1]);
  const cachedKb = toNum(/^Cached:\s+(\d+)/m.exec(text)?.[1]);
  const buffersKb = toNum(/^Buffers:\s+(\d+)/m.exec(text)?.[1]);
  const availRaw = /^MemAvailable:\s+(\d+)/m.exec(text)?.[1];
  const availableKb = availRaw !== undefined ? toNum(availRaw) : freeKb + cachedKb + buffersKb;
  return {
    usedMb: Math.max(0, (totalKb - availableKb) / 1024),
    totalMb: totalKb / 1024,
  };
}

/** 只统计整块物理盘，排除 loop/ram/dm- 与分区行，避免重复计数。扇区 × 512 = 字节。 */
const DEVICE_RE = /^(sd[a-z]+|hd[a-z]+|vd[a-z]+|xvd[a-z]+|nvme\d+n\d+|mmcblk\d+)$/;

export function parseDiskstats(text: string): DiskBytes {
  let read = 0;
  let write = 0;
  for (const line of text.split(/\r?\n/)) {
    const f = line.trim().split(/\s+/);
    if (f.length < 10 || !DEVICE_RE.test(f[2])) {
      continue;
    }
    read += toNum(f[5]) * 512;
    write += toNum(f[9]) * 512;
  }
  return { read, write };
}

/** /proc/net/dev：跳过 lo，累加所有网卡的 rx(索引 0) / tx(索引 8) 字节数。 */
export function parseNetDev(text: string): NetBytes {
  let rx = 0;
  let tx = 0;
  for (const line of text.split(/\r?\n/)) {
    const idx = line.indexOf(':');
    if (idx < 0) {
      continue;
    }
    const name = line.slice(0, idx).trim();
    if (!name || name === 'lo') {
      continue;
    }
    const f = line.slice(idx + 1).trim().split(/\s+/);
    if (f.length < 9) {
      continue;
    }
    rx += toNum(f[0]);
    tx += toNum(f[8]);
  }
  return { rx, tx };
}

/** df -kP / 的最后一行：1024-blocks、Used，kB → GB。 */
export function parseDf(text: string): { usedGb: number; totalGb: number } {
  const lines = text.trim().split(/\r?\n/);
  const f = (lines[lines.length - 1] || '').trim().split(/\s+/);
  if (f.length < 3) {
    return { usedGb: 0, totalGb: 0 };
  }
  return { usedGb: toNum(f[2]) / 1048576, totalGb: toNum(f[1]) / 1048576 };
}

/** nvidia-smi --query-compute-apps=pid,used_memory：Linux 下可拿到进程级显存（MiB）。 */
export function parseComputeApps(text: string): Map<number, number> {
  const map = new Map<number, number>();
  for (const line of text.split(/\r?\n/)) {
    const f = line.split(',').map((s) => s.trim());
    if (f.length < 2) {
      continue;
    }
    const pid = toNum(f[0]);
    const mb = toNum(f[1].replace(/[^0-9.]/g, ''));
    if (pid > 0 && mb > 0) {
      map.set(pid, mb);
    }
  }
  return map;
}

/** ps -eo pid=,comm=,pcpu=,rss=：CPU 取 Top6，rss 单位 kB。 */
export function parsePs(text: string, gpuMem: Map<number, number>): ProcessMetric[] {
  const rows: ProcessMetric[] = [];
  for (const line of text.split(/\r?\n/)) {
    const f = line.trim().split(/\s+/);
    if (f.length < 4) {
      continue;
    }
    const pid = toNum(f[0]);
    if (!pid) {
      continue;
    }
    rows.push({
      pid,
      name: f[1],
      cpu: Math.min(100, Math.max(0, toNum(f[2]))),
      memoryMb: toNum(f[3]) / 1024,
      gpuMemoryMb: gpuMem.get(pid) || 0,
    });
  }
  return rows.sort((a, b) => b.cpu - a.cpu).slice(0, 6);
}

/**
 * 磁盘/网络吞吐是速率，必须由两次 /proc 采样差分得出。
 * 这里保留上一次读数，首次采样速率为 0，之后为真实值。
 */
export class LinuxCollector {
  private prev: Sample | undefined;

  async sample(): Promise<SystemInfo> {
    const now = Date.now();
    const disk = parseDiskstats(readProc('/proc/diskstats'));
    const net = parseNetDev(readProc('/proc/net/dev'));

    let diskReadBps = 0;
    let diskWriteBps = 0;
    let netRxBps = 0;
    let netTxBps = 0;
    if (this.prev) {
      const dt = (now - this.prev.t) / 1000;
      if (dt > 0) {
        diskReadBps = Math.max(0, disk.read - this.prev.disk.read) / dt;
        diskWriteBps = Math.max(0, disk.write - this.prev.disk.write) / dt;
        netRxBps = Math.max(0, net.rx - this.prev.net.rx) / dt;
        netTxBps = Math.max(0, net.tx - this.prev.net.tx) / dt;
      }
    }
    this.prev = { t: now, disk, net };

    const [dfOut, psOut, gpuOut] = await Promise.all([
      run('df', ['-kP', '/']).catch(() => ''),
      run('ps', ['-eo', 'pid=,comm=,pcpu=,rss=']).catch(() => ''),
      run('nvidia-smi', [
        '--query-compute-apps=pid,used_memory',
        '--format=csv,noheader,nounits',
      ]).catch(() => ''),
    ]);

    const mem = parseMeminfo(readProc('/proc/meminfo'));
    const capacity = parseDf(dfOut);
    return {
      diskUsedGb: capacity.usedGb,
      diskTotalGb: capacity.totalGb,
      diskReadBps,
      diskWriteBps,
      netRxBps,
      netTxBps,
      processes: parsePs(psOut, parseComputeApps(gpuOut)),
      memoryUsedMb: mem.usedMb,
      memoryTotalMb: mem.totalMb,
    };
  }
}
