export interface GpuMetric {
  index: number;
  name: string;
  memoryUsedMb: number;
  memoryTotalMb: number;
  utilization: number;
  temperatureC: number;
}

export interface ProcessMetric {
  pid: number;
  name: string;
  cpu: number;
  memoryMb: number;
  gpuMemoryMb: number;
  /** 该进程所在物理显卡号；GPU 进程明细可用时填充。 */
  gpuIndex?: number;
}

/** 某一张显卡上正在运行的进程。 */
export interface GpuProcessMetric {
  /** 物理卡号；-1 表示驱动未返回 uuid 且机器有多张卡，无法确定归属。 */
  gpuIndex: number;
  pid: number;
  /** 简短进程名（Windows 完整路径只取文件名）。 */
  name: string;
  /** 驱动返回的原始名称 / 路径，用于鼠标悬停。 */
  fullName: string;
  /** compute = CUDA 计算任务，graphics = 图形任务，both = 同一 PID 两类都有。 */
  kind: 'compute' | 'graphics' | 'both';
  usedMemoryMb: number;
  /** false 表示驱动返回 [N/A]（Windows WDDM 常见），界面必须显示「—」而非 0。 */
  memoryKnown: boolean;
}

export interface MetricsSnapshot {
  timestamp: number;
  host: string;
  cpu: number;
  cpuPerCore: number[];
  memoryUsedMb: number;
  memoryTotalMb: number;
  diskUsedGb: number;
  diskTotalGb: number;
  diskReadMbps: number;
  diskWriteMbps: number;
  netRxMbps: number;
  netTxMbps: number;
  gpus: GpuMetric[];
  processes: ProcessMetric[];
  /** 按显卡归属的 GPU 进程明细；旧版数据源可能没有此字段，界面需兜底为 []。 */
  gpuProcesses?: GpuProcessMetric[];
  uptimeSeconds: number;
}

/** 静态配置详情：本机或远程 Linux 服务器的硬件 / 系统信息。 */
export interface ServerInfo {
  source: 'local' | 'ssh' | 'demo';
  /** SSH 目标（user@host 或 ~/.ssh/config 别名），仅 ssh 模式有值。 */
  target?: string;
  hostname: string;
  os: string;
  kernel: string;
  arch: string;
  cpuModel: string;
  cores: number;
  uptimeSeconds: number;
  /** 采集状态说明，例如连接耗时或降级提示。 */
  status: string;
  /** SSH 连接 / 采集失败原因，界面据此显示错误横幅。 */
  error?: string;
  /** IDE 自身的远程会话名（Remote-SSH / WSL / Container），存在时采集发生在远端扩展宿主。 */
  remoteName?: string;
}

export interface HistoryPoint {
  t: number;
  cpu: number;
  memory: number;
  gpuMemory: number;
  gpuUtil: number;
}

export interface DashboardPayload {
  snapshot: MetricsSnapshot;
  history: HistoryPoint[];
  host: string;
  intervalMs: number;
  dataSource: string;
  paused: boolean;
  /** 插件运行所在主机的平台（os.platform()），用于界面显示对应的采集口径说明。 */
  platform?: string;
  serverInfo?: ServerInfo;
}

export interface MetricsSource {
  next(host: string): MetricsSnapshot;
  /** 带后台刷新的数据源可暴露静态配置详情（SSH 源用它返回远端机器信息）。 */
  readonly serverInfo?: ServerInfo;
  /** 后台带定时器的数据源可实现此方法来释放资源。 */
  dispose?(): void;
}

const clamp = (v: number, min: number, max: number): number => Math.max(min, Math.min(max, v));

const PROCESS_NAMES = [
  'python train.py',
  'torch_worker / 0',
  'torch_worker / 1',
  'jupyter-lab',
  'dockerd',
  'node server.js',
];

/**
 * 演示数据源：生成带波动、阶跃和相关性的假指标，用于在没有真实服务器时验证界面。
 * 接入真实服务器时，实现同一个 MetricsSource 接口即可，界面层无需改动。
 */
export class DemoSource implements MetricsSource {
  private tick = 0;
  private cpu = 42;
  private memPct = 54;
  private gpuMemPct = 61;
  private gpuUtil = 74;
  private temp = 63;

  next(host: string): MetricsSnapshot {
    this.tick += 1;
    const wave = Math.sin(this.tick / 8) * 7 + Math.sin(this.tick / 21) * 4;

    this.cpu = clamp(this.cpu + (42 + wave - this.cpu) * 0.18 + (Math.random() - 0.5) * 5, 3, 97);
    this.memPct = clamp(this.memPct + (55 - this.memPct) * 0.05 + (Math.random() - 0.5) * 1.2, 20, 92);
    if (Math.random() < 0.05) {
      this.gpuMemPct += (Math.random() - 0.5) * 22;
    }
    this.gpuMemPct = clamp(this.gpuMemPct + (62 - this.gpuMemPct) * 0.05 + (Math.random() - 0.5) * 2, 12, 95);
    this.gpuUtil = clamp(this.gpuUtil + (72 + Math.sin(this.tick / 6) * 12 - this.gpuUtil) * 0.2 + (Math.random() - 0.5) * 7, 2, 99);
    this.temp = clamp(this.temp + (58 + this.gpuUtil * 0.12 - this.temp) * 0.1 + (Math.random() - 0.5) * 1.5, 32, 89);

    const memoryTotalMb = 262144;
    const diskTotalGb = 2048;
    const gpus: GpuMetric[] = [
      {
        index: 0,
        name: 'NVIDIA A100 80GB PCIe',
        memoryUsedMb: (81920 * this.gpuMemPct) / 100,
        memoryTotalMb: 81920,
        utilization: this.gpuUtil,
        temperatureC: this.temp,
      },
      {
        index: 1,
        name: 'NVIDIA RTX 4090',
        memoryUsedMb: (24564 * clamp(this.gpuMemPct - 18 + Math.sin(this.tick / 13) * 8, 5, 98)) / 100,
        memoryTotalMb: 24564,
        utilization: clamp(this.gpuUtil - 22, 0, 99),
        temperatureC: clamp(this.temp - 9, 30, 85),
      },
    ];

    const processes: ProcessMetric[] = PROCESS_NAMES.map((name, i) => ({
      pid: 12000 + i * 137,
      name,
      cpu: clamp(this.cpu * (0.42 - i * 0.06) + (Math.random() - 0.5) * 6, 0.2, 99),
      memoryMb: Math.round(2048 + (5 - i) * 940 + (Math.random() - 0.5) * 300),
      gpuMemoryMb: i < 2 ? Math.round(gpus[0].memoryUsedMb * (i === 0 ? 0.52 : 0.28)) : 0,
      gpuIndex: i < 2 ? 0 : i === 3 ? 1 : undefined,
    }));

    const gpuProcesses: GpuProcessMetric[] = [
      {
        gpuIndex: 0, pid: 12000, name: 'python train.py', fullName: '/home/ubuntu/train.py',
        kind: 'compute', usedMemoryMb: Math.round(gpus[0].memoryUsedMb * 0.52), memoryKnown: true,
      },
      {
        gpuIndex: 0, pid: 12137, name: 'torch_worker / 0', fullName: '/opt/venv/bin/python',
        kind: 'compute', usedMemoryMb: Math.round(gpus[0].memoryUsedMb * 0.28), memoryKnown: true,
      },
      {
        gpuIndex: 0, pid: 12274, name: 'torch_worker / 1', fullName: '/opt/venv/bin/python',
        kind: 'compute', usedMemoryMb: Math.round(gpus[0].memoryUsedMb * 0.11), memoryKnown: true,
      },
      {
        gpuIndex: 1, pid: 12411, name: 'blender', fullName: '/usr/bin/blender',
        kind: 'both', usedMemoryMb: Math.round(gpus[1].memoryUsedMb * 0.46), memoryKnown: true,
      },
      {
        gpuIndex: 1, pid: 12548, name: 'Xorg', fullName: '/usr/lib/xorg/Xorg',
        kind: 'graphics', usedMemoryMb: Math.round(gpus[1].memoryUsedMb * 0.17), memoryKnown: true,
      },
    ];

    return {
      timestamp: Date.now(),
      host,
      cpu: this.cpu,
      cpuPerCore: Array.from({ length: 8 }, (_, i) =>
        clamp(this.cpu + Math.sin(this.tick / 5 + i) * 14 + (Math.random() - 0.5) * 10, 1, 100),
      ),
      memoryUsedMb: (memoryTotalMb * this.memPct) / 100,
      memoryTotalMb,
      diskUsedGb: 812 + Math.sin(this.tick / 30) * 6,
      diskTotalGb,
      diskReadMbps: 40 + Math.random() * 60,
      diskWriteMbps: 18 + Math.random() * 40,
      netRxMbps: 120 + Math.random() * 180,
      netTxMbps: 30 + Math.random() * 90,
      gpus,
      processes,
      gpuProcesses,
      uptimeSeconds: 86400 * 12 + this.tick * 2,
    };
  }
}

/**
 * 解析 nvidia-smi --query-gpu=index,name,memory.used,memory.total,utilization.gpu,temperature.gpu
 * --format=csv,noheader,nounits 的输出。本机与 SSH 远程采集共用这一份解析。
 */
export function parseGpuQuery(text: string): GpuMetric[] {
  const gpus: GpuMetric[] = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    const row = line.trim();
    if (!row) {
      continue;
    }
    const parts = row.split(',').map((s) => s.trim());
    if (parts.length < 6) {
      continue;
    }
    const num = (v: string): number => {
      const n = Number(v.replace(/[^0-9.\-]/g, ''));
      return Number.isFinite(n) ? n : 0;
    };
    gpus.push({
      index: num(parts[0]),
      name: parts.slice(1, parts.length - 4).join(', ') || 'NVIDIA GPU',
      memoryUsedMb: num(parts[parts.length - 4]),
      memoryTotalMb: num(parts[parts.length - 3]),
      utilization: num(parts[parts.length - 2]),
      temperatureC: num(parts[parts.length - 1]),
    });
  }
  return gpus;
}

export function toHistoryPoint(s: MetricsSnapshot): HistoryPoint {
  const gpu = s.gpus[0];
  return {
    t: s.timestamp,
    cpu: s.cpu,
    memory: s.memoryTotalMb ? (s.memoryUsedMb / s.memoryTotalMb) * 100 : 0,
    gpuMemory: gpu && gpu.memoryTotalMb ? (gpu.memoryUsedMb / gpu.memoryTotalMb) * 100 : 0,
    gpuUtil: gpu ? gpu.utilization : 0,
  };
}
