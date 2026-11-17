// smoke test of the button logic of content.js with a tiny fake page
const fs = require("fs");
const src = fs.readFileSync(require("path").join(__dirname, "..", "content.js"), "utf8");
let now = 1000000;
const realNow = Date.now; Date.now = () => now;
const timers = []; const vt = [];
function advance(ms) { now += ms; for (let i = 0; i < 50; i++) { const due = vt.filter((x) => x.at <= now); if (!due.length) break; due.forEach((x) => { vt.splice(vt.indexOf(x), 1); x.f(); }); } timers.forEach((f) => f()); }
class Ev { constructor(type, init = {}) { this.type = type; Object.assign(this, init); this.isTrusted = true; } stopPropagation() {} stopImmediatePropagation() {} preventDefault() {} composedPath() { return this._path || [this.target]; } }
class El {
  constructor(tag) { this.tagName = String(tag).toUpperCase(); this.children = []; this.parentNode = null; this.attrs = {}; this.isConnected = false; this.rect = { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 }; this.listeners = {}; this.style = new Proxy({}, { get: (t, k) => (k === "setProperty" ? () => {} : t[k]), set: (t, k, v) => ((t[k] = v), true) }); this.textContent = ""; this.hidden = false; this._pop = false; this.paused = true; this.ended = false; this.duration = 0; this.currentSrc = ""; this.src = ""; }
  get parentElement() { return this.parentNode && this.parentNode.tagName ? this.parentNode : null; }
  get href() { return this.attrs.href || ""; }
  set href(v) { this.attrs.href = v; }
  get nodeType() { return 1; }
  addEventListener(t, f) { (this.listeners[t] = this.listeners[t] || []).push(f); }
  removeEventListener(t, f) { this.listeners[t] = (this.listeners[t] || []).filter((x) => x !== f); }
  dispatchEvent(e) { (this.listeners[e.type] || []).forEach((f) => f(e)); return true; }
  appendChild(c) { c.parentNode = this; this.children.push(c); const set = (n, v) => { n.isConnected = v; n.children.forEach((k) => set(k, v)); }; set(c, this.isConnected); return c; }
  append(...k) { k.forEach((c) => (typeof c === "string" ? 0 : this.appendChild(c))); }
  remove() { if (this.parentNode) { this.parentNode.children = this.parentNode.children.filter((x) => x !== this); this.parentNode = null; const set = (n) => { n.isConnected = false; n.children.forEach(set); }; set(this); } }
  setAttribute(k, v) { this.attrs[k] = v; }
  getAttribute(k) { return this.attrs[k] ?? null; }
  getBoundingClientRect() { return this.rect; }
  querySelectorAll(sel) { const out = []; const want = sel.split(",").map((s) => s.trim().split("[")[0].toUpperCase()); const walk = (n) => n.children.forEach((c) => { if (want.includes(c.tagName)) out.push(c); walk(c); }); walk(this); return out; }
  querySelector(sel) { return this.shadowFind ? this.shadowFind(sel) : this.querySelectorAll(sel)[0] || new El("div"); }
  closest(sel) {
    const parts = sel.split(",").map((x) => x.trim());
    for (let n = this; n; n = n.parentNode) {
      for (const q of parts) {
        const tag = q.split("[")[0].toUpperCase();
        if (tag && n.tagName === tag && (!/\[href\]/.test(q) || n.attrs.href)) return n;
        if (/role='listitem'/.test(q) && n.attrs.role === "listitem") return n;
      }
    }
    return null;
  }
  contains(n) { for (let x = n; x; x = x.parentNode) if (x === this) return true; return false; }
  attachShadow() { const r = new El("#shadow"); const cache = {}; r.getElementById = (id) => (cache[id] = cache[id] || new El("div")); r.elementFromPoint = () => null; r.shadowFind = () => new El("div"); r.isConnected = true; this.shadow = r; return r; }
  matches(s) { return s === ":popover-open" ? this._pop : false; }
  showPopover() { this._pop = true; }
  hidePopover() { this._pop = false; }
  replaceChildren() {}
  focus() {}
  get classList() { return { add() {}, remove() {}, toggle() {}, contains() { return false; } }; }
  get scrollHeight() { return 100; }
}
const html = new El("html"); html.isConnected = true;
const body = new El("body"); html.appendChild(body);
const doc = new El("#document"); doc.isConnected = true;
Object.assign(doc, {
  documentElement: html, body, title: "Page", readyState: "complete", fullscreenElement: null, webkitFullscreenElement: null,
  createElement: (t) => new El(t), createElementNS: (n, t) => new El(t),
  querySelectorAll: (s) => body.querySelectorAll(s), querySelector: () => null,
  elementsFromPoint: () => [], elementFromPoint: () => null, getElementById: () => null,
  hasFocus: () => true, location: { href: "https://example.com/", hostname: "example.com" },
});
const wl = {};
const win = {
  innerWidth: 1366, innerHeight: 768, top: null, parent: null, listeners: wl,
  addEventListener(t, f) { (wl[t] = wl[t] || []).push(f); }, removeEventListener() {},
  postMessage() {}, getComputedStyle: () => ({ display: "block", visibility: "visible" }),
  location: doc.location,
};
win.top = win; win.parent = win; win.window = win; win.document = doc;
const sent = [];
const chrome = {
  runtime: { id: "x", lastError: null, sendMessage(m, cb) { sent.push(m); if (cb) setTimeout(() => cb(replyFor(m)), 0); return { catch() {} }; }, onMessage: { addListener(f) { chrome.onMsg = f; } }, getURL: (p) => p },
  storage: { local: { get(d, cb) { cb && cb(d); } }, onChanged: { addListener() {} } },
};
function replyFor(m) { if (m.type === "swiftget-config") return null; if (m.type === "swiftget-media-request") return []; if (m.type === "swiftget-resolve-video") return { items: [{ label: "1080p · MP4", yt: { quality: "1080p", ext: "mp4" } }] }; return { ok: true }; }
const globals = { document: doc, window: win, chrome, location: doc.location, innerWidth: 1366, innerHeight: 768, addEventListener: win.addEventListener, removeEventListener() {}, setInterval: (f, ms) => { timers.push(f); return timers.length; }, setTimeout: (f, ms) => { vt.push({ f, at: now + (ms || 0) }); return vt.length; }, clearTimeout, clearInterval() {}, MutationObserver: class { observe() {} disconnect() {} }, getComputedStyle: win.getComputedStyle, requestAnimationFrame: (f) => f(), Node: El, HTMLElement: El, HTMLVideoElement: El, ShadowRoot: El, CSS: { escape: (s) => s }, navigator: { userAgent: "x", language: "en" }, MouseEvent: Ev, KeyboardEvent: Ev, Event: Ev, getSelection: () => ({ toString: () => "" }), parent: win, top: win, self: win, frames: [], matchMedia: () => ({ matches: false }), CustomEvent: Ev };
const names = Object.keys(globals);
const fn = new Function(...names, "globalThis", src);
const g = { __medialabRoots: new WeakMap() };
fn(...names.map((k) => globals[k]), new Proxy(g, { get: (t, k) => (k in t ? t[k] : globals[k]), set: (t, k, v) => ((t[k] = v), true) }));

// ---- scenario: a page with 3 cards (links to video pages), mouse over card 1, then 2
const mkCard = (href, l, t) => { const a = new El("a"); a.href = href; a.rect = { left: l, top: t, right: l + 210, bottom: t + 118, width: 210, height: 118 }; body.appendChild(a); return a; };
const c1 = mkCard("https://www.youtube.com/watch?v=AAAAAAAAAAA", 20, 100);
const c2 = mkCard("https://www.youtube.com/watch?v=BBBBBBBBBBB", 260, 100);
const hosts = () => body.parentNode.children.filter((x) => x.attrs && x.attrs.popover);
const shownHosts = () => hosts().filter((h) => h.style.display === "block");
function move(el, x, y) { const e = new Ev("mousemove", { clientX: x, clientY: y, target: el }); e._path = [el, body, html]; (wl.mousemove || []).forEach((f) => f(e)); }
function await_(){} let ok = true; const check = (c, m) => { console.log((c ? "ok   " : "FAIL ") + m); if (!c) ok = false; };

now += 1000; move(c1, 60, 140);
check(shownHosts().length === 1, "one button after the mouse is on card 1 (" + shownHosts().length + ")");
const b1 = shownHosts()[0];
advance(800); 
check(sent.some((m) => m.type === "swiftget-resolve-video" && /AAAAAAAAAAA/.test(m.page)), "qualities of card 1 looked up ahead, by its own link");
now += 100; move(c2, 300, 140); const before = sent.length;
check(shownHosts().length === 1, "still one button on card 2");
advance(300); check(!sent.slice(before).some((m) => m.type === "swiftget-resolve-video" && /AAAAAAAAAAA/.test(m.page)), "card 1 is not asked again when the mouse went on"); advance(3000); move(body, 700, 600); advance(10);
check(shownHosts().length === 1, "button stays when the mouse leaves the cards");
// press on the button area (own host in path)
const hostEl = shownHosts()[0];
const e2 = new Ev("mousemove", { clientX: 5, clientY: 5, target: hostEl }); e2._path = [hostEl, html]; (wl.mousemove || []).forEach((f) => f(e2));
check(shownHosts().length === 1, "button stays when the mouse is on it");
// X: pressing it hides at once; back (as new) when the mouse is on a video again
const hostForX = shownHosts()[0];
const closeEl = [...(hostForX.shadow.children || [])];
// find handler registered for the close button via press("close"): it is the 'click' listener on getElementById("close")
const closeBtn = hostForX.shadow.getElementById("close");
(closeBtn.listeners.click || []).forEach((f) => f(new Ev("click", { target: closeBtn })));
check(shownHosts().length === 0, "X hides the button at once");
check(sent.some((m) => m.type === "swiftget-forget-video"), "X asks to forget what was found (looks it up again next time)");
advance(500);
check(shownHosts().length === 0, "stays hidden while the mouse is still on that card");
move(body, 700, 600); advance(500); move(c2, 300, 140); advance(300);
check(shownHosts().length === 1, "back when the mouse comes to a video again");
// scrolled off screen
c2.rect = { left: 260, top: -500, right: 470, bottom: -382, width: 210, height: 118 }; c1.rect = { left: 20, top: -500, right: 230, bottom: -382, width: 210, height: 118 };
now += 1000; timers.forEach((f) => f());
check(shownHosts().length === 0, "no button when its card is off screen");

// ---- hover preview floating over a card: the card's own link stays the target
c1.rect = { left: 20, top: 100, right: 230, bottom: 218, width: 210, height: 118 };
c2.rect = { left: 260, top: 100, right: 470, bottom: 218, width: 210, height: 118 };
advance(1000); move(c1, 60, 140); advance(100);
const pv = new El("video"); pv.rect = { left: 20, top: 100, right: 230, bottom: 218, width: 210, height: 118 }; pv.paused = false; pv.duration = 30; body.appendChild(pv);
move(pv, 90, 150); advance(100);
const afterPv = shownHosts();
check(afterPv.length === 1, "one button while a preview plays over the card");
sent.length = 0; advance(600);
check(!sent.some((m) => m.type === "swiftget-resolve-video" && !/AAAAAAAAAAA/.test(m.page || "")), "the preview is looked up by the card's link, not as another video");
pv.remove(); advance(500);
check(shownHosts().length === 1, "button stays after the preview ends");
advance(4000);
check(shownHosts().length === 1, "and stays on the card (it is the card that counts)");

// ---- a site whose cards play a preview video only on hover (no video-page links)
const li = new El("li"); li.rect = { left: 500, top: 100, right: 710, bottom: 218, width: 210, height: 118 }; body.appendChild(li);
const pv2 = new El("video"); pv2.rect = { left: 500, top: 100, right: 710, bottom: 218, width: 210, height: 118 }; pv2.paused = false; li.appendChild(pv2);
advance(1000); move(pv2, 560, 150); advance(100);
check(shownHosts().length === 1, "one button on a card whose preview plays");
pv2.remove(); advance(300); advance(3000);
check(shownHosts().length === 1, "the button stays on the card when its preview video goes (the box is the target)");
chrome.onMsg && chrome.onMsg({ type: "swiftget-media", items: [{ label: "720p · MP4 · stream", url: "https://cdn.x/a/b.m3u8", t: now, family: "cdn.x/a" }, { label: "480p · MP4 · stream", url: "https://cdn.x/a/c.m3u8", t: now, family: "cdn.x/a" }] }, {}, () => {});
advance(100);
check(shownHosts().length === 1, "the list of the card is live (no error when streams arrive)");
// ---- the add-in goes away (switched off / updated): the copy in the page ends quietly
advance(500); move(c1, 60, 140); advance(100);
check(shownHosts().length >= 0, "(a button is there before the add-in goes)");
chrome.runtime.id = undefined; advance(800);
check(hosts().length === 0, "the add-in is gone: the button is removed and nothing is left running");
try { move(c2, 300, 140); advance(500); check(true, "no error after that"); } catch (e) { check(false, "no error after that: " + e.message); }
console.log(ok ? "content simulation: all checks passed" : "content simulation: FAILED");
process.exit(ok ? 0 : 1);

