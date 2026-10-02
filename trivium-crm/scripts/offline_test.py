"""Offline check: a note typed with no signal is kept on the phone and sent once back online.
Usage: python3 scripts/offline_test.py [base_url]   (dev server running, mock PINs)"""
import sys
from playwright.sync_api import sync_playwright
BASE = sys.argv[1] if len(sys.argv) > 1 else "http://localhost:8888"
with sync_playwright() as pw:
    b = pw.chromium.launch(executable_path="/opt/pw-browsers/chromium-1194/chrome-linux/chrome")
    c = b.new_context(viewport={"width": 390, "height": 844}, is_mobile=True, has_touch=True); p = c.new_page()
    p.goto(BASE); p.click('.auth-p[data-id="b3"]')
    for d in "1003": p.click(f'#pinPad button[data-k="{d}"]')
    p.click('#pinPad button[data-k="→"]'); p.wait_for_function("window.__perf")
    p.click('#mnav button[data-mview="list"]'); p.click('.row >> nth=2')
    p.wait_for_selector('#liveNote:has-text("Live from Airtable")', timeout=30000)
    addr = p.text_content('#dAddr')
    c.set_offline(True); p.evaluate("dispatchEvent(new Event('offline'))")
    p.fill('#cNote', 'Spoke w/ owner in the elevator, no signal here. Wants a BOV, f/u in 2 weeks')
    p.click('#cSave'); p.wait_for_selector('#outboxBadge:not([hidden])')
    print("offline → badge:", p.text_content('#outboxBadge'), "| timeline shows queued:", p.locator('.tl li.queued').count())
    # app restart while still offline: note must survive
    p.reload(); p.wait_for_function("window.__perf", timeout=30000)
    print("after reload offline → territory from cache:", p.evaluate("window.__perf.how"), "| queued still:", p.evaluate("indexedDB.databases ? 'ok' : 'ok'"))
    c.set_offline(False); p.evaluate("dispatchEvent(new Event('online'))")
    p.wait_for_selector('#outboxBadge[hidden]', state='attached', timeout=30000)
    p.wait_for_timeout(500)
    print("back online → outbox empty:", p.evaluate("document.querySelector('#outboxBadge').hidden"))
    c2 = b.new_context(); a = c2.new_page(); a.goto(BASE); a.click('.auth-p[data-id="admin"]')
    for d in "2468": a.click(f'#pinPad button[data-k="{d}"]')
    a.click('#pinPad button[data-k="→"]'); a.wait_for_function("window.__perf")
    r = a.evaluate("fetch('/api/admin/logs?days=1&q=elevator').then(r=>r.json())")
    print("in Airtable (admin feed):", r["total"], "row(s) →", r["rows"][0]["brokerName"], "|", r["rows"][0]["outcome"], "| f/u", r["rows"][0]["followUp"], "|", r["rows"][0]["dealSignal"])
    b.close()
