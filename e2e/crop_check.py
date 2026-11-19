"""Auto-crop + guide-crop e2e: fake camera shows a rotated page on a dark desk.
Usage: python3 e2e/crop_check.py <base> /tmp/bs-e2e/tabletop.y4m <user> <password>
Assumes the account and at least one book exist (run smoke.py first)."""
import sys
from playwright.sync_api import sync_playwright

base, y4m, user, pw = sys.argv[1:5]
ok = True
def check(name, cond, detail=''):
    global ok
    ok &= bool(cond)
    print(('PASS ' if cond else 'FAIL ') + name + (f' — {detail}' if detail else ''), flush=True)

with sync_playwright() as p:
    b = p.chromium.launch(executable_path='/usr/bin/google-chrome', args=['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', f'--use-file-for-fake-video-capture={y4m}'])
    page = b.new_context(viewport={'width': 412, 'height': 915}, is_mobile=True, has_touch=True).new_page()
    errs = []
    page.on('pageerror', lambda e: errs.append(str(e)))
    page.goto(base + '/')
    page.fill('input[name=username]', user); page.fill('input[name=password]', pw); page.click('button[type=submit]')
    page.wait_for_selector('text=Resume scanning')
    page.evaluate("() => { localStorage.setItem('bs2.minimal', '0'); localStorage.setItem('bs2.crop', 'auto'); localStorage.setItem('bs2.preset', 'balanced'); }")
    page.locator('text=Resume scanning').first.click()
    page.wait_for_function("document.querySelector('.hint') && document.querySelector('.hint').textContent.includes('page edges found')", timeout=20000)
    check('Enhanced: live outline detects page edges (worker)', True, page.inner_text('.hint'))
    def capture_info():
        before = page.inner_text('.lastind')
        page.click('.shutter')
        page.wait_for_function(f"document.querySelector('.lastind').textContent.length > 0 && document.querySelector('.lastind').textContent !== {before!r}", timeout=20000)
        return page.inner_text('.lastind')
    info = capture_info()
    check('auto crop applied', 'cropped (auto)' in info, info)
    w, h = [int(x) for x in info.split(' ')[0].split('×')]
    check('cropped to page shape, smaller than frame', w < 1800 and 1.2 < w / h < 1.45, f'{w}x{h}')
    # Guide crop: switch crop chip until it says guide
    while 'guide' not in page.inner_text('.chips'):
        page.click('.chips button:nth-child(2)')
    info = capture_info()
    check('guide crop applied', 'cropped (guide)' in info, info)
    # Minimal mode: auto crop unavailable, falls back to guide; no detection
    page.click('text=◉ Enhanced')
    check('Minimal mode shown', 'Minimal' in page.inner_text('.chips'))
    page.wait_for_function("document.querySelector('.statusbar').textContent.includes('all uploaded')", timeout=30000)
    book = page.evaluate("sessionStorage.getItem('bs.currentBook')")
    pages = page.evaluate(f"fetch('/api/books/{book}/pages').then(r => r.json())")['pages']
    pid = pages[-2]['id']  # the auto-cropped capture
    page.goto(f'{base}/#/pages/{pid}/review')
    page.wait_for_selector('text=OCR this page now')
    page.click('text=OCR this page now')
    page.wait_for_function("[...document.querySelectorAll('.rcard textarea')].some(t => t.value.includes('Bembaran'))", timeout=120000)
    texts = page.eval_on_selector_all('.rcard textarea', 'els => els.map(e => e.value)')
    check('OCR on cropped+straightened page keeps both columns apart', 'datu' in texts[0] and 'chieftains' in texts[1] and 'chieftains' not in texts[0], repr(texts[0][:50]))
    # manual crop correction
    page.click('text=Page tools')
    page.click('text=✂ Adjust crop')
    page.wait_for_selector('.cropbox')
    page.click('text=Save crop')
    page.on('dialog', lambda d: d.dismiss())
    page.wait_for_timeout(800)
    crop = page.evaluate(f"fetch('/api/pages/{pid}').then(r => r.json()).then(d => d.page.crop_region)")
    check('manual crop correction saved (non-destructive)', crop is not None and crop['w'] > 0.5, str(crop))
    page.goto(f'{base}/#/books/{book}/scan'); page.wait_for_timeout(1500)
    page.screenshot(path='/tmp/bs-e2e/scan-crop.png')
    check('no JS errors', not errs, '; '.join(errs[:2]))
    b.close()
sys.exit(0 if ok else 1)
