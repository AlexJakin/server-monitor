import * as fs from 'fs';
import * as path from 'path';
import { randomBytes } from 'crypto';
import * as vscode from 'vscode';
import { DashboardPayload } from './metrics';

export interface IncomingMessage {
  type: 'ready' | 'togglePause' | 'refresh' | 'setInterval' | 'switchDataSource';
  value?: number;
}

/**
 * 单实例仪表盘面板。HTML 全内联，不加载任何外部脚本或样式，
 * 因此在离线环境、VS Code 与 Trae CN 中表现一致。
 */
export class DashboardPanel {
  private static current: DashboardPanel | undefined;

  private readonly disposables: vscode.Disposable[] = [];

  private constructor(
    private readonly panel: vscode.WebviewPanel,
    private readonly extensionUri: vscode.Uri,
    onMessage: (message: IncomingMessage) => void,
  ) {
    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
    this.panel.webview.onDidReceiveMessage(onMessage, null, this.disposables);
    this.panel.webview.html = this.buildHtml();
  }

  /** 返回是否新建了面板；已存在时只把它切到前台。 */
  static show(
    extensionUri: vscode.Uri,
    onMessage: (message: IncomingMessage) => void,
  ): boolean {
    if (DashboardPanel.current) {
      DashboardPanel.current.panel.reveal(vscode.ViewColumn.One);
      return false;
    }

    const panel = vscode.window.createWebviewPanel(
      'serverMonitor.dashboard',
      'Server Monitor',
      vscode.ViewColumn.One,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'media')],
      },
    );
    DashboardPanel.current = new DashboardPanel(panel, extensionUri, onMessage);
    return true;
  }

  static post(payload: DashboardPayload): void {
    if (DashboardPanel.current) {
      void DashboardPanel.current.panel.webview.postMessage({ type: 'update', payload });
    }
  }

  private buildHtml(): string {
    const file = path.join(this.extensionUri.fsPath, 'media', 'dashboard.html');
    let html = fs.readFileSync(file, 'utf8');
    const nonce = randomBytes(16).toString('hex');

    const csp = [
      "default-src 'none'",
      "style-src 'unsafe-inline'",
      `script-src 'nonce-${nonce}'`,
      "img-src data:",
      "font-src 'none'",
      "connect-src 'none'",
    ].join('; ');

    html = html.replace(
      '<!-- __CSP_META__ -->',
      `<meta http-equiv="Content-Security-Policy" content="${csp}">`,
    );
    html = html.replace(/<script>/g, `<script nonce="${nonce}">`);
    return html;
  }

  private dispose(): void {
    DashboardPanel.current = undefined;
    while (this.disposables.length) {
      const item = this.disposables.pop();
      item?.dispose();
    }
    this.panel.dispose();
  }
}
