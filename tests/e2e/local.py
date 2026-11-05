"""Local (offline, two players on one screen) regression in a real browser: the merge must not have changed local play. Run: python3 tests/e2e/local.py"""
import subprocess, sys, os
from pathlib import Path
from playwright.sync_api import sync_playwright
HERE = Path(__file__).parent; PORT = os.environ.get("PORT", "8766"); BASE = f"http://localhost:{PORT}"
passed = failed = 0
def ok(c, m):
    global passed, failed
    if c: passed += 1
    else: failed += 1; print("  FAIL:", m)
srv = subprocess.Popen(["node", str(HERE / "server.mjs")], env={**os.environ, "PORT": PORT}, stdout=subprocess.PIPE, text=True); srv.stdout.readline()
errors = []
try:
    with sync_playwright() as p:
        br = p.chromium.launch(); ctx0 = br.new_context(viewport={"width": 1280, "height": 800}); ctx0.add_init_script("try{if(!sessionStorage.getItem('fd')){localStorage.setItem('scrabble.firstdraw','off');}}catch(e){}"); pg = ctx0.new_page()
        pg.on("pageerror", lambda e: errors.append(str(e))); pg.on("console", lambda m: errors.append(m.text) if m.type == "error" else None)
        ev = lambda expr: pg.evaluate("async () => { const m = await import('/js/state.js'); const {S, app} = m; return (" + expr + ") }")
        pg.goto(BASE + "/"); pg.wait_for_selector("#coverPlay"); pg.click("#coverPlay")
        pg.wait_for_selector("#md[open]"); pg.click("#mf .btn >> nth=0"); pg.wait_for_selector("#sd[open]"); pg.click("#sf .btn >> nth=2")
        pg.wait_for_selector("#dlg[open]"); pg.click("#dF .btn >> nth=0")
        pg.wait_for_function("document.querySelectorAll('#rk0 .tile').length===7")
        ok(not ev("!!app.net"), "local play: no online session")
        ok(pg.locator("html[data-online]").count() == 0 and pg.locator("#bUndo").is_visible() and pg.locator("#bNew").is_visible(), "local play still shows Undo and New game")
        ok(pg.locator("#netBar").is_hidden() and pg.locator("#lobby").is_hidden(), "no online UI in local play")
        ok(ev("!!document.querySelector('.pname bdi')") , "names are editable spans as before")
        blanks = ev("S.players[0].rack.map(t => !!(t && t.blank))"); idx = [i for i, b in enumerate(blanks) if not b][:2]
        for k, i in enumerate(idx):
            pg.click(f"#rk0 .slot:nth-child({i + 1}) .tile"); pg.click(f"#board > .sq:nth-child({7 * 15 + 7 + k + 1})")
        pg.click("#bSubmit"); pg.wait_for_function("document.getElementById('sc0').textContent!=='0'")
        ok(ev("S.cur") == 1 and ev("S.undo") is not None, "turn passed, undo available")
        pg.click("#bUndo"); pg.wait_for_selector("#dlg[open]"); pg.click("#dF .danger"); pg.wait_for_function("document.getElementById('sc0').textContent==='0'")
        ok(ev("S.cur") == 0, "undo works")

        # ---- unlimited undo: every action (move, pass, swap) can be taken back, step by step ----
        def play(player, col, n=1):
            blanks = ev(f"S.players[{player}].rack.map(t => !!(t && t.blank))"); idx = [i for i, b in enumerate(blanks) if not b][:n]
            for k, i in enumerate(idx):
                pg.click(f"#rk{player} .slot:nth-child({i + 1}) .tile"); pg.click(f"#board > .sq:nth-child({7 * 15 + col + k + 1})")
            pg.click("#bSubmit")
        def undo_once():
            pg.click("#bUndo"); pg.wait_for_selector("#dlg[open]"); pg.click("#dF .danger"); pg.wait_for_selector("#dlg[open]", state="hidden")
        play(0, 7, 2); pg.wait_for_function("S_cur_is(1)".replace("S_cur_is(1)", "document.getElementById('sc0').textContent!=='0'"))
        play(1, 9, 1); pg.wait_for_function("document.getElementById('sc1').textContent!=='0'")
        ok(ev("S.undoStack.length") == 2 and ev("S.cur") == 0, "two moves played: two steps of history")
        undo_once()
        ok(ev("S.cur") == 1 and ev("S.hist.length") == 1 and pg.locator("#sc1").inner_text() == "0", "first Undo takes back the second player's move")
        ok(pg.locator("#bUndo").is_enabled(), "Undo is available again straight away (it is no longer a single use)")
        undo_once()
        ok(ev("S.cur") == 0 and ev("S.hist.length") == 0 and pg.locator("#sc0").inner_text() == "0" and ev("S.undo") is None, "second Undo takes back the first player's move too")
        ok(pg.locator("#bUndo").is_disabled(), "nothing left to undo: the button is disabled")
        play(0, 7, 2); pg.wait_for_function("document.getElementById('sc0').textContent!=='0'")
        pg.click("#bPass"); pg.wait_for_function("S_dummy".replace("S_dummy", "true"))
        ok(ev("S.hist.length") == 2 and ev("S.cur") == 0, "a pass is an action too")
        undo_once()
        ok(ev("S.hist.length") == 1 and ev("S.cur") == 1, "a pass can be taken back")
        ok(pg.evaluate("async () => { const P = await import('/js/persist.js'); return P.validate(JSON.parse(JSON.stringify(P.serialise()))); }"), "the saved match (with its undo history) still validates")
        undo_once()
        ok(ev("S.hist.length") == 0 and ev("S.cur") == 0, "all the way back to the start")
        before = ev("S.players[0].rack.map(t => t && t.id).join()") + "|" + ev("S.bag.map(t => t.id).join()")
        pg.click("#bSwap"); pg.click("#rk0 .slot:nth-child(1) .tile"); pg.click("#rk0 .slot:nth-child(2) .tile"); pg.click("#bSubmit")
        pg.wait_for_function("S_x".replace("S_x", "true")); ok(ev("S.hist.length") == 1 and ev("S.hist[0].type") == "swap" and ev("S.cur") == 1, "a swap is played")
        undo_once()
        ok(ev("S.players[0].rack.map(t => t && t.id).join()") + "|" + ev("S.bag.map(t => t.id).join()") == before and ev("S.cur") == 0, "a swap can be taken back: the same tiles are on the rack and the bag is in the same order")

        # ---- rack display (Settings): always visible, or only on its owner's turn ----
        ok(pg.locator("#rk1 .tile:not(.back)").count() == 7 and pg.locator("#rk0 .tile:not(.back)").count() == 7, "default: both racks are face up")
        pg.click("#bSettings"); pg.click('#rkB button[data-v="turn"]'); pg.click("#aClose")
        ok(pg.locator("#rk0 .tile:not(.back)").count() == 7 and pg.locator("#rk1 .tile.back").count() == 7 and pg.locator("#rk1 .tile:not(.back)").count() == 0, "turn mode: only the player on turn sees their rack, the other shows card backs")
        ok(pg.evaluate("document.getElementById('rk1').innerHTML.includes('aria-label')") is False, "the hidden rack leaks no letters into the page")
        play(0, 7, 2); pg.wait_for_function("document.getElementById('sc0').textContent!=='0'")
        ok(pg.locator("#rk1 .tile:not(.back)").count() == 7 and pg.locator("#rk0 .tile.back").count() == 7, "the racks swap when the turn passes")
        pg.click("#bSettings"); pg.click('#rkB button[data-v="always"]'); pg.click("#aClose")
        ok(pg.locator("#rk0 .tile:not(.back)").count() == 7 and pg.locator("#rk1 .tile:not(.back)").count() == 7, "switching back shows both racks again")

        # ---- pause: a fixed screen button; the clocks stop, the position is hidden, a card says so ----
        ok(pg.locator("#t0").get_attribute("role") is None and pg.locator("#t1").get_attribute("role") is None, "a clock is only a clock: it is not a button any more")
        pg.click("#t1"); pg.wait_for_timeout(300); ok(pg.locator("#mOv[data-kind=pause]:not([hidden])").count() == 0, "clicking a clock does not pause")
        # v5.5: the pause button is fixed to the SCREEN (js/pausefab.js), independent of racks, panels and layout
        fab = lambda: pg.evaluate("(() => { const r = document.getElementById('pauseFab').getBoundingClientRect(); return [Math.round(r.x), Math.round(innerHeight - r.bottom), Math.round(r.width), Math.round(r.height)] })()")   # [left, gap to the bottom edge, w, h]
        pg.wait_for_selector("#pauseFab:not([hidden])"); f0 = fab()
        ok(f0 == [8, 8, 44, 44], f"the pause button sits in the bottom-left screen corner: {f0}")
        ok(pg.evaluate("getComputedStyle(document.getElementById('pauseFab')).position") == "fixed" and pg.evaluate("!document.getElementById('pauseFab').closest('.app, .players, .rack')"), "it is fixed and lives outside the panels, racks and the layout")
        for w, h in ((390, 844), (844, 390), (800, 1280), (1280, 800)):
            pg.set_viewport_size({"width": w, "height": h}); pg.wait_for_timeout(250)
            ok(fab() == f0, f"{w}x{h}: the pause button did not move: {fab()}")
        for k in ("tight", "wide"):
            pg.evaluate("localStorage.setItem('scrabble.rackScale', '%s')" % k)
        pg.evaluate("document.documentElement.style.setProperty('--rk', '0.6')"); pg.wait_for_timeout(150); ok(fab() == f0, "changing the rack size does not move it")
        pg.evaluate("document.documentElement.style.removeProperty('--rk')")
        pg.click("#pauseFab"); pg.wait_for_selector("#mOv[data-kind=pause]:not([hidden])")
        ok(ev("S.hold") is True and "متوقفة" in pg.inner_text("#mOvT") and pg.locator("html[data-paused]").count() == 1, "pause card is up and the game is on hold")
        a = ev("S.players[S.cur].ms"); pg.wait_for_timeout(1300); b = ev("S.players[S.cur].ms")
        ok(a == b, f"the clock does not run while paused ({a} == {b})")
        ok(pg.evaluate("document.querySelector('#board').closest('.app > *').inert"), "the game is inert behind the card")
        pg.keyboard.press("Escape"); ok(pg.locator("#mOv").is_visible(), "Escape does not end a pause")
        pg.click("#mOvAct button"); pg.wait_for_selector("#mOv", state="hidden")
        c = ev("S.players[S.cur].ms"); pg.wait_for_timeout(1300); d = ev("S.players[S.cur].ms")
        ok(ev("S.hold") is False and d < c and pg.locator("html[data-paused]").count() == 0, "resume restarts the clock and shows the position again")
        pg.keyboard.press("p"); pg.wait_for_selector("#mOv[data-kind=pause]:not([hidden])"); pg.click("#mOvAct button"); pg.wait_for_selector("#mOv", state="hidden")
        ok(True, "the P key pauses too")
        pg.click("#bSettings"); pg.click("#pauseNow"); pg.wait_for_selector("#mOv[data-kind=pause]:not([hidden])"); pg.click("#mOvAct button"); pg.wait_for_selector("#mOv", state="hidden")
        ok(True, "and so does the button in Settings")
        # end of game through the real endGame(): the result card must use the v4.5 final-score rule (x2, half rounds down, no floor)
        pg.evaluate("""async () => { const {S} = await import('/js/state.js'); const G = await import('/js/game.js');
          S.players[0].score = 100; S.players[0].ms = 150000; S.players[1].score = 90; S.players[1].ms = 151000; G.endGame('time'); }""")
        pg.wait_for_selector("#dlg.result[open] .resCard")
        bb = pg.locator("#dF .btn >> nth=0").bounding_box(); vh = pg.evaluate("innerHeight")
        ok(bb and bb["y"] >= 0 and bb["y"] + bb["height"] <= vh, "local result card is on screen after an earlier floating confirm (undo)")
        txt = pg.inner_text("#dlg .res")
        ok("2 × 2" in txt.replace("\u200f", "") or "2 × 2" in txt, f"2:30 counts as 2 minutes x 2: {txt[:140]!r}")
        ok("+4" in txt and "+6" in txt, "time bonus shown as +4 (2:30 -> 2 min) and +6 (2:31 -> 3 min)")
        # ---- first turn: each player draws a tile, the higher value starts, a tie is drawn again ----
        def fresh(picks):
            c = br.new_context(viewport={"width": 1280, "height": 800}); c.add_init_script("window.__picks = %s; window.EAS_FIRSTDRAW_PICK = () => window.__picks.shift();" % picks)
            q = c.new_page(); q.on("pageerror", lambda e: errors.append(str(e)))
            q.goto(BASE + "/"); q.wait_for_selector("#coverPlay"); q.click("#coverPlay")
            q.wait_for_selector("#md[open]"); q.click("#mf .btn >> nth=0"); q.wait_for_selector("#sd[open]"); q.click("#sf .btn >> nth=2")
            q.wait_for_selector("#dlg[open]"); q.click("#dF .btn >> nth=0"); q.wait_for_selector("#fdOv.on .fdTile")
            return q
        T = lambda l, v: "{l:'%s',v:%d,blank:false}" % (l, v)
        q = fresh("[[%s,%s],[%s,%s]]" % (T("ا", 1), T("ب", 1), T("ا", 1), T("ش", 4)))   # round 1 ties (1 = 1); round 2: the second player draws the 4
        ok(q.evaluate("document.querySelector('#board').closest('.app > *').inert") and q.locator("#fdOv .fdTile.ready").count() == 2, "the draw card is up, the game is inert, both tiles wait to be tapped")
        q.click("#fdOv .fdTile >> nth=0", force=True); q.wait_for_function("document.querySelectorAll('#fdOv .fdTile.flip').length===1")
        ok(q.locator("#fdOv .fdTile.ready").count() == 1, "the first player's tile is face up, the second player has not drawn yet")
        q.click("#fdOv .fdTile >> nth=1", force=True); q.wait_for_selector("#fdOv .fdTile.tie")
        ok("تعادل" in q.inner_text("#fdOv .fdMsg"), "a tie is announced")
        q.wait_for_function("document.querySelectorAll('#fdOv .fdTile.ready').length===2 && document.querySelectorAll('#fdOv .fdTile.flip').length===0", timeout=8000)
        ok(True, "and drawn again with two fresh face-down tiles")
        q.click("#fdOv .fdTile >> nth=1", force=True); q.click("#fdOv .fdTile >> nth=0", force=True); q.wait_for_selector("#fdOv .fdSlot.win", timeout=8000)
        ok(q.evaluate("document.querySelectorAll('#fdOv .fdSlot')[1].classList.contains('win')") and "يبدأ" in q.inner_text("#fdOv .fdMsg"), "the player with the 4 wins and is announced")
        q.click("#fdOv .btn.main"); q.wait_for_selector("#fdOv", state="detached")
        cur = q.evaluate("async () => (await import('/js/state.js')).S.cur"); hold = q.evaluate("async () => (await import('/js/state.js')).S.hold")
        ok(cur == 1 and hold is False, f"the second player starts and the game is live (cur={cur})")
        ok(q.locator("#pn1.on").count() == 1, "the second player's panel is the one highlighted")
        q.context.close()
        q = fresh("[[%s,%s]]" % (T("م", 3), T("ر", 1)))
        q.keyboard.press("Tab"); q.click("#fdOv .fdTile >> nth=0", force=True); q.click("#fdOv .fdTile >> nth=1", force=True); q.wait_for_selector("#fdOv .fdSlot.win", timeout=8000)
        q.keyboard.press("Escape"); q.wait_for_selector("#fdOv", state="detached")
        ok(q.evaluate("async () => (await import('/js/state.js')).S.cur") == 0, "when the first player draws the higher tile they start; Escape closes the card after the result")
        q.context.close()
        q = fresh("[]")
        q.click("#fdOv .fdAct .btn:not(.main)"); q.wait_for_selector("#fdOv", state="detached")
        ok(q.evaluate("async () => (await import('/js/state.js')).S.hold") is False, "Skip picks at random and starts the game at once")
        q.context.close()
        # ---- support link on the cover: one tap to the donation page, in a new tab, the game untouched ----
        c = br.new_context(viewport={"width": 390, "height": 844}); c.route("https://saweria.co/**", lambda r: r.fulfill(status=200, content_type="text/html", body="<title>saweria</title>ok"))
        q = c.new_page(); q.goto(BASE + "/"); q.wait_for_selector("#coverDonate", state="visible")
        a = q.locator("#coverDonate")
        ok(a.get_attribute("href") == "https://saweria.co/esbepe83", "the donation button points at https://saweria.co/esbepe83")
        ok(a.get_attribute("target") == "_blank" and "noopener" in a.get_attribute("rel"), "it opens in a new tab and cannot reach back into the game")
        ok(q.locator("#donT").is_visible() and q.locator("#coverPlay").is_visible() and q.locator("#coverOnline").is_visible(), "the support section sits with the two ways to play")
        with q.expect_popup() as pop: a.click()
        ok(pop.value.url == "https://saweria.co/esbepe83", "tapping it goes straight to the donation page: " + pop.value.url)
        ok(q.locator("#cover").is_visible() and not q.evaluate("document.body.classList.contains('coverOn') === false"), "the game page is still on its cover, nothing started")
        bb = q.locator("#coverDonate").bounding_box()
        ok(bb and bb["y"] + bb["height"] <= 844 and bb["height"] >= 44, "the button is fully on screen and a comfortable tap target")
        c.close()
        br.close()
finally:
    srv.terminate()
real = [e for e in errors if "favicon" not in e and "manifest" not in e]
ok(not real, f"no browser errors: {real[:3]}")
print(f"{passed} passed, {failed} failed"); sys.exit(1 if failed else 0)
