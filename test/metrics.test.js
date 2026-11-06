/* 纯 Node 回归测试：先 npm run compile，再 node test/metrics.test.js */
const assert = require('assert');
const os = require('os');
const lm = require('../out/linuxMetrics.js');
const probe = require('../out/sshProbe.js');
const cfg = require('../out/sshConfig.js');
const ssh = require('../out/sshSource.js');
const gp = require('../out/gpuProcesses.js');
const { LocalSource } = require('../out/localSource.js');

function group(name, fn) {
  fn();
  console.log('  PASS  ' + name);
}

console.log('Linux /proc parsers');
group('meminfo (MemAvailable + fallback)', () => {
  const a = lm.parseMeminfo('MemTotal:       16384000 kB\nMemFree:         2048000 kB\nBuffers:          512000 kB\nCached:          4096000 kB\nMemAvailable:    8192000 kB\n');
  assert(Math.abs(a.totalMb - 16000) < 0.01);
  assert(Math.abs(a.usedMb - 8000) < 0.01);
  const b = lm.parseMeminfo('MemTotal: 1024000 kB\nMemFree: 102400 kB\nBuffers: 102400 kB\nCached: 204800 kB\n');
  assert(Math.abs(b.usedMb - 600) < 0.01);
});
group('diskstats ignores partitions / loop devices', () => {
  const d = lm.parseDiskstats('   8 0 sda 100 0 1000 50 20 0 200 10 0 0 0\n   8 1 sda1 10 0 99999 0 0 0 99999 0 0 0 0\n   7 0 loop0 0 0 88888 0 0 0 88888 0 0 0 0\n 259 0 nvme0n1 5 0 500 1 2 0 300 1 0 0 0\n');
  assert.strictEqual(d.read, 1500 * 512);
  assert.strictEqual(d.write, 500 * 512);
});
group('netdev skips lo and uses tx index 8', () => {
  const n = lm.parseNetDev('Inter-| Receive | Transmit\n face |bytes packets |bytes packets\n  lo: 999999 0 0 0 0 0 0 0 999999 0 0 0 0 0 0 0 0\neth0: 1000 0 0 0 0 0 0 0 500 0 0 0 0 0 0 0 0\nwlan0: 2000 0 0 0 0 0 0 0 700 0 0 0 0 0 0 0 0\n');
  assert.strictEqual(n.rx, 3000);
  assert.strictEqual(n.tx, 1200);
});
group('df -kP /', () => {
  const d = lm.parseDf('Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/sda1 209715200 52428800 157286400 25% /\n');
  assert(Math.abs(d.totalGb - 200) < 0.01);
  assert(Math.abs(d.usedGb - 50) < 0.01);
});
group('compute-apps N/A tolerance + ps sorting / gpu memory', () => {
  const g = lm.parseComputeApps('1234, 2048\n5678, 1024\n9999, [N/A]\n');
  assert.strictEqual(g.get(1234), 2048);
  assert.strictEqual(g.get(5678), 1024);
  assert.strictEqual(g.get(9999), undefined);
  const p = lm.parsePs('  1234 python  85.3  4194304\n  5678 bash  1.2  20480\n  9999 node  12.0  102400\n', g);
  assert.strictEqual(p[0].pid, 1234);
  assert.strictEqual(p[1].pid, 9999);
  assert.strictEqual(p[0].gpuMemoryMb, 2048);
  assert.strictEqual(p[0].memoryMb, 4096);
});
group('/proc/stat delta (total + per-core)', () => {
  const s1 = lm.parseProcStat('cpu  1000 0 500 8000 100 0 0 0 0 0\ncpu0 500 0 250 4000 50 0 0 0 0 0\ncpu1 500 0 250 4000 50 0 0 0 0 0\n');
  const s2 = lm.parseProcStat('cpu  1300 0 600 8100 100 0 0 0 0 0\ncpu0 650 0 300 4050 50 0 0 0 0 0\ncpu1 650 0 300 4050 50 0 0 0 0 0\n');
  assert.strictEqual(s1.cores.length, 2);
  const d = lm.cpuDelta(s1, s2);
  assert(Math.abs(d.cpu - 80) < 0.001);
  assert.deepStrictEqual(d.cpuPerCore, [80, 80]);
});

console.log('GPU process attribution');
group('uuid -> gpu index map', () => {
  const m = gp.parseGpuUuidMap('0, GPU-aaaa-1111\n1, GPU-bbbb-2222\n2, [N/A]\n');
  assert.strictEqual(m.get('gpu-aaaa-1111'), 0);
  assert.strictEqual(m.get('gpu-bbbb-2222'), 1);
  assert.strictEqual(m.size, 2);
});
group('shortProcessName handles Windows paths and driver placeholders', () => {
  assert.strictEqual(gp.shortProcessName('C:\\Program Files\\NVIDIA\\python.exe'), 'python.exe');
  assert.strictEqual(gp.shortProcessName('/usr/bin/python3'), 'python3');
  assert.strictEqual(gp.shortProcessName('[Insufficient Permissions]'), '[Insufficient Permissions]');
});
group('parseGpuApps maps uuid, keeps comma in name, tolerates [N/A] memory', () => {
  const map = gp.parseGpuUuidMap('0, GPU-aaaa\n1, GPU-bbbb\n');
  const rows = gp.parseGpuApps(
    'GPU-aaaa, 1234, 20480, /usr/bin/python3\nGPU-aaaa, 5678, 4096, torch, worker\nGPU-bbbb, 9999, [N/A], blender\n',
    map, 'compute', [0, 1],
  );
  assert.strictEqual(rows.length, 3);
  assert.strictEqual(rows[0].gpuIndex, 0);
  assert.strictEqual(rows[0].usedMemoryMb, 20480);
  assert.strictEqual(rows[0].memoryKnown, true);
  assert.strictEqual(rows[0].name, 'python3');
  assert.strictEqual(rows[1].name, 'torch, worker', 'process_name containing a comma');
  assert.strictEqual(rows[2].gpuIndex, 1);
  assert.strictEqual(rows[2].memoryKnown, false, '[N/A] must not be reported as 0 MB');
  assert.strictEqual(rows[2].usedMemoryMb, 0);
});
group('legacy 2/3-column format and single-GPU fallback', () => {
  const three = gp.parseGpuApps('1234, 2048, python\n', new Map(), 'compute', [0]);
  assert.strictEqual(three[0].gpuIndex, 0);
  assert.strictEqual(three[0].usedMemoryMb, 2048);
  assert.strictEqual(three[0].name, 'python');
  const two = gp.parseGpuApps('1234, 2048\n', new Map(), 'compute', [0]);
  assert.strictEqual(two[0].name, '[unknown]');
  const multi = gp.parseGpuApps('1234, 2048, python\n', new Map(), 'compute', [0, 1]);
  assert.strictEqual(multi[0].gpuIndex, -1, 'cannot attribute without uuid on multi-GPU');
});
group('mergeGpuProcesses dedupes compute+graphics and keeps max memory', () => {
  const compute = gp.parseGpuApps('GPU-a, 9999, [N/A], blender\n', gp.parseGpuUuidMap('1, GPU-a\n'), 'compute', [1]);
  const graphics = gp.parseGpuApps('GPU-a, 9999, 1024, blender\n', gp.parseGpuUuidMap('1, GPU-a\n'), 'graphics', [1]);
  const merged = gp.mergeGpuProcesses([compute, graphics]);
  assert.strictEqual(merged.length, 1);
  assert.strictEqual(merged[0].kind, 'both');
  assert.strictEqual(merged[0].usedMemoryMb, 1024);
  assert.strictEqual(merged[0].memoryKnown, true);
});
group('attachGpuIndex annotates the CPU process ranking', () => {
  const procs = [{ pid: 1234, name: 'python', cpu: 80, memoryMb: 4096, gpuMemoryMb: 20480 }];
  const apps = gp.parseGpuApps('GPU-a, 1234, 20480, python\n', gp.parseGpuUuidMap('0, GPU-a\n'), 'compute', [0]);
  const out = gp.attachGpuIndex(procs, apps);
  assert.strictEqual(out[0].gpuIndex, 0);
  assert.strictEqual(procs[0].gpuIndex, undefined, 'must not mutate the input');
});

console.log('SSH remote probe');
const script = probe.REMOTE_PROBE;
group('remote script is quote-free and single-line (Windows OpenSSH safe)', () => {
  assert(!script.includes('"'));
  assert(!script.includes("'"));
  assert(!script.includes('\n'));
  [
    '/proc/stat', '/proc/meminfo', '/proc/diskstats', '/proc/net/dev', 'nvidia-smi', 'df -kP /', 'ps -eo',
    '@@SM:GPUMAP@@', '@@SM:GPUAPPS@@', '@@SM:GPUGRAPH@@',
    '--query-gpu=index,uuid', '--query-compute-apps=gpu_uuid', '--query-graphics-apps=',
  ].forEach((k) => assert(script.includes(k), 'missing command: ' + k));
});

const SAMPLE = [
  'Warning: Permanently added the RSA host key',
  '@@SM:META@@',
  'HOSTNAME=gpu-node-07',
  'OS="Ubuntu 22.04.4 LTS"',
  'KERNEL=5.15.0-119-generic',
  'ARCH=x86_64',
  'CPUMODEL= AMD EPYC 7763 64-Core Processor',
  'CORES=128',
  '@@SM:T1@@',
  '1000.00 9000.00',
  '@@SM:MEM@@',
  'MemTotal:       528000000 kB',
  'MemFree:        10000000 kB',
  'Buffers:         100000 kB',
  'Cached:        10000000 kB',
  'MemAvailable:   128000000 kB',
  '@@SM:CPU1@@',
  'cpu  1000 0 500 8000 100 0 0 0 0 0',
  'cpu0 500 0 250 4000 50 0 0 0 0 0',
  'cpu1 500 0 250 4000 50 0 0 0 0 0',
  '@@SM:IO1@@',
  '   8 0 sda 100 0 1000 50 20 0 200 10 0 0 0',
  '@@SM:NET1@@',
  '  lo: 999 0 0 0 0 0 0 0 999 0 0 0 0 0 0 0 0',
  'eth0: 10000 0 0 0 0 0 0 0 5000 0 0 0 0 0 0 0 0',
  '@@SM:STATIC@@',
  'Filesystem 1024-blocks Used Available Capacity Mounted on',
  '/dev/sda1 2097152000 524288000 1572864000 25% /',
  '@@SM:PS@@',
  '  1234 python  85.3  4194304',
  '  5678 bash  1.2  20480',
  '@@SM:GPU@@',
  '0, NVIDIA A100 80GB PCIe, 40960, 81920, 55, 62',
  '1, NVIDIA RTX 4090, 2048, 24564, 12, 48',
  '@@SM:GPUPS@@',
  '1234, 20480',
  '9999, [N/A]',
  '@@SM:GPUMAP@@',
  '0, GPU-aaaa-1111',
  '1, GPU-bbbb-2222',
  '@@SM:GPUAPPS@@',
  'GPU-aaaa-1111, 1234, 20480, /usr/bin/python3',
  'GPU-aaaa-1111, 5678, 4096, torch, worker',
  'GPU-bbbb-2222, 9999, [N/A], blender',
  '@@SM:GPUGRAPH@@',
  'GPU-bbbb-2222, 9999, 1024, Xorg',
  '@@SM:CPU2@@',
  'cpu  1300 0 600 8100 100 0 0 0 0 0',
  'cpu0 650 0 300 4050 50 0 0 0 0 0',
  'cpu1 650 0 300 4050 50 0 0 0 0 0',
  '@@SM:IO2@@',
  '   8 0 sda 110 0 2000 60 30 0 500 20 0 0 0',
  '@@SM:NET2@@',
  '  lo: 999 0 0 0 0 0 0 0 999 0 0 0 0 0 0 0 0',
  'eth0: 20000 0 0 0 0 0 0 0 9000 0 0 0 0 0 0 0 0',
  '@@SM:T2@@',
  '1001.00 9000.00',
  '@@SM:END@@',
].join('\n');

group('full remote payload parses into a valid MetricsSnapshot + ServerInfo', () => {
  const r = probe.parseProbe(SAMPLE);
  assert.strictEqual(r.info.hostname, 'gpu-node-07');
  assert.strictEqual(r.info.os, 'Ubuntu 22.04.4 LTS');
  assert.strictEqual(r.info.cores, 128);
  assert.strictEqual(r.info.cpuModel, 'AMD EPYC 7763 64-Core Processor');
  assert.strictEqual(r.info.uptimeSeconds, 1001);
  assert(Math.abs(r.metrics.cpu - 80) < 0.001);
  assert.deepStrictEqual(r.metrics.cpuPerCore, [80, 80]);
  assert(Math.abs(r.metrics.memoryTotalMb - 515625) < 0.01);
  assert(Math.abs(r.metrics.memoryUsedMb - 390625) < 0.01);
  assert(Math.abs(r.metrics.diskUsedGb - 500) < 0.01);
  assert(Math.abs(r.metrics.diskTotalGb - 2000) < 0.01);
  assert(Math.abs(r.metrics.diskReadMbps - 4.096) < 0.001);
  assert(Math.abs(r.metrics.netRxMbps - 0.08) < 0.001);
  assert.strictEqual(r.metrics.gpus.length, 2);
  assert.strictEqual(r.metrics.gpus[0].name, 'NVIDIA A100 80GB PCIe');
  assert.strictEqual(r.metrics.gpus[0].memoryUsedMb, 40960);
  assert.strictEqual(r.metrics.processes[0].pid, 1234);
  assert.strictEqual(r.metrics.processes[0].gpuMemoryMb, 20480);
  assert.strictEqual(r.metrics.gpuProcesses.length, 3);
  assert.strictEqual(r.metrics.gpuProcesses[0].gpuIndex, 0);
  assert.strictEqual(r.metrics.gpuProcesses[0].usedMemoryMb, 20480);
  assert.strictEqual(r.metrics.gpuProcesses[0].name, 'python3');
  const merged = r.metrics.gpuProcesses.find((a) => a.pid === 9999);
  assert.strictEqual(merged.kind, 'both');
  assert.strictEqual(merged.usedMemoryMb, 1024);
  assert.strictEqual(merged.gpuIndex, 1);
  assert.strictEqual(r.metrics.processes[0].gpuIndex, 0, 'CPU ranking annotated with GPU index');
});
group('old driver without gpu_uuid falls back to the GPUPS section', () => {
  const legacy = [
    '@@SM:META@@', 'HOSTNAME=old-driver',
    '@@SM:GPU@@', '0, NVIDIA T4, 2048, 16384, 10, 40',
    '@@SM:GPUPS@@', '1234, 2048, python',
    '@@SM:END@@',
  ].join('\n');
  const r = probe.parseProbe(legacy);
  assert.strictEqual(r.metrics.gpuProcesses.length, 1);
  assert.strictEqual(r.metrics.gpuProcesses[0].gpuIndex, 0, 'single GPU is unambiguous');
  assert.strictEqual(r.metrics.gpuProcesses[0].usedMemoryMb, 2048);
});
group('degraded payload and malformed output', () => {
  const m = probe.parseProbe('@@SM:META@@\nHOSTNAME=tiny\n@@SM:END@@\n');
  assert.strictEqual(m.info.os, 'Linux');
  assert.strictEqual(m.info.cpuModel, '未知 CPU');
  assert.strictEqual(m.metrics.cpu, 0);
  assert.deepStrictEqual(m.metrics.gpus, []);
  assert.deepStrictEqual(m.metrics.processes, []);
  assert.deepStrictEqual(m.metrics.gpuProcesses, []);
  assert.throws(() => probe.parseProbe('random login banner'), /未收到采集标记/);
});

console.log('SSH session detection');
group('ssh command-line target extraction', () => {
  assert.strictEqual(cfg.sshTargetFromCommand('C:\\Windows\\System32\\OpenSSH\\ssh.exe -p 2222 ubuntu@10.0.0.5'), 'ubuntu@10.0.0.5');
  assert.strictEqual(cfg.sshTargetFromCommand('ssh -o StrictHostKeyChecking=no gpu-server'), 'gpu-server');
  assert.strictEqual(cfg.sshTargetFromCommand('ssh user@host nvidia-smi'), 'user@host');
  assert.strictEqual(cfg.sshTargetFromCommand('ssh -tt root@node'), 'root@node');
  assert(Array.isArray(cfg.readSshConfigHosts()));
});
group('friendly ssh errors', () => {
  assert(ssh.explainSshError({ stderr: 'Permission denied (publickey).', message: '' }).includes('密钥'));
  assert(ssh.explainSshError({ killed: true, message: '' }).includes('超时'));
  assert(ssh.explainSshError({ stderr: 'Host key verification failed.', message: '' }).includes('known_hosts'));
});

console.log('Local source live regression');
const src = new LocalSource();
setTimeout(() => {
  const s = src.next(os.hostname());
  assert(s.memoryTotalMb > 0, 'memory');
  assert(s.gpus.length > 0, 'nvidia-smi');
  assert(s.processes.length > 0, 'process list');
  assert(s.diskTotalGb > 0, 'disk');
  assert(Array.isArray(s.gpuProcesses) && s.gpuProcesses.length > 0, 'gpu process list');
  console.log('  PASS  real local metrics -> ' + s.gpus[0].name + ' | ' + s.memoryUsedMb.toFixed(0) + '/' + s.memoryTotalMb.toFixed(0) + ' MB | ' + s.processes.length + ' procs | ' + s.gpuProcesses.length + ' gpu procs');
  src.dispose();
  console.log('ALL TESTS PASSED');
}, 3500);
