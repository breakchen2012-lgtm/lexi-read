#!/usr/bin/env python3
"""
在真实浏览器里跑 tests/smoke.html：
  - 起一个本地静态服务器（同时接收测试页 POST 回来的结果）
  - 拉起无头 Chrome
  - 等结果回来，打印，然后杀掉 Chrome

用法: python3 scripts/browser_test.py [页面路径] [--shot 输出png] [--wait 秒]
"""
import functools, http.server, json, os, socketserver, subprocess, sys, tempfile, threading, time
from urllib.parse import urlparse, parse_qs

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
PORT = 8791

RESULT = {}
DONE = threading.Event()
MOCK = {'count': 0, 'last': None}

# ─────────────── 模拟 Supabase（Auth + PostgREST），用于同步测试 ───────────────
SB = {'users': {}, 'tables': {}, 'seq': 0}
SB_PK = {
    'lexi_articles': 'id', 'lexi_bodies': 'id', 'lexi_vocab': 'word',
    'lexi_aica': 'k', 'lexi_settings': 'user_id',
}


def sb_user(token):
    """token 形如 tok-<user_id>；返回 user_id 或 None"""
    if not token or not token.startswith('Bearer tok-'):
        return None
    uid = token[len('Bearer tok-'):]
    return uid if uid in SB['users'] else None


def sb_session(uid):
    u = SB['users'][uid]
    return {
        'access_token': 'tok-' + uid, 'refresh_token': 'ref-' + uid,
        'expires_in': 3600, 'token_type': 'bearer',
        'user': {'id': uid, 'email': u['email']},
    }
MOCK_TEXT = (
    '【本句释义】adj. 有韧性的，能快速恢复的\n'
    '【为什么】句中与 able to recover quickly 同义，指城市灾后恢复能力强\n'
    '【其他常用义】无\n'
    '【例句】The team remained resilient after the setback. 团队受挫后依然坚韧。\n'
    '【记忆】re-（回）+ sil（跳）+ -ient → 弹回来的'
)


class Handler(http.server.SimpleHTTPRequestHandler):
    protocol_version = 'HTTP/1.0'          # 每个请求一个连接，避免 keep-alive 错位

    def log_message(self, *a):
        pass

    def _read_body(self):
        try:
            n = int(self.headers.get('content-length') or 0)
        except ValueError:
            n = 0
        return self.rfile.read(n) if n > 0 else b''

    # ── 模拟 Supabase：预检 ──
    def do_OPTIONS(self):
        self._body = self._read_body()
        self.send_response(204)
        for k, v in self._cors().items():
            self.send_header(k, v)
        self.send_header('Content-Length', '0')
        self.end_headers()
        self.close_connection = True

    def _cors(self):
        return {
            'Access-Control-Allow-Origin': self.headers.get('Origin', '*'),
            'Access-Control-Allow-Methods': 'GET,POST,PATCH,DELETE,OPTIONS',
            'Access-Control-Allow-Headers': 'apikey,authorization,content-type,prefer,x-client-info',
            'Access-Control-Expose-Headers': '*',
            'Access-Control-Max-Age': '600',
        }

    def _send(self, code, obj=None, extra=None):
        body = b'' if obj is None else json.dumps(obj, ensure_ascii=False).encode()
        self.send_response(code)
        for k, v in self._cors().items():
            self.send_header(k, v)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self.end_headers()
        if body:
            self.wfile.write(body)
        self.close_connection = True

    def _sb(self, method):
        """返回 True 表示这个请求已经被模拟 Supabase 处理掉了"""
        parsed = urlparse(self.path)
        path, qs = parsed.path, parse_qs(parsed.query)
        if not path.startswith('/__sb/'):
            return False
        line = method + ' ' + path + (('?' + parsed.query) if parsed.query else '')
        SB.setdefault('reqlog', []).append(line)
        try:
            with open('/tmp/sb-req.log', 'a') as fh:
                fh.write(line + '\n')
        except Exception:
            pass
        inner = path[len('/__sb'):]

        # ── Auth ──
        if inner.startswith('/auth/v1/'):
            raw = self._body
            body = json.loads(raw or b'{}') if raw else {}
            route = inner[len('/auth/v1/'):]
            if route == 'signup':
                email = (body.get('email') or '').strip().lower()
                if not email or len(body.get('password') or '') < 6:
                    return self._send(400, {'msg': 'Password should be at least 6 characters'}) or True
                if any(u['email'] == email for u in SB['users'].values()):
                    return self._send(400, {'msg': 'User already registered'}) or True
                SB['seq'] += 1
                uid = 'u%d' % SB['seq']
                SB['users'][uid] = {'email': email, 'password': body['password']}
                self._send(200, sb_session(uid))
                return True
            if route.startswith('token'):
                grant = (qs.get('grant_type') or [''])[0]
                if grant == 'password':
                    for uid, u in SB['users'].items():
                        if u['email'] == (body.get('email') or '').strip().lower():
                            if u['password'] != body.get('password'):
                                return self._send(400, {'error_description': 'Invalid login credentials'}) or True
                            self._send(200, sb_session(uid))
                            return True
                    return self._send(400, {'error_description': 'Invalid login credentials'}) or True
                if grant == 'refresh_token':
                    rt = body.get('refresh_token') or ''
                    uid = rt[4:] if rt.startswith('ref-') else ''
                    if uid in SB['users']:
                        self._send(200, sb_session(uid))
                    else:
                        self._send(401, {'error_description': 'Invalid Refresh Token'})
                    return True
            if route == 'logout':
                self._send(204)
                return True
            return self._send(404, {'msg': 'not found'}) or True

        # ── PostgREST ──
        if inner.startswith('/rest/v1/'):
            table = inner[len('/rest/v1/'):].strip('/')
            uid = sb_user(self.headers.get('Authorization'))
            if not uid:
                return self._send(401, {'message': 'JWT expired'}) or True
            rows = SB['tables'].setdefault(table, [])
            pk = SB_PK.get(table, 'id')
            raw = self._body
            payload = json.loads(raw or b'null') if raw else None

            if method == 'POST':
                try:
                    with open('/tmp/sb-req.log', 'a') as fh:
                        fh.write('  BODY ' + json.dumps(payload, ensure_ascii=False)[:200] + '\n')
                except Exception:
                    pass
                items = payload if isinstance(payload, list) else [payload]
                prefer = self.headers.get('Prefer', '')
                for it in items:
                    it = dict(it); it['user_id'] = uid
                    if 'resolution=merge-duplicates' in prefer or True:
                        for i, r in enumerate(rows):
                            if r['user_id'] == uid and r.get(pk) == it.get(pk):
                                rows[i] = {**r, **it}
                                break
                        else:
                            rows.append(it)
                return self._send(201) or True

            if method == 'DELETE':
                col = pk
                filt = qs.get(col, qs.get('id', qs.get('word', [''])))
                keep, removed = [], 0
                for r in rows:
                    if r['user_id'] == uid and filt and str(r.get(col)) == str(filt[0]).replace('eq.', ''):
                        removed += 1
                        continue
                    keep.append(r)
                SB['tables'][table] = keep
                return self._send(204, extra={'Preference-Applied': 'return=minimal'}) or True

            if method == 'GET':
                out = [r for r in rows if r['user_id'] == uid]
                for col, vals in qs.items():
                    if col in ('select', 'limit', 'offset', 'order'):
                        continue
                    v = vals[0]
                    if v.startswith('eq.'):
                        want = v[3:]
                        out = [r for r in out if str(r.get(col)) == want]
                    elif v.startswith('in.('):
                        inner_v = v[4:].rstrip(')')
                        wanted = {x.strip().strip('"') for x in inner_v.split(',')}
                        out = [r for r in out if str(r.get(col)) in wanted]
                sel = (qs.get('select') or ['*'])[0]
                if sel != '*' and 'raw' in [c.strip() for c in sel.split(',')]:
                    SB['body_rows_served'] = SB.get('body_rows_served', 0) + len(out)
                if sel != '*':
                    cols = [c.strip() for c in sel.split(',')]
                    out = [{c: r.get(c) for c in cols} for r in out]
                offset = int((qs.get('offset') or ['0'])[0])
                limit = int((qs.get('limit') or ['1000'])[0])
                return self._send(200, out[offset:offset + limit]) or True
            return self._send(404, {'message': 'unsupported'}) or True
        return False

    def do_GET(self):
        self._body = self._read_body()
        if self.path.startswith('/__sb-stats'):
            return self._send(200, {'body_rows_served': SB.get('body_rows_served', 0),
                                    'tables': {k: len(v) for k, v in SB['tables'].items()}})
        if self.path.startswith('/__sb-dump'):
            return self._send(200, {'tables': SB['tables'], 'users': list(SB['users']),
                                    'reqlog': SB.get('reqlog', [])[-400:]})
        if self.path.startswith('/__sb-reset'):
            SB['tables'] = {}; SB['users'] = {}; SB['seq'] = 0; SB['body_rows_served'] = 0; SB['reqlog'] = []
            return self._send(200, {'ok': True})
        if self._sb('GET'):
            return
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

    def do_DELETE(self):
        self._body = self._read_body()
        if self._sb('DELETE'):
            return
        self.send_response(404)
        self.end_headers()

    def do_POST(self):
        self._body = self._read_body()
        if self._sb('POST'):
            return
        if self.path.startswith('/__mock'):
            raw = self._body
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
            raw = self._body
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
    request_queue_size = 512          # 默认只有 5，SW 预缓存并发请求多时会被丢连接


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
    # 第二个端口：给「第二台设备」用（不同端口 = 不同浏览器源 = 存储天然隔离）
    httpd2 = Server(
        ('127.0.0.1', PORT + 1), functools.partial(Handler, directory=served))
    threading.Thread(target=httpd2.serve_forever, daemon=True).start()
    url = f'http://127.0.0.1:{PORT}{page}'
    print('serving', served, '→', url)

    if shot and os.path.exists(shot):
        os.remove(shot)
    args = [
        CHROME, '--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run',
        '--disable-extensions', '--disable-background-networking', '--disable-sync',
        '--disable-crash-reporter', '--autoplay-policy=no-user-gesture-required',
        '--enable-logging=stderr', '--v=0',
        '--user-data-dir=' + (profile or tempfile.mkdtemp(prefix='lexi-chrome-')),
        '--window-size=' + ('1000,1000' if 'sync' in page else '430,932'),
    ]
    if shot:
        args += ['--screenshot=' + shot]
    args += [url]

    errlog = open('/tmp/chrome-err.log', 'wb')
    proc = subprocess.Popen(args, stdout=subprocess.DEVNULL, stderr=errlog,
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

    try:
        errlog.close()
    except Exception:
        pass
    try:
        import re as _re
        with open('/tmp/chrome-err.log', errors='replace') as fh:
            for ln in fh:
                if _re.search(r'Uncaught|SyntaxError|Failed to load|TypeError|ReferenceError|CONSOLE', ln):
                    print('  [chrome]', ln.strip()[:220])
    except Exception:
        pass

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
