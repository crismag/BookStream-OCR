"""End-to-end smoke test in real Chrome with a fake camera feeding a synthetic page.

Usage:  python3 e2e/smoke.py http://127.0.0.1:8080 /tmp/bs-e2e/parallel.y4m <setup-token>
Covers: setup → create book → camera capture ×3 → upload confirmed → reload/resume →
OCR queue → in-browser Tesseract worker → review text → language-selective export.
"""
import json, re, sys, time
from playwright.sync_api import sync_playwright

base, y4m, token = sys.argv[1], sys.argv[2], sys.argv[3]
results = []

def check(name, cond, detail=''):
    results.append((name, bool(cond), detail))
    print(('PASS ' if cond else 'FAIL ') + name + (f' — {detail}' if detail else ''), flush=True)

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
    cam = page.inner_text('.caminfo')
    check('camera opened (fake device)', True, cam)

    for i in range(3):
        page.click('.shutter')
        page.wait_for_timeout(700)
    page.wait_for_function("document.querySelector('.queuestat').textContent.includes('All uploaded')", timeout=30000)
    check('3 captures uploaded and confirmed', True, page.inner_text('.queuestat'))
    label = page.inner_text('.pagebtn')
    check('page number auto-advanced to 4', 'Page 4' in label, label)

    # reload → resume keeps numbering, nothing pending
    page.reload()
    page.wait_for_selector('.shutter')
    label = page.inner_text('.pagebtn')
    check('resume after reload keeps next page number', 'Page 4' in label, label)
    page.click('text=✓ Finish')
    page.wait_for_selector('.tiles .tile')
    n = page.locator('.tiles .tile').count()
    check('gallery shows 3 pages', n == 3, str(n))
    imgs_ok = page.evaluate("Promise.all([...document.querySelectorAll('.thumb img')].map(i => i.decode().then(() => i.naturalWidth > 0).catch(() => false)))")
    check('thumbnails load through authorized endpoint', all(imgs_ok), str(imgs_ok))

    # anonymous access to images must fail
    page_id = page.get_attribute('.tiles .tile a', 'href').split('/')[2]
    anon = browser.new_context().new_page()
    r = anon.goto(f'{base}/api/pages/{page_id}/image?variant=thumb')
    check('image denied without login', r.status == 401, str(r.status))
    r = anon.goto(f'{base}/storage/')
    check('storage not web-reachable', r.status != 200 or 'BookStream' in anon.content(), str(r.status))

    page.click('text=⚙ Queue OCR')
    page.wait_for_timeout(800)
    page.goto(base + '/#/process')
    page.wait_for_selector('text=Start OCR worker')
    t0 = time.time()
    page.click('text=▶ Start OCR worker')
    page.wait_for_function("document.querySelector('[role=status]').textContent.includes('No queued pages')", timeout=240000)
    check('browser OCR processed queue', True, f'{time.time() - t0:.1f}s')
    page.click('text=■ Stop')

    page.goto(f'{base}/#/pages/{page_id}/review')
    page.wait_for_selector('.rcard textarea')
    texts = page.eval_on_selector_all('.rcard textarea', 'els => els.map(e => e.value)')
    check('original region OCR text', 'Bembaran' in texts[0] and 'datu' in texts[0], repr(texts[0][:120]))
    check('translation region OCR text', 'chieftains' in texts[1], repr(texts[1][:120]))
    check('verse line breaks preserved', texts[0].count('\n') >= 3, str(texts[0].count('\n')))
    check('inferred pair shown', page.locator('.rcard .b-inferred').count() == 2)

    # correction + export
    page.fill('.rcard:nth-of-type(1) textarea', texts[0] + '\n[corrected]')
    page.locator('.rcard').first.locator('text=Save text').click()
    page.wait_for_timeout(600)
    book_id = page.evaluate("sessionStorage.getItem('bs.currentBook')")
    orig = page.evaluate(f"fetch('/api/books/{book_id}/export.txt?mode=original&download=0').then(r => r.text())")
    trans = page.evaluate(f"fetch('/api/books/{book_id}/export.txt?mode=translation&download=0').then(r => r.text())")
    check('original-only export has Maranao, not English', 'Bembaran' in orig and 'chieftains' not in orig and '[corrected]' in orig)
    check('translation-only export has English only', 'chieftains' in trans and 'datu' not in trans)
    tsv = page.evaluate(f"fetch('/api/books/{book_id}/export.txt?mode=parallel&format=tsv&download=0').then(r => r.text())")
    check('parallel TSV has 3 pair rows + header', len(tsv.strip().split('\n')) == 4, str(len(tsv.strip().split('\n'))))
    js = json.loads(page.evaluate(f"fetch('/api/books/{book_id}/export.json?download=0').then(r => r.text())"))
    r0 = js['pages'][0]['regions'][0]
    check('JSON keeps OCR and correction separately', r0['text_source'] == 'correction' and len(r0['ocr_results']) == 1 and '[corrected]' not in r0['ocr_results'][0]['text'])
    check('no JS errors', not errors, '; '.join(errors[:3]))
    page.screenshot(path='/tmp/bs-e2e/review.png', full_page=True)
    page.goto(f'{base}/#/books/{book_id}/scan')
    page.wait_for_selector('.shutter')
    page.wait_for_timeout(800)
    page.screenshot(path='/tmp/bs-e2e/scan.png')
    browser.close()

failed = [r for r in results if not r[1]]
print(f'\n{len(results) - len(failed)}/{len(results)} checks passed')
sys.exit(1 if failed else 0)
