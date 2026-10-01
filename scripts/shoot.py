#!/usr/bin/env python3
"""
用 Chrome DevTools Protocol 精确截图：
导航 → 轮询 JS 表达式直到为真 → 截图。不再依赖 --virtual-time-budget 的玄学时机。

用法: python3 scripts/shoot.py
"""
import base64, json, os, socket, struct, subprocess, sys, tempfile, time, urllib.request
from urllib.parse import urlparse

CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
DEBUG_PORT = 9333
BASE = os.environ.get("LEXI_BASE", "http://127.0.0.1:8791")
OUT = "/tmp/shots"
SETUP = "localStorage.setItem('lexiread.ai',JSON.stringify({baseUrl:'https://api.deepseek.com',apiKey:'sk-demo',model:'deepseek-chat'}))"
PROFILE = os.environ.get("LEXI_PROFILE", "/tmp/lexi-shot-profile")


# ───────────────────────── 极简 WebSocket 客户端 ─────────────────────────
class WS:
    def __init__(self, url):
        u = urlparse(url)
        self.sock = socket.create_connection((u.hostname, u.port), timeout=30)
        key = base64.b64encode(os.urandom(16)).decode()
        path = u.path + (('?' + u.query) if u.query else '')
        req = (f"GET {path} HTTP/1.1\r\nHost: {u.hostname}:{u.port}\r\n"
               "Upgrade: websocket\r\nConnection: Upgrade\r\n"
               f"Sec-WebSocket-Key: {key}\r\nSec-WebSocket-Version: 13\r\n\r\n")
        self.sock.sendall(req.encode())
        buf = b''
        while b'\r\n\r\n' not in buf:
            d = self.sock.recv(4096)
            if not d:
                raise RuntimeError('握手失败')
            buf += d
        if b'101' not in buf.split(b'\r\n')[0]:
            raise RuntimeError('握手被拒: ' + buf[:200].decode('utf-8', 'replace'))
        self.buf = buf.split(b'\r\n\r\n', 1)[1]
        self._id = 0

    def _read(self, n):
        while len(self.buf) < n:
            d = self.sock.recv(65536)
            if not d:
                raise EOFError
            self.buf += d
        out, self.buf = self.buf[:n], self.buf[n:]
        return out

    def send(self, text):
        payload = text.encode()
        mask = os.urandom(4)
        n = len(payload)
        head = b'\x81'
        if n < 126:
            head += bytes([0x80 | n])
        elif n < 65536:
            head += bytes([0x80 | 126]) + struct.pack('>H', n)
        else:
            head += bytes([0x80 | 127]) + struct.pack('>Q', n)
        masked = bytes(b ^ mask[i % 4] for i, b in enumerate(payload))
        self.sock.sendall(head + mask + masked)

    def recv(self):
        while True:
            h = self._read(2)
            op = h[0] & 0x0f
            ln = h[1] & 0x7f
            if ln == 126:
                ln = struct.unpack('>H', self._read(2))[0]
            elif ln == 127:
                ln = struct.unpack('>Q', self._read(8))[0]
            data = self._read(ln) if ln else b''
            if op == 0x9:      # ping
                self.sock.sendall(b'\x8a\x80' + os.urandom(4))
                continue
            if op == 0x8:
                raise EOFError('closed')
            if op in (0x1, 0x2):
                return data.decode('utf-8', 'replace')

    def cmd(self, method, params=None, session=None, timeout=40):
        self._id += 1
        mid = self._id
        msg = {'id': mid, 'method': method, 'params': params or {}}
        if session:
            msg['sessionId'] = session
        self.send(json.dumps(msg))
        t0 = time.time()
        while time.time() - t0 < timeout:
            m = json.loads(self.recv())
            if m.get('id') == mid:
                if 'error' in m:
                    raise RuntimeError(f"{method}: {m['error']}")
                return m.get('result', {})
        raise TimeoutError(method)


def http_json(path):
    with urllib.request.urlopen(f'http://127.0.0.1:{DEBUG_PORT}{path}', timeout=15) as r:
        return json.load(r)


# ───────────────────────── 截图任务 ─────────────────────────
SHOTS = [
    dict(name='01-library', url=f'{BASE}/index.html', w=402, h=874,
         wait="document.body.dataset.ready==='1' && document.querySelectorAll('#article-list .card').length>0",
         settle=900, dpr=2, theme='light'),
    dict(name='02-reader-word', url=f'{BASE}/index.html?article=demo-article&word=resilient',
         w=402, h=874,
         wait="document.querySelector('#panel') && !document.querySelector('#panel').hidden && /有韧性/.test(document.querySelector('#ai-word').textContent)",
         settle=900, dpr=2, theme='light', setup=SETUP),
    dict(name='03-reader-dark', url=f'{BASE}/index.html?article=demo-article', w=402, h=874,
         wait="document.querySelectorAll('#reader-body .w').length>60", settle=900, dpr=2, theme='dark',
         actions="var b=document.querySelector('#btn-theme');b.click();b.click()"),
    dict(name='04-vocab', url=f'{BASE}/index.html?tab=vocab', w=402, h=874,
         wait="document.querySelectorAll('#vocab-list .card').length>=4", settle=600, dpr=2, theme='light'),
    dict(name='05-review', url=f'{BASE}/index.html?review=1', w=402, h=874,
         wait="(document.querySelector('.rc-word')||{}).textContent", settle=500, dpr=2, theme='light',
         actions="document.querySelector('[data-action=\"reveal\"]').click()"),
    dict(name='07-import', url=f'{BASE}/index.html', w=402, h=874,
         wait="document.body.dataset.ready==='1'", settle=1100, dpr=2, theme='light',
         actions="document.querySelector('[data-action=\"new-article\"]').click()"),
    dict(name='06-desktop', url=f'{BASE}/index.html?article=demo-article&word=resilient',
         w=1280, h=820,
         wait="document.querySelector('#panel') && !document.querySelector('#panel').hidden && /有韧性/.test(document.querySelector('#ai-word').textContent)",
         settle=900, dpr=1, theme='light', setup=SETUP),
]


def main():
    only = sys.argv[1] if len(sys.argv) > 1 else None
    os.makedirs(OUT, exist_ok=True)
    subprocess.run(['pkill', '-f', PROFILE], capture_output=True)
    time.sleep(0.6)
    if '--clean' in sys.argv:
        subprocess.run(['rm', '-rf', PROFILE], capture_output=True)

    proc = subprocess.Popen([
        CHROME, '--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run',
        '--disable-extensions', '--disable-crash-reporter', '--hide-scrollbars',
        '--force-device-scale-factor=1',
        f'--remote-debugging-port={DEBUG_PORT}', f'--user-data-dir={PROFILE}',
        'about:blank',
    ], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)

    for _ in range(60):
        try:
            http_json('/json/version')
            break
        except Exception:
            time.sleep(0.5)
    else:
        print('Chrome 调试端口没起来')
        return 1

    ws = WS(http_json('/json/version')['webSocketDebuggerUrl'])
    for spec in SHOTS:
        if only and only not in spec['name']:
            continue
        t = ws.cmd('Target.createTarget', {'url': 'about:blank'})
        tid = t['targetId']
        sid = ws.cmd('Target.attachToTarget', {'targetId': tid, 'flatten': True})['sessionId']
        ws.cmd('Page.enable', session=sid)
        ws.cmd('Runtime.enable', session=sid)
        ws.cmd('Emulation.setDeviceMetricsOverride',
               {'width': spec['w'], 'height': spec['h'],
                'deviceScaleFactor': spec.get('dpr', 1), 'mobile': spec['w'] < 700}, session=sid)
        # 先在本源写入主题，避免截图时闪一下
        ws.cmd('Page.navigate', {'url': spec['url']}, session=sid)
        time.sleep(1.0)
        if spec.get('setup'):
            ws.cmd('Runtime.evaluate', {'expression': spec['setup']}, session=sid)
            ws.cmd('Page.reload', session=sid)
            time.sleep(1.4)
        ok = False
        t0 = time.time()
        while time.time() - t0 < 45:
            try:
                r = ws.cmd('Runtime.evaluate',
                           {'expression': f"(()=>{{try{{return !!({spec['wait']})}}catch(e){{return false}}}})()",
                            'returnByValue': True}, session=sid)
                if r.get('result', {}).get('value'):
                    ok = True
                    break
            except Exception:
                pass
            time.sleep(0.35)
        if not ok:
            print(f"  !! {spec['name']} 等待条件超时")
        if spec.get('actions'):
            try:
                ws.cmd('Runtime.evaluate', {'expression': spec['actions']}, session=sid)
            except Exception as e:
                print('  动作失败', e)
        time.sleep(spec.get('settle', 500) / 1000.0)
        img = ws.cmd('Page.captureScreenshot', {'format': 'png', 'captureBeyondViewport': False},
                     session=sid)['data']
        path = os.path.join(OUT, spec['name'] + '.png')
        with open(path, 'wb') as fh:
            fh.write(base64.b64decode(img))
        print(f"  ✓ {spec['name']:<16} {spec['w']}x{spec['h']}  {os.path.getsize(path)/1024:.0f} KB  wait_ok={ok}")
        ws.cmd('Target.closeTarget', {'targetId': tid})

    try:
        os.killpg(os.getpgid(proc.pid), 15)
    except Exception:
        pass
    return 0


if __name__ == '__main__':
    sys.exit(main())
