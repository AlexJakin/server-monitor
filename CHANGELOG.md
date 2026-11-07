# Change Log

## [0.6.0] - 2026-11-07

- **7 套显示风格**：`classic` / `minimal` / `professional` / `gentle` / `nature` / `tech` / `neon-retro`。仪表盘右上角新增即时切换下拉框，并新增 `Server Monitor: 切换显示风格` 命令与 `serverMonitor.theme` 配置；三者写入同一份全局配置，改动后无需重载面板。
- 样式层重构为完整 CSS 变量体系：散落在样式表与 4 张指标卡内联样式里的硬编码颜色全部改为 `--soft-*` / `--brand-*` 等主题变量；新增形状令牌（圆角、内边距、字号、字体、卡片顶条高度）与特效令牌（网格层、扫描线、透视地平线、发光），换肤不再只是换色，也能改变密度与气质。
- `classic` / `minimal` / `professional` / `gentle` / `nature` 保留 IDE 明暗自适应；`tech` / `neon-retro` 为固定深色。`neon-retro` 含粉紫渐变、CRT 扫描线、透视地平线网格、常驻色差切片与每 7 秒一次的标题故障抖动，遵循 `prefers-reduced-motion`。
- Webview 首帧由 `DashboardPanel.buildHtml()` 注入 `data-theme`，避免先闪一下经典配色；后续通过 `DashboardPayload.theme` 同步下拉框。独立浏览器预览支持 `?theme=` / `?scheme=` 与 localStorage 记忆。
- 新增 `media/theme-gallery.html` 主题总览页（8 张并排 iframe 预览，含经典浅色）与 `media/screenshots/theme-*.png` 渲染截图；总览页通过 `.vscodeignore` 排除，不进 vsix。
- `显示宿主环境信息` 增加 `display theme` 输出；`media/dashboard.html` 仍是 CSS/JS 全内联、零 CDN、零新增 npm 依赖。
- 验证：`npm run typecheck` / `npm test` / `npm run package` 通过；7 套主题与经典浅色均由无头 Chrome 实际渲染截图核对，无布局错乱。

## [0.5.0] - 2026-11-06

- **每张显卡的运行进程明细**：新增按物理卡分组的卡片，显示型号、显存占用条、利用率、进程数，并逐条列出进程名、PID、类型（计算 / 图形 / 计算+图形）、显存与占整卡比例；空卡与超出 6 条的剩余数量都有明确提示。
- 新增 `src/gpuProcesses.ts`：`--query-gpu=index,uuid` 做 uuid→卡号映射，解析 `--query-compute-apps=gpu_uuid,pid,used_memory,process_name` 与可选的 `--query-graphics-apps`，同一 PID 同时属于两类时合并，进程名含逗号、Windows 完整路径、`[N/A]` 显存均做容错；老驱动不支持 `gpu_uuid` 时退回不带 uuid 的查询格式。
- 远程采集脚本新增 `@@SM:GPUMAP@@` / `@@SM:GPUAPPS@@` / `@@SM:GPUGRAPH@@` 三段，仍保持无引号、无换行的 Windows OpenSSH 安全约束；`@@SM:GPUPS@@` 增加 `process_name` 列并兼作兜底。
- `MetricsSnapshot` 新增可选 `gpuProcesses`，`ProcessMetric` 新增可选 `gpuIndex`；SSH / 本机 / 演示三个数据源全部补齐，本机采集隔次刷新（约 4 秒）以控制 nvidia-smi 调用频率。
- 进程排行新增「GPU」列与「按 CPU / 按显存」排序切换；`显示宿主环境信息` 增加 `gpu processes` 计数；页脚关于 Windows WDDM 的口径改为「进程名单可见、显存不可读」。
- **诚实标注驱动限制**：Windows WDDM 的 `used_memory` 返回 `[N/A]`，界面显示「—」并说明原因，不用 0 冒充；Linux / SSH 场景可正常显示每个进程的显存。
- 验证：`npm test` 扩到 19 组全部通过（新增 6 组 GPU 归属解析、1 组老驱动兜底、完整远端样本加断言）；远程脚本 `sh -n` 语法校验 + 本机 sh 端到端实跑通过（39 个进程全部归属 GPU 0）；本机真实采集回归拿到 RTX 3070 上 40 个 GPU 进程。

## [0.4.0] - 2026-11-05

- **SSH 远程 Linux 采集**：新增 `src/sshProbe.ts`（一条 ssh 连接内完成全部采集的 POSIX 脚本 + 分段解析）、`src/sshSource.ts`（系统 OpenSSH 子进程、后台刷新缓存、超时与错误提示、切换时终止在途进程）、`src/sshConfig.ts`（读 `~/.ssh/config` 别名 + 从集成终端进程树识别 ssh 目标）。
- `serverMonitor.dataSource` 增加 `ssh`；新增 `连接远程服务器（SSH）`、`跟随当前终端的 SSH 会话` 两条命令，以及 `sshHost` / `sshArgs` / `sshTimeoutMs` / `sshAutoDetect` 四项配置。
- **自动跟随终端 SSH 会话**：默认开启，通过 `Terminal.processId` + 系统进程表识别集成终端里的 `ssh user@host`，自动把面板切到该服务器（低频轮询捕捉登录后输入的情况）。手动选过 local/demo 后不再自动抢回数据源。
- **服务器配置详情**卡片：连接目标、主机名、操作系统、内核、架构、CPU 型号与核数、内存/磁盘容量、GPU 型号、运行时长、采集状态；SSH 模式徽标显示目标主机，连接失败显示醒目横幅与中文排查建议。
- 凭据只用本地 SSH 配置：`BatchMode=yes` + `NumberOfPasswordPrompts=0`，插件从不接收或保存密码，也不引入 `ssh2` 等带原生依赖的 npm 包，Trae CN 兼容性不变。
- 新增 `npm test`（`test/metrics.test.js`）：Linux `/proc` 解析、远程采集脚本、模拟远端完整输出、缺省容错、ssh 目标解析、错误提示、Windows 本机实测回归，共 13 组全部通过；远程脚本另用 POSIX `sh -n` 校验语法并在本机 sh 端到端实跑一次。
- 边界：SSH 模式的 Linux 采集属于「解析与脚本已验证、远端真机端到端待确认」；本机 WSL 被安全策略禁用且无发行版，也没有可连接的远程服务器。

## [0.3.0] - 2026-11-05

- 新增 `src/linuxMetrics.ts`：Linux 本机采集。`/proc/meminfo`（MemAvailable）、`/proc/diskstats` + `/proc/net/dev` 两次差分算吞吐、`df -kP /`、`ps -eo`、`nvidia-smi --query-compute-apps`（Linux 下可拿到**进程级显存**）；全部 Node 内置模块，不装 agent。
- `src/localSource.ts` 按 `os.platform()` 分派 Windows / Linux 采集；CPU 仍用 `os.cpus()` 差分（跨平台），Linux 内存改用 MemAvailable 口径。
- `DashboardPayload` 增加 `platform`，界面页脚按平台显示对应采集口径；`显示宿主环境信息` 增加 `platform` / `release` 输出。
- `package.json` 声明 `extensionKind: ["workspace", "ui"]`，便于 VS Code Remote-SSH 场景下扩展优先在远端运行，从而采到远端 Linux 数据。
- 验证：Linux 解析逻辑 6 组模拟 `/proc` 样本单测通过；Windows 分支回归实测通过（RTX 3070、6 个真实进程）；typecheck / compile / HTML 校验通过。**未在 Linux 真机实跑**（本机 WSL 被安全策略禁用且无发行版）。
- 边界说明：采集的是「IDE 所在机器」，仍不连接远程服务器；Windows 上的 Trae CN 看远程 Linux 服务器需另接 SSH / 监控 API 采集层。

## [0.2.0] - 2026-11-05

- 新增 `src/localSource.ts`：本机 Windows 真实指标采集，默认启用。CPU/每核用 `os.cpus()` 差分，内存用 `os` 模块，GPU 用 `nvidia-smi`，磁盘/网络/进程用 PowerShell 性能计数器；后台异步刷新 + 快照缓存，`next()` 仍保持同步。
- 数据源可切换：`serverMonitor.dataSource` 支持 `local`（默认）/ `demo`，新增 `Server Monitor: 切换数据源` 命令与面板「数据源」按钮；切换时销毁旧采集实例并清空历史趋势。
- 界面强化数据源标识：绿色「本机实测」/ 橙色「演示数据」徽标，演示模式显示醒目横幅；补齐无 GPU、无进程数据时的兜底提示；CPU 核数改为动态读取。
- `显示宿主环境信息` 命令补充数据源、计算机名、核数、采集状态、GPU 与进程数量，便于确认真伪。
- README 增加「为什么还是演示数据」排查清单、本机采集口径表与已知限制（Windows WDDM 不提供进程级显存）。

## [0.1.0] - 2026-11-05

- 改造为服务器资源监控仪表盘：4 张指标卡、资源趋势折线图、多 GPU 明细、存储/网络、进程 Top 6。
- 界面自适应 VS Code 明暗主题，全部 CSS/JS 内联、零外部依赖；`media/dashboard.html` 可独立在浏览器预览并自动播放演示数据。
- 新增状态栏速览、暂停/继续、立即刷新、采样间隔切换，以及 4 条命令与 4 项配置。
- 采集层抽象为 `MetricsSource` 接口，当时仅实现 `DemoSource`（演示数据）。
- VSIX 输出改为 `server-monitor.vsix`。

## [0.0.1] - 2026-11-05

- 初始骨架：两条示例命令、状态栏入口、编辑器右键菜单、可配置项。
- 按 VS Code 1.80 公开 API 编写，打包后的 `.vsix` 可同时用于 VS Code 与 Trae CN。
