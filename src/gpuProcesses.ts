import { GpuProcessMetric, ProcessMetric } from './metrics';

export type AppKind = 'compute' | 'graphics' | 'both';

/**
 * GPU 进程明细解析。
 *
 * 数据源统一为 nvidia-smi 的两条查询：
 *   --query-gpu=index,uuid                              → uuid 到物理卡号的映射
 *   --query-compute-apps=gpu_uuid,pid,used_memory,process_name
 *   --query-graphics-apps=...                           → 新驱动才有，失败时静默降级
 *
 * 全部是纯函数，便于用模拟输出做单元测试（本机 WSL 不可用、也没有可连的远程服务器）。
 */

/** `0, GPU-b0d5ce7d-...` → Map<uuid, index>。忽略 `[N/A]` 与表头。 */
export function parseGpuUuidMap(text: string): Map<string, number> {
  const map = new Map<string, number>();
  for (const line of String(text || '').split(/\r?\n/)) {
    const row = line.trim();
    if (!row) {
      continue;
    }
    const parts = row.split(',').map((s) => s.trim());
    if (parts.length < 2) {
      continue;
    }
    const index = Number(parts[0]);
    const uuid = parts[1];
    if (Number.isInteger(index) && index >= 0 && uuid && !/^\[|^N\/A$/i.test(uuid)) {
      map.set(uuid.toLowerCase(), index);
    }
  }
  return map;
}

/**
 * Windows 下 process_name 常是完整路径（C:\...\python.exe），界面只显示文件名，
 * 完整路径保留在 title 里。方括号是驱动的占位文本，原样保留。
 */
export function shortProcessName(raw: string): string {
  const value = String(raw || '').trim();
  if (!value) {
    return 'unknown';
  }
  if (/^\[.*\]$/.test(value)) {
    return value;
  }
  const parts = value.split(/[\\/]/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : value;
}

function parseMemory(raw: string): { mb: number; known: boolean } {
  const value = String(raw || '').trim();
  // [N/A] / [Insufficient Permissions] / 空值都表示驱动不提供，不能当成 0 显存。
  if (!/^\d+(\.\d+)?$/.test(value)) {
    return { mb: 0, known: false };
  }
  return { mb: Number(value), known: true };
}

/**
 * 解析 compute/graphics apps 输出，把每行归属到物理卡号。
 *
 * 兼容两种列格式：
 *   4+ 列：gpu_uuid, pid, used_memory, process_name[, ...]
 *   3  列：pid, used_memory, process_name（老驱动不支持 gpu_uuid 时）
 * process_name 可能含逗号，因此固定取前几列，剩余部分重新拼接。
 */
export function parseGpuApps(
  text: string,
  uuidToIndex: Map<string, number>,
  kind: 'compute' | 'graphics',
  gpuIndexes: number[],
): GpuProcessMetric[] {
  const rows: GpuProcessMetric[] = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    const row = line.trim();
    if (!row || row.startsWith('#')) {
      continue;
    }
    const parts = row.split(',').map((s) => s.trim());
    if (parts.length < 2) {
      continue;
    }

    const hasUuid = !/^\d+$/.test(parts[0]);
    const uuid = hasUuid ? parts[0] : '';
    const pidRaw = hasUuid ? parts[1] : parts[0];
    const memRaw = hasUuid ? parts[2] : parts[1];
    const nameRaw = (hasUuid ? parts.slice(3) : parts.slice(2)).join(', ').trim();

    const pid = Number(pidRaw);
    if (!Number.isInteger(pid) || pid <= 0) {
      continue;
    }

    let gpuIndex = uuid ? uuidToIndex.get(uuid.toLowerCase()) : undefined;
    if (gpuIndex === undefined) {
      // 单卡机器上即便驱动不给 uuid，也能确定归属；多卡时标记 -1（未分配）。
      gpuIndex = gpuIndexes.length === 1 ? gpuIndexes[0] : -1;
    }
    const mem = parseMemory(memRaw);
    const fullName = nameRaw || '[unknown]';
    rows.push({
      gpuIndex,
      pid,
      name: shortProcessName(fullName),
      fullName,
      kind,
      usedMemoryMb: mem.mb,
      memoryKnown: mem.known,
    });
  }
  return rows;
}

/**
 * 合并 compute / graphics 两组：同一张卡上的同一 PID 可能同时属于两类（Windows 常见 C+G）。
 * 显存取较大值，总量加硬上限防止异常驱动刷出上千行拖慢 Webview。
 */
export function mergeGpuProcesses(groups: GpuProcessMetric[][]): GpuProcessMetric[] {
  const merged = new Map<string, GpuProcessMetric>();
  for (const group of groups) {
    for (const item of group) {
      const key = `${item.gpuIndex}:${item.pid}`;
      const prev = merged.get(key);
      if (!prev) {
        merged.set(key, { ...item });
        continue;
      }
      if (prev.kind !== item.kind) {
        prev.kind = 'both';
      }
      if (item.usedMemoryMb > prev.usedMemoryMb) {
        prev.usedMemoryMb = item.usedMemoryMb;
      }
      prev.memoryKnown = prev.memoryKnown || item.memoryKnown;
      if (item.fullName && item.fullName !== '[unknown]' && prev.fullName === '[unknown]') {
        prev.fullName = item.fullName;
        prev.name = item.name;
      }
    }
  }
  return Array.from(merged.values())
    .sort(
      (a, b) =>
        (a.gpuIndex < 0 ? 9999 : a.gpuIndex) - (b.gpuIndex < 0 ? 9999 : b.gpuIndex) ||
        b.usedMemoryMb - a.usedMemoryMb ||
        a.pid - b.pid,
    )
    .slice(0, 200);
}

/**
 * 给进程排行补上「所在 GPU」列：用 PID 反查 GPU 进程明细。
 * Windows WDDM 下列得出进程但显存未知，此时仍会显示 GPU 归属，只是显存列为「—」。
 */
export function attachGpuIndex(processes: ProcessMetric[], apps: GpuProcessMetric[]): ProcessMetric[] {
  if (!apps.length) {
    return processes;
  }
  const byPid = new Map<number, number>();
  for (const app of apps) {
    if (app.gpuIndex >= 0 && !byPid.has(app.pid)) {
      byPid.set(app.pid, app.gpuIndex);
    }
  }
  return processes.map((p) => {
    const gpuIndex = byPid.get(p.pid);
    return gpuIndex === undefined ? p : { ...p, gpuIndex };
  });
}
