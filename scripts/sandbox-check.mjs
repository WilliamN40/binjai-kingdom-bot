/**
 * Checks the live sandbox from inside the bot container: that commands work,
 * and that the walls hold (other groups, the record, the host, private
 * networks, privileges, disk quota).
 *
 *   sudo docker exec -i binjaibot node --input-type=module - <host-private-ip> < scripts/sandbox-check.mjs
 */

import * as fs from 'node:fs';
import * as net from 'node:net';

const SOCKET = process.env.SANDBOX_SOCKET || '/run/sandbox/runner.sock';
const HOST_IP = process.argv[2] || '10.0.0.1';
const A = { group: 'group_900000000001', uid: 29001 };
const B = { group: 'group_900000000002', uid: 29002 };

function call(who, command, extra = {}) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(SOCKET);
    const chunks = [];
    socket.on('connect', () => socket.write(JSON.stringify({ ...who, command, ...extra }) + '\n'));
    socket.on('data', (c) => chunks.push(c));
    socket.on('error', reject);
    socket.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new Error(`the runner sent no reply for: ${command.slice(0, 60)}`));
      }
    });
  });
}

let failures = 0;
function check(name, pass, detail = '') {
  if (!pass) failures++;
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `\n        ${String(detail).trim().split('\n').join('\n        ')}` : ''}`);
}
const out = (r) => `${r.stdout}${r.stderr}`.trim();

// Record folders the way the bot creates them (owner = bot, closed to others).
for (const who of [A, B]) {
  const dir = `/data/groups/${who.group}/transcript`;
  fs.mkdirSync(dir, { recursive: true });
  fs.chmodSync(`/data/groups/${who.group}`, 0o750);
  fs.writeFileSync(`${dir}/2026-01-01.txt`, `record of ${who.group}\n`);
}

try {
  // ── It works ───────────────────────────────────────────────────────
  let r = await call(A, 'id -u; id -g; pwd; echo secretA > private.txt; cat private.txt');
  check('commands run as the group\'s own user, in its workspace', r.code === 0 && /^29001\n29001\n\/work\/group_900000000001\nsecretA/.test(r.stdout), out(r));

  r = await call(A, 'cat "$RECORD/transcript/2026-01-01.txt"');
  check('a group can read its own record', r.code === 0 && r.stdout.includes('record of group_900000000001'), out(r));

  r = await call(A, 'python3 -c "import pandas, matplotlib, openpyxl, docx, pypdf; print(\'py ok\')" && ffmpeg -version | head -1 && pdftotext -v 2>&1 | head -1 && node -v');
  check('python libraries, ffmpeg, pdftotext and node are installed', r.code === 0 && r.stdout.includes('py ok') && /ffmpeg version/.test(r.stdout), out(r));

  r = await call(A, 'curl -sS -m 15 -o /dev/null -w "%{http_code}" https://example.com');
  check('public internet is reachable', r.code === 0 && r.stdout.trim() === '200', out(r));

  r = await call(A, 'pip install -q cowsay 2>&1 | tail -2; python3 -c "import cowsay; print(\'installed\', cowsay.__name__)"', { timeoutMs: 120000 });
  check('pip can install a package into the workspace', r.code === 0 && r.stdout.includes('installed cowsay'), out(r));

  const payload = Buffer.from(Array.from({ length: 5000 }, (_, i) => i % 256));
  await call(A, 'mkdir -p -- "$(dirname -- "$SANDBOX_FILE")" && cat > "$SANDBOX_FILE"', { env: { SANDBOX_FILE: 'inbox/1_test.bin' }, stdin: payload.toString('base64'), stdinBase64: true });
  r = await call(A, 'cat -- "$SANDBOX_FILE"', { env: { SANDBOX_FILE: 'inbox/1_test.bin' }, binary: true });
  check('files survive the trip in and back out unchanged', Buffer.from(r.stdout, 'base64').equals(payload));

  // ── The walls hold ─────────────────────────────────────────────────
  r = await call(B, 'cat /work/group_900000000001/private.txt; ls /work/group_900000000001');
  check('another group cannot read this group\'s workspace', r.code !== 0 && !r.stdout.includes('secretA') && /Permission denied/.test(r.stderr), out(r));

  r = await call(B, 'cat /record/group_900000000001/transcript/2026-01-01.txt; ls /record/group_900000000001');
  check('another group cannot read this group\'s record', r.code !== 0 && !r.stdout.includes('record of') && /Permission denied/.test(r.stderr), out(r));

  r = await call(A, 'echo tampered >> "$RECORD/transcript/2026-01-01.txt"; rm -f "$RECORD/transcript/2026-01-01.txt"; touch "$RECORD/new.txt"; cat "$RECORD/transcript/2026-01-01.txt"');
  check('a group cannot change or delete its own record', r.stdout.trim() === 'record of group_900000000001' && /Permission denied/.test(r.stderr), out(r));

  r = await call(A, 'ls /run/sandbox; echo x | timeout 3 nc -U /run/sandbox/runner.sock 2>&1; node -e "require(\'net\').createConnection(\'/run/sandbox/runner.sock\').on(\'error\',e=>{console.log(\'ERR\',e.code);process.exit(0)}).on(\'connect\',()=>{console.log(\'CONNECTED\');process.exit(0)})"');
  check('commands cannot reach the runner\'s control socket', !r.stdout.includes('CONNECTED') && /EACCES|Permission denied/.test(out(r)), out(r));

  // SANDBOX_CMD is the command text itself, and a GitHub token is put there on purpose when configured.
  r = await call(A, 'cat /proc/1/environ 2>&1 | head -c 200; echo; env | grep -vE "^(SANDBOX_CMD|GH_TOKEN|GITHUB_TOKEN)=" | grep -ciE "telegram|anthropic|claude|oauth|token|secret|key" ');
  check('no secrets are visible (environment, other processes)', /Permission denied/.test(out(r)) && r.stdout.trim().endsWith('0'), out(r));

  r = await call(A, 'touch /etc/x /usr/x 2>&1; echo "uid=$(id -u)"; /usr/sbin/iptables -F OUTPUT 2>&1 | head -2; echo "iptables exit=${PIPESTATUS[0]}"; /usr/sbin/iptables -S OUTPUT 2>&1 | head -1');
  check('system files are read-only and the firewall cannot be changed', /Read-only file system/.test(out(r)) && /iptables exit=[1-9]/.test(r.stdout) && /Permission denied/i.test(out(r)), out(r));

  r = await call(
    A,
    'HEX=$(awk \'$2=="00000000"{print $3; exit}\' /proc/net/route); ' +
      'GW=$(printf "%d.%d.%d.%d" 0x${HEX:6:2} 0x${HEX:4:2} 0x${HEX:2:2} 0x${HEX:0:2}); echo "gateway=$GW"; ' +
      `for target in http://169.254.169.254/opc/v2/instance/ http://$GW:80/ http://$GW:22/ http://${HOST_IP}:80/ http://${HOST_IP}:22/ http://${HOST_IP}:8001/ http://172.17.0.1:80/ http://10.0.0.1/ http://192.168.1.1/; do ` +
      `code=$(curl -s -m 4 -o /dev/null -w "%{http_code}" "$target" 2>/dev/null); echo "$target -> \${code:-000} (exit $?)"; done`,
    { timeoutMs: 90000 },
  );
  const reached = r.stdout.split('\n').filter((line) => line.includes('->') && !/-> 000 /.test(line));
  check('the host, other containers, the local network and cloud metadata are unreachable', /gateway=172\./.test(r.stdout) && reached.length === 0, out(r));

  r = await call(A, 'curl -s -m 6 -o /dev/null -w "%{http_code}" telnet://smtp.gmail.com:587 2>&1; echo " exit=$?"');
  check('outbound mail ports are blocked', !/exit=0/.test(r.stdout), out(r));

  // ── Limits ─────────────────────────────────────────────────────────
  let started = Date.now();
  r = await call(A, 'sleep 300 & echo started');
  check('a command that leaves something running still returns, and the leftover is killed', r.stdout.includes('started') && Date.now() - started < 10_000, `${Date.now() - started} ms`);
  r = await call(A, 'pgrep -u "$(id -u)" sleep | wc -l');
  check('nothing from the previous command is still running', r.stdout.trim() === '0', out(r));

  started = Date.now();
  r = await call(A, 'sleep 60', { timeoutMs: 2000 });
  check('a command past its time limit is stopped', r.timedOut === true && Date.now() - started < 10_000, `${Date.now() - started} ms`);

  r = await call(A, 'dd if=/dev/zero of=toobig bs=1M count=300 2>&1 | tail -1; ls -la toobig | awk "{print \\$5}"');
  check('a single file cannot exceed 200 MB', /File size limit exceeded|File too large/i.test(out(r)) || Number(r.stdout.trim().split('\n').pop()) <= 210 * 1024 * 1024, out(r));

  started = Date.now();
  r = await call(A, 'for i in 1 2 3 4 5 6 7 8 9 10; do dd if=/dev/zero of=fill_$i bs=1M count=180 status=none || exit 9; done; echo "wrote everything"', { timeoutMs: 180000 });
  // The disk takes writes faster than any watcher can poll, so a flood may overshoot once.
  // What must hold is that it cannot keep going: a full workspace can delete but not write.
  const floodMb = Math.round(r.usageBytes / 1048576);
  check('a flood of writes leaves the workspace over quota at most once', r.usageBytes < 3.2 * 1024 ** 3, `stopped by watcher=${r.overQuota}, usage ${floodMb} MB after ${Date.now() - started} ms`);

  r = await call(A, 'dd if=/dev/zero of=more bs=1M count=5 2>&1 | tail -1; echo "size=$(stat -c %s more 2>/dev/null || echo 0)"');
  check('a workspace over its quota cannot write any more', r.writeBlocked === true && /size=0/.test(r.stdout), out(r));

  r = await call(A, 'rm -f fill_* toobig more note.txt; du -sm . | cut -f1');
  check('a workspace over its quota can still delete files', r.code === 0 && Number(r.stdout.trim()) < 100, `usage now ${r.stdout.trim()} MB`);

  r = await call(A, 'echo hello > note.txt && cat note.txt');
  check('after cleaning up it can write again', r.writeBlocked === false && r.stdout.trim() === 'hello', out(r));

  r = await call(A, 'python3 -c "x = bytearray(1) * (3 * 1024**3); print(len(x))" 2>&1 | tail -1; echo "exit=${PIPESTATUS[0]}"', { timeoutMs: 60000 });
  const stillUp = await call(B, 'echo runner alive');
  check('a command that eats all the memory is killed without taking the runner down', /exit=137|Killed|MemoryError/.test(out(r)) && stillUp.stdout.includes('runner alive'), out(r));

  r = await call(A, ':(){ :|:& };: ; sleep 2; echo survived', { timeoutMs: 20000 });
  const alive = await call(B, 'echo other group still works');
  check('a fork bomb in one group does not take the sandbox down', alive.stdout.includes('still works'), out(r).slice(0, 200));
} finally {
  for (const who of [A, B]) {
    await call(who, 'find . -mindepth 1 -delete').catch(() => {});
    fs.rmSync(`/data/groups/${who.group}`, { recursive: true, force: true });
  }
}

console.log(`\n${failures === 0 ? 'All sandbox checks passed.' : `${failures} sandbox check(s) FAILED.`}`);
process.exit(failures === 0 ? 0 : 1);
