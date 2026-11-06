import { execFile } from 'child_process';
import * as os from 'os';
import {
  GpuMetric,
  GpuProcessMetric,
  MetricsSnapshot,
  MetricsSource,
  ProcessMetric,
  parseGpuQuery,
} from './metrics';
import { LinuxCollector, SystemInfo } from './linuxMetrics';
import { attachGpuIndex, mergeGpuProcesses, parseGpuApps, parseGpuUuidMap } from './gpuProcesses';

const clamp = (v: number, min: number, max: number): number => Math.max(min, Math.min(max, v));

interface CpuTick {
  idle: number;
  total: number;
}

interface RawProcess {
  pid?: number;
  name?: string;
  cpu?: number;
  memoryMb?: number;
}

/** 统一走 child_process，只依赖 Node 内置模块，不引入任何原生二进制 npm 包。 */
function run(command: string, args: string[]): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    execFile(
      command,
      args,
      { timeout: 8000, maxBuffer: 2 * 1024 * 1024, windowsHide: true, encoding: 'utf8' },
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

function cpuTicks(): CpuTick[] {
  return os.cpus().map((cpu) => {
    const t = cpu.times;
    return { idle: t.idle, total: t.user + t.nice + t.sys + t.idle + t.irq };
  });
}

/**
 * Windows：一次 PowerShell 调用取回磁盘容量、磁盘/网络吞吐和进程 Top6。
 * 使用 PerfFormattedData（格式化计数器）即时读数，无需等待采样周期。
 */
const PS_SCRIPT = `
$ErrorActionPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$cores = [Environment]::ProcessorCount
$d = Get-CimInstance Win32_LogicalDisk -Filter "DriveType=3" | Sort-Object DeviceID | Select-Object -First 1
$size = [double]$d.Size
$free = [double]$d.FreeSpace
$pd = Get-CimInstance Win32_PerfFormattedData_PerfDisk_PhysicalDisk | Where-Object { $_.Name -eq '_Total' } | Select-Object -First 1
$readBps = [double]$pd.DiskReadBytesPersec
$writeBps = [double]$pd.DiskWriteBytesPersec
$rx = 0.0
$tx = 0.0
Get-CimInstance Win32_PerfFormattedData_Tcpip_NetworkInterface | Where-Object { $_.Name -notmatch 'isatap|Loopback' } | ForEach-Object { $rx += [double]$_.BytesReceivedPersec; $tx += [double]$_.BytesSentPersec }
$procs = @(Get-CimInstance Win32_PerfFormattedData_PerfProc_Process | Where-Object { $_.Name -notmatch '^(Idle|_Total)$' } | Sort-Object PercentProcessorTime -Descending | Select-Object -First 6 | ForEach-Object {
  [pscustomobject]@{
    pid = [int]$_.IDProcess
    name = [string]($_.Name -replace '#[0-9]+$', '')
    cpu = [math]::Round([double]$_.PercentProcessorTime / $cores, 1)
    memoryMb = [math]::Round([double]$_.WorkingSetPrivate / 1MB, 1)
  }
})
$out = [pscustomobject]@{
  diskUsedGb = [math]::Round(($size - $free) / 1GB, 1)
  diskTotalGb = [math]::Round($size / 1GB, 1)
  diskReadBps = $readBps
  diskWriteBps = $writeBps
  netRxBps = $rx
  netTxBps = $tx
  processes = $procs
}
$out | ConvertTo-Json -Compress -Depth 5
`;

function toNumber(value: unknown): number {
  const n = typeof value === 'string' ? Number(value.replace(/[^0-9.\-]/g, '')) : Number(value);
  return Number.isFinite(n) ? n : 0;
}

function parseSystem(stdout: string): SystemInfo | undefined {
  const start = stdout.indexOf('{');
  const end = stdout.lastIndexOf('}');
  if (start < 0 || end <= start) {
    return undefined;
  }
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(stdout.slice(start, end + 1)) as Record<string, unknown>;
  } catch {
    return undefined;
  }

  const list = raw.processes;
  const items: RawProcess[] = Array.isArray(list)
    ? (list as RawProcess[])
    : list
      ? [list as RawProcess]
      : [];
  const processes: ProcessMetric[] = items.map((p) => ({
    pid: toNumber(p.pid),
    name: String(p.name || 'unknown'),
    cpu: clamp(toNumber(p.cpu), 0, 100),
    memoryMb: toNumber(p.memoryMb),
    // Windows WDDM 驱动下 nvidia-smi 不提供进程级显存（返回 [N/A]），此处恒为 0。
    gpuMemoryMb: 0,
  }));

  return {
    diskUsedGb: toNumber(raw.diskUsedGb),
    diskTotalGb: toNumber(raw.diskTotalGb),
    diskReadBps: toNumber(raw.diskReadBps),
    diskWriteBps: toNumber(raw.diskWriteBps),
    netRxBps: toNumber(raw.netRxBps),
    netTxBps: toNumber(raw.netTxBps),
    processes,
  };
}

async function querySystemWindows(): Promise<SystemInfo | undefined> {
  const stdout = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', PS_SCRIPT]);
  return parseSystem(stdout);
}

const CSV_ARGS = '--format=csv,noheader,nounits';
const GPU_ARGS = [
  '--query-gpu=index,name,memory.used,memory.total,utilization.gpu,temperature.gpu',
  CSV_ARGS,
];
const GPU_UUID_ARGS = ['--query-gpu=index,uuid', CSV_ARGS];
const GPU_APPS_ARGS = ['--query-compute-apps=gpu_uuid,pid,used_memory,process_name', CSV_ARGS];
const GPU_GRAPH_ARGS = ['--query-graphics-apps=gpu_uuid,pid,used_memory,process_name', CSV_ARGS];
const GPU_APPS_FALLBACK_ARGS = ['--query-compute-apps=pid,used_memory,process_name', CSV_ARGS];

async function nvidiaSmi(args: string[]): Promise<string> {
  try {
    return await run('nvidia-smi', args);
  } catch {
    // 部分 Windows 安装没把 NVSMI 加进 PATH，但系统目录下一定有。
    return await run('C:\\Windows\\System32\\nvidia-smi.exe', args);
  }
}

async function queryGpus(): Promise<GpuMetric[]> {
  try {
    return parseGpuQuery(await nvidiaSmi(GPU_ARGS));
  } catch {
    return [];
  }
}

/** 逐卡进程明细：4 条查询并行，任一驱动字段不支持都静默降级为空。 */
async function queryGpuProcesses(gpus: GpuMetric[]): Promise<GpuProcessMetric[]> {
  const [mapText, appsText, graphText, fallbackText] = await Promise.all([
    nvidiaSmi(GPU_UUID_ARGS).catch(() => ''),
    nvidiaSmi(GPU_APPS_ARGS).catch(() => ''),
    nvidiaSmi(GPU_GRAPH_ARGS).catch(() => ''),
    nvidiaSmi(GPU_APPS_FALLBACK_ARGS).catch(() => ''),
  ]);
  const uuidMap = parseGpuUuidMap(mapText);
  const indexes = gpus.map((g) => g.index);
  const apps = mergeGpuProcesses([
    parseGpuApps(appsText.trim() || fallbackText, uuidMap, 'compute', indexes),
    parseGpuApps(graphText, uuidMap, 'graphics', indexes),
  ]);
  // 单卡机器若驱动既不返回 uuid 也没有映射，仍可确定归属。
  if (gpus.length === 1) {
    for (const app of apps) {
      if (app.gpuIndex < 0) {
        app.gpuIndex = gpus[0].index;
      }
    }
  }
  return apps;
}

/**
 * 「插件运行所在机器」的真实指标数据源，Windows 与 Linux 都支持。
 *
 * 采用「后台异步刷新 + 快照缓存」：CPU 每秒用 os.cpus() 差分计算（跨平台），
 * 系统信息每 2 秒按平台分派到 PowerShell 或 /proc 采集。next() 保持同步返回，
 * 因此扩展层与 Webview 的消息协议完全不用改动。
 *
 * 注意：采集的是 IDE 所在主机，不是远程服务器。远程 Linux 需要额外的 SSH 采集层。
 */
export class LocalSource implements MetricsSource {
  private prevTicks: CpuTick[];
  private cpu = 0;
  private cpuPerCore: number[];
  private diskUsedGb = 0;
  private diskTotalGb = 0;
  private diskReadBps = 0;
  private diskWriteBps = 0;
  private netRxBps = 0;
  private netTxBps = 0;
  private linuxMemory: { usedMb: number; totalMb: number } | undefined;
  private gpus: GpuMetric[] = [];
  private processes: ProcessMetric[] = [];
  private gpuProcesses: GpuProcessMetric[] = [];
  private gpuAppsTick = 0;
  private status = '正在采集本机指标…';
  private refreshing = false;
  private disposed = false;
  private snapshot: MetricsSnapshot;
  private readonly linuxCollector = new LinuxCollector();
  private readonly cpuTimer: NodeJS.Timeout;
  private readonly sysTimer: NodeJS.Timeout;

  constructor() {
    this.prevTicks = cpuTicks();
    this.cpuPerCore = this.prevTicks.map(() => 0);
    this.snapshot = this.build();
    void this.refreshSystem();
    this.cpuTimer = setInterval(() => this.sampleCpu(), 1000);
    this.sysTimer = setInterval(() => void this.refreshSystem(), 2000);
    this.cpuTimer.unref();
    this.sysTimer.unref();
  }

  get statusText(): string {
    return this.status;
  }

  next(host: string): MetricsSnapshot {
    return { ...this.snapshot, host, timestamp: Date.now() };
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    clearInterval(this.cpuTimer);
    clearInterval(this.sysTimer);
  }

  private sampleCpu(): void {
    const current = cpuTicks();
    if (current.length === this.prevTicks.length) {
      this.cpuPerCore = current.map((c, i) => {
        const dTotal = c.total - this.prevTicks[i].total;
        const dIdle = c.idle - this.prevTicks[i].idle;
        return dTotal > 0 ? clamp(100 * (1 - dIdle / dTotal), 0, 100) : 0;
      });
      this.cpu = this.cpuPerCore.reduce((a, b) => a + b, 0) / this.cpuPerCore.length;
    }
    this.prevTicks = current;
    this.snapshot = this.build();
  }

  private async refreshSystem(): Promise<void> {
    if (this.refreshing || this.disposed) {
      return;
    }
    this.refreshing = true;
    try {
      const sysPromise: Promise<SystemInfo | undefined> =
        os.platform() === 'win32'
          ? querySystemWindows().catch(() => undefined)
          : this.linuxCollector.sample().catch(() => undefined);
      const [sys, gpus] = await Promise.all([sysPromise, queryGpus()]);
      if (this.disposed) {
        return;
      }
      // GPU 进程明细变化慢，隔次刷新（约 4 秒）即可，避免每轮多跑 4 次 nvidia-smi。
      if (this.gpuAppsTick++ % 2 === 0 || !this.gpuProcesses.length) {
        this.gpuProcesses = await queryGpuProcesses(gpus);
        if (this.disposed) {
          return;
        }
      }
      if (sys) {
        this.diskUsedGb = sys.diskUsedGb;
        this.diskTotalGb = sys.diskTotalGb;
        this.diskReadBps = sys.diskReadBps;
        this.diskWriteBps = sys.diskWriteBps;
        this.netRxBps = sys.netRxBps;
        this.netTxBps = sys.netTxBps;
        this.processes = sys.processes;
        this.linuxMemory =
          sys.memoryUsedMb !== undefined && sys.memoryTotalMb
            ? { usedMb: sys.memoryUsedMb, totalMb: sys.memoryTotalMb }
            : undefined;
      }
      this.gpus = gpus;
      this.processes = attachGpuIndex(this.processes, this.gpuProcesses);

      const platformLabel =
        os.platform() === 'win32' ? 'Windows' : os.platform() === 'linux' ? 'Linux' : os.platform();
      const notes = [
        `${platformLabel} · ${os.cpus().length} 核 / ${(os.totalmem() / 1073741824).toFixed(0)} GB 内存`,
        gpus.length ? `检测到 ${gpus.length} 张 NVIDIA GPU` : '未检测到 NVIDIA GPU',
        this.gpuProcesses.length ? `${this.gpuProcesses.length} 个 GPU 进程` : '',
      ].filter(Boolean);
      if (!sys) {
        notes.push('磁盘/进程指标读取失败');
      }
      this.status = notes.join(' · ');
      this.snapshot = this.build();
    } finally {
      this.refreshing = false;
    }
  }

  private build(): MetricsSnapshot {
    const memTotalMb = this.linuxMemory ? this.linuxMemory.totalMb : os.totalmem() / 1048576;
    const memUsedMb = this.linuxMemory
      ? this.linuxMemory.usedMb
      : Math.max(0, (os.totalmem() - os.freemem()) / 1048576);
    return {
      timestamp: Date.now(),
      host: os.hostname(),
      cpu: this.cpu,
      cpuPerCore: this.cpuPerCore.slice(),
      memoryUsedMb: memUsedMb,
      memoryTotalMb: memTotalMb,
      diskUsedGb: this.diskUsedGb,
      diskTotalGb: this.diskTotalGb,
      // 界面按 Mbps / 8 还原成 MB/s。
      diskReadMbps: (this.diskReadBps * 8) / 1e6,
      diskWriteMbps: (this.diskWriteBps * 8) / 1e6,
      netRxMbps: (this.netRxBps * 8) / 1e6,
      netTxMbps: (this.netTxBps * 8) / 1e6,
      gpus: this.gpus.slice(),
      processes: this.processes.slice(),
      gpuProcesses: this.gpuProcesses.slice(),
      uptimeSeconds: os.uptime(),
    };
  }
}
