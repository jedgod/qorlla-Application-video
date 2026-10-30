#!/usr/bin/env python3
"""Collects the machine and security facts for a PHYSICAL Linux certification of the Qorlla Debian package.

Run it on the test machine AFTER installing the exact .deb and WHILE Qorlla is running (started by the normal user, from the menu or `qorlla`):
    python3 linux-collect-evidence.py --label ubuntu-24.04-a --deb ./qorlla-0.2.0-amd64.deb --expect-sha256 <sha from the CI run> --out evidence-ubuntu-24.04-a.json
    sudo python3 ...        (optional: lets it read which AppArmor profiles the kernel has loaded; without sudo that one field is recorded as unknown)

It writes a JSON file with the facts it can measure and a `results` section where every test starts as NOT_RUN. The tester then sets each test to pass / fail / not_applicable with a note (edit the file, or re-run with --out pointing at the same file: existing results are kept).
Validate the finished file with:  node qorlla-clients/e2e/linux-evidence-check.cjs <file>

Privacy: it NEVER reads or records the host name, user name, IP or MAC addresses, serial numbers, the machine id or home paths. Standard library only (Python 3.8+).
"""
import argparse, hashlib, json, os, platform, re, subprocess, sys, datetime

APP = '/opt/Qorlla/qorlla'
SANDBOX_OFF = re.compile(r'^--(no-sandbox|disable-setuid-sandbox|disable-gpu-sandbox|disable-seccomp-filter-sandbox|disable-namespace-sandbox|disable-renderer-sandbox|disable-sandbox)(=.*)?$', re.I)

TESTS = {
    'T01': 'Install the exact .deb (the SHA-256 recorded here equals the one from the CI run)',
    'T02': 'Start Qorlla as a normal user from the application menu and from the terminal; a window appears and stays up',
    'T03': 'Webcam: Qorlla lists the real camera, the self-view shows live video, and another participant sees it',
    'T04': 'Microphone: another participant hears the person speaking; the level indicator moves',
    'T05': 'Speaker: the person hears another participant; volume changes and device switching work',
    'T06': 'Screen sharing: starting and stopping a share; another participant sees the right screen; Qorlla asks the person to confirm',
    'T07': 'Real Qorlla service: create a meeting, join as a second participant, exchange audio and video, leave, end the meeting (staging services)',
    'T08': 'Reconnect: interrupt the network for about 10 s and restore it; media recovers; record how long it took',
    'T09': 'Direct media: with a normal connection the selected candidate pair type and both-direction counters are recorded',
    'T10': 'Cross-network TURN relay: this machine and a second device on a DIFFERENT network, relay-only policy; the selected pair is relay on both sides and media flows',
    'T11': 'Package upgrade: install the same or a newer .deb over the running installation; the profile stays loaded and Qorlla starts again',
    'T12': 'Uninstall and purge: the application, the launcher entry and the AppArmor profile are gone; the profile is no longer loaded',
    'T13': 'Deep link: opening qorlla://join?meeting=<11 digits> from the browser or terminal opens the pre-join page in the running or a new Qorlla',
    'T14': 'AppArmor and sandbox state recorded: profile loaded and attached to the running process where the host restricts user namespaces; renderers under seccomp',
}

def run(cmd, timeout=10):
    try:
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
        return r.stdout.strip() if r.returncode == 0 else None
    except Exception:
        return None

def read(path):
    try:
        with open(path, 'r', errors='replace') as f:
            return f.read()
    except Exception:
        return None

def field(status, name):
    m = re.search(r'^' + name + r':\s*(.*)$', status or '', re.M)
    return m.group(1).strip() if m else None

def sha256(path):
    h = hashlib.sha256()
    with open(path, 'rb') as f:
        for chunk in iter(lambda: f.read(1 << 20), b''):
            h.update(chunk)
    return h.hexdigest()

def os_release():
    out = {}
    for line in (read('/etc/os-release') or '').splitlines():
        if '=' in line:
            k, v = line.split('=', 1)
            out[k] = v.strip().strip('"')
    return {'id': out.get('ID'), 'versionId': out.get('VERSION_ID'), 'pretty': out.get('PRETTY_NAME'), 'kernel': platform.release()}

def machine():
    virt = run(['systemd-detect-virt']) or run(['systemd-detect-virt', '--container'])
    cpu = next((l.split(':', 1)[1].strip() for l in (read('/proc/cpuinfo') or '').splitlines() if l.lower().startswith('model name')), None)
    mem_kb = next((int(re.sub(r'\D', '', l)) for l in (read('/proc/meminfo') or '').splitlines() if l.startswith('MemTotal')), 0)
    gpus = []
    for line in (run(['lspci', '-mm']) or '').splitlines():
        if re.search(r'"(VGA compatible controller|3D controller|Display controller)"', line):
            parts = re.findall(r'"([^"]*)"', line)
            gpus.append(' '.join(parts[2:4]) if len(parts) >= 4 else 'unknown')
    video_nodes = len([d for d in os.listdir('/dev') if d.startswith('video')]) if os.path.isdir('/dev') else 0
    return {'virtualization': virt or 'unknown', 'physical': virt == 'none', 'cpuModel': cpu, 'memoryGB': round(mem_kb / 1048576, 1), 'gpu': gpus or ['unknown'], 'arch': platform.machine(), 'videoDeviceNodes': video_nodes}

def can_unshare():
    try:
        return subprocess.run(['unshare', '-U', 'true'], capture_output=True, timeout=10).returncode == 0
    except Exception:
        return None

def security():
    restrict = (read('/proc/sys/kernel/apparmor_restrict_unprivileged_userns') or 'absent').strip()
    profiles = read('/sys/kernel/security/apparmor/profiles')
    return {
        'apparmorEnabled': (read('/sys/module/apparmor/parameters/enabled') or '').strip() == 'Y',
        'restrictUnprivilegedUserns': restrict,
        'normalUserCanCreateUserNamespace': can_unshare(),
        'profileLoaded': (re.search(r'^qorlla \(', profiles, re.M) is not None) if profiles is not None else None,
        'profileFile': oct_stat('/etc/apparmor.d/qorlla'),
        'ranAsRoot': os.getuid() == 0,
    }

def oct_stat(path):
    try:
        st = os.stat(path)
        return {'mode': format(st.st_mode & 0o7777, 'o'), 'ownerUid': st.st_uid}
    except Exception:
        return None

def package(deb, expect):
    out = {'version': run(['dpkg-query', '-W', '-f=${Version}', 'qorlla']), 'chromeSandbox': oct_stat('/opt/Qorlla/chrome-sandbox'), 'debSha256': None, 'expectedSha256': (expect or '').lower() or None}
    if deb and os.path.isfile(deb):
        out['debSha256'] = sha256(deb)
    return out

def processes():
    procs = []
    for d in os.listdir('/proc'):
        if not d.isdigit():
            continue
        try:
            if os.readlink('/proc/%s/exe' % d) != APP:
                continue
        except Exception:
            continue
        status = read('/proc/%s/status' % d) or ''
        cmd = [a for a in (read('/proc/%s/cmdline' % d) or '').split('\0') if a]
        procs.append({'pid': int(d), 'ppid': int(field(status, 'PPid') or 0), 'uid': (field(status, 'Uid') or '').split()[0] if field(status, 'Uid') else None,
                      'seccomp': field(status, 'Seccomp'), 'noNewPrivs': field(status, 'NoNewPrivs'), 'apparmor': (read('/proc/%s/attr/current' % d) or '').strip(),
                      'sandboxOffSwitch': any(SANDBOX_OFF.match(a) for a in cmd), 'userNs': os.readlink('/proc/%s/ns/user' % d) if os.path.exists('/proc/%s/ns/user' % d) else None})
    pids = {p['pid'] for p in procs}
    procs.sort(key=lambda p: (p['ppid'] in pids, p['pid']))      # the main process (parent not in the set) first
    main_ns = procs[0]['userNs'] if procs else None
    for p in procs:
        p['ownUserNamespace'] = p.pop('userNs') != main_ns
        p.pop('pid'); p.pop('ppid')                            # pids are not evidence
    return procs

def main():
    ap = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    ap.add_argument('--label', required=True, help='short label, e.g. ubuntu-24.04-a (lower case letters, digits, . _ -)')
    ap.add_argument('--deb', help='path to the .deb that was installed')
    ap.add_argument('--expect-sha256', help='the SHA-256 of that .deb from the CI run')
    ap.add_argument('--out', required=True)
    a = ap.parse_args()
    if not re.fullmatch(r'[a-z0-9._-]{3,40}', a.label):
        sys.exit('the label must be 3-40 characters of a-z 0-9 . _ -')
    existing = {}
    if os.path.exists(a.out):
        try:
            existing = json.load(open(a.out)).get('results', {})
        except Exception:
            existing = {}
    results = {k: existing.get(k, {'status': 'NOT_RUN', 'note': ''}) for k in TESTS}
    doc = {'schema': 'qorlla-linux-evidence/1', 'label': a.label, 'date': datetime.date.today().isoformat(), 'machine': machine(), 'os': os_release(), 'security': security(),
           'package': package(a.deb, a.expect_sha256), 'processes': processes(), 'tests': TESTS, 'results': results}
    with open(a.out, 'w') as f:
        json.dump(doc, f, indent=2); f.write('\n')
    print('wrote', a.out); print('physical machine:', doc['machine']['physical'], '| OS:', doc['os']['pretty'], '| Qorlla processes found:', len(doc['processes']))
    if not doc['processes']:
        print('NOTE: Qorlla is not running; start it as the normal user and run this again so the process security state is recorded')
    if doc['security']['profileLoaded'] is None:
        print('NOTE: run with sudo to record whether the AppArmor profile is loaded in the kernel')
    print('Set each test in "results" to pass / fail / not_applicable with a note, then validate with linux-evidence-check.cjs')

if __name__ == '__main__':
    main()
