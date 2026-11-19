"""End-to-end smoke test in real Chrome with a fake camera feeding a synthetic page.

Usage:  python3 e2e/smoke.py http://127.0.0.1:8080 /tmp/bs-e2e/parallel.y4m <setup-token>
Covers: setup → create book → page-shaped viewfinder → capture ×3 → saved locally →
upload confirmed → reload/resume → OCR queued automatically → "no worker" visible →
in-browser worker → text saved → review (columns independent) → exports.
"""
import json, sys, time
from playwright.sync_api import sync_playwright

base, y4m, token = sys.argv[1], sys.argv[2], sys.argv[3]
results = []

def check(name, cond, detail=''):
    results.append((name, bool(cond), detail))
    print(('PASS ' if cond else 'FAIL ') + name + (f' — {detail}' if detail else ''), flush=True)

def status(page):
    return page.inner_text('.statusbar')

with sync_playwright() as p:
    browser = p.chromium.launch(executable_path='/usr/bin/google-chrome', args=[
        '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', f'--use-file-for-fake-video-capture={y4m}'])
    ctx = browser.new_context(viewport={'width': 412, 'height': 915}, device_scale_factor=2, is_mobile=True, has_touch=True)
    page = ctx.new_page()
    errors = []
    page.on('pageerror', lambda e: errors.append(str(e)))
    page.on('console', lambda m: m.type == 'error' and errors.append(m.text))

    page.goto(base + '/')
    page.fill('input[name=setup_token]', token)
    page.fill('input[name=username]', 'cris')
    page.fill('input[name=password]', 'library-scan-2026')
    page.click('button[type=submit]')
    page.wait_for_selector('text=Your books')
    check('setup + login', True)

    page.click('text=+ New book')
    page.click('text=Fill in: Darangen')
    page.click('text=Create & start scanning')
    page.wait_for_selector('.shutter', timeout=15000)
    page.wait_for_function("document.querySelector('video.preview').videoWidth > 0", timeout=15000)
    box = page.locator('.stage').bounding_box()
    check('viewfinder is page-shaped (portrait, not square)', box['height'] / box['width'] > 1.2, f"{box['width']:.0f}x{box['height']:.0f}")
    vw = page.evaluate("[document.querySelector('video').videoWidth, document.querySelector('video').videoHeight]")
    check('preview stream is modest 4:3 (not 4K)', max(vw) <= 1920 and abs(vw[0] / vw[1] - 4 / 3) < 0.05, str(vw))
    check('default preset Balanced', 'Balanced 2400px' in page.inner_text('.chips'))

    for i in range(3):
        page.click('.shutter')
        page.wait_for_timeout(400)
    page.wait_for_function("document.querySelector('.statusbar').textContent.includes('all uploaded') && document.querySelector('.statusbar').textContent.includes('3 this session')", timeout=30000)
    check('3 captures saved and uploaded', True, status(page))
    last = page.inner_text('.lastind')
    w, h = [int(x) for x in last.split(' ')[0].split('×')]
    check('saved image respects Balanced (≤2400, not upscaled)', max(w, h) <= 2400, last)
    check('page number auto-advanced to 4', 'p. 4' in page.inner_text('.pagebtn'))
    page.wait_for_function("document.querySelector('.ocrind').textContent.includes('queued')", timeout=15000)
    check('OCR queued automatically + no-worker warning', 'no worker' in page.inner_text('.ocrind'), page.inner_text('.ocrind'))

    page.reload()
    page.wait_for_selector('.shutter')
    check('resume after reload keeps next page number', 'p. 4' in page.inner_text('.pagebtn'))
    book_id = page.evaluate("sessionStorage.getItem('bs.currentBook')")
    page.goto(f'{base}/#/books/{book_id}/pages')
    page.wait_for_selector('.tiles .tile')
    n = page.locator('.tiles .tile').count()
    check('gallery shows 3 pages', n == 3, str(n))
    check('pages say OCR queued (not done)', page.locator('.tile .b-queued').count() == 3)
    check('pages screen warns no OCR worker', 'No OCR worker is running' in page.inner_text('main'))
    imgs_ok = page.evaluate("Promise.all([...document.querySelectorAll('.thumb img')].map(i => i.decode().then(() => i.naturalWidth > 0).catch(() => false)))")
    check('thumbnails load through authorized endpoint', all(imgs_ok), str(imgs_ok))

    page_id = page.get_attribute('.tiles .tile a', 'href').split('/')[2]
    anon = browser.new_context().new_page()
    r = anon.goto(f'{base}/api/pages/{page_id}/image?variant=thumb')
    check('image denied without login', r.status == 401, str(r.status))

    page.click('text=Run OCR in this browser')
    page.wait_for_selector('text=Start OCR worker')
    t0 = time.time()
    page.click('text=▶ Start OCR worker')
    page.wait_for_function("document.querySelector('[role=status]').textContent.includes('No queued pages')", timeout=240000)
    check('worker processed the automatic queue', True, f'{time.time() - t0:.1f}s')
    st = page.evaluate(f"fetch('/api/books/{book_id}/ocr/status').then(r => r.json())")
    check('server sees active worker', st['worker_active'] and st['done'] == 3, json.dumps({k: st[k] for k in ('queued', 'leased', 'done', 'worker_active')}))
    page.click('text=■ Stop')

    page.goto(f'{base}/#/pages/{page_id}/review')
    page.wait_for_selector('.rcard textarea')
    texts = page.eval_on_selector_all('.rcard textarea', 'els => els.map(e => e.value)')
    check('original column OCR text (Maranao only)', 'Bembaran' in texts[0] and 'datu' in texts[0] and 'chieftains' not in texts[0], repr(texts[0][:80]))
    check('translation column OCR text (English only)', 'chieftains' in texts[1] and 'datu' not in texts[1], repr(texts[1][:80]))
    check('verse line breaks preserved', texts[0].count('\n') >= 3, str(texts[0].count('\n')))

    page.fill('.rcard:nth-of-type(1) textarea', texts[0] + '\n[corrected]')
    page.locator('.rcard').first.locator('text=Save text').click()
    page.wait_for_timeout(600)
    orig = page.evaluate(f"fetch('/api/books/{book_id}/export.txt?mode=original&download=0').then(r => r.text())")
    trans = page.evaluate(f"fetch('/api/books/{book_id}/export.txt?mode=translation&download=0').then(r => r.text())")
    check('original-only export', 'Bembaran' in orig and 'chieftains' not in orig and '[corrected]' in orig)
    check('translation-only export', 'chieftains' in trans and 'datu' not in trans)
    full = page.evaluate(f"fetch('/api/books/{book_id}/export.txt?mode=full&download=0').then(r => r.text())")
    check('full export ordered by page', full.index('Page 1 ') < full.index('Page 2 ') < full.index('Page 3 '))
    js = json.loads(page.evaluate(f"fetch('/api/books/{book_id}/export.json?download=0').then(r => r.text())"))
    r0 = js['pages'][0]['regions'][0]
    check('JSON keeps raw OCR and correction separately', r0['text_source'] == 'correction' and len(r0['ocr_results']) == 1 and '[corrected]' not in r0['ocr_results'][0]['text'])
    check('no JS errors', not errors, '; '.join(errors[:3]))
    page.goto(f'{base}/#/books/{book_id}/scan')
    page.wait_for_selector('.shutter')
    page.wait_for_timeout(1200)
    page.screenshot(path='/tmp/bs-e2e/scan.png')
    browser.close()

failed = [r for r in results if not r[1]]
print(f'\n{len(results) - len(failed)}/{len(results)} checks passed')
sys.exit(1 if failed else 0)
