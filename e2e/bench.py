"""Capture-pipeline benchmark + resilience checks in real Chrome (fake camera).

Usage: python3 e2e/bench.py <base> <y4m> <user> <password> [out.json]
Measures per preset: time until the shutter is ready again, time until a capture is
saved locally (IndexedDB), upload latency, saved size. Then checks behaviour on a weak
network, while offline, across background/foreground and a reload during uploads.
Numbers are from a headless desktop Chrome with a 1920×1440 fake camera — they show
relative costs and correctness, not Galaxy S24 performance.
"""
import json, sys, time
from playwright.sync_api import sync_playwright

base, y4m, user, pw = sys.argv[1:5]
out_path = sys.argv[5] if len(sys.argv) > 5 else None
ok = True
report = {'env': 'headless Chrome, fake camera 1920x1440, local PHP server', 'presets': {}, 'checks': {}}

def check(name, cond, detail=''):
    global ok
    ok &= bool(cond)
    report['checks'][name] = {'pass': bool(cond), 'detail': detail}
    print(('PASS ' if cond else 'FAIL ') + name + (f' — {detail}' if detail else ''), flush=True)

with sync_playwright() as p:
    b = p.chromium.launch(executable_path='/usr/bin/google-chrome', args=['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', f'--use-file-for-fake-video-capture={y4m}'])
    ctx = b.new_context(viewport={'width': 412, 'height': 915}, is_mobile=True, has_touch=True)
    page = ctx.new_page()
    errs = []
    page.on('pageerror', lambda e: errs.append(str(e)))
    cdp = ctx.new_cdp_session(page)

    page.goto(base + '/')
    page.fill('input[name=username]', user); page.fill('input[name=password]', pw); page.click('button[type=submit]')
    page.wait_for_selector('text=Your books')
    book = page.evaluate("""async () => {
      const st = await fetch('/api/auth/state').then(r => r.json());
      const r = await fetch('/api/books', {method: 'POST', headers: {'Content-Type': 'application/json', 'X-CSRF-Token': st.csrf},
        body: JSON.stringify({title: 'Benchmark ' + Date.now(), default_layout: 'parallel', original_language: 'mrw', translation_language: 'eng'})}).then(r => r.json());
      return r.book.id; }""")
    server_pages = lambda: page.evaluate(f"fetch('/api/books/{book}/pages').then(r => r.json()).then(d => d.pages.length)")

    def open_scan(settings):
        page.evaluate("s => { for (const [k, v] of Object.entries(s)) localStorage.setItem(k, v); window.__bsMetrics && window.__bsMetrics.reset(); }", settings)
        page.goto(f'{base}/#/books/{book}/scan')
        page.reload()
        page.wait_for_selector('.shutter')
        page.wait_for_function("document.querySelector('video.preview').videoWidth > 0", timeout=15000)
        page.wait_for_timeout(600)

    def session_count():
        t = page.inner_text('.statusbar')
        return int(t.split('☁ ')[1].split(' ')[0])

    def burst(n, gap_ms=250, timeout=120):
        start = session_count()
        t0 = time.time()
        for _ in range(n):
            page.click('.shutter')
            page.wait_for_timeout(gap_ms)
        while session_count() < start + n and time.time() - t0 < timeout:
            page.wait_for_timeout(100)
        return time.time() - t0

    def wait_uploaded(timeout=180):
        page.wait_for_function("document.querySelector('.statusbar').textContent.includes('all uploaded')", timeout=timeout * 1000)

    def wait_server(target, timeout=60):
        t0 = time.time()
        while server_pages() < target and time.time() - t0 < timeout:
            page.wait_for_timeout(500)
        return server_pages()

    def summary():
        return page.evaluate('window.__bsMetrics.summary()')

    # ---------- presets ----------
    runs = [('minimal', {'bs2.preset': 'minimal', 'bs2.minimal': '1', 'bs2.crop': 'off'}, 10),
            ('fast', {'bs2.preset': 'fast', 'bs2.minimal': '0', 'bs2.crop': 'auto'}, 10),
            ('balanced', {'bs2.preset': 'balanced', 'bs2.minimal': '0', 'bs2.crop': 'auto'}, 10),
            ('quality', {'bs2.preset': 'quality', 'bs2.minimal': '0', 'bs2.crop': 'auto'}, 10),
            ('balanced_30', {'bs2.preset': 'balanced', 'bs2.minimal': '0', 'bs2.crop': 'auto'}, 30),
            ('minimal_30', {'bs2.preset': 'minimal', 'bs2.minimal': '1', 'bs2.crop': 'off'}, 30)]
    for name, s, n in runs:
        before = server_pages()
        open_scan(s)
        secs = burst(n)
        wait_uploaded()
        m = summary()
        dims = page.inner_text('.lastind')
        key = name.split('_')[0]
        row = {
            'captures': n,
            'saved_dims_and_size': dims,
            'ready_ms': m.get(f'ready_ms_{key}'),
            'saved_total_ms': m.get(f'saved_total_ms_{key}'),
            'prepare_ms': m.get('prepare_ms'), 'idb_ms': m.get('idb_ms'),
            'upload_ms': m.get('upload_ms'), 'server_ms': m.get('server_ms'),
            'wall_seconds_for_all_saved_locally': round(secs, 2),
            'js_heap_mb': page.evaluate("performance.memory ? Math.round(performance.memory.usedJSHeapSize/1e6) : null"),
        }
        report['presets'][name] = row
        check(f'{name}: {n} captures saved + uploaded, server pages +{n}', wait_server(before + n) - before == n, dims)
    mins = int(report['presets']['minimal']['saved_dims_and_size'].split('×')[0])
    check('Minimal preset saves at 1600 long edge (resolution really applied)', mins == 1600, report['presets']['minimal']['saved_dims_and_size'])

    # ---------- weak network: capture must not wait for uploads ----------
    open_scan({'bs2.preset': 'balanced', 'bs2.minimal': '0', 'bs2.crop': 'auto'})
    cdp.send('Network.enable')
    cdp.send('Network.emulateNetworkConditions', {'offline': False, 'latency': 400, 'downloadThroughput': 750 * 1024 / 8, 'uploadThroughput': 200 * 1024 / 8})
    before = server_pages()
    secs = burst(10)
    on_phone = page.inner_text('.statusbar')
    check('weak network: 10 captures saved locally without waiting for uploads', secs < 15, f'{secs:.1f}s; {on_phone.splitlines()[0]}')
    t0 = time.time()
    wait_uploaded(300)
    check('weak network: all 10 uploaded eventually, no duplicates', server_pages() - before == 10, f'{time.time() - t0:.1f}s at 200 kbit/s up')
    cdp.send('Network.emulateNetworkConditions', {'offline': False, 'latency': 0, 'downloadThroughput': -1, 'uploadThroughput': -1})

    # ---------- offline ----------
    before = server_pages()
    ctx.set_offline(True)
    page.wait_for_timeout(300)
    burst(5)
    st = page.inner_text('.statusbar')
    check('offline: captures continue and stay on phone', '💾 5 on phone' in st and 'offline' in st, st.splitlines()[0])
    ctx.set_offline(False)
    wait_uploaded(120)
    check('back online: uploads resume, none lost, none duplicated', wait_server(before + 5) - before == 5)

    # ---------- reload during uploads (interrupted session) ----------
    before = server_pages()
    cdp.send('Network.emulateNetworkConditions', {'offline': False, 'latency': 300, 'downloadThroughput': -1, 'uploadThroughput': 100 * 1024 / 8})
    burst(4)
    page.reload()
    page.wait_for_selector('.shutter')
    cdp.send('Network.emulateNetworkConditions', {'offline': False, 'latency': 0, 'downloadThroughput': -1, 'uploadThroughput': -1})
    wait_uploaded(120)
    page.wait_for_timeout(1500)
    check('reload mid-upload: every capture arrives exactly once', server_pages() - before == 4, f'{server_pages() - before} of 4')

    # ---------- background / foreground ----------
    page.evaluate("""() => { Object.defineProperty(document, 'visibilityState', {configurable: true, get: () => 'hidden'});
                              Object.defineProperty(document, 'hidden', {configurable: true, get: () => true});
                              document.dispatchEvent(new Event('visibilitychange')); }""")
    page.wait_for_timeout(500)
    stopped = page.evaluate("!document.querySelector('video').srcObject || document.querySelector('video').srcObject.getTracks().every(t => t.readyState === 'ended')")
    page.evaluate("""() => { Object.defineProperty(document, 'visibilityState', {configurable: true, get: () => 'visible'});
                              Object.defineProperty(document, 'hidden', {configurable: true, get: () => false});
                              document.dispatchEvent(new Event('visibilitychange')); }""")
    page.wait_for_function("document.querySelector('video').srcObject && document.querySelector('video').srcObject.getTracks().some(t => t.readyState === 'live')", timeout=10000)
    before = server_pages()
    burst(1)
    got = wait_server(before + 1) - before
    check('background releases camera; foreground restarts it and capture works', stopped and got == 1, f'camera stopped={stopped}, new pages={got}, status={page.inner_text(".statusbar").splitlines()[:2]}')

    # ---------- minimal mode really disables live detection ----------
    open_scan({'bs2.preset': 'minimal', 'bs2.minimal': '1', 'bs2.crop': 'auto'})
    page.wait_for_timeout(2500)
    n_detect = (page.evaluate('window.__bsMetrics.summary()').get('live_detect_ms') or {}).get('n', 0)
    check('Minimal mode: no live page detection runs', n_detect == 0, f'{n_detect} detections in 2.5s')
    open_scan({'bs2.preset': 'balanced', 'bs2.minimal': '0', 'bs2.crop': 'auto'})
    page.wait_for_timeout(2500)
    n_detect = (page.evaluate('window.__bsMetrics.summary()').get('live_detect_ms') or {}).get('n', 0)
    check('Enhanced mode: live detection throttled to ~2/s', 2 <= n_detect <= 7, f'{n_detect} detections in 2.5s')

    check('no JS errors', not errs, '; '.join(errs[:2]))
    b.close()

print(json.dumps(report['presets'], indent=1))
if out_path:
    with open(out_path, 'w') as f:
        json.dump(report, f, indent=1)
sys.exit(0 if ok else 1)
