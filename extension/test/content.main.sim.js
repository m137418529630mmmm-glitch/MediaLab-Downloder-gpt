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

// ---- scenario: the page's own video: the button does not blink while it loads
const hosts = () => body.parentNode.children.filter((x) => x.attrs && x.attrs.popover);
const shownHosts = () => hosts().filter((h) => h.style.display === "block");
let ok = true; const check = (c, m) => { console.log((c ? "ok   " : "FAIL ") + m); if (!c) ok = false; };
function move(el, x, y) { const e = new Ev("mousemove", { clientX: x, clientY: y, target: el }); e._path = [el, body, html]; (wl.mousemove || []).forEach((f) => f(e)); }
const big = new El("video"); big.rect = { left: 100, top: 80, right: 900, bottom: 530, width: 800, height: 450 }; big.paused = false; big.duration = 60; body.appendChild(big);
advance(1500);
check(shownHosts().length === 1, "a button on the page's own playing video");
big.paused = true; advance(700);
check(shownHosts().length === 1, "it stays while the video is loading (not playing for a moment)");
const keepRect = big.rect; big.rect = { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 }; advance(400);
check(shownHosts().length === 1, "and while the video's size blinks");
big.rect = keepRect; advance(400);
check(shownHosts().length === 1, "and after");
big.rect = { left: 100, top: -900, right: 900, bottom: -450, width: 800, height: 450 }; advance(300);
check(shownHosts().length === 0, "gone at once when the video is scrolled away (not a blip)");
// ---- a click in the page (the add-in tells the background which keys are held): no TypeError on `.catch`
let clickErr = null;
try { const e = new Ev("mousedown", { clientX: 5, clientY: 5, target: body, altKey: false, ctrlKey: false, shiftKey: false }); e._path = [body, html]; (wl.mousedown || []).forEach((f) => f(e)); advance(2000); } catch (e) { clickErr = e; }
check(!clickErr, "a click and the page being watched throw no error" + (clickErr ? ": " + clickErr.message : ""));
// ---- a site with no rule: a picture card that links to /stock-video/…
const card = new El("a"); card.attrs.href = "https://example.org/stock-video/mommy-and-baby-hands-155903/"; card.rect = { left: 400, top: 120, right: 880, bottom: 360, width: 480, height: 240 };
const img = new El("img"); img.rect = { left: 400, top: 120, right: 880, bottom: 360, width: 480, height: 240 }; card.appendChild(img); body.appendChild(card);
big.rect = { left: 0, top: -900, right: 800, bottom: -450, width: 800, height: 450 };
const m2 = (el, path) => { const e = new Ev("mousemove", { clientX: 500, clientY: 200, target: el }); e._path = path; (wl.mousemove || []).forEach((f) => f(e)); };
advance(300); m2(img, [img, card, body, html]); advance(400);
check(shownHosts().length === 1, "a button on a picture card of any site (its link says it is a video's page)");
// the add-in is gone and "chrome.runtime" with it: nothing throws (the TypeError of the console)
big.rect = { left: 100, top: 80, right: 900, bottom: 530, width: 800, height: 450 }; advance(800);
chrome.runtime = undefined;
let threw = null;
try { move(big, 300, 200); advance(1500); move(body, 700, 600); advance(1500); } catch (e) { threw = e; }
check(!threw, "no error when chrome.runtime is gone" + (threw ? ": " + threw.message : ""));
check(shownHosts().length === 0, "and no button is left");
console.log(ok ? "content (own video) simulation: all checks passed" : "content (own video) simulation: FAILED");
process.exit(ok ? 0 : 1);
