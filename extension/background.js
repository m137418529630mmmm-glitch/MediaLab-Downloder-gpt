// MediaLab Downloader browser integration (Manifest V3 service worker)
//  1. takes over browser downloads and hands them to the MediaLab Downloader app
//     together with cookies + referrer, so links behind a login still work
//  2. watches network responses for video/audio and HLS streams and offers
//     a "Download this video" button on the page
//  3. Videos on web pages: the app finds the qualities with yt-dlp,
//     downloads video + audio with many connections and joins them
//  4. adds "Download with MediaLab Downloader", "Download all links with MediaLab
//     Download" and "Download video with MediaLab Downloader" to the right-click menu
//  5. follows the app's Options: file types to take, sites to leave alone,
//     the keys that skip / force MediaLab Downloader, the video panel

// Chrome / Edge / Opera load yt-core.js here; Firefox lists it in its manifest
if (typeof importScripts === "function") importScripts("yt-core.js");

// enabled: the on / off switch of the add-in's window (off = the browser
// keeps its downloads and no buttons are shown on videos)
const DEFAULTS = { port: 9614, intercept: true, minSizeKB: 0, enabled: true };

async function getOpts() {
  return Object.assign({}, DEFAULTS, await chrome.storage.local.get(DEFAULTS));
}

function apiUrl(port, path) {
  return `http://127.0.0.1:${port}${path}`;
}

// which add-in asks (its version and browser): the program tells the user
// when the Firefox add-on is older than the program and must be updated
// (Firefox keeps its own copy of the add-on)
const IS_FIREFOX = typeof navigator !== "undefined" && /Firefox\//.test(navigator.userAgent || "");
const ADDIN_HEADERS = { "X-MediaLab-Ext": chrome.runtime.getManifest().version, "X-MediaLab-Browser": IS_FIREFOX ? "firefox" : "chromium" };
// who this add-in is: the program lets it start its helper (see below)
if (!IS_FIREFOX && chrome.runtime.id) ADDIN_HEADERS["X-MediaLab-Id"] = chrome.runtime.id;

async function plainFetch(url, opts = {}, ms = 1500) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    if (/^http:\/\/127\.0\.0\.1:/.test(url)) opts = { ...opts, headers: Object.assign({}, ADDIN_HEADERS, opts.headers || {}) };
    return await fetch(url, { ...opts, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------- the program's helper
// The program puts a small helper of its own on this computer and tells the
// browser about it ("native messaging"): the browser starts it and the add-in
// talks to it through the browser itself, not over the network. Nothing the
// browser does about pages reaching this computer, and no port kept by
// another program or by Windows, stands in the way. Without the helper (an
// older program, Firefox before the user allowed it) the port is used, as
// before; when the helper can't reach the program, the port is tried too.
const HOST = "com.medialab.downloader";
// asked for by the user (a download, the program's window): the helper may
// open the program when it is closed
const START_PATHS = new Set(["/add", "/links", "/playlist", "/show", "/open-torrent"]);
let helper = null; // { port, pending, heard }
let helperOffUntil = 0;
let helperSeq = 0;
let helperQuiet = null;

async function helperAllowed() {
  if (Date.now() < helperOffUntil) return false;
  if (IS_FIREFOX) {
    // Firefox: only once the user said yes in the add-in's window
    try {
      if (!(await chrome.permissions.contains({ permissions: ["nativeMessaging"] }))) return false;
    } catch {
      return false;
    }
  }
  return typeof chrome.runtime.connectNative === "function";
}

function helperOpen() {
  if (helper) return helper;
  let port;
  try {
    port = chrome.runtime.connectNative(HOST);
  } catch {
    helperOffUntil = Date.now() + 60000;
    return null;
  }
  const me = { port, pending: new Map(), heard: false };
  port.onMessage.addListener((m) => {
    me.heard = true;
    const p = m && me.pending.get(m.id);
    if (!p) return;
    me.pending.delete(m.id);
    clearTimeout(p.timer);
    p.resolve(m);
  });
  port.onDisconnect.addListener(() => {
    void (chrome.runtime && chrome.runtime.lastError);
    if (helper === me) helper = null;
    // never said a word: there is no helper on this computer (yet)
    if (!me.heard) helperOffUntil = Date.now() + 60000;
    for (const p of me.pending.values()) {
      clearTimeout(p.timer);
      p.resolve(null);
    }
    me.pending.clear();
  });
  helper = me;
  return me;
}

/** After a quiet while the helper is let go (it ends; the browser may rest). */
function helperRestLater() {
  clearTimeout(helperQuiet);
  helperQuiet = setTimeout(() => {
    if (!helper) return;
    if (helper.pending.size) return helperRestLater();
    try {
      helper.port.disconnect();
    } catch {
      /* gone already */
    }
    helper = null;
  }, 120000);
}

function helperAsk(msg, wait) {
  return new Promise((resolve) => {
    const h = helperOpen();
    if (!h) return resolve(null);
    const id = ++helperSeq;
    const timer = setTimeout(() => {
      h.pending.delete(id);
      resolve({ id, error: "timeout" });
    }, wait + 2000);
    h.pending.set(id, { resolve, timer });
    try {
      h.port.postMessage({ ...msg, id });
    } catch {
      h.pending.delete(id);
      clearTimeout(timer);
      resolve(null);
    }
    helperRestLater();
  });
}

function helperResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => JSON.parse(body || "null"),
    text: async () => body || "",
  };
}

/** A request through the helper; null = not this way (the port is tried). */
async function viaHelper(path, opts, ms) {
  if (path === "/pair" || path === "/quit" || !(await helperAllowed())) return null;
  const start = START_PATHS.has(path) || !!opts.startApp;
  const m = await helperAsk(
    {
      method: (opts.method || "GET").toUpperCase(),
      path,
      headers: Object.assign({}, ADDIN_HEADERS, opts.headers || {}),
      body: typeof opts.body === "string" ? opts.body : null,
      ms,
      start,
    },
    // opening the program takes a few seconds
    start ? Math.max(ms, 30000) : ms
  );
  if (!m) return null;
  // the program said no to the helper's key: the add-in's own way is tried
  // (never a dead end because of the helper)
  if (m.status === 401) return null;
  if (typeof m.status === "number") {
    linkState = "ok";
    return helperResponse(m.status, m.body);
  }
  if (m.error === "timeout") {
    const e = new Error("MediaLab Downloader took too long to answer");
    e.name = "AbortError";
    throw e;
  }
  // "down" (the program is closed), "big" (an answer too big for the helper)
  return null;
}

// ---------------------------------------------------------------- the program's key
// The program listens on two ports: the known one (Options, 9614) answers
// only "are you there" and pairing; the real one is chosen at random on
// this computer. Every request to it is signed with the program's secret
// key (the key itself is never sent, and a signed request can't be sent
// again). Loaded from the program's folder, the add-in finds the key and the
// port there (token.json); otherwise (Firefox, another folder) it asks for
// them once and the user says yes in a window of the program.
let link = null; // { token, port }
const FRONT_PATHS = new Set(["/ping", "/pair", "/show", "/quit"]);

async function fromFolder() {
  try {
    const r = await fetch(chrome.runtime.getURL("token.json"), { cache: "no-store" });
    if (!r.ok) return { has: false };
    const j = await r.json();
    return { has: true, token: j.token || "", port: Number(j.port) || 0 };
  } catch {
    return { has: false };
  }
}

/** The key and the real port, or null. */
async function programLink(fresh) {
  if (link && !fresh) return link;
  const f = await fromFolder();
  if (f.has && f.token && f.port) return (link = { token: f.token, port: f.port, folder: true });
  const { appToken, appPort } = await chrome.storage.local.get(["appToken", "appPort"]);
  if (appToken && appPort) return (link = { token: appToken, port: Number(appPort), folder: false });
  link = null;
  return null;
}

let pairing = null;
async function askForKey(frontPort) {
  if (!pairing) {
    pairing = (async () => {
      try {
        // the user has up to two minutes to answer in the program
        const r = await plainFetch(apiUrl(frontPort, "/pair"), { method: "POST", headers: { "X-SwiftGet": "1" } }, 125000);
        if (!r.ok) return null;
        const j = await r.json();
        if (j.token && j.port) {
          await chrome.storage.local.set({ appToken: j.token, appPort: j.port });
          link = { token: j.token, port: Number(j.port), folder: false };
          return link;
        }
        return null;
      } catch {
        return null;
      } finally {
        setTimeout(() => (pairing = null), 1000);
      }
    })();
  }
  return pairing;
}

const enc = new TextEncoder();
const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
async function signHeaders(token, method, path) {
  const time = String(Date.now());
  const nonce = hex(crypto.getRandomValues(new Uint8Array(16)));
  const key = await crypto.subtle.importKey("raw", enc.encode(token), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = hex(await crypto.subtle.sign("HMAC", key, enc.encode(`${method}\n${path}\n${time}\n${nonce}`)));
  return { "X-MediaLab-Time": time, "X-MediaLab-Nonce": nonce, "X-MediaLab-Sig": sig };
}

/** The real port moved (it was taken at the program's start): ask where. */
async function whereNow(frontPort, l) {
  try {
    const r = await plainFetch(apiUrl(frontPort, "/where"), { headers: { "X-SwiftGet": "1", ...(await signHeaders(l.token, "GET", "/where")) } }, 1500);
    if (!r.ok) return null;
    const port = Number((await r.json()).port) || 0;
    if (!port) return null;
    if (!l.folder) await chrome.storage.local.set({ appPort: port });
    return (link = { ...l, port });
  } catch {
    return null;
  }
}

// how the connection to the program is (for the add-in's window)
let linkState = "unknown"; // "ok" | "nokey" | "down"

/** A request; to the program it goes to the real port, signed. */
async function fetchWithTimeout(url, opts = {}, ms = 1500) {
  const m = /^http:\/\/127\.0\.0\.1:(\d+)(\/[^?#]*)/.exec(url);
  if (!m) return plainFetch(url, opts, ms);
  const frontPort = Number(m[1]);
  const path = m[2];
  const helped = await viaHelper(path, opts, ms);
  if (helped) return helped;
  if (FRONT_PATHS.has(path)) return plainFetch(url, opts, ms);
  const method = (opts.method || "GET").toUpperCase();
  const send = async (l) => {
    const headers = Object.assign({}, opts.headers || {}, await signHeaders(l.token, method, path));
    return plainFetch(`http://127.0.0.1:${l.port}${path}`, { ...opts, headers }, ms);
  };
  let l = await programLink();
  if (!l) {
    // from the program's folder, the key may only be a moment late
    const f = await fromFolder();
    if (f.has) {
      await new Promise((r) => setTimeout(r, 1500));
      l = await programLink(true);
    }
    if (!l && !f.has) l = await askForKey(frontPort);
    if (!l) {
      linkState = "nokey";
      throw new TypeError("not connected to MediaLab Downloader");
    }
  }
  let r;
  try {
    r = await send(l);
  } catch (e) {
    if (e && e.name === "AbortError") throw e;
    // the real port did not answer: it may have moved
    const again = (await programLink(true)) || l;
    const moved = again.port !== l.port ? again : await whereNow(frontPort, again);
    if (!moved) {
      linkState = "down";
      throw e;
    }
    r = await send(moved);
  }
  if (r.status === 401) {
    // a new key (the program was set up again): read it again, else ask
    const f = await fromFolder();
    let again = await programLink(true);
    if (!again || (again.token === l.token && !f.has)) {
      await chrome.storage.local.remove(["appToken", "appPort"]);
      again = f.has ? null : await askForKey(frontPort);
    }
    if (again && again.token !== l.token) r = await send(again);
  }
  linkState = r.status === 401 ? "nokey" : "ok";
  return r;
}

/** The add-in's window: "Connect again" (forget the key and the port, look again). */
async function reconnect() {
  link = null;
  linkState = "unknown";
  const f = await fromFolder();
  if (!f.has) await chrome.storage.local.remove(["appToken", "appPort"]);
  const { port } = await getOpts();
  try {
    const r = await fetchWithTimeout(apiUrl(port, "/config"), { headers: { "X-SwiftGet": "1" } }, 3000);
    return r.ok;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------- a clean start
// After every update (and every reload) the add-in forgets what the old
// version kept: as if it was removed and added again. The user's choices
// (button style, size...) and a key given by pairing stay.
const OLD_KEYS = ["loadedStamp", "reloadedFor", "reloadedForStamp", "seenRepair"];
chrome.runtime.onInstalled.addListener(async (d) => {
  if (d.reason !== "install" && d.reason !== "update") return;
  try {
    await chrome.storage.session.clear();
    await chrome.storage.local.remove(OLD_KEYS.filter((k) => k !== "seenRepair"));
  } catch {
    /* nothing kept */
  }
  link = null;
  await rememberLoadedFiles();
});

// ---------------------------------------------------------------- self update
// The add-in is loaded from the program's own folder. When the program
// updates itself it brings newer add-in files along; the browser only reads
// them after a reload, so the add-in reloads itself once per new version.
//
// The version alone is not enough (a new setup of the same version brings
// changed files too): the files on the disk are compared with the files the
// browser loaded, and when they differ the add-in reloads (once for them).
const OWN_FILES = ["manifest.json", "background.js", "content.js", "yt-core.js", "popup.html", "popup.js", "options.html", "options.js"];

async function filesStamp() {
  let all = "";
  for (const name of OWN_FILES) {
    try {
      const r = await fetch(chrome.runtime.getURL(name), { cache: "no-store" });
      all += `${name}\n${await r.text()}\n`;
    } catch {
      all += `${name}\n-\n`;
    }
  }
  const sum = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(all));
  return [...new Uint8Array(sum)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// what the browser loaded: the files as they are when it (re)loads the add-in
async function rememberLoadedFiles() {
  try {
    await chrome.storage.local.set({ loadedStamp: await filesStamp() });
  } catch {
    /* nothing to compare with: the version check still works */
  }
}
chrome.runtime.onStartup.addListener(rememberLoadedFiles);

// When the add-in starts (the browser started, it was installed, updated or switched on in the
// extensions page) its scripts are put into the pages that are already open: no reload of
// the pages is needed. A copy of the script that is still alive in a page keeps working (the
// new one stands down); one of the add-in's earlier run ends by itself.
async function reinjectIntoOpenTabs() {
  let tabs = [];
  try {
    tabs = await chrome.tabs.query({ url: ["http://*/*", "https://*/*"] });
  } catch {
    return;
  }
  for (const t of tabs) {
    if (t.id == null || t.discarded || t.status === "unloaded") continue;
    if (!t.url || !/^https?:\/\//i.test(t.url) || /^https?:\/\/(chrome\.google\.com\/webstore|chromewebstore\.google\.com|addons\.mozilla\.org)/i.test(t.url)) continue;
    const target = { tabId: t.id, allFrames: true };
    try {
      await chrome.scripting.executeScript({ target, files: ["hook.js"], world: "MAIN" });
      await chrome.scripting.executeScript({ target, files: ["early.js", "content.js"] });
    } catch {
      /* a page the browser keeps closed to add-ins (its store, its own pages) */
    }
  }
}
(async () => {
  try {
    const { reinjected } = await chrome.storage.session.get("reinjected");
    if (reinjected) return; // the worker only woke up again: the pages were done at the start
    await chrome.storage.session.set({ reinjected: true });
    await reinjectIntoOpenTabs();
  } catch {
    /* no session storage: nothing to do */
  }
})();

async function followOwnFiles() {
  const { loadedStamp, reloadedForStamp } = await chrome.storage.local.get(["loadedStamp", "reloadedForStamp"]);
  if (!loadedStamp) return false;
  const now = await filesStamp();
  if (now === loadedStamp || now === reloadedForStamp) return false;
  await chrome.storage.local.set({ reloadedForStamp: now });
  chrome.runtime.reload();
  return true;
}

async function followAppVersion() {
  const last = (await chrome.storage.session.get("versionCheckAt")).versionCheckAt || 0;
  if (Date.now() - last < 60000) return;
  await chrome.storage.session.set({ versionCheckAt: Date.now() });
  try {
    if (await followOwnFiles()) return;
  } catch {
    /* fetch / crypto missing: the version check below */
  }
  const { port } = await getOpts();
  try {
    const r = await fetchWithTimeout(apiUrl(port, "/ping"), { headers: { "X-SwiftGet": "1" } }, 800);
    if (!r.ok || typeof r.json !== "function") return;
    const ping = await r.json();
    // "Repair the browser add-in" in the program: start again, clean
    const repair = Number(ping.repair) || 0;
    if (repair) {
      const { seenRepair } = await chrome.storage.local.get("seenRepair");
      if (seenRepair !== repair) {
        await chrome.storage.local.set({ seenRepair: repair });
        if (seenRepair !== undefined) {
          await chrome.storage.session.clear();
          chrome.runtime.reload();
          return;
        }
      }
    }
    const want = ping.ext;
    const have = chrome.runtime.getManifest().version;
    if (!want || want === have) return;
    // only once per version: if the files on disk did not change (the add-in
    // was loaded from somewhere else) it must not keep reloading
    const done = (await chrome.storage.local.get("reloadedFor")).reloadedFor;
    if (done === want) return;
    await chrome.storage.local.set({ reloadedFor: want });
    chrome.runtime.reload();
  } catch {
    /* the program is not running */
  }
}
followAppVersion();

// "are you there": on the known port, else on the program's own port (the
// known one may be kept by another program or by Windows); a busy computer
// may take a moment, so it is asked twice before the program is "not running"
async function appAlive() {
  const { port } = await getOpts();
  const ask = async (p, ms) => {
    try {
      const r = await plainFetch(apiUrl(p, "/ping"), { headers: { "X-SwiftGet": "1" } }, ms);
      return r.ok;
    } catch {
      return false;
    }
  };
  try {
    const h = await viaHelper("/ping", { headers: { "X-SwiftGet": "1" } }, 3000);
    if (h && h.ok) {
      followAppVersion();
      return true;
    }
  } catch {
    /* the port is asked below */
  }
  for (const ms of [1500, 4000]) {
    if (await ask(port, ms)) {
      followAppVersion();
      return true;
    }
    const l = await programLink(true);
    if (l && l.port && l.port !== port && (await ask(l.port, ms))) return true;
  }
  return false;
}

/**
 * The site's cookies as the browser sends them. `store`: the cookie store of
 * the window (a private window, a Firefox container) the file came from.
 */
async function cookieHeader(url, store) {
  try {
    const q = store ? { url, storeId: store } : { url };
    const cookies = await chrome.cookies.getAll(q);
    return cookies.map((c) => `${c.name}=${c.value}`).join("; ");
  } catch {
    return "";
  }
}

/** The cookie store of a download / a tab: a private window has its own. */
async function storeOf(item) {
  if (!item) return undefined;
  if (item.cookieStoreId) return item.cookieStoreId;
  if (!item.incognito) return undefined;
  try {
    const stores = await chrome.cookies.getAllCookieStores();
    const tabs = await chrome.tabs.query({});
    const privateTabs = new Set(tabs.filter((t) => t.incognito).map((t) => t.id));
    const s =
      stores.find((st) => (st.tabIds || []).some((id) => privateTabs.has(id))) ||
      // the private store when no private tab is open any more (the
      // download's tab closed): the one that is not the normal one
      stores.find((st) => st.id === "firefox-private") ||
      stores.find((st) => st.id !== "0" && st.id !== "firefox-default");
    return s ? s.id : undefined;
  } catch {
    return undefined;
  }
}

/** The site's cookies for the app, only used if the site asks for a login. */
async function cookieList(url) {
  try {
    const list = await chrome.cookies.getAll({ url });
    return list.map((c) => ({
      domain: c.domain,
      name: c.name,
      value: c.value,
      path: c.path || "/",
      secure: !!c.secure,
      expirationDate: c.expirationDate || null,
    }));
  } catch {
    return [];
  }
}

function isYoutube(url) {
  try {
    return /(^|\.)youtube\.com$|^youtu\.be$/i.test(new URL(url).hostname);
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------- protected videos
// A video protected by its site (DRM): no program can download it. The
// message says so plainly, in the browser's language.
const DRM_TEXTS = {
  ar: "🔒 الفيديو ده محمي من صاحب الموقع (DRM) ومينفعش يتحمّل بأي برنامج تحميل. تقدر تتفرج عليه من الموقع بس.",
  fr: "🔒 Cette vidéo est protégée par son site (DRM) : aucun programme ne peut la télécharger. Elle se regarde seulement sur le site.",
  es: "🔒 Este vídeo está protegido por su sitio (DRM): ningún programa puede descargarlo. Solo se puede ver en el sitio.",
  de: "🔒 Dieses Video ist von seiner Seite geschützt (DRM): Kein Programm kann es herunterladen. Es lässt sich nur auf der Seite ansehen.",
  pt: "🔒 Este vídeo é protegido pelo site (DRM): nenhum programa consegue baixá-lo. Ele só pode ser assistido no site.",
  tr: "🔒 Bu video sitesi tarafından korunuyor (DRM): hiçbir program indiremez. Yalnızca sitede izlenebilir.",
  ru: "🔒 Это видео защищено сайтом (DRM): ни одна программа не может его скачать. Его можно смотреть только на сайте.",
  en: "🔒 This video is protected by its site (DRM): no download program can save it. It can only be watched on the site.",
};
// Telegram Web plays its videos through its own page (a "stream" address
// that exists only inside that page): no program can download it from
// outside, Telegram's own download button can.
const TELEGRAM_TEXTS = {
  ar: "الفيديو ده في تيليجرام ويب مينفعش يتحمّل من برا الصفحة. نزّله من زرار التحميل بتاع تيليجرام نفسه (⋮ ← تنزيل).",
  fr: "Cette vidéo de Telegram Web ne peut pas être téléchargée hors de la page. Utilisez le bouton de téléchargement de Telegram (⋮ → Télécharger).",
  es: "Este vídeo de Telegram Web no se puede descargar fuera de la página. Usa el botón de descarga de Telegram (⋮ → Descargar).",
  de: "Dieses Video in Telegram Web lässt sich nicht außerhalb der Seite laden. Nutze den Download-Knopf von Telegram (⋮ → Herunterladen).",
  pt: "Este vídeo do Telegram Web não pode ser baixado fora da página. Use o botão de download do próprio Telegram (⋮ → Baixar).",
  tr: "Telegram Web'deki bu video sayfanın dışından indirilemez. Telegram'ın kendi indirme düğmesini kullanın (⋮ → İndir).",
  ru: "Это видео в Telegram Web нельзя скачать вне страницы. Используйте кнопку загрузки самого Telegram (⋮ → Скачать).",
  en: "This Telegram Web video can't be downloaded outside the page. Use Telegram's own download button (⋮ → Download).",
};
const isTelegramStream = (url) => /^https:\/\/web\.telegram\.org\/(?:[a-z]\/)?stream\//i.test(url || "");
function telegramText() {
  const lang = String((navigator.language || "en")).slice(0, 2).toLowerCase();
  return TELEGRAM_TEXTS[lang] || TELEGRAM_TEXTS.en;
}
const isDrm = (text) => /\bDRM\b|drm protected|widevine|playready/i.test(text || "");
function drmText() {
  const lang = String((navigator.language || "en")).slice(0, 2).toLowerCase();
  return DRM_TEXTS[lang] || DRM_TEXTS.en;
}

// ---------------------------------------------------------------- the browser's own request
// What the browser sent for a file a moment ago (some sites let only exactly
// that request in: the right Accept-Language, Sec-Fetch-*, client hints...).
// The download is handed over with the same headers. Kept in memory for two
// minutes: the download starts right after its request.
const SENT_HEADERS = new Map();
const KEEP_HEADERS = /^(accept-language|sec-fetch-(site|mode|dest|user)|sec-ch-ua(-mobile|-platform)?|origin|referer|user-agent|cookie|x-requested-with)$/i;
function rememberRequest(d) {
  if (!d.requestHeaders || !/^https?:/i.test(d.url)) return;
  const kept = d.requestHeaders.filter((h) => KEEP_HEADERS.test(h.name) && typeof h.value === "string");
  if (!kept.length) return;
  SENT_HEADERS.set(d.url, { at: Date.now(), headers: kept });
  if (SENT_HEADERS.size > 300) {
    const old = Date.now() - 120000;
    for (const [k, v] of SENT_HEADERS) if (v.at < old || SENT_HEADERS.size > 300) SENT_HEADERS.delete(k);
  }
}
try {
  // Chrome / Edge / Brave need "extraHeaders" to show Cookie and Referer
  const extra = chrome.webRequest.OnSendHeadersOptions && chrome.webRequest.OnSendHeadersOptions.EXTRA_HEADERS;
  chrome.webRequest.onSendHeaders.addListener(
    rememberRequest,
    { urls: ["<all_urls>"], types: ["main_frame", "sub_frame", "media", "object", "other", "xmlhttprequest"] },
    extra ? ["requestHeaders", extra] : ["requestHeaders"]
  );
} catch (_) {
  /* no request headers here: the cookies and the page still go along */
}

// ---------------------------------------------------------------- forms
// A file a form's button gives (POST): the app asks for it the same way, with
// the form's data. What it sent is kept for two minutes. A form with a file in
// it (an upload) can't be sent again: its download stays in the browser.
const FORMS = new Map();
const FORM_LIMIT = 64 * 1024;
function forgetOld(map, ms) {
  const old = Date.now() - ms;
  for (const [k, v] of map) if (v.at < old) map.delete(k);
}
function formOf(d) {
  const rb = d.requestBody;
  if (!rb) return { body: null };
  if (rb.formData) {
    const p = new URLSearchParams();
    for (const [k, values] of Object.entries(rb.formData)) for (const v of values) p.append(k, String(v));
    const body = p.toString();
    return body.length > FORM_LIMIT ? { body: null } : { body, fields: true };
  }
  if (Array.isArray(rb.raw) && rb.raw.length && rb.raw.every((x) => x.bytes)) {
    const size = rb.raw.reduce((n, x) => n + x.bytes.byteLength, 0);
    if (size > FORM_LIMIT) return { body: null };
    const all = new Uint8Array(size);
    let at = 0;
    for (const x of rb.raw) {
      all.set(new Uint8Array(x.bytes), at);
      at += x.bytes.byteLength;
    }
    try {
      return { body: new TextDecoder("utf-8", { fatal: true }).decode(all) };
    } catch {
      return { body: null };
    }
  }
  return { body: null };
}
try {
  const loads = { urls: ["<all_urls>"], types: ["main_frame", "sub_frame"] };
  chrome.webRequest.onBeforeRequest.addListener(
    (d) => {
      if (d.method !== "POST") return;
      forgetOld(FORMS, 120000);
      FORMS.set(d.url, { ...formOf(d), at: Date.now(), id: d.requestId });
    },
    loads,
    ["requestBody"]
  );
  chrome.webRequest.onBeforeSendHeaders.addListener(
    (d) => {
      if (d.method !== "POST") return;
      const f = FORMS.get(d.url);
      const ct = (d.requestHeaders || []).find((h) => h.name.toLowerCase() === "content-type");
      if (f && f.id === d.requestId && ct && ct.value) f.type = ct.value;
    },
    loads,
    ["requestHeaders"]
  );
} catch (_) {
  /* no form data here: such downloads stay in the browser */
}

const b64 = (text) => {
  const bytes = new TextEncoder().encode(text);
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
};

/**
 * The form posted to `url` a moment ago, as the app sends it again:
 * undefined = no form; null = one that can't be sent again (a file in it).
 */
function formFor(url) {
  const f = url && FORMS.get(url);
  if (!f || Date.now() - f.at > 120000) return undefined;
  // multipart: the browser gives its fields without its files
  if (f.body === null || (f.fields && /multipart/i.test(f.type || ""))) return null;
  return { post: b64(f.body), postType: f.fields ? "application/x-www-form-urlencoded" : f.type || "" };
}

/** What the browser sent for `url` (or the first of `urls` it knows). */
function browserRequest(...urls) {
  for (const u of urls) {
    const r = u && SENT_HEADERS.get(u);
    if (r && Date.now() - r.at < 120000) return r.headers;
  }
  return null;
}

async function sendToApp({ url, audioUrl, referrer, fileName, headers, sourcePage, sourceKey, alsoUrl, clip, store, form, subs }) {
  const { port } = await getOpts();
  // the browser's own request for this file: its headers go along (the app
  // keeps its own Accept / Range); its cookie is the one the site really got
  const sent = headers ? null : browserRequest(url, alsoUrl);
  const sentCookie = sent && sent.find((h) => /^cookie$/i.test(h.name));
  const sentReferer = sent && sent.find((h) => /^referer$/i.test(h.name));
  const sentUa = sent && sent.find((h) => /^user-agent$/i.test(h.name));
  const passOn = sent ? sent.filter((h) => !/^(cookie|referer|user-agent)$/i.test(h.name)).map((h) => [h.name, h.value]) : null;
  const body = {
    url,
    audioUrl: audioUrl || null,
    headers: headers || (passOn && passOn.length ? passOn : null),
    sourcePage: sourcePage || null,
    sourceKey: sourceKey || null,
    referrer: referrer || (sentReferer && sentReferer.value) || null,
    cookies: (sentCookie && sentCookie.value) || (await cookieHeader(url, store)),
    userAgent: (sentUa && sentUa.value) || navigator.userAgent,
    fileName: fileName || null,
    clip: clip || null,
    subs: subs || null,
    ...(form ? form : {}),
  };
  const r = await fetchWithTimeout(
    apiUrl(port, "/add"),
    {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-SwiftGet": "1" },
      body: JSON.stringify(body),
    },
    3000
  );
  if (!r.ok) throw new Error(`MediaLab Downloader answered HTTP ${r.status}`);
}

// ---------------------------------------------------------------- app options

let appConfig = null;
let configAt = 0;

/** Options > File Types / General of the app (cached for a minute). */
async function getConfig() {
  if (appConfig && Date.now() - configAt < 60000) return appConfig;
  const { port } = await getOpts();
  try {
    const r = await fetchWithTimeout(apiUrl(port, "/config"), { headers: { "X-SwiftGet": "1" } }, 1000);
    if (r.ok) {
      appConfig = await r.json();
      configAt = Date.now();
    }
  } catch {
    /* app not running or older version: keep the last one */
  }
  return appConfig;
}

/** "*" matches anything, "?" one character (case-insensitive). */
function wildcard(pattern, text) {
  const re = new RegExp(
    "^" + pattern.toLowerCase().replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".") + "$"
  );
  return re.test(text.toLowerCase());
}

function hostMatches(host, pattern) {
  const p = pattern.replace(/^https?:\/\//i, "").split("/")[0].toLowerCase();
  if (!p) return false;
  if (p.includes("*")) return wildcard(p, host);
  return host === p || host.endsWith("." + p);
}

function extensionOf(name) {
  const clean = (name || "").split(/[?#]/)[0];
  const last = clean.split(/[\\/]/).pop() || "";
  const dot = last.lastIndexOf(".");
  return dot > 0 ? last.slice(dot + 1).toLowerCase() : "";
}

/** Should MediaLab Downloader take this browser download? (Options > File Types rules) */
function wanted(cfg, url, fileName, mime, keys) {
  if (!cfg) return true; // old app: take everything like before
  if (cfg.skipKey && cfg.skipKey !== "none" && keys[cfg.skipKey]) return false;
  if (cfg.forceKey && cfg.forceKey !== "none" && keys[cfg.forceKey]) return true;
  let host = "";
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return false;
  }
  if ((cfg.skipSites || []).some((s) => hostMatches(host, s))) return false;
  if ((cfg.skipAddresses || []).some((a) => wildcard(a, url))) return false;
  // a .torrent file: only when MediaLab Downloader is the main torrent program
  const isTorrent = extensionOf(fileName) === "torrent" || extensionOf(new URL(url).pathname) === "torrent" || /bittorrent/i.test(mime || "");
  if (isTorrent) return cfg.torrents !== false;
  const exts = cfg.captureExts || [];
  if (!exts.length) return true;
  let ext = extensionOf(fileName) || extensionOf(new URL(url).pathname);
  // script addresses (download.php?id=…) say nothing about the file
  if (/^(php\d?|aspx?|jsp|cgi|pl|cfm|do|action|html?)$/.test(ext) && !extensionOf(fileName)) ext = "";
  if (!ext) {
    // no extension (download.php?id=…): go by the type the server sends
    return !!mime && !/^(text\/html|image\/|text\/plain)/i.test(mime);
  }
  if (exts.some((e) => wildcard(e, ext))) return true;
  // an extension not in the list, but the server says it is a file to
  // download (not a page, picture or text the browser shows)
  return !!mime && /^(application\/(octet-stream|x-|zip|vnd\.|pdf|java-archive|gzip)|video\/|audio\/)/i.test(mime) && !/^(html?|xhtml|php\d?|aspx?|jsp|json|xml|js|css|txt)$/.test(ext);
}

// keys held when the user clicked the link (sent by the page)
let lastKeys = { alt: false, ctrl: false, shift: false, at: 0 };
function currentKeys() {
  return Date.now() - lastKeys.at < 4000 ? lastKeys : { alt: false, ctrl: false, shift: false };
}

function baseName(path) {
  if (!path) return null;
  const name = path.split(/[\\/]/).pop();
  return name || null;
}

// ---------------------------------------------------------------- 1. downloads

// Remembered in session storage, not in memory: the browser stops this
// service worker whenever it likes, and a lost "let the browser keep it"
// mark made the same file come back over and over.
const BYPASS_KEY = "bypassUrls";
const RECENT_KEY = "recentSends";

async function takeBypass(url) {
  const list = (await chrome.storage.session.get(BYPASS_KEY))[BYPASS_KEY] || [];
  const now = Date.now();
  const fresh = list.filter((b) => now - b.at < 120000);
  const hit = fresh.some((b) => b.url === url);
  await chrome.storage.session.set({ [BYPASS_KEY]: fresh.filter((b) => b.url !== url) });
  return hit;
}

async function addBypass(url) {
  const list = (await chrome.storage.session.get(BYPASS_KEY))[BYPASS_KEY] || [];
  list.push({ url, at: Date.now() });
  await chrome.storage.session.set({ [BYPASS_KEY]: list.slice(-50) });
}

/** The same address handed to the app a moment ago (pages and the browser can fire twice). */
async function sentRecently(url) {
  const list = (await chrome.storage.session.get(RECENT_KEY))[RECENT_KEY] || [];
  const now = Date.now();
  const fresh = list.filter((r) => now - r.at < 15000);
  const hit = fresh.some((r) => r.url === url);
  if (!hit) fresh.push({ url, at: now });
  await chrome.storage.session.set({ [RECENT_KEY]: fresh.slice(-50) });
  return hit;
}

/** The app's "Download with the browser" button: leave this one to the browser. */
async function appSaysBrowser(urls) {
  const { port } = await getOpts();
  try {
    const r = await fetchWithTimeout(
      apiUrl(port, "/browser"),
      { method: "POST", headers: { "Content-Type": "application/json", "X-SwiftGet": "1" }, body: JSON.stringify({ urls }) },
      800
    );
    if (!r.ok || typeof r.json !== "function") return false;
    return !!(await r.json()).browser;
  } catch {
    return false;
  }
}

/** Only downloads the user starts now: not ones the browser restores or resumes at start-up. */
function isNewDownload(item) {
  if (item.state && item.state !== "in_progress") return false;
  // ours (given back to the browser) and other extensions' downloads stay in the browser
  if (item.byExtensionId) return false;
  const started = Date.parse(item.startTime || "");
  if (!Number.isNaN(started) && Date.now() - started > 30000) return false;
  return true;
}

// Why the last download stayed with the browser (the toolbar window says it).
async function leftToBrowser(why, item) {
  try {
    const name = baseName(item && item.filename) || ((item && (item.finalUrl || item.url)) || "").split(/[?#]/)[0].split("/").pop() || "";
    await chrome.storage.local.set({ lastLeft: { why, name: name.slice(0, 120), at: Date.now() } });
  } catch {
    /* nothing to say it with */
  }
}

/**
 * Should MediaLab Downloader take this browser download? `{ take, why }`: why it
 * stays with the browser (said in the toolbar window), or "" when nothing
 * needs saying (sending is off, not a new download...).
 */
async function decide(item) {
  const no = (why) => ({ take: false, why });
  const opts = await getOpts();
  if (!opts.enabled || !opts.intercept) return no("");
  const url = item.finalUrl || item.url;
  if (!url || !/^https?:/i.test(url)) return no(""); // blob:, data:, file: stay in the browser
  // Telegram's own download of a video: only its page can give the file
  if (isTelegramStream(url) || isTelegramStream(item.url)) return no("");
  if (!isNewDownload(item)) return no("");
  if (await takeBypass(url)) return no("");
  // the browser's PDF viewer saving the PDF it shows: the browser asks where
  // to save it anyway (that window can't be stopped), so it keeps it rather
  // than two windows asking at once
  if (await shownInPdfViewer(item)) return no("");
  // already handed to the app by the click on its link: the browser's copy goes
  if ((await justTaken(item.url)) || (await justTaken(url))) return { take: true, why: "", already: true };
  if (opts.minSizeKB > 0 && item.totalBytes > 0 && item.totalBytes < opts.minSizeKB * 1024) return no("small");
  // a form with a file in it can't be sent again
  const form = formFor(item.url);
  if (form === null) return no("form");
  if (!(await appAlive())) return no("not-running"); // app not running: let the browser handle it
  const cfg = await getConfig();
  if (!wanted(cfg, url, baseName(item.filename), item.mime, currentKeys())) return no("rules");
  if (await appSaysBrowser([item.url, url])) return no(""); // the user chose the browser for it
  // a link that works once only (the browser just used it) or only with
  // the page's own sign-in: it stays in the browser
  if (!(await appCanFetch(form ? item.url : url, item, form))) return no("cant-fetch");
  return { take: true, why: "", form };
}

/** Can the program get this file with the browser's sign-in? (a short look; when it can't tell, yes) */
async function appCanFetch(url, item, form) {
  const { port } = await getOpts();
  try {
    const sent = browserRequest(url, item.url);
    const pick = (n) => sent && sent.find((h) => h.name.toLowerCase() === n);
    const passOn = sent ? sent.filter((h) => !/^(cookie|referer|user-agent|range)$/i.test(h.name)).map((h) => [h.name, h.value]) : null;
    const body = {
      url,
      referrer: item.referrer || (pick("referer") && pick("referer").value) || null,
      cookies: (pick("cookie") && pick("cookie").value) || (await cookieHeader(url, await storeOf(item))),
      userAgent: (pick("user-agent") && pick("user-agent").value) || navigator.userAgent,
      headers: passOn && passOn.length ? passOn : null,
      ...(form ? form : {}),
    };
    const r = await fetchWithTimeout(
      apiUrl(port, "/check"),
      { method: "POST", headers: { "Content-Type": "application/json", "X-SwiftGet": "1" }, body: JSON.stringify(body) },
      3200
    );
    if (!r.ok || typeof r.json !== "function") return true;
    return (await r.json()).ok !== false;
  } catch {
    return true;
  }
}

/** A PDF that a tab shows in the browser's own viewer right now. */
async function shownInPdfViewer(item) {
  const pdf = /pdf/i.test(item.mime || "") || /\.pdf($|[?#])/i.test(item.finalUrl || item.url || "");
  if (!pdf) return false;
  try {
    const tabs = await chrome.tabs.query({});
    const same = (a, b) => !!a && !!b && a.split("#")[0] === b.split("#")[0];
    return tabs.some((t) => same(t.url, item.url) || same(t.url, item.finalUrl));
  } catch {
    return false;
  }
}

// Tabs opened in the last seconds: one opened only for a download (a link
// with target="_blank") is closed when the app takes the download.
const NEW_TABS = new Map();
chrome.tabs.onCreated.addListener((tab) => {
  forgetOld(NEW_TABS, 15000);
  NEW_TABS.set(tab.id, { at: Date.now() });
});
async function closeEmptyTab(urls, tabId) {
  forgetOld(NEW_TABS, 15000);
  const ids = tabId >= 0 ? [tabId] : [...NEW_TABS.keys()];
  for (const id of ids) {
    if (!NEW_TABS.has(id)) continue;
    try {
      const tab = await chrome.tabs.get(id);
      const at = tab.pendingUrl || tab.url || "";
      // only a tab opened for the file's own address (or still empty), never one the user opened
      if (urls.includes(at) || ((at === "" || at === "about:blank") && tabId >= 0)) {
        NEW_TABS.delete(id);
        await chrome.tabs.remove(id);
      }
    } catch {
      NEW_TABS.delete(id);
    }
  }
}

/** The browser's own copy of a download the app has: gone without a trace. */
async function dropBrowserCopy(item) {
  if (item.id === undefined) return;
  try {
    await chrome.downloads.cancel(item.id);
  } catch {
    /* finished already */
  }
  try {
    const [d] = await chrome.downloads.search({ id: item.id });
    if (d && d.state === "complete" && d.exists !== false) await chrome.downloads.removeFile(item.id);
  } catch {
    /* gone already */
  }
  try {
    await chrome.downloads.erase({ id: item.id });
  } catch {
    /* gone already */
  }
  closeEmptyTab([item.url, item.finalUrl].filter(Boolean)).catch(() => {});
}

/**
 * Give the download to the app; only once the app has it does the browser's
 * own copy go (a link that works once is never lost). True: the app took it.
 */
async function takeOver(item, decided) {
  const url = item.finalUrl || item.url;
  const d = decided || { take: true };
  if (d.already || (await sentRecently(url))) {
    await dropBrowserCopy(item);
    return true;
  }
  try {
    // a form's download goes from the form's own address (its answer may send it on)
    await sendToApp({
      url: d.form ? item.url : url,
      alsoUrl: item.url,
      referrer: item.referrer,
      fileName: baseName(item.filename),
      store: await storeOf(item),
      form: d.form,
    });
  } catch (e) {
    // the app may have got it anyway (it was only slow to answer): never
    // shown twice
    if (e && e.name === "AbortError") {
      await dropBrowserCopy(item);
      return true;
    }
    // the app could not be reached: the browser keeps it
    await leftToBrowser("not-running", item);
    return false;
  }
  await dropBrowserCopy(item);
  return true;
}

/** A file link the page caught a click on: to the app, or back to the page. */
async function takeLink(url, referrer, store) {
  if (!/^https?:/i.test(url || "")) throw new Error("not a web address");
  const opts = await getOpts();
  if (!opts.enabled || !opts.intercept) throw new Error("sending is off");
  if (!(await appAlive())) throw new Error("MediaLab Downloader is not running");
  if (await appSaysBrowser([url])) throw new Error("the browser keeps it");
  // the same link clicked twice in a row: once is enough
  if (!(await sentRecently(url))) await sendToApp({ url, referrer, store });
  // the browser may still start it (a second handler of the page): not again
  await addBypassTaken(url);
  return true;
}

// links just handed over from a click: if the browser starts them anyway, they are dropped
const TAKEN_KEY = "takenLinks";
async function addBypassTaken(url) {
  const list = (await chrome.storage.session.get(TAKEN_KEY))[TAKEN_KEY] || [];
  list.push({ url, at: Date.now() });
  await chrome.storage.session.set({ [TAKEN_KEY]: list.slice(-50) });
}
async function justTaken(url) {
  const list = (await chrome.storage.session.get(TAKEN_KEY))[TAKEN_KEY] || [];
  return list.some((l) => l.url === url && Date.now() - l.at < 15000);
}

// Chrome, Edge, Brave, Opera: decided before the browser asks where to
// save it, so its own "Save as" window never shows up for files the app
// takes. The browser's download waits meanwhile and goes on if the app does
// not take it. Firefox has no such moment: its download is paused while the
// app is asked, and resumed if the app does not take it.
const DECIDE_EARLY = !!(chrome.downloads.onDeterminingFilename && chrome.downloads.onDeterminingFilename.addListener);
if (DECIDE_EARLY) {
  chrome.downloads.onDeterminingFilename.addListener((item, suggest) => {
    let answered = false;
    const keep = () => {
      if (!answered) {
        answered = true;
        try {
          suggest();
        } catch (_) {
          /* the download is gone */
        }
      }
    };
    // never leave the browser waiting long (the download goes on with it,
    // and is still taken over if the app takes it afterwards)
    const guard = setTimeout(keep, 9000);
    decide(item)
      .then(async (d) => {
        if (!d.take) {
          clearTimeout(guard);
          keep();
          if (d.why) await leftToBrowser(d.why, item);
          return;
        }
        const taken = await takeOver(item, d);
        clearTimeout(guard);
        if (taken) answered = true;
        else keep();
      })
      .catch(() => {
        clearTimeout(guard);
        keep();
      });
    return true; // answered later
  });
}

// Firefox: page loads decided from their answer (below), not asked again
// when they become a download
const DECIDED = new Map();

chrome.downloads.onCreated.addListener(async (item) => {
  if (DECIDE_EARLY) return;
  forgetOld(DECIDED, 120000);
  if (DECIDED.has(item.url) || DECIDED.has(item.finalUrl)) return;
  // paused while the app is asked: nothing is saved twice
  let paused = false;
  try {
    await chrome.downloads.pause(item.id);
    paused = true;
  } catch {
    /* not pausable (no resume on that server) or finished already */
  }
  const d = await decide(item).catch(() => ({ take: false, why: "" }));
  const taken = d.take && (await takeOver(item, d));
  if (!taken) {
    if (d.why) await leftToBrowser(d.why, item);
    if (paused) chrome.downloads.resume(item.id).catch(() => {});
  }
});

// Firefox: a file is caught from the answer to the page load, before Firefox
// asks what to do with it (and downloads it behind that window): the load
// waits while the app is asked, and is stopped if the app takes it.
const SHOWN_BY_BROWSER = /^(text\/|image\/|video\/|audio\/|multipart\/|application\/(pdf|xhtml\+xml|xml|json|javascript|x-javascript|ecmascript|ogg|x-xpinstall|[\w.+-]+\+(xml|json))$)/;
function nameInDisposition(cd) {
  const star = /filename\*\s*=\s*[\w-]+'[^']*'([^;]+)/i.exec(cd);
  if (star) {
    try {
      return decodeURIComponent(star[1].trim().replace(/^"|"$/g, ""));
    } catch {
      /* the plain name below */
    }
  }
  const plain = /(?:^|;)\s*filename\s*=\s*("((?:[^"\\]|\\.)*)"|[^;]+)/i.exec(cd);
  if (!plain) return "";
  return (plain[2] !== undefined ? plain[2].replace(/\\(.)/g, "$1") : plain[1]).trim();
}
async function fileAnswer(d) {
  if (d.method !== "GET" && d.method !== "POST") return {};
  const code = d.statusCode || 0;
  if (code < 200 || code > 299 || code === 204 || code === 205 || code === 206) return {};
  const get = (n) => (((d.responseHeaders || []).find((h) => h.name.toLowerCase() === n) || {}).value || "").trim();
  const mime = get("content-type").split(";")[0].trim().toLowerCase();
  const cd = get("content-disposition");
  if (!/^attachment/i.test(cd) && (!mime || SHOWN_BY_BROWSER.test(mime))) return {};
  let name = nameInDisposition(cd);
  if (!name) {
    try {
      name = decodeURIComponent(d.url.split(/[?#]/)[0].split("/").pop() || "");
    } catch {
      name = d.url.split(/[?#]/)[0].split("/").pop() || "";
    }
  }
  const size = get("content-encoding") ? 0 : Number(get("content-length")) || 0;
  const sent = browserRequest(d.url);
  const ref = sent && sent.find((h) => /^referer$/i.test(h.name));
  const item = {
    url: d.url,
    finalUrl: d.url,
    filename: name.split(/[\\/]/).pop() || "",
    mime,
    totalBytes: size,
    referrer: (ref && ref.value) || d.originUrl || "",
    incognito: !!d.incognito,
    cookieStoreId: d.cookieStoreId,
  };
  forgetOld(DECIDED, 120000);
  DECIDED.set(d.url, { at: Date.now() });
  const dec = await decide(item).catch(() => ({ take: false, why: "" }));
  if (!dec.take) {
    if (dec.why) await leftToBrowser(dec.why, item);
    return {};
  }
  if (!(await takeOver(item, dec))) return {};
  closeEmptyTab([d.url], d.tabId).catch(() => {});
  return { cancel: true };
}
if (!DECIDE_EARLY && IS_FIREFOX) {
  try {
    chrome.webRequest.onHeadersReceived.addListener(
      (d) => fileAnswer(d).catch(() => ({})),
      { urls: ["<all_urls>"], types: ["main_frame", "sub_frame"] },
      ["blocking", "responseHeaders"]
    );
  } catch (_) {
    /* no blocking here: downloads are decided when they start */
  }
}

// ---------------------------------------------------------------- per-tab state
// media_<tab>: generic files found on the page
// yt_<tab>:    { videoId, sabr, streams: { "<itag>_<dur>": stream }, resolved... }
// res_<tab>:   any other site: { page, resolving, resolved, resolveError }

async function readTab(tabId) {
  const keys = [`media_${tabId}`, `yt_${tabId}`, `res_${tabId}`];
  const r = await chrome.storage.session.get(keys);
  return { media: r[keys[0]] || [], yt: r[keys[1]] || null, res: r[keys[2]] || null };
}

function optionItems(resolved, source) {
  const subtitles = resolved.subtitles || [];
  return resolved.options.map((o) => ({
    label: o.label,
    sub: o.sub,
    yt: { ...o, title: resolved.title, source, subtitles },
  }));
}

/** Everything the page button and the popup show, in one list. */
// what the page's video is called and how it looks, told by the page's script at the time the
// mouse (or the player) came to it: the streams that open right after belong to it
const lastHoverAt = new Map(); // tabId -> when the mouse last came to a video / card
const metaKey = (tabId) => `metas_${tabId}`;
async function loadMetas(tabId) {
  const k = metaKey(tabId);
  return (await chrome.storage.session.get(k))[k] || [];
}
// changes of one tab's list one after the other (two pictures arriving together must not overwrite each other)
let metaQueue = Promise.resolve();
function changeMetas(tabId, fn) {
  metaQueue = metaQueue
    .then(async () => {
      const list = await loadMetas(tabId);
      const out = fn(list) || list;
      try {
        await chrome.storage.session.set({ [metaKey(tabId)]: out });
      } catch {
        // the add-in's session memory is full: only the newest videos keep their pictures
        out.slice(0, Math.max(0, out.length - 5)).forEach((m) => (m.frames = []));
        await chrome.storage.session.set({ [metaKey(tabId)]: out });
      }
    })
    .catch(() => {});
  return metaQueue;
}
const STREAM_TOKEN_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|\b[0-9a-f]{20,64}\b/gi;
const NUM_ID_RE = /(?:^|[^0-9])(\d{5,12})(?=[^0-9]|$)/g;
function tokensOfUrl(url) {
  const out = [];
  const raw = String(url || "");
  for (const m of raw.matchAll(STREAM_TOKEN_RE)) out.push(m[0].toLowerCase());
  try {
    const path = /^https?:/i.test(raw) ? new URL(raw).pathname : raw;
    for (const m of path.matchAll(NUM_ID_RE)) {
      if (!out.includes(m[1])) out.push(m[1]);
    }
  } catch {}
  return out;
}
function metaFor(list, t, claimed = null) {
  let best = null;
  let bestGap = Infinity;
  for (const x of list) {
    if (x.scan) continue;
    if (!x.title && !x.thumb && (!x.frames || !x.frames.length)) continue;
    if (claimed && claimed.has(x.id)) continue;
    const d = x.t - t; // the video started before its stream was seen (up to a few seconds) or a moment after
    if (d < -12000 || d > 3000) continue;
    if (Math.abs(d) < bestGap) {
      bestGap = Math.abs(d);
      best = x;
    }
  }
  if (!best && claimed) return metaFor(list, t, null);
  return best;
}
function matchMetaForMedia(metaList, m, familyMap, claimedIds) {
  const fam = streamFamily(m.url);
  if (familyMap && familyMap.has(fam)) return familyMap.get(fam);
  const urlTokens = tokensOfUrl(m.url);
  let mt = null;
  // 1. Direct token / UUID match against metaList keys, thumb, or href
  if (urlTokens.length) {
    mt = metaList.find((x) => {
      const k = [
        ...(Array.isArray(x.keys) ? x.keys : []),
        ...tokensOfUrl(x.thumb),
        ...tokensOfUrl(x.href),
      ];
      return k.some((tok) => urlTokens.includes(tok));
    });
  }
  // 2. Direct meta attached when stream was seen
  if (!mt && m.meta && (m.meta.title || m.meta.thumb)) {
    mt = metaList.find((x) => x.id === m.meta.id) || m.meta;
  }
  // 3. Timestamp proximity match (against live video/hover events)
  if (!mt && m.t) {
    mt = metaFor(metaList, m.t, claimedIds);
  }
  // 4. Fallback to unclaimed scanned card on the page
  if (!mt && claimedIds) {
    mt = metaList.find((x) => !claimedIds.has(x.id) && (x.title || x.thumb));
  }
  if (mt && mt.id && claimedIds) claimedIds.add(mt.id);
  if (mt && familyMap) familyMap.set(fam, mt);
  return mt;
}
function streamAttrs(metaList, m, familyMap, claimedIds) {
  const mt = matchMetaForMedia(metaList, m, familyMap, claimedIds);
  const name = (mt && mt.title) || m.name || "";
  const metaId = (mt && mt.id) || m.metaId || "";
  const thumb = (mt && mt.thumb && /^https?:/i.test(mt.thumb) ? mt.thumb : "") || (m.thumb && /^https?:/i.test(m.thumb) ? m.thumb : "");
  return {
    t: m.t || 0,
    family: streamFamily(m.url),
    ...(m.previewSeg ? { previewSeg: m.previewSeg } : {}),
    ...(m.previewSegs && m.previewSegs.length ? { previewSegs: m.previewSegs } : {}),
    ...(m.initSeg ? { initSeg: m.initSeg } : {}),
    ...(name ? { name } : {}),
    ...(metaId ? { metaId } : {}),
    // seen = the mouse was on this video / it is the page's player (the previews of a grid that
    // nobody stood on are not listed)
    ...(mt ? { seen: !!mt.hover } : {}),
    ...(thumb ? { thumb } : {}),
  };
}
function streamFamily(url) {
  try {
    const u = new URL(url);
    // an id of the video in the address (a uuid, a long hex / numeric asset id): all its streams are one video
    const id = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{20,}/i.exec(u.pathname);
    if (id) return u.host + "/" + id[0].toLowerCase();
    const numId = /(?:^|[^0-9])(\d{5,12})(?=[^0-9]|$)/.exec(u.pathname);
    if (numId) return u.host + "/id-" + numId[1];
    // distinct files in the same CDN directory (e.g. preview-foo.mp4 vs preview-bar.mp4) stay separate
    const cleanPath = u.pathname.replace(/(?:[_-](?:1080|720|540|480|360|240|4k|hd|sd|low|high|med)p?)+(?=\.[a-z0-9]{2,5}$)/i, "");
    return u.host + cleanPath;
  } catch {
    return url;
  }
}

async function itemsForTab(tabId, since = 0) {
  const tabState = await readTab(tabId);
  const metaList = await loadMetas(tabId);
  const { yt, res } = since ? {} : tabState; // since: only the streams opened since then
  const media = since ? tabState.media.filter((m) => (m.t || 0) >= since - 1500) : tabState.media;
  const items = [];
  if (res && !yt) {
    if (res.resolved && res.resolved.options.length) {
      items.push(...optionItems(res.resolved, res.page));
    } else if (res.resolving) {
      items.push({ label: "Getting video qualities…", sub: "This takes a few seconds", disabled: true });
    } else if (res.resolveError && !media.length) {
      // the page itself is no video page the app knows: the streams the
      // player opens show up here as soon as it plays
      const unknown = /unsupported url|no video formats|unable to extract/i.test(res.resolveError);
      items.push(
        isDrm(res.resolveError)
          ? { label: drmText(), sub: "", disabled: true, drm: true }
          : unknown
            ? { label: "Play the video for a moment", sub: "Its qualities appear here as soon as it plays", disabled: true }
            : { label: "Can't get this video", sub: res.resolveError, disabled: true }
      );
    }
  }
  if (yt) {
    if (yt.resolved && yt.resolved.options.length) {
      // qualities found by the app (yt-dlp): works with every stream format
      items.push(...optionItems(yt.resolved, `https://www.youtube.com/watch?v=${yt.videoId}`));
    } else {
      // fallback: streams captured from the player itself
      for (const o of buildOptions(yt.streams, appConfig && appConfig.mp3Kbps)) items.push({ label: o.label, sub: o.sub, yt: o });
      if (!items.length) {
        if (yt.resolving) {
          items.push({ label: "Getting video qualities…", sub: "This takes a few seconds", disabled: true });
        } else if (yt.resolveError) {
          items.push({ label: "Can't get this video", sub: yt.resolveError, disabled: true });
        } else if (yt.sabr) {
          items.push({
            label: "This video needs MediaLab Downloader",
            sub: "Open MediaLab Downloader (with yt-dlp.exe next to it) and reload the page",
            disabled: true,
          });
        }
      }
    }
  }
  const resolvedFound = items.some((i) => i.yt);
  let hlsAsked = false;
  const familyMap = new Map();
  const claimedIds = new Set();
  for (const m of media) {
    // when the app already found the real qualities, raw streams are noise
    if (resolvedFound && /HLS|DASH|video/i.test(m.type)) continue;
    const common = streamAttrs(metaList, m, familyMap, claimedIds);
    if (m.dash) {
      // its qualities are read by the app when it is clicked
      items.push({ label: "Video stream (DASH) · choose a quality", sub: m.url, resolve: m.url, ext: "mp4", ...common });
      continue;
    }
    if (m.type === "HLS stream") {
      // a quality list of a stream whose qualities are listed already
      if (m.child) continue;
      if (m.master && !m.master.separateAudio) {
        // every quality of the stream, read from its playlist
        for (const v of m.master.variants) {
          items.push({ label: `${hlsLabel(v)} · MP4 · stream`, sub: v.url, url: v.url, ext: "ts", ...common });
        }
        continue;
      }
      if (m.master) {
        // picture and sound come in separate lists: the app puts them together
        items.push({
          label: `${m.master.variants.map(hlsLabel).slice(0, 4).join(" / ")} · choose a quality`,
          sub: m.url,
          resolve: m.url,
          ext: "mp4",
          ...common,
        });
        continue;
      }
      // saved as an MP4 file; the quality first when the address tells it
      items.push({ label: `${qualityOf(m.url) || "Video"} · MP4 · stream`, sub: m.url, url: m.url, ext: "ts", ...common });
      if (!hlsAsked && !m.media) {
        hlsAsked = true;
        items.push({ label: "Other qualities of this stream…", sub: m.url, resolve: m.url, ext: "mp4", ...common });
      }
      continue;
    }
    const q = qualityOf(m.url);
    items.push({
      label: `${q ? q + " · " : ""}${(m.ext || "").toUpperCase() || m.type}${m.size ? " · " + fmtSize(m.size) : ""}`,
      sub: m.url,
      url: m.url,
      ext: m.ext,
      size: m.size || 0,
      audio: /^audio\//i.test(m.type || ""),
      ...common,
    });
  }
  return wantedOnly(items);
}

/**
 * What the menus offer: H.264 MP4 video (what Premiere and every editor opens), up to 1080p,
 * and MP3 for sound. WEBM / VP9 / AV1 / 4K are left out; a site that gives nothing else still
 * shows what it gives.
 */
function wantedOnly(list) {
  const real = list.filter((i) => !i.disabled);
  const rest = list.filter((i) => i.disabled);
  const ext = (i) => String((i.yt && i.yt.ext) || i.ext || "").toLowerCase();
  const codec = (i) => String((i.yt && i.yt.codec) || "").toUpperCase();
  const high = (i) => {
    const m = /(\d{3,4})p/i.exec((i.yt && i.yt.quality) || i.label || "");
    return m ? Number(m[1]) : 0;
  };
  const isAudio = (i) => (i.yt ? i.yt.quality === "audio" || i.yt.quality === "mp3" : !!i.audio);
  let video = real.filter((i) => !isAudio(i));
  let audio = real.filter(isAudio);
  const plain = video.filter((i) => !/VP9|VP8|AV1|HEVC|H\.265/.test(codec(i)) && !/^(webm|mkv|ogv|flv)$/.test(ext(i)));
  if (plain.length) video = plain;
  const upTo1080 = video.filter((i) => !high(i) || high(i) <= 1080);
  if (upTo1080.length) video = upTo1080;
  const mp3 = audio.filter((i) => ext(i) === "mp3" || (i.yt && i.yt.quality === "mp3"));
  if (mp3.length) audio = mp3;
  return [...video, ...audio, ...rest];
}

/** "720p" when a stream's address says which quality it is. */
function qualityOf(url) {
  let path = "";
  try {
    path = new URL(url).pathname;
  } catch {
    return "";
  }
  const m = /(?:^|[^0-9])(4320|2160|1440|1080|720|576|540|480|360|240|144)p?(?=[^0-9]|$)/i.exec(path);
  return m ? `${m[1]}p` : "";
}

async function pushToTab(tabId) {
  try {
    const { enabled } = await getOpts();
    if (!enabled) {
      // switched off: no buttons on the page, "off" on the add-in's icon
      Promise.resolve(chrome.action.setBadgeBackgroundColor({ color: "#8a94a3" })).catch(() => {});
      Promise.resolve(chrome.action.setBadgeText({ tabId, text: "off" })).catch(() => {});
      Promise.resolve(chrome.tabs.sendMessage(tabId, { type: "swiftget-media", items: [] })).catch(() => {});
      return;
    }
    const items = await itemsForTab(tabId);
    const count = items.filter((i) => !i.disabled).length;
    Promise.resolve(chrome.action.setBadgeBackgroundColor({ color: "#E95432" })).catch(() => {});
    Promise.resolve(chrome.action.setBadgeText({ tabId, text: count ? String(count) : "" })).catch(() => {});
    Promise.resolve(chrome.tabs.sendMessage(tabId, { type: "swiftget-media", items })).catch(() => {});
  } catch {}
}

// keepFresh: a page that changes without a reload (Artlist, YouTube...) already asks for its new
// video's stream a moment before the browser tells the add-in that the address changed:
// what was seen in that moment belongs to the new page and is kept
async function clearTab(tabId, keepFresh = false) {
  const key = `media_${tabId}`;
  if (!keepFresh) await chrome.storage.session.remove(metaKey(tabId));
  let keep = [];
  if (keepFresh) {
    const cur = (await chrome.storage.session.get(key))[key] || [];
    keep = cur.filter((m) => (m.t || 0) >= Date.now() - 1500);
  }
  await chrome.storage.session.remove([key, `yt_${tabId}`, `res_${tabId}`]);
  if (keep.length) await chrome.storage.session.set({ [key]: keep });
  chrome.action.setBadgeText({ tabId, text: "" }).catch(() => {});
  if (keep.length) pushToTab(tabId);
  else chrome.tabs.sendMessage(tabId, { type: "swiftget-media", items: [] }).catch(() => {});
}

// ---------------------------------------------------------------- 2. media sniffer

const MEDIA_TYPE = /^(video|audio)\//i;
const HLS_TYPE = /mpegurl/i;
const DASH_TYPE = /dash\+xml/i;

function headerMap(list) {
  const out = {};
  for (const h of list || []) out[h.name.toLowerCase()] = h.value || "";
  return out;
}

// the on / off switch, kept at hand: nothing is caught while it is off
let enabledNow = true;
chrome.storage.local.get({ enabled: true }, (o) => {
  if (chrome.runtime && chrome.runtime.lastError) return;
  enabledNow = !o || o.enabled !== false;
});
chrome.storage.onChanged.addListener((ch, area) => {
  if (area === "local" && ch.enabled) enabledNow = ch.enabled.newValue !== false;
});

async function addMedia(tabId, item) {
  if (!enabledNow) return;
  const key = `media_${tabId}`;
  const current = (await chrome.storage.session.get(key))[key] || [];
  item.t = Date.now(); // when it was seen: which video it belongs to is told by this
  const same = current.find((m) => m.url === item.url);
  if (same) {
    // the same stream opened again (a preview played again): it is the newest again
    same.t = item.t;
    if (item.meta && (item.meta.title || item.meta.thumb)) same.meta = item.meta;
    await chrome.storage.session.set({ [key]: current });
    return;
  }
  current.push(item);
  while (current.length > 25) current.shift();
  await chrome.storage.session.set({ [key]: current });
  pushToTab(tabId);
  if (item.type === "HLS stream") readHls(tabId, item.url).catch(() => {});
}

function parseHlsMediaPreview(text, base) {
  const lines = text.split(/\r?\n/).map((l) => l.trim());
  let initSeg = "";
  const segs = [];
  for (const l of lines) {
    if (!l) continue;
    if (/^#EXT-X-MAP:/i.test(l)) {
      const m = /URI=["']([^"']+)["']/i.exec(l);
      if (m && m[1]) {
        try {
          initSeg = new URL(m[1], base).toString();
        } catch {}
      }
      continue;
    }
    if (l.startsWith("#")) continue;
    try {
      const u = new URL(l, base).toString();
      if (/^https?:/i.test(u) && !/\.m3u8(\?|$)/i.test(u)) segs.push(u);
    } catch {}
  }
  if (!segs.length) return null;
  const mid = segs[Math.floor(segs.length / 2)];
  const p1 = segs[Math.min(1, segs.length - 1)];
  const p3 = segs[Math.floor(segs.length * 0.75)];
  const previewSegs = [...new Set([mid, p1, p3].filter(Boolean))];
  return { previewSeg: mid, previewSegs, initSeg };
}

/**
 * An HLS stream: its playlist says which qualities it has (a "master" list
 * of one list per quality). Read once, so the button shows "1080p", "720p"...
 * instead of anonymous streams.
 */
function parseHlsMaster(text, base) {
  if (!/#EXT-X-STREAM-INF/i.test(text)) return null;
  const lines = text.split(/\r?\n/).map((l) => l.trim());
  const variants = [];
  // separate sound lists: a quality list alone would be without sound
  const separateAudio = lines.some((l) => /^#EXT-X-MEDIA:.*TYPE=AUDIO.*URI=/i.test(l));
  for (let i = 0; i < lines.length; i++) {
    if (!/^#EXT-X-STREAM-INF:/i.test(lines[i])) continue;
    let uri = "";
    for (let j = i + 1; j < lines.length; j++) {
      if (lines[j] && !lines[j].startsWith("#")) {
        uri = lines[j];
        break;
      }
    }
    if (!uri) continue;
    let url = "";
    try {
      url = new URL(uri, base).toString();
    } catch {
      continue;
    }
    const res = /RESOLUTION=(\d+)x(\d+)/i.exec(lines[i]);
    const bw = /[^-]BANDWIDTH=(\d+)/i.exec("," + lines[i]);
    variants.push({ url, height: res ? Number(res[2]) : 0, width: res ? Number(res[1]) : 0, bw: bw ? Number(bw[1]) : 0 });
  }
  if (!variants.length) return null;
  // one entry per quality, the best first
  variants.sort((a, b) => b.height - a.height || b.bw - a.bw);
  const seen = new Set();
  const unique = variants.filter((v) => {
    const k = v.height ? `h${v.height}` : `b${v.bw}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  return { variants: unique, separateAudio };
}

async function readHls(tabId, url) {
  let tabUrl = "";
  try {
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    tabUrl = (tab && tab.url) || "";
    if (tabUrl) await previewRules(url, tabUrl);
  } catch {}
  const fetchText = async (u) => {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 8000);
    try {
      if (tabUrl) await previewRules(u, tabUrl).catch(() => {});
      const r = await fetch(u, { credentials: "include", signal: ctl.signal });
      if (!r.ok) return "";
      return (await r.text()).slice(0, 512 * 1024);
    } catch {
      return "";
    } finally {
      clearTimeout(timer);
    }
  };
  const text = await fetchText(url);
  if (!/^\s*#EXTM3U/.test(text)) return;
  const master = parseHlsMaster(text, url);
  let masterPv = null;
  if (master && master.variants.length) {
    const pick = master.variants[master.variants.length - 1] || master.variants[0];
    const subText = await fetchText(pick.url);
    if (/^\s*#EXTM3U/.test(subText)) masterPv = parseHlsMediaPreview(subText, pick.url);
  }
  const key = `media_${tabId}`;
  const current = (await chrome.storage.session.get(key))[key] || [];
  const me = current.find((m) => m.url === url);
  if (!me) return;
  if (master) {
    me.master = master;
    if (masterPv) {
      me.previewSeg = masterPv.previewSeg;
      me.previewSegs = masterPv.previewSegs;
      me.initSeg = masterPv.initSeg;
    }
    // the quality lists the player opened by itself: shown under the master
    const inside = new Set(master.variants.map((v) => v.url));
    const fam = streamFamily(url);
    for (const m of current) {
      if (m !== me && (inside.has(m.url) || (m.media && streamFamily(m.url) === fam))) {
        m.child = true;
        if (m.previewSeg && !me.previewSeg) {
          me.previewSeg = m.previewSeg;
          me.previewSegs = m.previewSegs;
          me.initSeg = m.initSeg;
        }
      }
    }
  } else {
    me.media = true;
    const pv = parseHlsMediaPreview(text, url);
    if (pv) {
      me.previewSeg = pv.previewSeg;
      me.previewSegs = pv.previewSegs;
      me.initSeg = pv.initSeg;
    }
    const fam = streamFamily(url);
    for (const m of current) {
      if (m.master && (m.master.variants.some((v) => v.url === url) || streamFamily(m.url) === fam)) {
        me.child = true;
        if (pv && !m.previewSeg) {
          m.previewSeg = pv.previewSeg;
          m.previewSegs = pv.previewSegs;
          m.initSeg = pv.initSeg;
        }
      }
    }
  }
  await chrome.storage.session.set({ [key]: current });
  pushToTab(tabId);
}

/** "1080p" (or the bit rate when the list does not say the size). */
function hlsLabel(v) {
  if (v.height) return `${v.height}p`;
  if (v.bw) return `${Math.round(v.bw / 1000)} kbps`;
  return "Video";
}

chrome.webRequest.onHeadersReceived.addListener(
  (d) => {
    if (d.tabId < 0 || d.statusCode < 200 || d.statusCode >= 300) return;
    const url = d.url;
    if (!/^https?:/i.test(url)) return;
    if (/googlevideo\.com/i.test(url)) return; // YouTube has its own handler below
    if (isTelegramStream(url)) return; // only Telegram's own page can play it
    const h = headerMap(d.responseHeaders);
    const type = (h["content-type"] || "").toLowerCase();
    const isHls = HLS_TYPE.test(type) || /\.m3u8(\?|$)/i.test(url);
    // DASH: a list of the parts of a video in several qualities (.mpd)
    const isDash = DASH_TYPE.test(type) || /\.mpd(\?|$)/i.test(url);
    const isMedia = MEDIA_TYPE.test(type) && !type.includes("mp2t"); // skip HLS chunks
    if (!isHls && !isDash && !isMedia) return;
    if (isDash) {
      addMedia(d.tabId, { url, type: "DASH stream", size: 0, ext: "mp4", dash: true }).catch(() => {});
      return;
    }
    // byte-range pieces of a bigger stream can't be saved as a file
    if (/[?&](range|bytestart)=/i.test(url)) return;

    let size = 0;
    const cr = /\/(\d+)\s*$/.exec(h["content-range"] || "");
    if (cr) size = Number(cr[1]);
    else if (h["content-length"]) size = Number(h["content-length"]);
    // tiny tracking beacons are left out, while stock preview clips and SFX are kept
    if (isMedia && size > 0 && size < (/^audio\//i.test(type) ? 16 : 40) * 1024) return;

    addMedia(d.tabId, {
      url,
      type: isHls ? "HLS stream" : type.split(";")[0],
      size,
      ext: isHls ? "ts" : (type.split("/")[1] || "mp4").split(";")[0].replace("x-matroska", "mkv").replace("mpeg", "mp3"),
    }).catch(() => {});
  },
  { urls: ["<all_urls>"] },
  ["responseHeaders"]
);

// ---------------------------------------------------------------- 3. YouTube

// The player asks for many small pieces of the same stream; we only need to
// store each stream once per tab.
const seenStreams = new Map(); // tabId -> Set("<itag>_<dur>")

async function addYoutubeStream(tabId, stream) {
  const key = `yt_${tabId}`;
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  const videoId = tab ? videoIdOf(tab.url) : null;
  const state = (await chrome.storage.session.get(key))[key] || { videoId, sabr: false, streams: {} };
  if (videoId && state.videoId && state.videoId !== videoId) {
    // the user moved to another video
    state.videoId = videoId;
    state.streams = {};
    state.sabr = false;
    seenStreams.delete(tabId);
  }
  state.videoId = state.videoId || videoId;
  if (stream.sabr) {
    if (state.sabr) return;
    state.sabr = true;
  } else {
    const sk = `${stream.itag}_${stream.dur}${stream.lang ? "_" + stream.lang : ""}`;
    // keep the newest URL of each stream (the old one may expire)
    state.streams[sk] = stream;
    const ids = Object.keys(state.streams);
    if (ids.length > 60) delete state.streams[ids[0]];
  }
  await chrome.storage.session.set({ [key]: state });
  pushToTab(tabId);
}

chrome.webRequest.onBeforeRequest.addListener(
  (d) => {
    if (d.tabId < 0) return;
    const stream = parseStream(d.url);
    if (!stream) return;
    const sk = stream.sabr ? "sabr" : `${stream.itag}_${stream.dur}${stream.lang ? "_" + stream.lang : ""}`;
    let seen = seenStreams.get(d.tabId);
    if (!seen) seenStreams.set(d.tabId, (seen = new Set()));
    if (seen.has(sk)) return;
    seen.add(sk);
    addYoutubeStream(d.tabId, stream).catch(() => {});
  },
  { urls: ["*://*.googlevideo.com/videoplayback*"] }
);

// a part of a video as the page sent it: two times in seconds, the end
// after the start (else nothing)
function partOf(c) {
  if (!c || typeof c !== "object") return null;
  const start = Number(c.start);
  const end = Number(c.end);
  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start || end > 7 * 24 * 3600) return null;
  return { start, end, exact: c.exact === true };
}

async function downloadVideo(option, pageTitle, pageUrl, clip, store, subs) {
  const title = cleanYoutubeTitle(option.title || pageTitle);
  const name = option.quality === "mp3" ? `${title}.mp3` : `${title} [${option.quality}].${option.ext}`;
  await sendToApp({
    url: option.videoUrl,
    audioUrl: option.audioUrl,
    referrer: option.source && !isYoutube(option.source) ? option.source : pageUrl || "https://www.youtube.com/",
    fileName: name,
    headers: option.headers,
    sourcePage: option.source,
    sourceKey: option.key,
    clip,
    store,
    subs,
  });
}

async function sendSubtitles(page, langs, format, title) {
  if (!/^https?:/i.test(page || "") || !Array.isArray(langs) || !langs.length) throw new Error("no subtitles were chosen");
  const { port } = await getOpts();
  const r = await fetchWithTimeout(
    apiUrl(port, "/subtitles"),
    {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-SwiftGet": "1" },
      body: JSON.stringify({ url: page, langs, format: format === "vtt" ? "vtt" : "srt", title: title || "" }),
    },
    125000
  );
  const data = await r.json();
  if (!data.ok) throw new Error(data.error || "no subtitles");
  return data;
}

const qualityHeight = (i) => {
  const m = /(\d{3,4})p/i.exec((i.yt && i.yt.quality) || i.label || "");
  return m ? Number(m[1]) : 0;
};

/** The popup's link box: a YouTube video and a quality ("best", "1080p", "720p", "mp3"). */
async function quickDownload(link, quality) {
  let host = "";
  try {
    host = new URL(link).hostname;
  } catch {
    throw new Error("This is not a link");
  }
  if (!isYoutube(link) || !videoIdOf(link)) throw new Error("YouTube video links only");
  const page = videoPage(link);
  const r = await askApp(page, undefined, true);
  if (!(r.resolved && r.resolved.options.length)) throw new Error(r.resolveError || "Can't get this video");
  const list = wantedOnly(optionItems(r.resolved, page)).filter((i) => i.yt);
  const videos = list.filter((i) => i.yt.quality !== "audio" && i.yt.quality !== "mp3");
  let pick;
  if (quality === "mp3") {
    pick = list.find((i) => i.yt.quality === "mp3") || list.find((i) => i.yt.quality === "audio");
  } else if (quality === "best") {
    pick = videos[0];
  } else {
    const h = parseInt(quality, 10) || 0;
    pick = videos.find((i) => qualityHeight(i) === h) || videos.find((i) => qualityHeight(i) < h) || videos[videos.length - 1];
  }
  if (!pick) throw new Error("No quality of this video fits");
  await downloadVideo(pick.yt, r.resolved.title, page, null, undefined);
  return { title: r.resolved.title || "", label: pick.label };
}

/** Referer / Origin for the add-in's own requests of one sound (the popup's play button). */
async function previewRules(url, referrer) {
  if (!/^https?:/i.test(url) || !/^https?:/i.test(referrer)) return;
  if (!chrome.declarativeNetRequest || !chrome.declarativeNetRequest.updateSessionRules) return;
  const u = new URL(url);
  let hash = 0;
  for (const c of u.host) hash = (hash * 31 + c.charCodeAt(0)) % 90000;
  const id = 9000000 + hash;
  await chrome.declarativeNetRequest.updateSessionRules({
    removeRuleIds: [id],
    addRules: [
      {
        id,
        priority: 1,
        action: {
          type: "modifyHeaders",
          requestHeaders: [
            { header: "Referer", operation: "set", value: referrer },
            { header: "Origin", operation: "set", value: new URL(referrer).origin },
          ],
        },
        condition: { urlFilter: `||${u.host}`, tabIds: [-1], resourceTypes: ["media", "xmlhttprequest", "image", "other"] },
      },
    ],
  });
}

async function sendPlaylist(url) {
  if (!/^https?:/i.test(url || "")) throw new Error("bad address");
  const { port } = await getOpts();
  const r = await fetchWithTimeout(
    apiUrl(port, "/playlist"),
    { method: "POST", headers: { "Content-Type": "application/json", "X-SwiftGet": "1" }, body: JSON.stringify({ url }) },
    5000
  );
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
}

// The on / off switch: every tab shows it at once.
chrome.storage.onChanged.addListener((ch, area) => {
  if (area !== "local" || !ch.enabled) return;
  chrome.action.setBadgeText({ text: ch.enabled.newValue === false ? "off" : "" }).catch(() => {});
  restartAll(ch.enabled.newValue !== false).catch(() => {});
});

// Off and on again = a restart of the add-in: everything it found or kept is forgotten, the
// program is looked for again, and every page starts over (no reload of the page needed).
async function restartAll(on) {
  askCache.clear();
  askBusy.clear();
  resolving.clear();
  seenStreams.clear();
  try {
    const all = await chrome.storage.session.get(null);
    const keys = Object.keys(all).filter((k) => /^(media|yt|res|metas)_\d+$/.test(k));
    if (keys.length) await chrome.storage.session.remove(keys);
  } catch {
    /* nothing kept */
  }
  if (on) await reconnect().catch(() => {});
  const tabs = await chrome.tabs.query({}).catch(() => []);
  for (const t of tabs) {
    if (t.id == null) continue;
    chrome.action.setBadgeText({ tabId: t.id, text: "" }).catch(() => {});
    chrome.tabs.sendMessage(t.id, { type: "swiftget-reset" }).catch(() => {});
    if (on && t.url && isYoutube(t.url) && videoIdOf(t.url)) resolveYoutube(t.id, t.url).catch(() => {});
  }
}

// Ask the app (yt-dlp) for the qualities of a video page.
const resolving = new Map(); // tabId -> page being resolved

// What the app found for a video page is kept for a while (the same video is asked again when
// the mouse rests on it, and again when it is pressed): the second time it is instant. Only one
// request per video is on its way at a time; failures are never kept.
const askCache = new Map(); // page -> { at, value }
const askBusy = new Map(); // page -> promise
const ASK_KEEP_MS = 10 * 60 * 1000;
let askActive = 0;
const askWaiters = [];

/** The same video is one address: "watch?v=ID&list=…&pp=…" and "shorts/ID" ask for the video alone. */
function videoPage(page) {
  try {
    if (isYoutube(page)) {
      const id = videoIdOf(page);
      if (id) return `https://www.youtube.com/watch?v=${id}`;
    }
  } catch {
    /* keep it as it is */
  }
  return page;
}

async function askApp(page, referer, startApp = false) {
  const key = videoPage(page);
  const hit = askCache.get(key);
  if (hit && Date.now() - hit.at < ASK_KEEP_MS) return hit.value;
  if (askBusy.has(key)) return askBusy.get(key);
  const run = (async () => {
    // at most a few at a time: the mouse resting on many videos one after the other
    // must not start a crowd of look-ups
    while (askActive >= 4) await new Promise((r) => askWaiters.push(r));
    askActive++;
    let value;
    try {
      try {
        value = await askAppNow(key, referer, startApp);
      } catch (e) {
        // a slow or dropped answer: once more, at once (the program keeps what it already read)
        if (!(await appAlive())) throw e;
        value = await askAppNow(key, referer, startApp);
      }
    } finally {
      askActive--;
      const next = askWaiters.shift();
      if (next) next();
    }
    if (value.resolved && value.resolved.options.length) {
      askCache.set(key, { at: Date.now(), value });
      while (askCache.size > 120) askCache.delete(askCache.keys().next().value);
    }
    return value;
  })().finally(() => askBusy.delete(key));
  askBusy.set(key, run);
  return run;
}

async function askAppNow(page, referer, startApp = false) {
  const { port } = await getOpts();
  const r = await fetchWithTimeout(
    apiUrl(port, "/resolve"),
    {
      startApp,
      method: "POST",
      headers: { "Content-Type": "application/json", "X-SwiftGet": "1" },
      body: JSON.stringify({ url: page, cookieList: await cookieList(referer || page), referer: referer || null }),
    },
    60000
  );
  const data = await r.json();
  return data.ok
    ? { resolved: { title: data.title, site: data.site, options: data.options, subtitles: data.subtitles || [] } }
    : { resolveError: data.error || "unknown error" };
}

async function patchYt(tabId, videoId, change) {
  const key = `yt_${tabId}`;
  let state = (await chrome.storage.session.get(key))[key];
  if (!state || state.videoId !== videoId) state = { videoId, sabr: false, streams: {} };
  Object.assign(state, change);
  await chrome.storage.session.set({ [key]: state });
  pushToTab(tabId);
}

async function resolveYoutube(tabId, pageUrl) {
  const videoId = videoIdOf(pageUrl);
  if (!videoId || !/(^|\.)youtube\.com$/i.test(new URL(pageUrl).hostname)) return;
  const key = `yt_${tabId}`;
  const state = (await chrome.storage.session.get(key))[key];
  if (state && state.videoId === videoId && (state.resolved || state.resolveError)) return;
  if (resolving.get(tabId) === videoId) return;
  resolving.set(tabId, videoId);
  await patchYt(tabId, videoId, { resolving: true, resolveError: null });
  let change;
  try {
    change = await askApp(`https://www.youtube.com/watch?v=${videoId}`);
  } catch (e) {
    change = { resolveError: (await appAlive()) ? String((e && e.message) || e) : "MediaLab Downloader is not running" };
  } finally {
    if (resolving.get(tabId) === videoId) resolving.delete(tabId);
  }
  // the user may have moved on to another video meanwhile
  const now = await chrome.tabs.get(tabId).catch(() => null);
  if (now && videoIdOf(now.url) === videoId) await patchYt(tabId, videoId, { resolving: false, ...change });
}

/**
 * Any other site: the page (or the post / reel / video link next to the
 * video the user is watching) is handed to yt-dlp, which knows Facebook,
 * Instagram, TikTok, X, Vimeo, Dailymotion and ~1800 more sites.
 */
async function resolvePage(tabId, page, embedded = false) {
  // YouTube's own pages have their own way (resolveYoutube); a YouTube
  // player embedded in another site goes this way
  if (!page || !/^https?:/i.test(page) || (isYoutube(page) && !embedded)) return;
  const key = `res_${tabId}`;
  const state = (await chrome.storage.session.get(key))[key];
  if (state && state.page === page && (state.resolved || state.resolving || state.resolveError)) return;
  if (resolving.get(tabId) === page) return;
  resolving.set(tabId, page);
  await chrome.storage.session.set({ [key]: { page, resolving: true } });
  pushToTab(tabId);
  let change;
  try {
    change = await askApp(page);
  } catch (e) {
    change = { resolveError: (await appAlive()) ? String((e && e.message) || e) : "MediaLab Downloader is not running" };
  } finally {
    if (resolving.get(tabId) === page) resolving.delete(tabId);
  }
  const now = (await chrome.storage.session.get(key))[key];
  if (now && now.page === page) {
    await chrome.storage.session.set({ [key]: { page, resolving: false, ...change } });
    pushToTab(tabId);
  }
}

/** The bubble of a video that is not the page's main one was clicked. */
async function resolveOneVideo(msg, tab) {
  const r = await resolveOneVideoRaw(msg, tab);
  if (r && r.items) r.items = wantedOnly(r.items);
  return r;
}

async function resolveOneVideoRaw(msg, tab) {
  if (isTelegramStream(msg.src) || isTelegramStream(msg.resolve)) return { error: telegramText() };
  // a DASH stream of the page: its own qualities
  if (msg.resolve && /^https?:/i.test(msg.resolve)) {
    try {
      // the user asked (a player's own menu): a closed program is opened
      const r = await askApp(msg.resolve, tab && tab.url, true);
      if (r.resolved && r.resolved.options.length) return { items: optionItems(r.resolved, msg.resolve) };
      return { error: r.resolveError || "Can't get this video" };
    } catch (e) {
      return { error: (await appAlive()) ? String((e && e.message) || e) : "MediaLab Downloader is not running" };
    }
  }
  // a player in a frame (Dailymotion, news sites...): what was found for the
  // whole page (its qualities, its streams) is what this player plays
  if (msg.frame && tab) {
    if (!msg.page && !isYoutube(tab.url)) {
      await resolvePage(tab.id, tab.url).catch(() => {});
      // it may have been started already (the player was seen): wait for it
      for (let i = 0; i < 180; i++) {
        const { res } = await readTab(tab.id);
        if (!res || !res.resolving) break;
        await new Promise((r) => setTimeout(r, 500));
      }
    }
    const found = (await itemsForTab(tab.id)).filter((i) => !i.disabled);
    if (found.length) return { items: found };
  }
  const items = [];
  if (msg.feed && !msg.page) {
    // Facebook feed and no link next to this video: the page's own streams,
    // else how to get the video's own page
    const found = tab ? (await itemsForTab(tab.id)).filter((i) => !i.disabled && !i.yt) : [];
    if (found.length) return { items: found };
    return { error: "Open the video first (click the time next to the name above the video), then press the button again." };
  }
  // a hover preview's own file is a short low-quality clip: never offered for a video whose
  // page / link is known
  if (msg.src && /^https?:/i.test(msg.src) && !msg.page) {
    items.push({ label: "Video file", sub: msg.src, url: msg.src, ext: (/\.(\w{2,4})(\?|$)/.exec(msg.src) || [])[1] || "mp4" });
  }
  const page = msg.page || (msg.hover || (msg.src && !msg.frame) ? "" : tab && tab.url);
  let problem = "";
  if (page && /^https?:/i.test(page)) {
    try {
      const r = await askApp(page);
      if (r.resolved && r.resolved.options.length) items.unshift(...optionItems(r.resolved, page));
      else problem = r.resolveError || "Can't get this video";
    } catch (e) {
      if (!(await appAlive())) return { error: "MediaLab Downloader is not running" };
      problem = String((e && e.message) || e);
    }
  }
  if (items.length) return { items };
  // the page is nothing the app knows (a player of its own): the streams the player opened are
  // this video. For a video the mouse is on only the streams opened since the mouse came to it
  // count (the others are other videos); its preview takes a moment to start, so wait for it.
  if (tab) {
    const since = Number(msg.since) || 0;
    const wait = msg.hover ? 7000 : 1500;
    const until = Date.now() + wait;
    for (;;) {
      const found = (await itemsForTab(tab.id, msg.hover ? since : 0)).filter((i) => !i.disabled && !i.yt);
      if (found.length) return { items: found };
      if (Date.now() >= until) break;
      await new Promise((r) => setTimeout(r, 350));
    }
  }
  if (/unsupported url/i.test(problem) || (msg.hover && !problem)) {
    return { error: "No stream yet. Keep the mouse on the video until it plays, then press the button again." };
  }
  if (isDrm(problem)) return { error: drmText(), drm: true };
  return { error: problem || "Can't get this video" };
}

// ---------------------------------------------------------------- tab lifecycle

chrome.tabs.onUpdated.addListener(async (tabId, info, tab) => {
  try {
    if (!info.url) return;
    const ytKey = `yt_${tabId}`;
    const { [ytKey]: yt } = await chrome.storage.session.get(ytKey);
    const newId = videoIdOf(info.url);
    if (yt && newId && yt.videoId === newId) return; // same video (e.g. timestamp change)
    seenStreams.delete(tabId);
    const resKey = `res_${tabId}`;
    const { [resKey]: res } = await chrome.storage.session.get(resKey);
    if (info.status === "loading" || yt || res) await clearTab(tabId, true);
    if (newId && isYoutube(info.url)) resolveYoutube(tabId, info.url).catch(() => {});
  } catch {}
});
chrome.tabs.onRemoved.addListener((tabId) => {
  seenStreams.delete(tabId);
  Promise.resolve(chrome.storage.session.remove([`media_${tabId}`, `yt_${tabId}`, `res_${tabId}`, metaKey(tabId)])).catch(() => {});
});

// ---------------------------------------------------------------- 4. context menu

function makeMenus() {
  const quietErr = () => void (chrome.runtime && chrome.runtime.lastError);
  try {
    chrome.contextMenus.removeAll(() => {
      quietErr();
      chrome.contextMenus.create({ id: "swiftget-link", title: "Download with MediaLab Downloader", contexts: ["link"] }, quietErr);
      chrome.contextMenus.create({
        id: "swiftget-media",
        title: "Download this media with MediaLab Downloader",
        contexts: ["video", "audio", "image"],
      }, quietErr);
      chrome.contextMenus.create({
        id: "swiftget-video",
        title: "Download video with MediaLab Downloader",
        contexts: ["page", "video", "frame"],
      }, quietErr);
      chrome.contextMenus.create({
        id: "swiftget-all",
        title: "Download all links with MediaLab Downloader",
        contexts: ["page", "frame", "link", "image"],
      }, quietErr);
      chrome.contextMenus.create({
        id: "swiftget-selected",
        title: "Download selected links with MediaLab Downloader",
        contexts: ["selection"],
      }, quietErr);
    });
  } catch {}
}
chrome.runtime.onInstalled.addListener(makeMenus);
chrome.runtime.onStartup.addListener(makeMenus);

/** Every link of the page (or of the selection) to the app's "Download all links". */
async function sendAllLinks(tab, selection) {
  const res = await chrome.tabs.sendMessage(tab.id, { type: "swiftget-collect-links", selection }).catch(() => null);
  if (!res || !res.links || !res.links.length) return;
  const { port } = await getOpts();
  await fetchWithTimeout(
    apiUrl(port, "/links"),
    {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-SwiftGet": "1" },
      body: JSON.stringify({
        page: res.page || tab.url,
        links: res.links,
        cookies: await cookieHeader(res.page || tab.url),
        userAgent: navigator.userAgent,
      }),
    },
    5000
  );
}

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === "swiftget-all" || info.menuItemId === "swiftget-selected") {
    if (tab) sendAllLinks(tab, info.menuItemId === "swiftget-selected").catch((e) => console.warn("MediaLab Downloader:", e));
    return;
  }
  if (info.menuItemId === "swiftget-video") {
    if (!tab) return;
    // find the qualities and open the panel on the page
    if (isYoutube(tab.url)) resolveYoutube(tab.id, tab.url);
    else resolvePage(tab.id, info.frameUrl && info.frameUrl !== tab.url ? tab.url : tab.url);
    chrome.tabs.sendMessage(tab.id, { type: "swiftget-open-panel" }).catch(() => {});
    pushToTab(tab.id);
    return;
  }
  const url = info.linkUrl || info.srcUrl;
  if (!url || !/^https?:/i.test(url)) return;
  storeOf(tab)
    .then((store) => sendToApp({ url, referrer: info.pageUrl, store }))
    .catch((e) => console.warn("MediaLab Downloader:", e));
});

// ---------------------------------------------------------------- messages from page/popup

function reply(promise, sendResponse) {
  promise
    .then(() => sendResponse({ ok: true }))
    .catch((e) => sendResponse({ ok: false, error: String((e && e.message) || e) }));
  return true;
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  switch (msg.type) {
    case "swiftget-download": {
      const item = msg.item || {};
      // a video inside a frame (embedded player): that frame's page
      const referrer = sender.frameId && msg.referrer ? msg.referrer : sender.tab ? sender.tab.url : msg.referrer;
      // a part only from the "✂ Part" tab (the whole video never carries one)
      const clip = msg.part ? partOf(msg.clip) : null;
      if (msg.part && !clip) return reply(Promise.reject(new Error("the part is not right")), sendResponse);
      return reply(
        storeOf(sender.tab).then((store) =>
          item.yt
            ? downloadVideo(item.yt, msg.title, referrer, clip, store, typeof msg.subs === "string" ? msg.subs.slice(0, 1000) : null)
            : sendToApp({ url: item.url, referrer, fileName: msg.fileName, clip, store })
        ),
        sendResponse
      );
    }
    case "swiftget-subtitles":
      sendSubtitles(msg.page, msg.langs, msg.format, msg.title)
        .then((d) => sendResponse({ ok: true, count: d.count, note: d.note || "" }))
        .catch((e) => sendResponse({ ok: false, error: String((e && e.message) || e) }));
      return true;
    case "swiftget-get-media":
      itemsForTab(msg.tabId).then(sendResponse).catch(() => sendResponse([]));
      return true;
    case "swiftget-get-pics": {
      // the small pictures of the videos the popup shows (asked once, not with every refresh)
      loadMetas(Number(msg.tabId))
        .then((list) => {
          const out = {};
          for (const m of list) if ((msg.ids || []).includes(m.id)) out[m.id] = { thumb: m.thumb || "", frames: m.frames || [] };
          sendResponse(out);
        })
        .catch(() => sendResponse({}));
      return true;
    }
    case "swiftget-clear-tab": {
      // the popup's "start again": what was caught on this page is forgotten (the page is not reloaded)
      const tabId = Number(msg.tabId);
      clearTab(tabId, false)
        .then(() => chrome.tabs.sendMessage(tabId, { type: "swiftget-reset" }).catch(() => {}))
        .then(() => sendResponse({ ok: true }))
        .catch(() => sendResponse({ ok: false }));
      return true;
    }
    case "swiftget-quick-download": {
      // the link box of the popup: a YouTube link and a quality go to the program at once
      quickDownload(String(msg.link || "").trim(), String(msg.quality || "best"))
        .then((r) => sendResponse({ ok: true, ...r }))
        .catch((e) => sendResponse({ ok: false, error: String((e && e.message) || e) }));
      return true;
    }
    case "swiftget-preview-rules": {
      // listening to a sound before it is downloaded: the sound's own site gets the same
      // Referer / Origin the page sends (many sites hand a file out only to its own page)
      previewRules(String(msg.url || ""), String(msg.referrer || ""))
        .then(() => sendResponse({ ok: true }))
        .catch((e) => sendResponse({ ok: false, error: String((e && e.message) || e) }));
      return true;
    }
    case "swiftget-forget-video": {
      // its X was pressed: what was found for this video is looked up again next time
      for (const k of [msg.link, msg.page]) {
        if (!k) continue;
        askCache.delete(k);
        askCache.delete(videoPage(k));
      }
      if (sender.tab) {
        const tabId = sender.tab.id;
        const url = sender.tab.url || "";
        const mine = msg.link && videoPage(msg.link) === videoPage(url);
        if (mine || !msg.link) {
          resolving.delete(tabId);
          chrome.storage.session
            .remove([`yt_${tabId}`, `res_${tabId}`])
            .then(() => {
              if (isYoutube(url) && videoIdOf(url)) resolveYoutube(tabId, url);
              pushToTab(tabId);
            })
            .catch(() => {});
        }
      }
      sendResponse({ ok: true });
      return false;
    }
    case "swiftget-hover-meta": {
      if (!sender.tab || !enabledNow) return false;
      if (msg.hover) lastHoverAt.set(sender.tab.id, Date.now());
      const keys = Array.isArray(msg.keys) ? msg.keys.map((k) => String(k).toLowerCase()).slice(0, 12) : [];
      const entry = {
        id: String(msg.id || ""),
        t: Number(msg.t) || Date.now(),
        title: String(msg.title || ""),
        thumb: String(msg.thumb || ""),
        href: String(msg.href || ""),
        keys,
        scan: !!msg.scan,
        hover: !!msg.hover,
        frames: [],
      };
      changeMetas(sender.tab.id, (list) => {
        const same =
          (entry.id && list.find((x) => x.id === entry.id)) ||
          (keys.length && list.find((x) => x.keys && x.keys.some((k) => keys.includes(k)))) ||
          (entry.href && list.find((x) => x.href === entry.href));
        if (same) {
          if (entry.title) same.title = entry.title;
          if (entry.thumb && (!same.thumb || /^data:/i.test(same.thumb))) same.thumb = entry.thumb;
          if (entry.href) same.href = entry.href;
          if (keys.length) same.keys = [...new Set([...(same.keys || []), ...keys])].slice(0, 16);
          if (!msg.refresh && !msg.scan) same.t = entry.t;
          if (!msg.scan) same.scan = false;
          if (entry.hover) same.hover = true; // the mouse came to it (or it is the page's own player)
          return;
        }
        list.push(entry);
        while (list.length > 50) list.shift();
      });
      return false;
    }
    case "swiftget-json-metas": {
      if (!sender.tab || !enabledNow || !Array.isArray(msg.list)) return false;
      changeMetas(sender.tab.id, (list) => {
        for (const item of msg.list.slice(0, 60)) {
          if (!item || typeof item !== "object") continue;
          const keys = Array.isArray(item.keys) ? item.keys.map((k) => String(k).toLowerCase()).slice(0, 12) : [];
          const title = String(item.title || "").trim().slice(0, 160);
          const thumb = String(item.thumb || "").trim();
          if (!keys.length || (!title && !thumb)) continue;
          const same = list.find((x) => x.keys && x.keys.some((k) => keys.includes(k)));
          if (same) {
            if (!same.title && title) same.title = title;
            if (!same.thumb && thumb) same.thumb = thumb;
            same.keys = [...new Set([...(same.keys || []), ...keys])].slice(0, 16);
          } else {
            list.push({ id: `jm-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, t: Date.now(), title, thumb, href: "", keys, frames: [] });
          }
        }
        while (list.length > 60) list.shift();
      });
      return false;
    }
    case "swiftget-hover-frames": {
      // a few pictures taken from the video while it plays (any site): the small picture and its preview
      if (!sender.tab || !enabledNow) return false;
      changeMetas(sender.tab.id, (list) => {
        const m = list.find((x) => x.id === String(msg.id || ""));
        if (!m) return;
        m.frames = (Array.isArray(msg.frames) ? msg.frames : []).filter((f) => typeof f === "string" && f.length < 30000).slice(0, 3);
        if ((!m.thumb || /^https?:/.test(m.thumb) === false) && m.frames[0]) m.thumb = m.frames[0];
      });
      return false;
    }
    case "swiftget-save-pic": {
      const tabId = Number(msg.tabId || (sender.tab && sender.tab.id));
      if (!tabId || !enabledNow) return false;
      const frames = (Array.isArray(msg.frames) ? msg.frames : []).filter((f) => typeof f === "string" && f.length < 40000).slice(0, 3);
      const thumb = typeof msg.thumb === "string" && msg.thumb.length < 40000 ? msg.thumb : frames[0] || "";
      const keys = tokensOfUrl(msg.url || msg.family || "");
      const id = String(msg.metaId || `sp-${msg.family || Date.now()}`);
      changeMetas(tabId, (list) => {
        let m = list.find((x) => x.id === id || (keys.length && x.keys && x.keys.some((k) => keys.includes(k))));
        if (!m) {
          m = { id, t: Date.now(), title: String(msg.name || ""), thumb, href: "", keys, frames };
          list.push(m);
          while (list.length > 60) list.shift();
        } else {
          if (thumb && !m.thumb) m.thumb = thumb;
          if (frames.length && (!m.frames || !m.frames.length)) m.frames = frames;
        }
      });
      return false;
    }
    case "swiftget-stream-seen": {
      // a stream the page asked for (told by the page itself: a worker's request is not in the browser's list)
      const u = String(msg.url || "");
      if (!sender.tab || !/^https?:/i.test(u) || isTelegramStream(u)) return false;
      let meta = null;
      if (msg.meta && typeof msg.meta === "object" && (msg.meta.title || msg.meta.thumb)) {
        const id = `sm-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
        const keys = [...new Set([...(Array.isArray(msg.meta.keys) ? msg.meta.keys : []), ...tokensOfUrl(u)])].slice(0, 12);
        meta = { id, t: Date.now(), title: String(msg.meta.title || ""), thumb: String(msg.meta.thumb || ""), href: String(msg.meta.href || ""), keys, frames: [] };
        changeMetas(sender.tab.id, (list) => {
          const same = keys.length && list.find((x) => x.keys && x.keys.some((k) => keys.includes(k)));
          if (same) {
            if (!same.title && meta.title) same.title = meta.title;
            if (!same.thumb && meta.thumb) same.thumb = meta.thumb;
            meta.id = same.id;
          } else {
            list.push(meta);
            while (list.length > 50) list.shift();
          }
        });
      }
      addMedia(
        sender.tab.id,
        /\.mpd(\?|#|$)/i.test(u)
          ? { url: u, type: "DASH stream", size: 0, ext: "mp4", dash: true, ...(meta ? { meta } : {}) }
          : { url: u, type: "HLS stream", size: 0, ext: "ts", ...(meta ? { meta } : {}) }
      ).catch(() => {});
      return false;
    }
    case "swiftget-direct-media": {
      const u = String(msg.url || "");
      if (!sender.tab || !/^https?:/i.test(u) || isTelegramStream(u) || /googlevideo\.com/i.test(u)) return false;
      const extMatch = /\.([a-z0-9]{2,4})(\?|#|$)/i.exec(u);
      const ext = extMatch ? extMatch[1].toLowerCase() : "mp4";
      const isAud = /^(mp3|wav|m4a|ogg|aac|flac)$/i.test(ext);
      let meta = null;
      if (msg.meta && typeof msg.meta === "object" && (msg.meta.title || msg.meta.thumb)) {
        const id = `dm-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
        const keys = [...new Set([...(Array.isArray(msg.meta.keys) ? msg.meta.keys : []), ...tokensOfUrl(u)])].slice(0, 12);
        meta = { id, t: Date.now(), title: String(msg.meta.title || ""), thumb: String(msg.meta.thumb || ""), href: String(msg.meta.href || ""), keys, hover: !!msg.meta.hover, frames: [] };
        changeMetas(sender.tab.id, (list) => {
          const same = keys.length && list.find((x) => x.keys && x.keys.some((k) => keys.includes(k)));
          if (same) {
            if (!same.title && meta.title) same.title = meta.title;
            if (!same.thumb && meta.thumb) same.thumb = meta.thumb;
            if (meta.hover) same.hover = true;
            meta.id = same.id;
          } else {
            list.push(meta);
            while (list.length > 50) list.shift();
          }
        });
      }
      addMedia(sender.tab.id, {
        url: u,
        type: isAud ? `audio/${ext === "mp3" ? "mpeg" : ext}` : `video/${ext}`,
        size: 0,
        ext,
        ...(meta ? { meta } : {}),
      }).catch(() => {});
      return false;
    }
    case "swiftget-media-request":
      if (!sender.tab) return false;
      if (sender.tab.url && videoIdOf(sender.tab.url)) resolveYoutube(sender.tab.id, sender.tab.url).catch(() => {});
      itemsForTab(sender.tab.id).then(sendResponse).catch(() => sendResponse([]));
      return true;
    case "swiftget-video-seen":
      // the page shows a video: find its qualities
      if (!sender.tab) return false;
      getOpts().then((o) => {
        if (!o.enabled) return;
        if (isYoutube(sender.tab.url)) resolveYoutube(sender.tab.id, sender.tab.url).catch(() => {});
        // a Facebook feed: its address is no video (the video's own post
        // link is looked up when its button is clicked)
        else if (!msg.feed) resolvePage(sender.tab.id, msg.page || sender.tab.url, !!msg.frame).catch(() => {});
      }).catch(() => {});
      return false;
    case "swiftget-resolve-video":
      // one of several videos on the page: its own file, or its own link
      resolveOneVideo(msg, sender.tab).then(sendResponse).catch((e) => sendResponse({ error: String((e && e.message) || e) }));
      return true;
    case "swiftget-link-rules":
      // what a click on a file link in the page should do (decided in the
      // page at once, so the browser never starts its own download)
      Promise.all([getOpts(), getConfig()]).then(([o, cfg]) => {
        if (!o.enabled || !o.intercept || !cfg) return sendResponse(null);
        sendResponse({
          exts: cfg.captureExts || [],
          skipSites: cfg.skipSites || [],
          skipAddresses: cfg.skipAddresses || [],
          skipKey: cfg.skipKey || "none",
          forceKey: cfg.forceKey || "none",
        });
      }).catch(() => sendResponse(null));
      return true;
    case "swiftget-link":
      // a file link clicked in a page: straight to the app
      return reply(
        storeOf(sender.tab).then((store) => takeLink(msg.url, sender.tab ? sender.tab.url : "", store)),
        sendResponse
      );
    case "swiftget-magnet":
      // a torrent's magnet link clicked on a page
      return reply(
        getOpts().then(async (o) => {
          if (!o.enabled || !o.intercept) throw new Error("sending is off");
          // Options > Torrents: MediaLab Downloader is not the main torrent program
          const cfg = await getConfig();
          if (cfg && cfg.torrents === false) throw new Error("torrents are not taken");
          return sendToApp({ url: msg.url, referrer: sender.tab ? sender.tab.url : "" });
        }),
        sendResponse
      );
    case "swiftget-playlist":
      // "Download all" on a playlist page: the app's playlist window
      return reply(sendPlaylist(msg.url), sendResponse);
    case "swiftget-status":
      (async () => {
        if (!enabledNow) return sendResponse({ ok: false, state: "off" });
        const ok = await appAlive();
        if (!ok) return sendResponse({ ok: false, state: "down" });
        // the program runs: is the add-in connected to it (its key)?
        const { port } = await getOpts();
        let linked = false;
        try {
          linked = (await fetchWithTimeout(apiUrl(port, "/config"), { headers: { "X-SwiftGet": "1" } }, 2500)).ok;
        } catch {
          linked = false;
        }
        sendResponse({ ok: linked, state: linked ? "ok" : "nokey" });
      })();
      return true;
    case "swiftget-reconnect":
      reconnect().then((ok) => sendResponse({ ok })).catch(() => sendResponse({ ok: false }));
      return true;
    case "swiftget-keys":
      lastKeys = { alt: !!msg.alt, ctrl: !!msg.ctrl, shift: !!msg.shift, at: Date.now() };
      return false;
    case "swiftget-config":
      Promise.all([getConfig(), getOpts()]).then(([cfg, o]) => {
        const panel = (cfg && cfg.panel) || { enabled: true, skipSites: [] };
        sendResponse(o.enabled ? panel : { ...panel, enabled: false });
      }).catch(() => sendResponse({ enabled: true, skipSites: [] }));
      return true;
    default:
      return false;
  }
});
