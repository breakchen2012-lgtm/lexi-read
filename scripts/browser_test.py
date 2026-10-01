#!/usr/bin/env python3
"""
在真实浏览器里跑 tests/smoke.html：
  - 起一个本地静态服务器（同时接收测试页 POST 回来的结果）
  - 拉起无头 Chrome
  - 等结果回来，打印，然后杀掉 Chrome

用法: python3 scripts/browser_test.py [页面路径] [--shot 输出png] [--wait 秒]
"""
import functools, http.server, json, os, socketserver, subprocess, sys, tempfile, threading, time

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
PORT = 8791

RESULT = {}
DONE = threading.Event()
MOCK = {'count': 0, 'last': None}
MOCK_TEXT = (
    '【本句释义】adj. 有韧性的，能快速恢复的\n'
    '【为什么】句中与 able to recover quickly 同义，指城市灾后恢复能力强\n'
    '【其他常用义】无\n'
    '【例句】The team remained resilient after the setback. 团队受挫后依然坚韧。\n'
    '【记忆】re-（回）+ sil（跳）+ -ient → 弹回来的'
)


class Handler(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def do_GET(self):
        if self.path.startswith('/__mock_last'):
            body = json.dumps(MOCK, ensure_ascii=False).encode('utf-8')
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Content-Length', str(len(body)))
            self.send_header('Cache-Control', 'no-store')
            self.end_headers()
            self.wfile.write(body)
            return
        return super().do_GET()

    def do_POST(self):
        if self.path.startswith('/__mock'):
            n = int(self.headers.get('content-length', 0))
            raw = self.rfile.read(n)
            try:
                MOCK['last'] = json.loads(raw.decode('utf-8'))
            except Exception:
                MOCK['last'] = {'raw': raw[:400].decode('utf-8', 'replace')}
            MOCK['count'] += 1
            if self.headers.get('Authorization') != 'Bearer sk-test':
                body = json.dumps({'error': {'message': 'Authentication Fails, Your api key is invalid'}}).encode()
                self.send_response(401)
                self.send_header('Content-Type', 'application/json')
                self.send_header('Content-Length', str(len(body)))
                self.end_headers()
                self.wfile.write(body)
                return
            self.send_response(200)
            self.send_header('Content-Type', 'text/event-stream; charset=utf-8')
            self.send_header('Cache-Control', 'no-cache')
            self.end_headers()
            for i in range(0, len(MOCK_TEXT), 4):
                chunk = json.dumps({'choices': [{'delta': {'content': MOCK_TEXT[i:i + 4]}}]},
                                   ensure_ascii=False)
                self.wfile.write(('data: ' + chunk + '\n\n').encode('utf-8'))
                self.wfile.flush()
                time.sleep(0.004)
            self.wfile.write(b'data: [DONE]\n\n')
            self.wfile.flush()
            return
        if self.path.startswith('/__results'):
            n = int(self.headers.get('content-length', 0))
            raw = self.rfile.read(n)
            try:
                payload = json.loads(raw.decode('utf-8'))
            except Exception as e:
                payload = {'parse_error': str(e)}
            RESULT.clear()
            RESULT.update(payload)
            self.send_response(204)
            self.send_header('Access-Control-Allow-Origin', '*')
            self.end_headers()
            # 增量上报不算完成，只有最后那次（不带 partial）才算
            if not payload.get('partial'):
                DONE.set()
        else:
            self.send_response(404)
            self.end_headers()


class Server(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True


def main():
    argv = sys.argv[1:]
    page = '/tests/smoke.html'
    shot = None
    wait = 40
    profile = None
    root = None
    if argv and not argv[0].startswith('--'):
        page = argv.pop(0)
    while argv:
        a = argv.pop(0)
        if a == '--shot':
            shot = argv.pop(0)
        elif a == '--wait':
            wait = int(argv.pop(0))
        elif a == '--profile':
            profile = argv.pop(0)
        elif a == '--root':
            root = argv.pop(0)

    served = os.path.abspath(root) if root else ROOT
    httpd = Server(
        ('127.0.0.1', PORT), functools.partial(Handler, directory=served))
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    url = f'http://127.0.0.1:{PORT}{page}'
    print('serving', served, '→', url)

    if shot and os.path.exists(shot):
        os.remove(shot)
    args = [
        CHROME, '--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run',
        '--disable-extensions', '--disable-background-networking', '--disable-sync',
        '--disable-crash-reporter', '--autoplay-policy=no-user-gesture-required',
        '--user-data-dir=' + (profile or tempfile.mkdtemp(prefix='lexi-chrome-')),
        '--window-size=430,932',
    ]
    if shot:
        args += ['--screenshot=' + shot]
    args += [url]

    proc = subprocess.Popen(args, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                            start_new_session=True)
    ok = DONE.wait(timeout=wait)

    time.sleep(2.5)            # 让 Chrome 把 localStorage 落盘
    if shot:
        time.sleep(3)          # 给截图留点时间
    try:
        os.killpg(os.getpgid(proc.pid), 15)
    except Exception:
        pass
    httpd.shutdown()

    if not ok:
        print(f'!! {wait}s 内没有收到最终结果，下面是已收到的部分结果')
        if shot and os.path.exists(shot):
            print('截图:', shot)

    res = RESULT.get('results', [])
    errs = RESULT.get('errors', [])
    passed = sum(1 for r in res if r[0])
    for ok_, name, info in res:
        mark = '✓' if ok_ else '✗'
        line = f'{mark} {name}'
        if info:
            line += f'  → {info}'
        print(line)
    for e in errs:
        print('⚠ 页面错误:', e)
    print(f'\n{passed}/{len(res)} 通过')
    if shot and os.path.exists(shot):
        print('截图:', shot)
    sys.exit(0 if ok and passed == len(res) and not errs else 1)


if __name__ == '__main__':
    main()
