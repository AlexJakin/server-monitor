import { MetricsSnapshot, ServerInfo, parseGpuQuery } from './metrics';
import {
  cpuDelta,
  parseComputeApps,
  parseDf,
  parseDiskstats,
  parseMeminfo,
  parseNetDev,
  parseProcStat,
  parsePs,
} from './linuxMetrics';
import { attachGpuIndex, mergeGpuProcesses, parseGpuApps, parseGpuUuidMap } from './gpuProcesses';

/**
 * 一次 SSH 连接内完成全部采集的远端脚本。
 *
 * 约束（很重要）：字符串里刻意不使用单引号、双引号和换行。它作为**单个 argv**
 * 直接交给系统 ssh 客户端，Windows OpenSSH 会自行拼接参数，带引号容易在
 * Windows CRT 转义中变形；所有内容由远端 POSIX shell 解析，因此 $(...)、
 * 管道、重定向都是安全的。
 *
 * 分两段采样 /proc/stat、/proc/diskstats、/proc/net/dev，用 /proc/uptime
 * 的真实时间差做差分，得到 CPU 使用率与磁盘/网络吞吐（避免依赖本地计时）。
 */
export const REMOTE_PROBE: string = [
  'echo @@SM:META@@',
  'echo HOSTNAME=$(hostname)',
  'echo OS=$(grep -m1 ^PRETTY_NAME= /etc/os-release 2>/dev/null | cut -d= -f2-)',
  'echo KERNEL=$(uname -r)',
  'echo ARCH=$(uname -m)',
  'echo CPUMODEL=$(grep -m1 -i ^model.name /proc/cpuinfo 2>/dev/null | cut -d: -f2-)',
  'echo CORES=$(grep -c ^processor /proc/cpuinfo)',
  'echo @@SM:T1@@',
  'cat /proc/uptime',
  'echo @@SM:MEM@@',
  'cat /proc/meminfo',
  'echo @@SM:CPU1@@',
  'grep ^cpu /proc/stat',
  'echo @@SM:IO1@@',
  'cat /proc/diskstats',
  'echo @@SM:NET1@@',
  'cat /proc/net/dev',
  'echo @@SM:STATIC@@',
  'df -kP / 2>/dev/null',
  'echo @@SM:PS@@',
  'ps -eo pid=,comm=,pcpu=,rss= 2>/dev/null | sort -k3 -gr | head -12',
  'echo @@SM:GPU@@',
  'nvidia-smi --query-gpu=index,name,memory.used,memory.total,utilization.gpu,temperature.gpu --format=csv,noheader,nounits 2>/dev/null',
  'echo @@SM:GPUPS@@',
  'nvidia-smi --query-compute-apps=pid,used_memory,process_name --format=csv,noheader,nounits 2>/dev/null',
  'echo @@SM:GPUMAP@@',
  'nvidia-smi --query-gpu=index,uuid --format=csv,noheader,nounits 2>/dev/null',
  'echo @@SM:GPUAPPS@@',
  'nvidia-smi --query-compute-apps=gpu_uuid,pid,used_memory,process_name --format=csv,noheader,nounits 2>/dev/null',
  'echo @@SM:GPUGRAPH@@',
  'nvidia-smi --query-graphics-apps=gpu_uuid,pid,used_memory,process_name --format=csv,noheader,nounits 2>/dev/null',
  'sleep 0.5',
  'echo @@SM:CPU2@@',
  'grep ^cpu /proc/stat',
  'echo @@SM:IO2@@',
  'cat /proc/diskstats',
  'echo @@SM:NET2@@',
  'cat /proc/net/dev',
  'echo @@SM:T2@@',
  'cat /proc/uptime',
  'echo @@SM:END@@',
].join('; ');

const MARKER = /^@@SM:([A-Z0-9]+)@@\s*$/;

/** 按 @@SM:XXX@@ 标记切段；标记之外的行（登录 banner 等）一律忽略。 */
export function splitProbe(text: string): Map<string, string[]> {
  const map = new Map<string, string[]>();
  let current = '';
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.trim();
    const marker = MARKER.exec(line);
    if (marker) {
      current = marker[1];
      map.set(current, []);
      continue;
    }
    if (current && current !== 'END') {
      map.get(current)!.push(raw);
    }
  }
  return map;
}

export type ProbeInfo = Pick<
  ServerInfo,
  'hostname' | 'os' | 'kernel' | 'arch' | 'cpuModel' | 'cores' | 'uptimeSeconds'
>;

export interface ProbeResult {
  metrics: Omit<MetricsSnapshot, 'timestamp' | 'host'>;
  info: ProbeInfo;
}

function section(map: Map<string, string[]>, key: string): string {
  return (map.get(key) || []).join('\n');
}

function uptime(map: Map<string, string[]>, key: string): number {
  const value = Number.parseFloat((map.get(key) || [])[0] || '');
  return Number.isFinite(value) ? value : 0;
}

/** 去掉 /etc/os-release 值两侧的双引号。 */
function unquote(value: string): string {
  return String(value || '')
    .trim()
    .replace(/^["']+/, '')
    .replace(/["']+$/, '')
    .trim();
}

/**
 * 解析远端采集输出。所有字段都允许缺省：无 N 卡、精简容器里没有
 * /proc/diskstats、os-release 缺失等情况都会退化成 0 / 占位文本，不抛异常。
 */
export function parseProbe(text: string): ProbeResult {
  const map = splitProbe(text);
  if (!map.has('META')) {
    throw new Error('未收到采集标记，远端 shell 可能不兼容或登录 banner 干扰了输出');
  }

  const meta: Record<string, string> = {};
  for (const line of map.get('META') || []) {
    const idx = line.indexOf('=');
    if (idx > 0) {
      meta[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
    }
  }

  const t1 = uptime(map, 'T1');
  const t2 = uptime(map, 'T2');
  const dt = t2 > t1 ? t2 - t1 : 0.5;

  const cpu = cpuDelta(parseProcStat(section(map, 'CPU1')), parseProcStat(section(map, 'CPU2')));
  const mem = parseMeminfo(section(map, 'MEM'));
  const disk1 = parseDiskstats(section(map, 'IO1'));
  const disk2 = parseDiskstats(section(map, 'IO2'));
  const net1 = parseNetDev(section(map, 'NET1'));
  const net2 = parseNetDev(section(map, 'NET2'));
  const capacity = parseDf(section(map, 'STATIC'));
  const gpus = parseGpuQuery(section(map, 'GPU'));
  const gpuIndexes = gpus.map((g) => g.index);
  const uuidMap = parseGpuUuidMap(section(map, 'GPUMAP'));
  // 带 uuid 的详细查询优先；老驱动不支持 gpu_uuid 字段时整段为空，退回 GPUPS 段。
  const appsText = section(map, 'GPUAPPS').trim() || section(map, 'GPUPS');
  const gpuProcesses = mergeGpuProcesses([
    parseGpuApps(appsText, uuidMap, 'compute', gpuIndexes),
    parseGpuApps(section(map, 'GPUGRAPH'), uuidMap, 'graphics', gpuIndexes),
  ]);
  const processes = attachGpuIndex(
    parsePs(section(map, 'PS'), parseComputeApps(section(map, 'GPUPS'))),
    gpuProcesses,
  );

  const cores = Number.parseInt(meta.CORES || '', 10) || cpu.cpuPerCore.length;
  const cpuPerCore = cpu.cpuPerCore.length ? cpu.cpuPerCore : Array.from({ length: cores }, () => 0);
  const rate = (delta: number): number => (Math.max(0, delta) / dt) * 8 / 1e6;

  return {
    metrics: {
      cpu: cpu.cpu,
      cpuPerCore,
      memoryUsedMb: mem.usedMb,
      memoryTotalMb: mem.totalMb,
      diskUsedGb: capacity.usedGb,
      diskTotalGb: capacity.totalGb,
      // 界面按 Mbps / 8 还原成 MB/s。
      diskReadMbps: rate(disk2.read - disk1.read),
      diskWriteMbps: rate(disk2.write - disk1.write),
      netRxMbps: rate(net2.rx - net1.rx),
      netTxMbps: rate(net2.tx - net1.tx),
      gpus,
      processes,
      gpuProcesses,
      uptimeSeconds: t2 || t1,
    },
    info: {
      hostname: unquote(meta.HOSTNAME) || 'unknown',
      os: unquote(meta.OS) || 'Linux',
      kernel: unquote(meta.KERNEL) || '—',
      arch: unquote(meta.ARCH) || '—',
      cpuModel: unquote(meta.CPUMODEL) || '未知 CPU',
      cores,
      uptimeSeconds: t2 || t1,
    },
  };
}
