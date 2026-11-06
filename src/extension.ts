import * as os from 'os';
import * as vscode from 'vscode';
import { DashboardPanel, IncomingMessage } from './panel';
import {
  DashboardPayload,
  DemoSource,
  HistoryPoint,
  MetricsSnapshot,
  MetricsSource,
  ServerInfo,
  toHistoryPoint,
} from './metrics';
import { LocalSource } from './localSource';
import { SshSource } from './sshSource';
import { detectSshTarget, readSshConfigHosts } from './sshConfig';

type Mode = 'local' | 'demo' | 'ssh';

interface Settings {
  host: string;
  intervalMs: number;
  historyLength: number;
  dataSource: Mode;
  sshHost: string;
  sshArgs: string;
  sshTimeoutMs: number;
  sshAutoDetect: boolean;
}

interface DataSourcePick extends vscode.QuickPickItem {
  value: Mode;
}

interface HostPick extends vscode.QuickPickItem {
  value: string;
}

const EMPTY_SNAPSHOT: MetricsSnapshot = {
  timestamp: 0,
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

/** ssh 模式但没配主机时的占位源，绝不用演示数据冒充服务器读数。 */
const EMPTY_SOURCE: MetricsSource = {
  next: (host: string): MetricsSnapshot => ({ ...EMPTY_SNAPSHOT, host, timestamp: Date.now() }),
};

let timer: NodeJS.Timeout | undefined;
let pollTimer: NodeJS.Timeout | undefined;
let outputChannel: vscode.OutputChannel | undefined;
let statusBar: vscode.StatusBarItem | undefined;
let paused = false;
let history: HistoryPoint[] = [];
let lastSnapshot: MetricsSnapshot | undefined;
let source: MetricsSource = EMPTY_SOURCE;
let activeKey = '';
let userChoseSource = false;
let detectedTarget = '';
let detecting = false;
let lastDetectAt = 0;

function settings(): Settings {
  const config = vscode.workspace.getConfiguration('serverMonitor');
  const mode = config.get<string>('dataSource', 'local');
  return {
    host: config.get<string>('host', ''),
    intervalMs: Math.max(500, config.get<number>('refreshIntervalMs', 2000)),
    historyLength: Math.max(10, config.get<number>('historyLength', 60)),
    dataSource: mode === 'ssh' || mode === 'demo' ? mode : 'local',
    sshHost: config.get<string>('sshHost', '').trim(),
    sshArgs: config.get<string>('sshArgs', '').trim(),
    sshTimeoutMs: Math.max(3000, config.get<number>('sshTimeoutMs', 12000)),
    sshAutoDetect: config.get<boolean>('sshAutoDetect', true),
  };
}

function remoteName(): string | undefined {
  // 1.80 起公开 API；用结构断言兜住第三方 IDE 的类型差异。
  return (vscode.env as { remoteName?: string }).remoteName || undefined;
}

function displayHost(config: Settings): string {
  if (config.host) {
    return config.host;
  }
  if (config.dataSource === 'ssh') {
    return config.sshHost || '未配置服务器';
  }
  return config.dataSource === 'local' ? os.hostname() : 'gpu-01';
}

/** 数据源键包含 SSH 目标：换服务器时也要重建连接，不能复用旧快照。 */
function ensureSource(config: Settings): void {
  const key = `${config.dataSource}|${config.dataSource === 'ssh' ? config.sshHost : ''}`;
  if (key === activeKey) {
    return;
  }
  activeKey = key;
  source.dispose?.();
  if (config.dataSource === 'ssh') {
    source = config.sshHost
      ? new SshSource({
          target: config.sshHost,
          extraArgs: config.sshArgs ? config.sshArgs.split(/\s+/).filter(Boolean) : [],
          timeoutMs: config.sshTimeoutMs,
          intervalMs: Math.max(1500, config.intervalMs),
        })
      : EMPTY_SOURCE;
  } else if (config.dataSource === 'local') {
    source = new LocalSource();
  } else {
    source = new DemoSource();
  }
  history = [];
}

function buildServerInfo(config: Settings, snapshot: MetricsSnapshot): ServerInfo {
  const remote = remoteName();
  if (config.dataSource === 'ssh') {
    const fromSource = source.serverInfo;
    if (fromSource) {
      return { ...fromSource, remoteName: remote };
    }
    return {
      source: 'ssh',
      target: config.sshHost,
      hostname: '—',
      os: 'Linux',
      kernel: '—',
      arch: '—',
      cpuModel: '—',
      cores: 0,
      uptimeSeconds: 0,
      status: '未连接',
      error: '未配置 SSH 主机：运行「Server Monitor: 连接远程服务器（SSH）」选择或输入目标',
      remoteName: remote,
    };
  }
  if (config.dataSource === 'local') {
    const cpus = os.cpus();
    const platform = os.platform() === 'win32' ? 'Windows' : os.platform() === 'linux' ? 'Linux' : os.platform();
    return {
      source: 'local',
      hostname: os.hostname(),
      os: `${platform} ${os.release()}`,
      kernel: os.release(),
      arch: os.arch(),
      cpuModel: cpus[0]?.model || '未知 CPU',
      cores: cpus.length,
      uptimeSeconds: snapshot.uptimeSeconds || os.uptime(),
      status: source instanceof LocalSource ? source.statusText : '本机采集',
      remoteName: remote,
    };
  }
  return {
    source: 'demo',
    hostname: 'gpu-01',
    os: 'Ubuntu 22.04.4 LTS（示例）',
    kernel: '5.15.0-generic（示例）',
    arch: 'x86_64',
    cpuModel: 'AMD EPYC 7763（示例）',
    cores: snapshot.cpuPerCore.length || 8,
    uptimeSeconds: snapshot.uptimeSeconds,
    status: '演示数据 · 以下配置均为示例，非真实机器',
    remoteName: remote,
  };
}

function updateStatusBar(snapshot: MetricsSnapshot, config: Settings): void {
  if (!statusBar) {
    return;
  }
  const gpu = snapshot.gpus[0];
  const usedGb = gpu ? (gpu.memoryUsedMb / 1024).toFixed(1) : '0.0';
  const totalGb = gpu ? Math.round(gpu.memoryTotalMb / 1024) : 0;
  statusBar.text = `$(pulse) CPU ${snapshot.cpu.toFixed(0)}%   ·   显存 ${usedGb}/${totalGb}G`;

  const sourceLabel =
    config.dataSource === 'ssh'
      ? `SSH 远程：${config.sshHost || '未配置'}`
      : config.dataSource === 'local'
        ? '本机实测（真实读数）'
        : '演示数据（模拟）';
  const tooltip = new vscode.MarkdownString();
  tooltip.appendMarkdown(`**Server Monitor** · \`${displayHost(config)}\`\n\n`);
  tooltip.appendMarkdown(`数据源：**${sourceLabel}**\n\n`);
  tooltip.appendMarkdown(
    `CPU ${snapshot.cpu.toFixed(1)}% · 内存 ${(snapshot.memoryUsedMb / 1024).toFixed(1)} GB · GPU ${gpu ? gpu.utilization.toFixed(0) + '%' : '—'}\n\n`,
  );
  const info = source.serverInfo;
  if (info?.error) {
    tooltip.appendMarkdown(`⚠️ ${info.error}\n\n`);
  }
  if (remoteName()) {
    tooltip.appendMarkdown(`IDE 远程会话：\`${remoteName()}\`（采集发生在远端扩展宿主）\n\n`);
  }
  tooltip.appendMarkdown('点击打开完整监控面板');
  statusBar.tooltip = tooltip;
}

function collectAndPush(): void {
  const config = settings();
  ensureSource(config);
  const host = displayHost(config);
  const snapshot = source.next(host);
  lastSnapshot = snapshot;
  history.push(toHistoryPoint(snapshot));
  if (history.length > config.historyLength) {
    history = history.slice(-config.historyLength);
  }
  updateStatusBar(snapshot, config);

  const payload: DashboardPayload = {
    snapshot,
    history,
    host,
    intervalMs: config.intervalMs,
    dataSource: config.dataSource,
    paused,
    platform: os.platform(),
    serverInfo: buildServerInfo(config, snapshot),
  };
  DashboardPanel.post(payload);
}

function startTimer(): void {
  if (timer) {
    clearInterval(timer);
  }
  timer = setInterval(() => {
    if (!paused) {
      collectAndPush();
    }
  }, settings().intervalMs);
}

async function setConfig(key: string, value: string | number | boolean): Promise<void> {
  await vscode.workspace
    .getConfiguration('serverMonitor')
    .update(key, value, vscode.ConfigurationTarget.Global);
}

/** 选择 SSH 目标：~/.ssh/config 别名 + 手动输入 + 跟随当前终端会话。 */
async function connectSsh(): Promise<boolean> {
  const current = settings().sshHost;
  const hosts = readSshConfigHosts();
  const picks: HostPick[] = [];
  if (detectedTarget) {
    picks.push({
      label: `$(radio-tower) 当前终端会话：${detectedTarget}`,
      description: '自动识别到的 SSH 目标',
      value: detectedTarget,
    });
  }
  for (const host of hosts) {
    picks.push({
      label: `$(server) ${host}`,
      description: host === current ? '当前配置' : '来自 ~/.ssh/config',
      value: host,
    });
  }
  picks.push(
    { label: '$(terminal) 跟随当前终端的 SSH 会话', description: '读取集成终端进程树中的 ssh 目标', value: '__terminal__' },
    { label: '$(edit) 手动输入 user@host', description: '也可填 ~/.ssh/config 里的别名', value: '__manual__' },
  );

  const pick = await vscode.window.showQuickPick(picks, {
    placeHolder: current ? `当前 SSH 目标：${current}` : '选择要监控的 Linux 服务器',
  });
  if (!pick) {
    return false;
  }

  let target = pick.value;
  if (target === '__terminal__') {
    const found = await detectNow();
    if (!found) {
      void vscode.window.showInformationMessage(
        'Server Monitor：当前终端未检测到 ssh 会话，请手动输入目标或先用 ssh 登录。',
      );
      return false;
    }
    target = found;
  } else if (target === '__manual__') {
    const typed = await vscode.window.showInputBox({
      prompt: '输入 SSH 目标（user@host 或 ~/.ssh/config 别名）',
      placeHolder: '例如 ubuntu@192.168.1.10 或 gpu-server',
      value: current,
      ignoreFocusOut: true,
    });
    if (!typed || !typed.trim()) {
      return false;
    }
    target = typed.trim();
  }

  userChoseSource = true;
  detectedTarget = target;
  await setConfig('sshHost', target);
  await setConfig('dataSource', 'ssh');
  startTimer();
  collectAndPush();
  outputChannel?.appendLine(`SSH 目标已设为 ${target}`);
  return true;
}

async function chooseDataSource(): Promise<void> {
  const current = settings();
  const picks: DataSourcePick[] = [
    {
      label: '$(cloud) SSH 远程 Linux 服务器',
      description: current.sshHost ? `当前：${current.sshHost}` : '选择或输入服务器地址，用系统 OpenSSH 采集',
      value: 'ssh',
    },
    {
      label: '$(pulse) 本机实测',
      description: '读取 IDE 所在机器的 CPU / 内存 / GPU / 磁盘 / 进程',
      value: 'local',
    },
    {
      label: '$(eye) 演示数据',
      description: '模拟生成的假指标，仅用于预览界面',
      value: 'demo',
    },
  ];
  const pick = await vscode.window.showQuickPick(picks, {
    placeHolder: `当前数据源：${current.dataSource === 'ssh' ? `SSH · ${current.sshHost}` : current.dataSource === 'local' ? '本机实测' : '演示数据'}`,
  });
  if (!pick) {
    return;
  }
  userChoseSource = true;
  if (pick.value === 'ssh' && !current.sshHost) {
    const ok = await connectSsh();
    if (!ok) {
      return;
    }
  } else {
    await setConfig('dataSource', pick.value);
    startTimer();
    collectAndPush();
  }
}

/** 立即检测一次终端进程树里的 ssh 目标。 */
async function detectNow(): Promise<string | undefined> {
  const terminal = vscode.window.activeTerminal;
  if (!terminal) {
    return undefined;
  }
  let pid: number | undefined;
  try {
    pid = await terminal.processId;
  } catch {
    return undefined;
  }
  if (!pid) {
    return undefined;
  }
  const target = await detectSshTarget(pid);
  if (target) {
    detectedTarget = target;
  }
  return target;
}

/**
 * 自动跟随：用户在集成终端里 ssh 登录后，把面板切到那台服务器。
 * 1.80 公开 API 读不到终端输入，因此通过 Terminal.processId + 系统进程表识别。
 * 用户手动选过 local/demo 后不再自动抢回数据源；已是 ssh 时仍跟随目标变化。
 */
async function autoDetect(): Promise<void> {
  const config = settings();
  if (!config.sshAutoDetect || detecting) {
    return;
  }
  detecting = true;
  try {
    const target = await detectNow();
    if (!target || target === detectedTarget) {
      return;
    }
    detectedTarget = target;
    const allowSwitch = !userChoseSource || config.dataSource === 'ssh';
    if (!allowSwitch) {
      return;
    }
    if (config.dataSource === 'ssh' && config.sshHost === target) {
      return;
    }
    await setConfig('sshHost', target);
    await setConfig('dataSource', 'ssh');
    startTimer();
    collectAndPush();
    outputChannel?.appendLine(`检测到终端 SSH 会话 ${target}，已自动切换数据源`);
    void vscode.window.showInformationMessage(
      `Server Monitor：检测到 SSH 会话 ${target}，面板已切换到该服务器的数据`,
    );
  } finally {
    detecting = false;
  }
}

function scheduleDetect(): void {
  const now = Date.now();
  if (now - lastDetectAt < 6000) {
    return;
  }
  lastDetectAt = now;
  setTimeout(() => void autoDetect(), 1200);
}

/** 只使用 VS Code 1.80 起就存在的公开 API，同一份 .vsix 可运行在 VS Code 与 Trae CN。 */
export function activate(context: vscode.ExtensionContext): void {
  const channel = vscode.window.createOutputChannel('Server Monitor');
  outputChannel = channel;
  context.subscriptions.push(channel);

  statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusBar.command = 'serverMonitor.openDashboard';
  statusBar.text = '$(pulse) Server Monitor';
  statusBar.tooltip = '点击打开服务器监控面板';
  statusBar.show();
  context.subscriptions.push(statusBar);

  const handleMessage = (message: IncomingMessage): void => {
    switch (message.type) {
      case 'ready':
      case 'refresh':
        collectAndPush();
        break;
      case 'togglePause':
        paused = !paused;
        collectAndPush();
        break;
      case 'setInterval':
        if (typeof message.value === 'number' && message.value >= 500) {
          void setConfig('refreshIntervalMs', message.value);
        }
        break;
      case 'switchDataSource':
        void chooseDataSource();
        break;
    }
  };

  const openDashboard = vscode.commands.registerCommand('serverMonitor.openDashboard', () => {
    const created = DashboardPanel.show(context.extensionUri, handleMessage);
    if (!created) {
      collectAndPush();
    }
    scheduleDetect();
  });

  const togglePause = vscode.commands.registerCommand('serverMonitor.togglePause', () => {
    paused = !paused;
    collectAndPush();
  });

  const refresh = vscode.commands.registerCommand('serverMonitor.refresh', () => collectAndPush());
  const switchSource = vscode.commands.registerCommand('serverMonitor.switchDataSource', () =>
    chooseDataSource(),
  );
  const connect = vscode.commands.registerCommand('serverMonitor.connectSsh', () => connectSsh());
  const followTerminal = vscode.commands.registerCommand('serverMonitor.followTerminalSsh', async () => {
    const target = await detectNow();
    if (!target) {
      void vscode.window.showInformationMessage('Server Monitor：当前终端未检测到 ssh 会话。');
      return;
    }
    await setConfig('sshHost', target);
    await setConfig('dataSource', 'ssh');
    startTimer();
    collectAndPush();
    void vscode.window.showInformationMessage(`Server Monitor：已跟随 SSH 会话 ${target}`);
  });

  const showEnvironment = vscode.commands.registerCommand('serverMonitor.showEnvironment', () => {
    const config = settings();
    const info = lastSnapshot ? buildServerInfo(config, lastSnapshot) : undefined;
    const lines = [
      '--- 宿主环境 ---',
      `appName:        ${vscode.env.appName}`,
      `vscode.version: ${vscode.version}`,
      `remoteName:     ${remoteName() || '（无，IDE 在本机运行）'}`,
      `extension id:   ${context.extension.id}`,
      '--- 数据源 ---',
      `dataSource:     ${config.dataSource}`,
      `sshHost:        ${config.sshHost || '（未配置）'}`,
      `sshArgs:        ${config.sshArgs || '（无）'}`,
      `autoDetect:     ${config.sshAutoDetect}`,
      `display host:   ${displayHost(config)}`,
      `platform:       ${os.platform()} / ${os.release()}`,
      `local cores:    ${os.cpus().length}`,
      `ssh status:     ${source instanceof SshSource ? source.statusText : '未启用 SSH 采集'}`,
      `local status:   ${source instanceof LocalSource ? source.statusText : '未启用本机采集'}`,
      '--- 服务器配置 ---',
      `hostname:       ${info?.hostname || '—'}`,
      `os:             ${info?.os || '—'}`,
      `kernel:         ${info?.kernel || '—'}`,
      `cpu:            ${info?.cpuModel || '—'} / ${info?.cores || 0} 核`,
      `uptime:         ${info?.uptimeSeconds || 0} s`,
      `gpus detected:  ${lastSnapshot ? lastSnapshot.gpus.length : 0}`,
      `gpu processes:  ${lastSnapshot ? (lastSnapshot.gpuProcesses || []).length : 0}`,
      `processes:      ${lastSnapshot ? lastSnapshot.processes.length : 0}`,
      `last sample:    ${lastSnapshot ? new Date(lastSnapshot.timestamp).toLocaleTimeString() : '尚无数据'}`,
      ...(info?.error ? [`ERROR:          ${info.error}`] : []),
    ];
    for (const line of lines) {
      channel.appendLine(line);
    }
    channel.show(true);
  });

  context.subscriptions.push(
    openDashboard,
    togglePause,
    refresh,
    switchSource,
    connect,
    followTerminal,
    showEnvironment,
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration('serverMonitor')) {
        startTimer();
        collectAndPush();
      }
    }),
    vscode.window.onDidOpenTerminal(() => scheduleDetect()),
    vscode.window.onDidChangeActiveTerminal(() => scheduleDetect()),
  );

  startTimer();
  collectAndPush();
  // 终端里往往是在打开之后才输入 ssh，因此做一次低频轮询来捕捉会话变化。
  pollTimer = setInterval(() => {
    if (settings().sshAutoDetect) {
      void autoDetect();
    }
  }, 15000);
  pollTimer.unref();
  scheduleDetect();
  channel.appendLine(
    `Server Monitor 已激活：${vscode.env.appName} / VS Code API ${vscode.version} / 数据源 ${settings().dataSource}${remoteName() ? ` / 远程会话 ${remoteName()}` : ''}`,
  );
}

export function deactivate(): void {
  if (timer) {
    clearInterval(timer);
    timer = undefined;
  }
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = undefined;
  }
  source.dispose?.();
  outputChannel?.dispose();
  outputChannel = undefined;
}
