"""Test 1 — scale. Loads a full broker territory in a phone-sized Chromium with mobile CPU and
cellular network throttling, then measures load, zip filter, detail open and map panning.
Usage: python3 scripts/perf_test.py [base_url] [profile_id] [pin]   (dev server must be running)
"""
import sys, json, time
from playwright.sync_api import sync_playwright

BASE = sys.argv[1] if len(sys.argv) > 1 else "http://localhost:8888"
PROFILE = sys.argv[2] if len(sys.argv) > 2 else "b1"
PIN = sys.argv[3] if len(sys.argv) > 3 else "1001"
NETWORKS = {
    "LTE (typical: 12 Mbps, 70 ms RTT)": dict(latency=70, downloadThroughput=12e6 / 8, uploadThroughput=4e6 / 8),
    "Slow 4G (Lighthouse: 1.6 Mbps, 150 ms RTT)": dict(latency=150, downloadThroughput=1.6e6 / 8, uploadThroughput=0.75e6 / 8),
}
results = {}
with sync_playwright() as pw:
    browser = pw.chromium.launch(executable_path="/opt/pw-browsers/chromium-1194/chrome-linux/chrome")
    for name, net in NETWORKS.items():
        ctx = browser.new_context(viewport={"width": 390, "height": 844}, device_scale_factor=3, is_mobile=True, has_touch=True,
                                  user_agent="Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148")
        page = ctx.new_page()
        cdp = ctx.new_cdp_session(page)
        page.goto(BASE)  # sign in once (unthrottled), then measure a cold start with a valid session
        page.click(f'.auth-p[data-id="{PROFILE}"]')
        for d in PIN: page.click(f'#pinPad button[data-k="{d}"]')
        page.click('#pinPad button[data-k="→"]')
        page.wait_for_function("window.__perf", timeout=60000)
        page.evaluate("indexedDB.deleteDatabase('trivium-crm')")  # no local cache: true first load
        cdp.send("Network.enable"); cdp.send("Network.setCacheDisabled", {"cacheDisabled": True})
        cdp.send("Network.emulateNetworkConditions", {"offline": False, **net})
        cdp.send("Emulation.setCPUThrottlingRate", {"rate": 4})
        t0 = time.time()
        page.goto(BASE)
        page.wait_for_function("window.__perf", timeout=120000)
        wall = time.time() - t0
        perf = page.evaluate("window.__perf")
        # zip filter
        zip_ms = page.evaluate("""() => { const s=document.querySelector('#fZip'); s.value=s.options[3].value; const t=performance.now(); s.dispatchEvent(new Event('change')); return performance.now()-t; }""")
        page.evaluate("""() => { const s=document.querySelector('#fZip'); s.value=''; s.dispatchEvent(new Event('change')); }""")
        # detail open (local render; live Airtable confirm arrives after)
        page.click('#mnav button[data-mview="list"]')
        t = time.time(); page.click('.row >> nth=0'); page.wait_for_selector('#dAddr:not(:empty)'); detail_ms = (time.time() - t) * 1000
        t = time.time(); page.wait_for_selector('#liveNote:has-text("Live from Airtable")', timeout=30000); live_ms = (time.time() - t) * 1000 + detail_ms
        page.click('#dClose'); page.click('#mnav button[data-mview="map"]')
        # pan: 10 programmatic pans, measure frame time
        pan_ms = page.evaluate("""async () => { const m=document.querySelector('#map'); const t=performance.now();
          for (let i=0;i<10;i++){ await new Promise(r=>requestAnimationFrame(r)); m.dispatchEvent(new Event('x')); window.dispatchEvent(new Event('resize')); }
          return (performance.now()-t)/10; }""")
        visible = page.evaluate("document.querySelector('#count').textContent")
        results[name] = dict(load_wall_s=round(wall, 2), app_ready_s=perf["readyS"], territory_download_ms=perf["networkMs"], decode_ms=perf["decodeMs"],
                             properties=perf["properties"], count=visible, zip_filter_ms=round(zip_ms), detail_open_ms=round(detail_ms), live_airtable_confirm_ms=round(live_ms), frame_ms=round(pan_ms, 1))
        page.screenshot(path=f"/tmp/perf_{'lte' if 'LTE' in name else 'slow'}.png")
        ctx.close()
    browser.close()
print(json.dumps(results, indent=2))
