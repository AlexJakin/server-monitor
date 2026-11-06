import { ChildProcess, execFile } from 'child_process';
import { MetricsSnapshot, MetricsSource, ServerInfo } from './metrics';
import { parseProbe, REMOTE_PROBE } from './sshProbe';

export interface SshOptions {
  /** ssh 目标：user@host，或 ~/.ssh/config 里的 Host 别名。 */
  target: string;
  /** 附加 ssh 参数，例如 ['-p', '2222']。 */
  extraArgs?: string[];
  timeoutMs?: number;
  intervalMs?: number;
}

interface ExecError extends Error {
  stderr?: string;
  killed?: boolean;
  code?: string;
}

function runSsh(
  args: string[],
  timeoutMs: number,
  onStart: (child: ChildProcess) => void,
): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const child = execFile(
      'ssh',
      args,
      { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024, windowsHide: true, encoding: 'utf8' },
      (error, stdout, stderr) => {
        if (error) {
          const wrapped = error as ExecError;
          wrapped.stderr = String(stderr || '');
          reject(wrapped);
          return;
        }
        resolve(String(stdout || ''));
      },
    );
    onStart(child);
  });
}

/** 把 ssh 的原始报错翻成可执行的排查建议；绝不回显密码类信息。 */
export function explainSshError(error: unknown): string {
  const err = (error || {}) as ExecError;
  const raw = `${err.stderr || ''} ${err.message || ''}`.trim();
  if (err.killed || /ETIMEDOUT|timed out|TIMEDOUT/i.test(raw)) {
    return 'SSH 采集超时：检查服务器可达性，或调大 serverMonitor.sshTimeoutMs';
  }
  if (/Permission denied|Authentication failed/i.test(raw)) {
    return '认证失败：插件只用密钥登录（BatchMode），请配置 ~/.ssh/config 或 ssh-agent，并确认免密可用';
  }
  if (/Host key verification failed|REMOTE HOST IDENTIFICATION HAS CHANGED/i.test(raw)) {
    return '主机密钥校验失败：请先在终端手动 ssh 一次确认指纹，或检查 known_hosts';
  }
  if (/Could not resolve hostname|Name or service not known|no such host/i.test(raw)) {
    return '无法解析主机名：检查 serverMonitor.sshHost 与 ~/.ssh/config 里的 Host 别名';
  }
  if (/Connection refused|Network is unreachable|No route to host/i.test(raw)) {
    return '连接被拒绝或网络不可达：检查 sshd、端口与防火墙';
  }
  if (/ENOENT|not found|不是内部或外部命令|No such file/i.test(raw)) {
    return '找不到系统 ssh 客户端：请启用 OpenSSH 客户端并确认它在 PATH 中';
  }
  if (/未收到采集标记|采集数据不完整/i.test(raw)) {
    return raw;
  }
  const lines = raw.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  return lines.length ? lines[lines.length - 1].slice(0, 220) : 'SSH 采集失败（无错误信息）';
}

function emptySnapshot(): MetricsSnapshot {
  return {
    timestamp: Date.now(),
    host: '',
    cpu: 0,
    cpuPerCore: [],
    memoryUsedMb: 0,
    memoryTotalMb: 0,
    diskUsedGb: 0,
    diskTotalGb: 0,
    diskReadMbps: 0,
    diskWriteMbps: 0,
    netRxMbps: 0,
    netTxMbps: 0,
    gpus: [],
    processes: [],
    gpuProcesses: [],
    uptimeSeconds: 0,
  };
}

/**
 * 远程 Linux 指标源：用系统 OpenSSH 客户端执行一条采集命令，解析成
 * 与本机源完全相同的 MetricsSnapshot，界面与消息协议无需改动。
 *
 * 凭据完全交给本地 SSH 配置（~/.ssh/config、ssh-agent、默认密钥），
 * BatchMode=yes 保证永远不会弹出密码提示而卡住扩展宿主。
 * 采用「后台异步刷新 + 快照缓存」，next() 保持同步返回。
 */
export class SshSource implements MetricsSource {
  private snapshot: MetricsSnapshot = emptySnapshot();
  private info: ServerInfo;
  private readonly args: string[];
  private readonly timeoutMs: number;
  private readonly timer: NodeJS.Timeout;
  private refreshing = false;
  private disposed = false;
  private failures = 0;
  private successes = 0;
  private activeChild: ChildProcess | undefined;

  constructor(private readonly options: SshOptions) {
    const target = options.target.trim();
    this.timeoutMs = Math.max(3000, options.timeoutMs ?? 12000);
    const extra = (options.extraArgs || []).filter(Boolean);
    this.args = [
      ...extra,
      '-T',
      '-o',
      'BatchMode=yes',
      '-o',
      'NumberOfPasswordPrompts=0',
      '-o',
      'ConnectTimeout=6',
      '-o',
      'ServerAliveInterval=5',
      '-o',
      'ServerAliveCountMax=2',
      '-o',
      'LogLevel=ERROR',
      target,
      REMOTE_PROBE,
    ];
    this.info = {
      source: 'ssh',
      target,
      hostname: target,
      os: 'Linux',
      kernel: '—',
      arch: '—',
      cpuModel: '等待采集…',
      cores: 0,
      uptimeSeconds: 0,
      status: `正在连接 ${target} …`,
    };
    void this.refresh();
    const interval = Math.max(1500, options.intervalMs ?? 2000);
    this.timer = setInterval(() => void this.refresh(), interval);
    this.timer.unref();
  }

  get serverInfo(): ServerInfo {
    return { ...this.info };
  }

  get statusText(): string {
    return this.info.error ? `SSH 异常：${this.info.error}` : this.info.status;
  }

  get okCount(): number {
    return this.successes;
  }

  next(host: string): MetricsSnapshot {
    return { ...this.snapshot, host, timestamp: Date.now() };
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    clearInterval(this.timer);
    // 切换 / 关闭数据源时立即终止在途的 ssh 子进程，避免残留连接。
    this.activeChild?.kill();
    this.activeChild = undefined;
  }

  private async refresh(): Promise<void> {
    if (this.refreshing || this.disposed) {
      return;
    }
    this.refreshing = true;
    const started = Date.now();
    try {
      const stdout = await runSsh(this.args, this.timeoutMs, (child) => {
        this.activeChild = child;
        if (this.disposed) {
          child.kill();
        }
      });
      if (this.disposed) {
        return;
      }
      const result = parseProbe(stdout);
      this.snapshot = { ...result.metrics, host: this.options.target, timestamp: Date.now() };
      this.successes += 1;
      this.failures = 0;
      this.info = {
        ...result.info,
        source: 'ssh',
        target: this.options.target,
        status: `SSH 已连接 · ${this.options.target} · 单次采集 ${Date.now() - started} ms`,
        error: undefined,
      };
    } catch (error) {
      if (this.disposed) {
        return;
      }
      this.failures += 1;
      this.info = {
        ...this.info,
        status: `连续 ${this.failures} 次采集失败${this.successes ? '（沿用上次成功读数）' : ''}`,
        error: explainSshError(error),
      };
    } finally {
      this.activeChild = undefined;
      this.refreshing = false;
    }
  }
}
