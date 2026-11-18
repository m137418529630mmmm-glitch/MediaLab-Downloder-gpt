// Floating "Download this video" button, shown when the background worker
// detects a video/audio file or HLS stream on the page. Runs in every frame:
// videos inside frames (embedded players) and inside shadow DOM get their
// own button too.
(() => {
  if (window.__medialabDownload) return;
  window.__medialabDownload = true;
  const TOP = window.top === window;

  // ---- the add-in goes away (switched off, updated, removed): this copy of the script in an open
  // page ends quietly: no button left behind, no timers, no "Extension context invalidated"
  let dead = false;
  const alive = () => {
    try {
      return !!(chrome.runtime && chrome.runtime.id);
    } catch (_) {
      return false;
    }
  };
  // Every message to the add-in's background goes this way: when the add-in is gone (updated, switched
  // off, reloaded) `chrome.runtime` is not there any more and a plain call throws a TypeError.
  const safeSend = (msg, cb) => {
    try {
      if (!alive()) {
        shutdown();
        return Promise.resolve();
      }
      const r = chrome.runtime.sendMessage(msg, cb);
      if (r && typeof r.catch === "function") r.catch(() => {}); // (a refused message is no error)
      return Promise.resolve();
    } catch (e) {
      if (/context invalidated|sendMessage|undefined|chrome\.runtime/i.test(String((e && e.message) || e))) shutdown();
      return Promise.resolve();
    }
  };
  const timers = [];
  const every = (fn, ms) => {
    const t = setInterval(() => {
      if (dead) return;
      if (!alive()) return shutdown();
      try {
        fn();
      } catch (e) {
        if (/context invalidated/i.test(String((e && e.message) || e))) shutdown();
      }
    }, ms);
    timers.push(t);
    return t;
  };
  function shutdown() {
    if (dead) return;
    dead = true;
    window.__medialabDownload = false;
    for (const t of timers) clearInterval(t);
    try {
      for (const b of bubbles.values()) b.host.remove();
      bubbles.clear();
    } catch (_) {
      /* nothing to remove */
    }
    try {
      document.documentElement.removeAttribute("data-medialab-probe");
    } catch (_) {
      /* ignore */
    }
  }
  // errors of a script whose add-in is gone are not reported
  const quiet = (e) => {
    const m = String((e && (e.message || (e.reason && e.reason.message))) || "");
    if (!alive() || /context invalidated|receiving end does not exist|message port closed|reading 'sendMessage'/i.test(m)) {
      try {
        e.preventDefault();
        e.stopImmediatePropagation();
      } catch (_) {
        /* ignore */
      }
      shutdown();
    }
  };
  addEventListener("error", quiet, true);
  addEventListener("unhandledrejection", quiet, true);
  // the add-in puts this script into open pages when it starts (no reload of the page needed):
  // a copy that is already alive in the page keeps working, the new one stands down
  try {
    const root = document.documentElement;
    const nonce = Math.random().toString(36).slice(2) + Date.now().toString(36);
    root.setAttribute("data-medialab-probe", nonce);
    document.dispatchEvent(new CustomEvent("medialab-probe"));
    if (root.getAttribute("data-medialab-answer") === nonce) {
      window.__medialabDownload = false;
      return;
    }
    document.addEventListener("medialab-probe", () => {
      if (!dead && alive()) root.setAttribute("data-medialab-answer", root.getAttribute("data-medialab-probe") || "");
    });
  } catch (_) {
    /* a page without a root element */
  }

  let items = [];
  // Options > File Types > "Download panel for web players"
  let panel = { enabled: true, skipSites: [] };
  const hostMatches = (host, p) => {
    p = String(p).replace(/^https?:\/\//i, "").split("/")[0].toLowerCase();
    if (!p) return false;
    if (p.includes("*")) return new RegExp("^" + p.replace(/[.]/g, "\\.").replace(/\*/g, ".*") + "$").test(host);
    return host === p || host.endsWith("." + p);
  };
  // the on / off switch of the add-in's window
  let switchedOn = true;
  // the video button in full screen too (the add-in's window); off: hidden there
  let showInFullscreen = false;
  const panelAllowed = () =>
    switchedOn &&
    !noButtonHere &&
    panel.enabled !== false &&
    !(panel.skipSites || []).some((s) => hostMatches(location.hostname.toLowerCase(), s));
  // a press of the user (or the same press passed on by early.js), never one a
  // page's script made up
  const userPress = (e) => !!e && (e.isTrusted || !!(globalThis.__medialabReplayed && globalThis.__medialabReplayed.has(e)));
  // "Don't show it on this site", and where the user put it on this site
  const SITE = location.hostname.toLowerCase();
  let noButtonHere = false;
  let sitePlace = null;
  try {
    chrome.storage.local.get({ noButtonSites: [], buttonPlaces: {} }, (o) => {
      noButtonHere = !!(o && (o.noButtonSites || []).includes(SITE));
      sitePlace = (o && o.buttonPlaces && o.buttonPlaces[SITE]) || null;
      if (noButtonHere) removeAll();
    });
  } catch (_) {
    /* storage not reachable: shown, at its usual place */
  }
  const PRIVATE = !!(chrome.extension && chrome.extension.inIncognitoContext);
  function keepPlace(p) {
    sitePlace = p;
    // never in a private window (it would keep the site's name)
    if (PRIVATE) return;
    try {
      chrome.storage.local.get({ buttonPlaces: {} }, (o) => {
        const all = (o && o.buttonPlaces) || {};
        delete all[SITE];
        all[SITE] = p;
        const sites = Object.keys(all);
        for (const s of sites.slice(0, Math.max(0, sites.length - 200))) delete all[s];
        chrome.storage.local.set({ buttonPlaces: all });
      });
    } catch (_) {
      /* not kept: it stays there on this page */
    }
  }
  function noButtonOnThisSite() {
    noButtonHere = true;
    removeAll();
    try {
      chrome.storage.local.get({ noButtonSites: [] }, (o) => {
        const list = ((o && o.noButtonSites) || []).filter((h) => h !== SITE);
        list.push(SITE);
        chrome.storage.local.set({ noButtonSites: list.slice(-500) });
      });
    } catch (_) {
      /* only for this page then */
    }
  }

  const fmtSize = (n) => {
    if (!n) return "";
    const u = ["B", "KB", "MB", "GB"];
    let i = 0;
    while (n >= 1024 && i < u.length - 1) {
      n /= 1024;
      i++;
    }
    return `${n.toFixed(i ? 1 : 0)} ${u[i]}`;
  };
  const fmtLen = (s) => {
    s = Math.round(Number(s) || 0);
    if (!s) return "";
    const two = (n) => String(n).padStart(2, "0");
    return s >= 3600 ? `${Math.floor(s / 3600)}:${two(Math.floor(s / 60) % 60)}:${two(s % 60)}` : `${Math.floor(s / 60)}:${two(s % 60)}`;
  };
  // "1:02:05", "02:05", "125", "2:05.5" -> seconds (null when not a time)
  const parseClock = (text) => {
    const t = String(text || "").trim().replace(/[٠-٩]/g, (c) => String(c.charCodeAt(0) - 0x660)).replace(",", ".");
    const m = /^(?:(\d{1,2}):)?(?:(\d{1,3}):)?(\d{1,6})(?:\.(\d{1,3}))?$/.exec(t);
    if (!m) return null;
    const parts = t.split(".")[0].split(":").map(Number);
    if (parts.slice(1).some((n) => n >= 60)) return null;
    let secs = parts.reduce((a, n) => a * 60 + n, 0);
    if (m[4]) secs += Number("0." + m[4]);
    return secs;
  };
  const clock = (s) => {
    s = Math.max(0, Math.floor(Number(s) || 0));
    const two = (n) => String(n).padStart(2, "0");
    return s >= 3600 ? `${Math.floor(s / 3600)}:${two(Math.floor(s / 60) % 60)}:${two(s % 60)}` : `${two(Math.floor(s / 60))}:${two(s % 60)}`;
  };
  // the resolution in plain words (the app sends it; streams seen in the
  // player only have the height)
  const tagOf = (h) => (!h ? "" : h >= 4320 ? "8K" : h >= 2160 ? "4K" : h >= 1440 ? "2K" : h >= 1080 ? "Full HD" : h >= 720 ? "HD" : "SD");

  const cleanTitle = () =>
    (document.title || "video").replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_").trim().slice(0, 120) || "video";

  // --------------------------------------------------------------- videos
  // Videos of the page, also those inside shadow DOM (players built as web
  // components). The deep search is slower, so it runs every few rounds.
  let shadowVideos = [];
  let deepRound = 0;
  function collectShadow(root, out, depth) {
    if (depth > 6) return;
    for (const el of root.querySelectorAll("*")) {
      const sr = el.shadowRoot;
      if (!sr) continue;
      out.push(...sr.querySelectorAll("video"));
      collectShadow(sr, out, depth + 1);
    }
  }
  function allVideos() {
    const list = [...document.querySelectorAll("video")];
    if (deepRound++ % 4 === 0) {
      const found = [];
      try {
        collectShadow(document, found, 0);
      } catch (_) {
        /* a strange page: keep what we have */
      }
      shadowVideos = found;
    }
    for (const v of shadowVideos) if (v.isConnected && !list.includes(v)) list.push(v);
    return list;
  }

  // The video the user is watching: a playing one first, else the biggest
  // one on screen.
  function biggestVideo() {
    let best = null;
    let score = 0;
    for (const v of allVideos()) {
      const r = v.getBoundingClientRect();
      if (r.width < 200 || r.height < 100) continue;
      const visible = Math.max(0, Math.min(r.bottom, innerHeight) - Math.max(r.top, 0));
      if (visible < 60) continue;
      const s = r.width * visible * (!v.paused && !v.ended ? 4 : 1);
      if (s > score) {
        best = v;
        score = s;
      }
    }
    return best;
  }
  const playing = (v) => !v.paused && !v.ended && v.duration > 3;

  // Pages that are one video: their own address is the best link for it.
  const VIDEO_PAGE = [
    /youtube\.com\/(watch|shorts\/|live\/|embed\/)/i,
    /youtube-nocookie\.com\/embed\//i,
    /tiktok\.com\/@[^/]+\/(video|photo)\//i,
    /instagram\.com\/(reels?|p|tv)\//i,
    /facebook\.com\/(.+\/videos\/|watch|reel\/|share\/[vr]\/|plugins\/video)/i,
    /fb\.watch\//i,
    /(twitter|x)\.com\/[^/]+\/status\//i,
    /vimeo\.com\/\d+/i,
    /player\.vimeo\.com\/video\//i,
    // (not the "geo.dailymotion.com/player/…" frame: that is only the player)
    /dailymotion\.com\/(video\/|embed\/video\/)/i,
    /dai\.ly\//i,
    /reddit\.com\/r\/[^/]+\/comments\//i,
    /twitch\.tv\/(videos\/|[^/]+\/clip\/)/i,
    /clips\.twitch\.tv\//i,
    /pinterest\.[a-z.]+\/pin\//i,
    /snapchat\.com\/(spotlight|add)\//i,
    /linkedin\.com\/(posts|feed\/update)\//i,
  ];
  const isVideoPage = (u) => VIDEO_PAGE.some((r) => r.test(u));
  // Facebook feeds: the post a video is in is also a link the app can read
  // (the feed's own address - facebook.com/ - is not)
  const FB_POST = [
    /facebook\.com\/[^/?#]+\/posts\//i,
    /facebook\.com\/permalink\.php\?[^#]*story_fbid=/i,
    /facebook\.com\/story\.php\?[^#]*story_fbid=/i,
    /facebook\.com\/groups\/[^/]+\/(permalink|posts)\//i,
    /facebook\.com\/photo(\.php)?\/?\?[^#]*fbid=/i,
  ];
  const onFacebook = /(^|\.)facebook\.com$/i.test(location.hostname);
  const isPostLink = (u) => onFacebook && FB_POST.some((r) => r.test(u));
  // a Facebook feed (home, a page's wall, groups...): many videos, and its
  // own address is none of them
  const inFeed = () => onFacebook && !isVideoPage(location.href) && !isPostLink(location.href);
  // what is left of a Facebook link once its tracking part is cut off
  function cleanLink(u) {
    try {
      const x = new URL(u);
      for (const k of [...x.searchParams.keys()]) if (/^(__cft__|__tn__|_fb_noscript|ref|rdid|mibextid)/i.test(k)) x.searchParams.delete(k);
      x.hash = "";
      return x.toString();
    } catch {
      return u.split("#")[0];
    }
  }

  // In feeds (Facebook, Instagram, X...) the page shows many videos: look for
  // the post / reel link around the video being watched.
  function linkFor(video) {
    if (isVideoPage(location.href) || isPostLink(location.href)) return cleanLink(location.href);
    // a Facebook feed / home page is no video: nothing rather than the feed
    return ownLink(video) || (onFacebook ? "" : location.href);
  }

  // the post / video link next to this very video ("" = none found)
  function ownLink(video) {
    if (video === audioSlot) return "";
    // a card: the video it links to (exact)
    if (video.tagName === "A" && video.href && isVideoPage(video.href)) return cleanLink(video.href);
    let el = video;
    let post = "";
    for (let depth = 0; el && depth < 25; depth++) {
      const links = el.querySelectorAll ? el.querySelectorAll("a[href]") : [];
      for (const a of links) {
        if (isVideoPage(a.href)) return cleanLink(a.href);
        if (!post && isPostLink(a.href)) post = cleanLink(a.href);
      }
      // the end of this post (Facebook marks its posts, it has no <article>)
      if (el.tagName === "ARTICLE" || (el.getAttribute && el.getAttribute("role") === "article")) break;
      // out of a shadow root: on to the element that holds it
      el = el.parentElement || (el.parentNode && el.parentNode.host) || null;
    }
    if (post) return post;
    // an embedded player: the frame's own address is the video
    if (!TOP && isVideoPage(location.href)) return location.href;
    return "";
  }

  let lastPage = "";
  function watchVideos() {
    // videos that were already playing when the page was found (not told by an event)
    try {
      let k = 0;
      for (const pv of allVideos()) if ((!pv.paused || pv.readyState >= 1 || pv.currentSrc || pv.poster) && k++ < 24) noteVideo(pv);
    } catch (_) {
      /* a page that hides its videos */
    }
    const v = biggestVideo();
    if (!v) return;
    // ignore tiny muted background loops that never play for long
    if (v.paused && !(v.duration > 3) && !v.currentSrc) return;
    // in a frame (an embedded player): its own address when it is a video
    // page (YouTube / Vimeo embeds), otherwise the page around it (the
    // add-in knows that one)
    const page = TOP ? linkFor(v) : isVideoPage(location.href) ? location.href : "";
    if (page !== lastPage || (!TOP && !lastPage)) {
      if (!TOP && lastPage === "frame:" + page) return;
      lastPage = TOP ? page : "frame:" + page;
      safeSend({ type: "swiftget-video-seen", page, frame: !TOP, feed: TOP && !page && inFeed() });
    }
  }

  // ---------------------------------------------------------------- bubbles
  // One "Download" bubble on every video of the page. The main video (the
  // one playing / the biggest) uses what the add-in found for the page; any
  // other video is looked up when its bubble is clicked. A bubble can be
  // dragged anywhere on its video and stays there.
  const bubbles = new Map(); // video -> bubble

  // ---- ONE button for the whole tab, following the video the user is on -------------------
  // pointer: where the mouse is in this frame; the frame the mouse is in owns the button,
  // the other frames hide theirs (every frame runs this script)
  let mouseX = -1;
  let mouseY = -1;
  let lastPlaceAt = 0;
  let lastLookAt = 0;
  let lastActive = null;
  let foreignClaimAt = 0;
  let lastClaimAt = 0;
  let lastLocalPointerAt = 0;
  const FRAME_ID = Math.random().toString(36).slice(2) + Date.now().toString(36);
  function toChildFrames(msg) {
    try {
      for (const f of document.querySelectorAll("iframe, frame")) {
        try {
          if (f.contentWindow) f.contentWindow.postMessage(msg, "*");
        } catch (_) {
          /* a frame we cannot reach */
        }
      }
    } catch (_) {
      /* ignore */
    }
  }
  function claimButton(force) {
    const now = Date.now();
    if (!force && now - lastClaimAt < 700) return;
    lastClaimAt = now;
    foreignClaimAt = 0;
    const msg = { __medialabClaim: FRAME_ID };
    if (TOP) toChildFrames(msg);
    else {
      try {
        window.top.postMessage(msg, "*");
      } catch (_) {
        /* ignore */
      }
    }
  }
  addEventListener(
    "message",
    (e) => {
      const d = e && e.data;
      if (!d || typeof d !== "object" || !d.__medialabClaim || d.__medialabClaim === FRAME_ID) return;
      foreignClaimAt = Date.now();
      if (TOP || e.source === window.parent) toChildFrames(d);
    },
    true
  );
  // a stream (.m3u8 / .mpd) the page itself asked for, told by hook.js
  addEventListener(
    "message",
    (e) => {
      const d = e && e.data;
      if (e.source !== window || !d || typeof d !== "object") return;
      if (Array.isArray(d.__medialabMetaList) && d.__medialabMetaList.length) {
        try {
          safeSend({ type: "swiftget-json-metas", list: d.__medialabMetaList }, () => void chrome.runtime.lastError);
        } catch (_) {}
        return;
      }
      if (typeof d.__medialabDirectMedia === "string") {
        try {
          const meta = matchDomMetaForStream(d.__medialabDirectMedia);
          safeSend({ type: "swiftget-direct-media", url: d.__medialabDirectMedia, meta }, () => void chrome.runtime.lastError);
        } catch (_) {}
        return;
      }
      if (typeof d.__medialabStream !== "string") return;
      try {
        const meta = matchDomMetaForStream(d.__medialabStream);
        safeSend({ type: "swiftget-stream-seen", url: d.__medialabStream, meta }, () => void chrome.runtime.lastError);
      } catch (_) {
        /* add-in reloading */
      }
    },
    true
  );
  const hiddenByOtherFrame = () => {
    const now = Date.now();
    return !!foreignClaimAt && now - foreignClaimAt < 8000 && now - lastLocalPointerAt > 1500;
  };
  const inRect = (r, x, y, pad) => x >= r.left - pad && x <= r.right + pad && y >= r.top - pad && y <= r.bottom + pad;

  // ---- what the button is attached to ------------------------------------------------------
  // ONE button per page. It sits on the video, or on the card (a thumbnail that links to a
  // video page), the mouse is on, and stays there until the mouse is on another one. It does
  // not go away when a hover preview ends, and pressing it never opens the video.
  const audioSlot = document.createElement("span"); // stands for "the sound of this page"
  let theBubble = null;
  let cur = null; // the target the mouse chose
  let recentCard = null; // { a, t }: the card the mouse was on a moment ago
  let hiddenTarget = null; // closed with its X: comes back when the mouse comes to a target again
  let hiddenLeft = false;
  let mainAt = 0;
  let mainV = null;
  const cards = new WeakSet(); // boxes (a thumbnail's frame) that stand for the video that plays in them
  const isCard = (t) => !!t && (t.tagName === "A" || cards.has(t));
  const isAudioTarget = (t) => t === audioSlot;
  const connected = (t) => t === audioSlot || t.isConnected;
  const audioItems = () => items.filter((i) => i.audio && !i.disabled);
  function cardRect(a) {
    const r = a.getBoundingClientRect();
    if (r.width >= 120 && r.height >= 66) return r;
    let best = null;
    for (const c of a.querySelectorAll("img, video, canvas, picture")) {
      const x = c.getBoundingClientRect();
      if (!best || x.width * x.height > best.width * best.height) best = x;
    }
    return best || r;
  }
  function rectOfTarget(t) {
    if (t === audioSlot) {
      const w = 260;
      const h = 110;
      const left = Math.max(0, innerWidth - w - 14);
      return { left, top: 10, right: left + w, bottom: 10 + h, width: w, height: h };
    }
    return isCard(t) ? cardRect(t) : t.getBoundingClientRect();
  }
  const minSize = (t) => (isCard(t) ? [120, 66] : [200, 100]);
  // the rectangle of a button's target; one the page took away (a hover preview that ends
  // when the mouse leaves its card) keeps its last place for a moment
  function rectOfB(b) {
    if (connected(b.video)) {
      const r = rectOfTarget(b.video);
      b.lastRect = { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height };
      b.ghost = false;
      b.goneAt = 0;
      return r;
    }
    return b.lastRect || { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 };
  }
  function mainVideo() {
    const now = Date.now();
    if (now - mainAt > 400) {
      mainAt = now;
      mainV = TOP ? biggestVideo() : null;
    }
    return mainV;
  }
  // The box around a hover preview: the preview video comes and goes with the mouse, the box stays,
  // so the button stays too. A big player (the page's own video) has no box.
  function cardBoxOf(v) {
    const vr = v.getBoundingClientRect();
    if (vr.width >= innerWidth * 0.5 || vr.height >= innerHeight * 0.6) return null;
    const ok = (n) => {
      if (!n || n === document.body || n === document.documentElement) return false;
      const r = n.getBoundingClientRect();
      return r.width >= 120 && r.height >= 66 && r.width <= 760 && r.height <= 560;
    };
    for (const sel of ["a[href]", "article, li, figure, [role='listitem']", "[class*='card' i], [class*='tile' i], [class*='thumb' i], [class*='clip' i], [class*='item' i]"]) {
      const n = v.closest(sel);
      if (ok(n)) return n;
    }
    // Modern grid pages (Tailwind / CSS Modules) wrap the video, thumbnail <img>, and <a href> in a plain <div>
    let best = null;
    let p = v.parentElement;
    for (let depth = 0; p && depth < 7; depth++, p = p.parentElement) {
      if (!ok(p)) break;
      if (p.querySelectorAll && p.querySelectorAll("video").length > 1) break;
      if (p.querySelectorAll && p.querySelectorAll("a, img, h1, h2, h3, h4").length > 0) best = p;
    }
    return best;
  }
  const slugTitleFromHref = (href) => {
    if (!href) return "";
    try {
      const segs = new URL(href, location.href).pathname.split("/").filter(Boolean).map((x) => decodeURIComponent(x));
      const words = segs.filter(
        (x) =>
          /[a-z\u0600-\u06ff]{3}/i.test(x) &&
          /[-_]/.test(x) &&
          !/^[0-9a-f-]{16,}$/i.test(x) &&
          !/^(stock-footage|stock-video|royalty-free|video-templates|sound-effects)$/i.test(x)
      );
      if (words.length) {
        const w = words
          .sort((x, y) => y.length - x.length)[0]
          .replace(/[-_]+\d{5,}$/, "")
          .replace(/[-_]+/g, " ")
          .replace(/\.[a-z0-9]{2,4}$/i, "")
          .trim();
        if (w.length >= 4) return w.charAt(0).toUpperCase() + w.slice(1);
      }
    } catch (_) {}
    return "";
  };
  // the name of a card: what the page calls it
  function bestTitle(el) {
    if (!el) return "";
    const clean = (x) => String(x || "").replace(/\s+/g, " ").trim();
    const bad = /^(play|pause|mute|unmute|volume|fullscreen|video|audio|watch|download|image|thumbnail|preview|photo|more|menu|clip|share|save|like|favorite|favourite|bookmark|collection|board|similar|similar videos|add to .*|made with ai|create ai .*|hd|4k|8k|sd|fhd|uhd|new|pro|free|\d+:\d+|\d+\s*(fps|s|sec))$/i;
    const isUuid = (x) => /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|^[0-9a-f_-]{16,}$/i.test(x);
    const cands = [];
    const addCand = (v) => {
      const c = clean(v);
      if (c.length >= 3 && c.length <= 160 && !bad.test(c) && !isUuid(c) && !/^https?:/i.test(c)) cands.push(c);
    };
    const scanAttrs = (n) => {
      if (!n || n.nodeType !== 1 || !n.getAttribute) return;
      if (n.tagName === "BUTTON" || n.getAttribute("role") === "button") return;
      for (const a of ["data-title", "data-name", "data-video-title", "aria-label", "title"]) addCand(n.getAttribute(a));
    };
    // 1. Explicit headings, title classes, and thumbnail alt text first (most accurate on video grids)
    if (el.querySelectorAll) {
      for (const n of el.querySelectorAll("h1, h2, h3, h4, #video-title, [data-title], [data-name], [class*='title' i], [class*='name' i], img[alt]")) {
        if (n.tagName === "BUTTON" || (n.closest && n.closest("button"))) continue;
        scanAttrs(n);
        if (n.tagName === "IMG") addCand(n.alt || (n.getAttribute && n.getAttribute("alt")));
        else if (/^H[1-4]$/.test(n.tagName) || /title|name/i.test(String(n.className || "") + " " + (n.id || ""))) addCand(n.textContent);
      }
    }
    // 2. Links inside or wrapping the card
    const links = [];
    if (el.tagName === "A") links.push(el);
    if (el.closest) {
      const ca = el.closest("a[href]");
      if (ca && !links.includes(ca)) links.push(ca);
    }
    if (el.querySelectorAll) {
      for (const la of el.querySelectorAll("a[href]")) if (!links.includes(la)) links.push(la);
    }
    for (const a of links) {
      scanAttrs(a);
      addCand(a.textContent);
    }
    // 3. Slug from the card link (e.g. "/clip/christmas-tree-morning-gift/6638748")
    for (const a of links) {
      const slug = slugTitleFromHref(a.href || (a.getAttribute && a.getAttribute("href")));
      if (slug) addCand(slug);
    }
    // 4. General aria-label / title on container or non-button descendants
    scanAttrs(el);
    if (el.querySelectorAll) {
      for (const n of el.querySelectorAll("[aria-label], [title]")) scanAttrs(n);
    }
    return cands[0] || "";
  }
  // A thumbnail card of a site the add-in has no rule for: a link whose big picture / video leads
  // to a page that is a video's ("/stock-video/…", "/clip/…", "/footage/…", "/watch/…").
  const genericCards = new WeakSet();
  const VIDEOISH_PATH = /(^|\/)(stock-)?(video|videos|clip|clips|footage|film|films|movie|movies|watch|reel|reels|shorts|vid|player|play)(\/|-|_|$)/i;
  function looksLikeVideoCard(a) {
    if (a.tagName !== "A" || !a.href || !/^https?:/i.test(a.href)) return false;
    let u;
    try {
      u = new URL(a.href);
    } catch (_) {
      return false;
    }
    if (u.pathname.length < 2 || (u.origin === location.origin && u.pathname === location.pathname)) return false;
    const r = a.getBoundingClientRect();
    if (r.width < 160 || r.height < 90 || r.width > 900 || r.height > 700) return false;
    // the card is a picture / a video (not a text link)
    let media = null;
    for (const m of a.querySelectorAll("video, canvas, img, picture")) {
      const mr = m.getBoundingClientRect();
      if (mr.width * mr.height >= r.width * r.height * 0.25 && mr.width >= 100 && mr.height >= 56) {
        media = m;
        break;
      }
    }
    // overlay <a> sitting on top of a sibling <video>/<img> inside a card wrapper (MotionArray, etc.)
    if (!media && a.parentElement && a.parentElement !== document.body) {
      const pr = a.parentElement.getBoundingClientRect();
      if (pr.width <= 900 && pr.height <= 700) {
        for (const m of a.parentElement.querySelectorAll("video, canvas, img, picture")) {
          const mr = m.getBoundingClientRect();
          if (mr.width >= 100 && mr.height >= 56) {
            media = m;
            break;
          }
        }
      }
    }
    if (!media) return false;
    if (media.tagName === "VIDEO" || media.tagName === "CANVAS") return true;
    return VIDEOISH_PATH.test(u.pathname) || /video|clip|footage|play/i.test((a.getAttribute("aria-label") || "") + " " + (a.getAttribute("title") || ""));
  }
  const sameTargetLink = (a, b) => {
    if (!a || !b) return false;
    const la = ownLink(a);
    const lb = ownLink(b);
    return !!(la && lb && la === lb);
  };
  // what is under the mouse: a video, or a card that links to one
  function candidateFrom(e) {
    const path = e.composedPath ? e.composedPath() : [e.target];
    const roots = globalThis.__medialabRoots;
    let vid = null;
    let card = null;
    let fallbackBox = null;
    for (const n of path) {
      if (!n || n === document || n === window) break;
      if (roots && roots.has(n)) return { own: true };
      const tag = n.tagName;
      if (!tag) continue;
      if (!vid && tag === "VIDEO") vid = n;
      else if (!card && tag === "A" && n.href && (isVideoPage(n.href) || (looksLikeVideoCard(n) && (genericCards.add(n), true)))) card = n;
      else if (!fallbackBox && n.nodeType === 1 && n !== document.body && n !== document.documentElement && n.querySelector) {
        const r = n.getBoundingClientRect ? n.getBoundingClientRect() : null;
        if (r && r.width >= 140 && r.height >= 80 && r.width <= 760 && r.height <= 560) {
          const innerV = n.querySelector("video");
          if (innerV) fallbackBox = n;
          else if (!card) {
            const innerA = n.querySelector("a[href]");
            if (innerA && (isVideoPage(innerA.href) || (looksLikeVideoCard(innerA) && (genericCards.add(innerA), true)))) {
              card = innerA;
            }
          }
        }
      }
    }
    if (card) {
      const cr = cardRect(card);
      if (cr.width >= 120 && cr.height >= 66) {
        // Keep the existing stable bubble target if it points to the exact same video
        if (theBubble && connected(theBubble.video) && sameTargetLink(card, theBubble.video)) {
          recentCard = { a: theBubble.video, t: Date.now() };
          return { el: theBubble.video };
        }
        recentCard = { a: card, t: Date.now() };
        return { el: card };
      }
    }
    if (vid) {
      const r = vid.getBoundingClientRect();
      // If YouTube / a site floats an inline hover preview over the active card, stay locked on the card!
      if (theBubble && connected(theBubble.video) && !isMain(vid)) {
        const br = rectOfTarget(theBubble.video);
        if (
          sameTargetLink(vid, theBubble.video) ||
          (isCard(theBubble.video) && br.width >= 120 && br.height >= 66 && inRect(br, r.left + r.width / 2, r.top + r.height / 2, 45))
        ) {
          recentCard = { a: theBubble.video, t: Date.now() };
          return { el: theBubble.video };
        }
      }
      if (recentCard && Date.now() - recentCard.t < 15000 && recentCard.a.isConnected && !isMain(vid)) {
        if (inRect(cardRect(recentCard.a), r.left + r.width / 2, r.top + r.height / 2, 45)) {
          recentCard.t = Date.now();
          return { el: recentCard.a };
        }
      }
      // a preview that plays inside a thumbnail's frame: the frame is the target (steady)
      const box = r.width >= 100 && r.height >= 56 ? cardBoxOf(vid) : null;
      if (box) {
        cards.add(box);
        recentCard = { a: box, t: Date.now() };
        return { el: box };
      }
      if (r.width >= 200 && r.height >= 100) {
        return { el: vid };
      }
    }
    if (fallbackBox) {
      cards.add(fallbackBox);
      recentCard = { a: fallbackBox, t: Date.now() };
      return { el: fallbackBox };
    }
    return { el: null };
  }
  addEventListener(
    "mousemove",
    (e) => {
      if (dead) return;
      mouseX = e.clientX;
      mouseY = e.clientY;
      lastLocalPointerAt = Date.now();
      if (lastLocalPointerAt - lastLookAt < 60) return; // (a mouse moves a hundred times a second)
      lastLookAt = lastLocalPointerAt;
      let c;
      try {
        c = candidateFrom(e);
      } catch (_) {
        c = { el: null };
      }
      if (!c.own) {
        if (hiddenTarget) {
          if (c.el && c.el !== hiddenTarget) hiddenTarget = null; // another video: all as usual
          else if (!c.el) hiddenLeft = true; // the mouse left it
          else if (hiddenLeft) hiddenTarget = null; // and came back
        }
        if (c.el && c.el !== hiddenTarget && c.el !== cur) {
          cur = c.el;
          claimButton(true);
        }
      }
      if (bubbles.size) claimButton(false);
      // follow the mouse quickly
      if (lastLocalPointerAt - lastPlaceAt > 120) place();
    },
    { passive: true, capture: true }
  );
  function removeAll() {
    for (const b of bubbles.values()) {
      clearTimeout(b.prefetch);
      b.host.remove();
    }
    bubbles.clear();
    theBubble = null;
  }
  // size of the button: the slider in the add-in's menu (50% - 200%)
  const OLD_SIZES = { small: 0.85, normal: 1, large: 1.25 };
  // its look: the add-in's menu > "Button style"
  const STYLES = ["compact", "blue", "dark", "light", "green", "icon"];
  let look = "compact";
  const applyLook = () => {
    for (const b of bubbles.values()) {
      const w = b.root.querySelector(".wrap");
      if (w) w.className = "wrap " + look;
      placeOne(b);
    }
  };
  const clampZoom = (z) => Math.min(2, Math.max(0.5, Number(z) || 1));
  let zoom = 1;
  // how solid the button is while the mouse is not on it (the menu: 20% - 100%)
  const clampSolid = (o) => Math.min(1, Math.max(0.2, Number(o) || 0.9));
  let solid = 0.9;
  const applyZoom = () => {
    for (const b of bubbles.values()) {
      b.host.style.setProperty("--z", String(zoom));
      b.host.style.setProperty("--o", String(solid));
      placeOne(b);
    }
  };
  try {
    chrome.storage.local.get({ enabled: true }, (o) => {
      switchedOn = !o || o.enabled !== false;
      if (!switchedOn) removeAll();
    });
    chrome.storage.onChanged.addListener((ch) => {
      if (!ch.enabled) return;
      switchedOn = ch.enabled.newValue !== false;
      if (!switchedOn) removeAll();
      else resetAll();
    });
  } catch (_) {
    // storage not reachable (add-in reloading): stays on
  }
  try {
    chrome.storage.local.get({ bubbleFullscreen: false }, (o) => (showInFullscreen = !!(o && o.bubbleFullscreen)));
    chrome.storage.onChanged.addListener((ch) => {
      if (ch.bubbleFullscreen) {
        showInFullscreen = !!ch.bubbleFullscreen.newValue;
        bubbles.forEach((b) => placeOne(b));
      }
    });
    chrome.storage.local.get({ bubbleScale: null, bubbleSize: "normal", bubbleStyle: "compact", bubbleOpacity: 0.9 }, (o) => {
      zoom = clampZoom(o && o.bubbleScale != null ? o.bubbleScale : OLD_SIZES[o && o.bubbleSize]);
      solid = clampSolid(o && o.bubbleOpacity);
      look = STYLES.includes(o && o.bubbleStyle) ? o.bubbleStyle : "compact";
      applyZoom();
      applyLook();
    });
    chrome.storage.onChanged.addListener((ch) => {
      if (ch.bubbleStyle) {
        look = STYLES.includes(ch.bubbleStyle.newValue) ? ch.bubbleStyle.newValue : "compact";
        applyLook();
        return;
      }
      if (ch.bubbleOpacity) solid = clampSolid(ch.bubbleOpacity.newValue);
      else if (ch.bubbleScale) zoom = clampZoom(ch.bubbleScale.newValue);
      else if (ch.bubbleSize) zoom = clampZoom(OLD_SIZES[ch.bubbleSize.newValue]);
      else return;
      applyZoom();
    });
  } catch (_) {
    // storage not reachable (add-in reloading): default size
  }
  const STYLE = `
    :host { all: initial; }
    .wrap { font: 11px/1.25 "Segoe UI", system-ui, sans-serif; color: #1f2733; display: inline-block; zoom: var(--z, 1); position: relative; }
    .btn { display: inline-flex; align-items: stretch; color: #fff; border: 1px solid #B93A1C;
           background: linear-gradient(#F4805F, #E95432); border-radius: 3px;
           box-shadow: 0 1px 6px rgba(0,0,0,.35); font: inherit; font-weight: 600;
           opacity: var(--o, .9); transition: opacity .15s; user-select: none; white-space: nowrap; }
    .btn:hover, .btn.open { opacity: 1; }
    .btn.drag { opacity: 1; }
    .part { display: inline-flex; align-items: center; gap: 5px; padding: 3px 7px; cursor: default; }
    .part:hover { background: rgba(255,255,255,.12); }
    .btn.drag .part { cursor: grabbing; }
    .side { padding: 3px 6px; cursor: default; border-left: 1px solid rgba(255,255,255,.28); display: inline-flex; align-items: center; }
    .side:hover { background: rgba(255,255,255,.18); }
    .ico { width: 13px; height: 13px; flex: none; }
    .caret { font-size: 9px; opacity: .9; }
    .spin { width: 9px; height: 9px; border: 2px solid rgba(255,255,255,.4); border-top-color: #fff; border-radius: 50%;
            animation: r .8s linear infinite; flex: none; }
    @keyframes r { to { transform: rotate(360deg); } }
    /* the list floats under the button (the button never moves): to its
       left when the button is on the right of the video, else to its right,
       and above it when there is no room below */
    .list { position: absolute; top: 100%; right: 0; width: 330px; margin-top: 4px; background: #fff; border-radius: 6px;
            box-shadow: 0 6px 22px rgba(0,0,0,.28); overflow: hidden; max-height: 360px; overflow-y: auto; border: 1px solid #d5dbe4; }
    .wrap.toright .list { right: auto; left: 0; }
    .wrap.up .list { top: auto; bottom: 100%; margin-top: 0; margin-bottom: 4px; }
    .btn.locked { background: linear-gradient(#7b8794, #5b6573); border-color: #4a535f; }
    .head { padding: 7px 10px; background: #f4f6fa; border-bottom: 1px solid #e3e8ef; font-weight: 600; color: #334;
            overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .item { padding: 6px 10px; cursor: default; border-bottom: 1px solid #eef1f5; display: flex; gap: 6px; }
    .item:last-child { border-bottom: 0; }
    .item:hover { background: #FDEBE6; }
    .num { color: #6b7686; min-width: 16px; text-align: right; }
    .body { flex: 1; min-width: 0; }
    .t { font-weight: 600; display: flex; align-items: center; gap: 5px; flex-wrap: wrap; }
    .s { color: #6b7686; font-size: 10.5px; overflow-wrap: anywhere; }
    .tag { font-size: 9.5px; font-weight: 700; padding: 0 4px; border-radius: 3px; color: #fff; background: #7b8794; line-height: 14px; }
    .tag.HD { background: #1d8f5a; } .tag.FullHD { background: #E95432; } .tag.K2 { background: #7b3fd6; }
    .tag.K4 { background: #d6631d; } .tag.K8 { background: #c0262d; }
    .codec { font-size: 9.5px; color: #4a5566; border: 1px solid #c9d1dc; border-radius: 3px; padding: 0 3px; line-height: 13px; }
    .all { font-weight: 700; color: #E95432; }
    .msg { padding: 8px 10px; color: #1a9e5a; }
    .help { padding: 8px 10px; color: #334; background: #fffbe6; border-bottom: 1px solid #f0e2a8; }
    .act { margin-top: 6px; display: inline-block; background: #E95432; color: #fff; border-radius: 4px; padding: 3px 9px; cursor: default; }
    .act:hover { background: #C9421F; }
    .off { cursor: default; opacity: .7; }
    .off:hover { background: #fff; }
    .err { color: #d1342f; }
    /* "Download a part" */
    .clip { padding: 8px 10px; border-bottom: 1px solid #e3e8ef; background: #fafbfd; }
    .clip .row { display: flex; align-items: center; gap: 6px; margin-bottom: 6px; }
    .clip .row b { min-width: 34px; font-weight: 600; }
    .clip input[type=text] { width: 76px; font: inherit; padding: 3px 5px; border: 1px solid #c9d1dc; border-radius: 4px; color: #1f2733; background: #fff; }
    .clip input.bad { border-color: #d1342f; }
    .clip .now, .clip .btn2 { background: #FDEBE6; color: #E95432; border-radius: 4px; padding: 3px 8px; cursor: default; white-space: nowrap; }
    .clip .now:hover, .clip .btn2:hover { background: #F9D9D0; }
    .clip .len { color: #334; margin-bottom: 6px; }
    .clip label { display: flex; gap: 6px; align-items: flex-start; margin: 4px 0; cursor: default; }
    .clip label input { margin: 2px 0 0; flex: none; }
    .clip label small { display: block; color: #6b7686; font-size: 10.5px; }
    .clip .acts { display: flex; gap: 6px; margin-top: 6px; }
    .clip .pick { margin-top: 8px; font-weight: 600; color: #334; }
    .cliprow .t { color: #E95432; }
    /* "⬇ Whole video" / "✂ Part" (the part in orange) */
    .tabs { display: flex; border-bottom: 1px solid #e3e8ef; background: #f4f6fa; }
    .tab { flex: 1; text-align: center; padding: 7px 4px; cursor: default; color: #5b6575; font-weight: 600; border-bottom: 3px solid transparent; }
    .tab:hover { background: #eef2f8; }
    .tab.on { color: #E95432; border-bottom-color: #E95432; background: #fff; }
    .tab.part.on { color: #e8590c; border-bottom-color: #e8590c; }
    .cut { padding: 9px 12px 11px; background: #fff; }
    .cut .lead { color: #e8590c; font-weight: 700; margin-bottom: 8px; }
    .cut .times { display: flex; align-items: center; gap: 6px; margin-bottom: 8px; }
    .cut .times b { font-weight: 700; color: #1f2733; }
    .cut input[type=text] { width: 58px; font: inherit; text-align: center; padding: 3px 4px; border: 1px solid #c9d1dc; border-radius: 4px; color: #1f2733; background: #fff; }
    .cut input.bad { border-color: #d1342f; }
    .cut .now { color: #e8590c; cursor: default; white-space: nowrap; font-size: 10.5px; }
    .cut .now:hover { text-decoration: underline; }
    .cut .len { margin-left: auto; font-weight: 700; color: #1f2733; }
    .cut .len.err { color: #d1342f; }
    .cut .seg { display: inline-flex; border: 1px solid #e8590c; border-radius: 4px; overflow: hidden; margin-bottom: 8px; }
    .cut .seg span { padding: 3px 10px; color: #e8590c; cursor: default; background: #fff; }
    .cut .seg span + span { border-left: 1px solid #e8590c; }
    .cut .seg span.on { background: #e8590c; color: #fff; }
    .cut .qs { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 10px; }
    .cut .qs span { padding: 3px 9px; border: 1px solid #c9d1dc; border-radius: 4px; color: #1f2733; cursor: default; background: #fff; font-weight: 600; }
    .cut .qs span:hover { border-color: #e8590c; }
    .cut .qs span.on { border-color: #e8590c; background: #fff3eb; color: #e8590c; }
    .cut .acts { display: flex; gap: 8px; }
    .cut .pv { padding: 6px 10px; border-radius: 5px; background: #fff3eb; color: #e8590c; cursor: default; white-space: nowrap; }
    .cut .pv:hover { background: #ffe4d2; }
    .cut .go { flex: 1; text-align: center; padding: 6px 10px; border-radius: 5px; color: #fff; font-weight: 700; cursor: default;
               background: linear-gradient(#f57a2e, #e05a0c); box-shadow: 0 2px 6px rgba(224,90,12,.35); }
    .cut .go:hover { background: linear-gradient(#ff8a3d, #e8630f); }
    /* looks */
    .dark .btn { background: linear-gradient(#3a3f47, #23272e); border-color: #15181c; }
    .dark .btn:hover, .dark .btn.open { background: linear-gradient(#454b55, #2a2f37); }
    .dark .ico path { fill: #23272e; }
    .light .btn { background: linear-gradient(#ffffff, #e9eef5); border-color: #b8c3d1; color: #1f2733; }
    .light .btn:hover, .light .btn.open { background: linear-gradient(#ffffff, #dfe7f1); }
    .light .ico circle { fill: #E95432; }
    .light .ico path { fill: #fff; }
    .light .side { border-left-color: #c9d3df; }
    .light .spin { border-color: rgba(233,84,50,.3); border-top-color: #E95432; }
    .green .btn { background: linear-gradient(#35b36b, #1f8a4c); border-color: #176b3a; }
    .green .btn:hover, .green .btn.open { background: linear-gradient(#3cc276, #1d8048); }
    .green .ico path { fill: #1f8a4c; }
    .compact .btn { border-radius: 7px; background: linear-gradient(#F0694A, #D6431F); border-color: #A8341A; }
    .compact .btn:hover, .compact .btn.open { background: linear-gradient(#F5775A, #DC4A27); }
    .compact #label, .compact .caret, .compact #help { display: none; }
    .compact .part { padding: 4px 7px; }
    .compact .ico { width: 18px; height: 18px; }
    .compact .ico circle { fill: #e4e6ea; }
    .compact .ico path { fill: #D6431F; }
    .compact #close { padding: 4px 8px; font-size: 13px; border-left-color: rgba(255,255,255,.3); }
    .icon .btn { border-radius: 50%; }
    .icon .part { padding: 5px; }
    .icon #label, .icon .caret, .icon .side { display: none; }
    .icon .ico { width: 16px; height: 16px; }`;

  function isMain(video) {
    // a player in a frame the page covers (below): it is the page's video
    return TOP && (video === audioSlot || video.tagName === "IFRAME" || video === biggestVideo());
  }

  function directSrc(video) {
    if (video.tagName === "IFRAME") return "";
    const src = video.currentSrc || video.src || "";
    return /^https?:/i.test(src) && !/\.m3u8|\.mpd/i.test(src) ? src : "";
  }

  // where the bubbles live: in full screen the player's own element (the
  // only thing the browser shows then)
  function layer() {
    const f = document.fullscreenElement || document.webkitFullscreenElement;
    return f && f.tagName !== "VIDEO" ? f : document.documentElement;
  }

  const el = (tag, props = {}, ...kids) => {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
      if (k === "text") e.textContent = v;
      else e.setAttribute(k, v);
    }
    e.append(...kids);
    return e;
  };

  function makeBubble(video) {
    const host = document.createElement("div");
    host.style.all = "initial";
    host.style.position = "fixed";
    host.style.zIndex = "2147483647";
    // in the browser's top layer: nothing the page draws (a hover preview...) can cover it
    // or take its presses
    host.setAttribute("popover", "manual");
    host.style.setProperty("--z", String(zoom));
    host.style.setProperty("--o", String(solid));
    const root = host.attachShadow({ mode: "closed" });
    // early.js keeps the page's own player from taking presses on it
    (globalThis.__medialabRoots = globalThis.__medialabRoots || new WeakMap()).set(host, root);
    const svgNs = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(svgNs, "svg");
    svg.setAttribute("class", "ico");
    svg.setAttribute("viewBox", "0 0 16 16");
    const circle = document.createElementNS(svgNs, "circle");
    for (const [k, v] of [["cx", "8"], ["cy", "8"], ["r", "7.5"], ["fill", "#fff"]]) circle.setAttribute(k, v);
    const arrow = document.createElementNS(svgNs, "path");
    arrow.setAttribute("d", "M6.6 3.5h2.8v4.6h2.3L8 12 4.3 8.1h2.3z");
    arrow.setAttribute("fill", "#E95432");
    svg.append(circle, arrow);
    const list = el("div", { class: "list", id: "list" });
    list.hidden = true;
    const spin = el("span", { class: "spin", id: "spin" });
    spin.hidden = true;
    root.append(
      el("style", { text: STYLE }),
      el(
        "div",
        { class: "wrap " + look },
        el(
          "div",
          { class: "btn", id: "main" },
          el(
            "span",
            { class: "part", id: "grab", tabindex: "0", role: "button", "aria-haspopup": "true", "aria-label": "Download this video" },
            svg,
            spin,
            el("span", { id: "label", text: "Download this video" }),
            el("span", { class: "caret", text: "▼" })
          ),
          el("span", { class: "side", id: "help", title: "Help", text: "?", tabindex: "0", role: "button", "aria-label": "Help" }),
          el("span", { class: "side", id: "close", title: "Hide", text: "✕", tabindex: "0", role: "button", "aria-label": "Hide" })
        ),
        list
      )
    );
    const b = { host, root, video, open: false, own: null, loading: false, dx: null, dy: null, help: false, place: sitePlace, auto: null, hovered: false, ghost: false, goneAt: 0, lastRect: null, since: Date.now() };
    host.addEventListener("mouseenter", () => {
      b.hovered = true;
      claimButton(true);
    });
    host.addEventListener("mouseleave", () => {
      b.hovered = false;
    });
    const grab = root.getElementById("grab");
    // drag: move it anywhere on the video; a short press is a click
    let down = null;
    grab.addEventListener("mousedown", (e) => {
      if (e.button !== 0 || !userPress(e)) return;
      const hr = host.getBoundingClientRect();
      down = { x: e.clientX, y: e.clientY, ox: e.clientX - hr.left, oy: e.clientY - hr.top, moved: false };
      e.preventDefault();
    });
    addEventListener("mousemove", (e) => {
      if (!down) return;
      if (!down.moved && Math.abs(e.clientX - down.x) + Math.abs(e.clientY - down.y) < 5) return;
      down.moved = true;
      root.getElementById("main").classList.add("drag");
      const r = rectOfB(b);
      b.dx = e.clientX - down.ox - r.left;
      b.dy = e.clientY - down.oy - r.top;
      placeOne(b);
    });
    const up = (e) => {
      if (!down || !userPress(e)) return;
      const wasDrag = down.moved;
      down = null;
      root.getElementById("main").classList.remove("drag");
      if (!wasDrag) return clicked(b);
      // dropped: it goes to the nearest edge of the video, and stays there on
      // this site (its other videos, next time too)
      const r = rectOfB(b);
      const main = root.getElementById("main").getBoundingClientRect();
      const roomX = Math.max(1, r.width - main.width - 16);
      const roomY = Math.max(1, r.height - main.height - 16);
      const at = { x: Math.min(1, Math.max(0, (b.dx - 8) / roomX)), y: Math.min(1, Math.max(0, (b.dy - 8) / roomY)) };
      b.place = snapToEdge(at);
      b.dx = null;
      b.dy = null;
      keepPlace(b.place);
      placeOne(b);
    };
    addEventListener("mouseup", up);
    // heard here when the page's player keeps it from the window (early.js)
    root.addEventListener("mouseup", up);
    const press = (id, run) => {
      const x = root.getElementById(id);
      x.addEventListener("click", (e) => userPress(e) && run());
      x.addEventListener("keydown", (e) => {
        if ((e.key === "Enter" || e.key === " ") && e.isTrusted) {
          e.preventDefault();
          e.stopPropagation();
          run();
        }
      });
    };
    press("help", () => {
      b.help = !b.help;
      b.open = true;
      renderOne(b);
    });
    press("close", () => hideNow(b));
    // the keyboard: Enter / Space opens it like a click
    grab.addEventListener("keydown", (e) => {
      if ((e.key === "Enter" || e.key === " ") && e.isTrusted) {
        e.preventDefault();
        e.stopPropagation();
        clicked(b);
      }
    });
    // one player for many videos (the previews of a home page, a feed): a
    // new video in it forgets what was found for the one before
    // (only when it really is another video: a site's own player changes
    // its blob: source and empties itself often for the same video)
    watchTarget(b, video);
    layer().appendChild(host);
    bubbles.set("one", b);
    renderOne(b);
    placeOne(b);
    return b;
  }

  const ytIdOf = (u) => {
    const m = /[?&]v=([\w-]{11})|youtu\.be\/([\w-]{11})|\/(?:shorts|live|embed)\/([\w-]{11})/.exec(String(u || ""));
    return m ? m[1] || m[2] || m[3] : "";
  };
  const UUID_TOKEN_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|\b[0-9a-f]{24,64}\b/gi;
  const firstSrcsetUrl = (ss) => {
    if (!ss || typeof ss !== "string") return "";
    const parts = ss.split(",").map((x) => x.trim().split(/\s+/)[0]).filter(Boolean);
    const u = parts[parts.length - 1] || parts[0] || "";
    if (u.startsWith("//")) return "https:" + u;
    return /^https?:/i.test(u) ? u : "";
  };
  const pageFallbackThumb = () => {
    try {
      const sels = [
        { sel: "#vp-preview", attr: "data-thumb" },
        { sel: "video[poster]", attr: "poster" },
        { sel: "meta[property*=':image' i], meta[name*=':image' i]", attr: "content" },
        { sel: "link[rel='image_src'], link[rel='thumbnail'], link[as='image']", attr: "href" },
      ];
      for (const c of sels) {
        for (const m of document.querySelectorAll(c.sel)) {
          let u = (m.getAttribute && m.getAttribute(c.attr)) || m[c.attr] || "";
          if (typeof u === "string" && u.trim()) {
            u = u.trim();
            if (u.startsWith("//")) u = "https:" + u;
            if (/^https?:/i.test(u)) return u;
          }
        }
      }
      for (const s of document.querySelectorAll("script[type='application/ld+json']")) {
        const m = (s.textContent || "").match(/["']thumbnail(?:Url|_url)["']\s*:\s*["'](https?:[^"'\\\n\r]+)["']/i);
        if (m && m[1]) return m[1];
      }
    } catch (_) {}
    return "";
  };
  const pageFallbackTitle = () => {
    try {
      for (const m of document.querySelectorAll("meta[property*=':title' i], meta[name*=':title' i]")) {
        const c = (m.content || (m.getAttribute && m.getAttribute("content")) || "").trim();
        if (c.length >= 3) return c;
      }
    } catch (_) {}
    return document.title || "";
  };
  const singleVideoContainer = (v) => {
    if (!v) return null;
    let best = v.parentElement || v;
    let p = v.parentElement;
    for (let d = 0; p && p !== document.body && p !== document.documentElement && d < 7; d++, p = p.parentElement) {
      const r = p.getBoundingClientRect ? p.getBoundingClientRect() : null;
      if (r && (r.width > 860 || r.height > 680)) break;
      if (p.querySelectorAll && p.querySelectorAll("video").length > 1) break;
      best = p;
    }
    return best;
  };
  const extractDomKeys = (root, v, href, thumb) => {
    const out = new Set();
    const scanStr = (str) => {
      if (!str || typeof str !== "string") return;
      for (const m of str.matchAll(UUID_TOKEN_RE)) out.add(m[0].toLowerCase());
    };
    scanStr(href);
    scanStr(thumb);
    if (v) {
      scanStr(v.currentSrc);
      scanStr(v.src);
      scanStr(v.poster);
    }
    if (root && root.querySelectorAll) {
      const els = [root, ...[...root.querySelectorAll("img, video, source, a, [data-id], [data-clip-id], [data-video-id], [data-uuid]")].slice(0, 25)];
      for (const e of els) {
        if (!e || !e.getAttribute) continue;
        for (const a of ["src", "srcset", "data-src", "data-srcset", "poster", "data-poster", "data-thumb", "href", "data-id", "data-clip-id", "data-video-id", "data-uuid", "style"]) {
          const val = e.getAttribute(a) || "";
          scanStr(val);
          if (/^data-(id|clip-id|video-id|uuid)$/i.test(a) && val.length >= 5 && val.length <= 64) out.add(val.toLowerCase());
        }
      }
    }
    return [...out].slice(0, 12);
  };
  // the name and the picture of what the button is on: for the list "Media on this page"
  function metaOf(t) {
    let title = "";
    let thumb = "";
    let href = "";
    let keys = [];
    try {
      const box = isCard(t) ? t : cardBoxOf(t) || singleVideoContainer(t) || t;
      const v = t && t.tagName === "VIDEO" ? t : box && box.querySelector ? box.querySelector("video") : null;
      if (box && box.tagName === "A" && box.href) href = cleanLink(box.href);
      else if (box) {
        const a = (box.closest && box.closest("a[href]")) || (box.querySelector && box.querySelector("a[href]"));
        if (a && a.href) href = cleanLink(a.href);
      }
      title = bestTitle(box);
      if (!title && t && t.parentElement && t.parentElement !== box) title = bestTitle(t.parentElement);
      if (!title && href) title = slugTitleFromHref(href);
      if (v) {
        thumb = v.poster || (v.getAttribute && (v.getAttribute("poster") || v.getAttribute("data-poster") || v.getAttribute("data-thumb"))) || "";
      }
      if (!thumb && box && box.querySelectorAll) {
        for (const img of box.querySelectorAll("img")) {
          const r = img.getBoundingClientRect ? img.getBoundingClientRect() : { width: 100 };
          if (r.width > 0 && r.width < 48) continue;
          const u =
            img.currentSrc ||
            img.src ||
            (img.getAttribute && (img.getAttribute("data-src") || img.getAttribute("data-lazy-src") || firstSrcsetUrl(img.getAttribute("srcset") || img.getAttribute("data-srcset")))) ||
            "";
          if (u && !/^data:/i.test(u) && !/\.svg(\?|$)/i.test(u)) {
            thumb = u.startsWith("//") ? "https:" + u : u;
            break;
          }
        }
        if (!thumb) {
          for (const s of box.querySelectorAll("source[srcset], [data-thumb], [data-thumbnail], [data-poster]")) {
            const u =
              (s.getAttribute && (s.getAttribute("data-thumb") || s.getAttribute("data-thumbnail") || s.getAttribute("data-poster") || firstSrcsetUrl(s.getAttribute("srcset")))) || "";
            if (u && !/^data:/i.test(u)) {
              thumb = u.startsWith("//") ? "https:" + u : u;
              break;
            }
          }
        }
        if (!thumb) {
          for (const e of [box, ...[...box.querySelectorAll("*")].slice(0, 40)]) {
            const m = /url\(["']?(https?:[^"')]+)["']?\)/.exec(getComputedStyle(e).backgroundImage || "");
            if (m) {
              thumb = m[1];
              break;
            }
          }
        }
      }
      const id = ytIdOf(href);
      if (id && (!thumb || /^data:/.test(thumb))) thumb = `https://i.ytimg.com/vi/${id}/mqdefault.jpg`;
      if (!thumb && v) thumb = grabFrame(v);
      if (t && t.tagName === "VIDEO" && isMain(t)) {
        if (!title) title = pageFallbackTitle();
        if (!thumb) thumb = pageFallbackThumb();
      }
      keys = extractDomKeys(box, v, href, thumb);
    } catch (_) {
      /* a page that hides it */
    }
    title = String(title || "").replace(/\s+/g, " ").trim().slice(0, 160);
    if (/^data:/i.test(thumb) && thumb.length < 1000) thumb = "";
    return { title, thumb, href, keys };
  }
  function matchDomMetaForStream(streamUrl) {
    try {
      const tokens = [...String(streamUrl || "").matchAll(UUID_TOKEN_RE)].map((m) => m[0].toLowerCase());
      // 1. Check all video elements and their cards
      for (const v of allVideos()) {
        const box = cardBoxOf(v) || singleVideoContainer(v) || v;
        const m = metaOf(box);
        if (tokens.length && m.keys && m.keys.some((k) => tokens.includes(k))) return m;
      }
      // 2. Check active / hovered target
      const active = (cur && connected(cur) ? cur : null) || (recentCard && Date.now() - recentCard.t < 5000 && recentCard.a.isConnected ? recentCard.a : null);
      if (active) {
        const m = metaOf(active);
        if (m.title || m.thumb) return m;
      }
      // 3. Check playing video
      const pv = allVideos().find((v) => !v.paused && v.getBoundingClientRect().width >= 100);
      if (pv) return metaOf(cardBoxOf(pv) || pv);
    } catch (_) {}
    return null;
  }
  function scanPageCards() {
    try {
      for (const v of allVideos()) noteVideo(v, true);
      if (!document.querySelectorAll) return;
      const seenBoxes = new Set();
      const cardEls = document.querySelectorAll(
        "a[href*='/stock-video/' i], a[href*='/stock-footage/' i], a[href*='/video-templates/' i], a[href*='/clip/' i], a[href*='/video/' i], a[href*='/footage/' i], a[href*='/watch' i], a[href*='/shorts/' i], a[href*='/reel/' i], article, figure, [class*='card' i], [class*='tile' i]"
      );
      let count = 0;
      for (const el of cardEls) {
        if (count >= 40) break;
        const box = cardBoxOf(el) || el;
        if (seenBoxes.has(box)) continue;
        const r = box.getBoundingClientRect ? box.getBoundingClientRect() : null;
        if (!r || r.width < 100 || r.height < 56 || r.width > 800 || r.height > 650) continue;
        seenBoxes.add(box);
        const m = metaOf(box);
        if (!m.title && !m.thumb) continue;
        count++;
        const id = `${FRAME_ID}-c${++metaSeq}`;
        safeSend({ type: "swiftget-hover-meta", id, t: Date.now(), scan: true, ...m }, () => void chrome.runtime.lastError);
      }
    } catch (_) {}
  }
  // a picture from a playing video (any site where the browser lets a page copy it)
  function grabFrame(v) {
    try {
      if (!v || v.tagName !== "VIDEO" || v.readyState < 2 || !v.videoWidth) return "";
      const c = document.createElement("canvas");
      c.width = 160;
      c.height = Math.max(1, Math.round((160 * v.videoHeight) / v.videoWidth));
      const g = c.getContext("2d");
      g.drawImage(v, 0, 0, c.width, c.height);
      // not a black frame (a video that has just started)
      const px = g.getImageData(0, 0, c.width, c.height).data;
      let sum = 0;
      for (let i = 0; i < px.length; i += 64) sum += px[i] + px[i + 1] + px[i + 2];
      if (sum / (px.length / 64) / 3 < 14) return "";
      const d = c.toDataURL("image/jpeg", 0.55);
      return d.length > 1000 && d.length < 28000 ? d : "";
    } catch (_) {
      return ""; // the page keeps this video from being copied
    }
  }
  function collectFrames(b, id) {
    collectFramesFrom(
      () => (b.video.tagName === "VIDEO" ? b.video : b.video.querySelector ? b.video.querySelector("video") : null),
      id,
      () => b.metaId === id
    );
  }
  function collectFramesFrom(getVideo, id, stillWanted) {
    const frames = [];
    let n = 0;
    const timer = setInterval(() => {
      if (dead || !alive() || !stillWanted() || ++n > 8) return clearInterval(timer);
      const f = grabFrame(getVideo());
      if (!f || frames.length >= 3 || frames.includes(f)) return;
      // (also when a card's image is not a picture the page lets us read: its first frame is the picture)
      frames.push(f);
      try {
        safeSend({ type: "swiftget-hover-frames", id, frames }, () => void chrome.runtime.lastError);
      } catch (_) {
        clearInterval(timer);
      }
    }, 900);
  }
  let metaFor = null;
  let metaHref = "";
  let metaSeq = 0;
  // Every video the page plays (the previews of a grid start by themselves): its name and
  // pictures are kept for the streams it opens, matched by the time it started.
  const seenVideos = new WeakSet();
  let seenCount = 0;
  const videoMetaIds = new WeakMap();
  function noteVideo(v, refresh = false) {
    if (dead || !v || v.tagName !== "VIDEO") return;
    const r = v.getBoundingClientRect();
    if (r.width < 100 || r.height < 56) return;
    const knownId = videoMetaIds.get(v);
    if (knownId && !refresh) return;
    if (!knownId && seenCount >= 80) return;
    const id = knownId || `${FRAME_ID}-v${++metaSeq}`;
    if (!knownId) {
      seenVideos.add(v);
      videoMetaIds.set(v, id);
      seenCount++;
    }
    const box = cardBoxOf(v);
    if (box) cards.add(box);
    try {
      // the page's own big player counts as a video that is looked at; the previews of a grid only
      // when the mouse comes to them (tellMeta)
      const own = !box && (r.width >= innerWidth * 0.4 || r.height >= innerHeight * 0.45);
      const mInfo = metaOf(box || v);
      safeSend({ type: "swiftget-hover-meta", id, t: Date.now(), refresh: !!knownId, hover: own, ...mInfo }, () => void chrome.runtime.lastError);
      const dsrc = directSrc(v);
      if (dsrc) {
        safeSend({ type: "swiftget-direct-media", url: dsrc, meta: { ...mInfo, hover: own } }, () => void chrome.runtime.lastError);
      }
    } catch (_) {
      return; /* add-in reloading */
    }
    if (!knownId || refresh) collectFramesFrom(() => (v.isConnected ? v : null), id, () => v.isConnected);
  }
  for (const ev of ["loadstart", "loadeddata", "playing"]) {
    document.addEventListener(ev, (e) => noteVideo(e.target, ev !== "loadstart"), true);
  }
  function tellMeta(b) {
    if (isAudioTarget(b.video)) return;
    if (metaFor === b.video && metaHref === location.href) return;
    metaFor = b.video;
    metaHref = location.href;
    const id = `${FRAME_ID}-${++metaSeq}`;
    b.metaId = id;
    try {
      safeSend({ type: "swiftget-hover-meta", id, t: Date.now(), hover: true, ...metaOf(b.video) }, () => void chrome.runtime.lastError);
    } catch (_) {
      return; /* add-in reloading */
    }
    collectFrames(b, id);
  }

  function watchTarget(b, v) {
    if (b.unwatch) {
      try {
        b.unwatch();
      } catch (_) {
        /* gone */
      }
      b.unwatch = null;
    }
    if (!v || v === audioSlot || isCard(v) || v.tagName === "IFRAME") return;
    const again = () => {
      if (stale(b)) forget(b);
    };
    v.addEventListener("emptied", again);
    v.addEventListener("loadstart", again);
    b.unwatch = () => {
      v.removeEventListener("emptied", again);
      v.removeEventListener("loadstart", again);
    };
  }

  // the button goes to another video / card: what was found for the one before is not for this
  function retarget(b, t) {
    if (sameTargetLink(b.video, t)) {
      b.video = t;
      b.ghost = false;
      b.goneAt = 0;
      watchTarget(b, t);
      placeOne(b);
      return;
    }
    clearTimeout(b.prefetch);
    if (b.partWatch) stopPart(b);
    b.video = t;
    b.own = null;
    b.ownFor = "";
    b.loading = false;
    b.open = false;
    b.help = false;
    b.asked = "";
    b.dx = null;
    b.dy = null;
    b.auto = null;
    b.ghost = false;
    b.goneAt = 0;
    b.lastRect = null;
    b.since = Date.now();
    watchTarget(b, t);
    renderOne(b);
    prefetchLater(b);
  }

  // the qualities are looked up while the mouse rests on it, so they are there when it is pressed
  function prefetchLater(b) {
    const t = b.video;
    clearTimeout(b.prefetch);
    if (isAudioTarget(t) || isMain(t)) return;
    b.prefetch = setTimeout(() => {
      if (b.video === t && !b.own && !b.loading && !b.open && connected(t)) lookUp(b, "", true);
    }, 450);
  }

  // its X: it goes away now and comes back, as new (everything is looked up again), the next
  // time the mouse is on a video
  function hideNow(b) {
    const t = b.video;
    clearTimeout(b.prefetch);
    const link = ownLink(t) || (TOP && isMain(t) && !isAudioTarget(t) ? cleanLink(location.href) : "");
    hiddenTarget = t;
    hiddenLeft = false;
    cur = null;
    b.own = null;
    b.ownFor = "";
    b.loading = false;
    b.open = false;
    b.help = false;
    b.asked = "";
    b.lastOkAt = 0;
    b.host.style.display = "none";
    try {
      safeSend({ type: "swiftget-forget-video", link, page: TOP ? location.href : "" }, () => void chrome.runtime.lastError);
    } catch (_) {
      /* add-in reloading */
    }
  }

  // everything starts again (the add-in was switched off and on): like a fresh page
  function resetAll() {
    removeAll();
    hiddenTarget = null;
    hiddenLeft = false;
    cur = null;
    recentCard = null;
    mainV = null;
    mainAt = 0;
    items = [];
    lastPage = "";
    try {
      safeSend({ type: "swiftget-media-request" }, (res) => !chrome.runtime.lastError && update(res));
    } catch (_) {
      /* add-in reloading */
    }
    place();
  }


  // which video a player shows now: its own link, else its own file (a
  // blob: source says nothing: the site makes a new one for the same video)
  function videoKey(video) {
    return ownLink(video) || directSrc(video) || "";
  }

  // what was found (or is being looked up) is for another video now
  function stale(b) {
    const key = videoKey(b.video);
    if (b.own) return b.ownFor !== key;
    if (b.loading) return b.asked !== key;
    return false;
  }

  // what was found belongs to another video of this player now
  function forget(b) {
    if (!b.own && !b.loading) return;
    b.own = null;
    b.ownFor = "";
    b.loading = false;
    b.open = false;
    renderOne(b);
  }

  // What one video offers: the qualities of ONE video (the newest the page opened), each once,
  // best first. "Other qualities of this stream…" and a nameless "Video" are left out when real
  // qualities are there (they can lead to another video).
  function extractUrlTokens(u) {
    const out = [];
    const s = String(u || "");
    for (const m of s.matchAll(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|\b[0-9a-f]{20,64}\b/gi)) {
      out.push(m[0].toLowerCase());
    }
    try {
      const p = /^https?:/i.test(s) ? new URL(s).pathname : s;
      for (const m of p.matchAll(/(?:^|[^0-9])(\d{5,12})(?=[^0-9]|$)/g)) {
        if (!out.includes(m[1])) out.push(m[1]);
      }
    } catch (_) {}
    return out;
  }

  function shape(list, pref = null) {
    const real = list.filter((i) => !i.disabled);
    const info = list.filter((i) => i.disabled);
    if (real.length < 2) return list;
    const isAudio = (i) => (i.yt ? i.yt.quality === "audio" || i.yt.quality === "mp3" : !!i.audio);
    const prefSrc = pref && pref.src ? pref.src : "";
    const prefTokens = (pref && pref.tokens) || [];
    const prefMetaId = (pref && pref.metaId) || "";
    const groups = new Map();
    for (const i of real) {
      const key = i.yt ? "yt" : i.resolve ? "resolve" : "s:" + (i.family || i.url || "");
      const g = groups.get(key) || { opts: [], t: 0, audio: true, yt: !!i.yt, matchScore: 0, seen: false };
      g.opts.push(i);
      g.t = Math.max(g.t, i.t || 0);
      if (!isAudio(i)) g.audio = false;
      if (i.seen) g.seen = true;
      const u = String(i.url || i.sub || "");
      if (prefSrc && u && (u === prefSrc || u.split("?")[0] === prefSrc.split("?")[0])) g.matchScore = Math.max(g.matchScore, 100);
      if (prefTokens.length && u && prefTokens.some((tok) => u.toLowerCase().includes(tok))) g.matchScore = Math.max(g.matchScore, 60);
      if (prefMetaId && i.metaId && i.metaId === prefMetaId) g.matchScore = Math.max(g.matchScore, 50);
      groups.set(key, g);
    }
    const all = [...groups.entries()];
    const haveReal = all.some(([k]) => k !== "resolve");
    let pool = all.filter(([k]) => !(haveReal && k === "resolve"));
    const videoPool = pool.filter(([, g]) => !g.audio);
    if (videoPool.length) pool = videoPool;
    // Prioritize: YouTube resolved > direct src/ID/metaId match to active player > seen (main/hovered) > newest
    pool.sort(
      (a, b) =>
        (b[1].yt ? 1 : 0) - (a[1].yt ? 1 : 0) ||
        b[1].matchScore - a[1].matchScore ||
        (b[1].seen ? 1 : 0) - (a[1].seen ? 1 : 0) ||
        b[1].t - a[1].t
    );
    const g = pool[0][1];
    const high = (i) => {
      const m = /(\d{3,4})p/i.exec((i.yt && i.yt.quality) || i.label || "");
      return m ? Number(m[1]) : 0;
    };
    const seen = new Set();
    let opts = g.opts.filter((i) => {
      const k = i.yt ? i.yt.key || i.label : i.label;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
    opts.sort((a, b) => (isAudio(a) ? 1 : 0) - (isAudio(b) ? 1 : 0) || high(b) - high(a));
    if (opts.some((i) => high(i)) && opts.length > 1) opts = opts.filter((i) => high(i) || isAudio(i) || !/^video\b/i.test(i.label));
    return [...opts, ...info];
  }

  function itemsOf(b) {
    if (b.own && b.ownFor !== videoKey(b.video)) {
      b.own = null;
      b.ownFor = "";
    }
    const vidEl = b.video && b.video.tagName === "VIDEO" ? b.video : b.video && b.video.querySelector ? b.video.querySelector("video") : null;
    const dsrc = vidEl ? directSrc(vidEl) : "";
    const pref = {
      src: dsrc,
      tokens: extractUrlTokens(ownLink(b.video) || (b.video && b.video.href) || location.href),
      metaId: b.metaId || "",
    };
    if (b.own) return shape(b.own, pref);
    // the sound of the page: the sound files it opened
    if (isAudioTarget(b.video)) return audioItems();
    // a card: match its direct video src or streams opened since mouse entered
    if (isCard(b.video)) {
      if (dsrc && !ownLink(b.video)) {
        const hit = items.filter((i) => !i.disabled && i.url && (i.url === dsrc || i.url.split("?")[0] === dsrc.split("?")[0]));
        if (hit.length) return shape(hit, pref);
        const ext = (/\.([a-z0-9]{2,4})(\?|#|$)/i.exec(dsrc) || [])[1] || "mp4";
        return [{ label: `Video · ${ext.toUpperCase()}`, sub: dsrc, url: dsrc, ext }];
      }
      const fresh = items.filter((i) => !i.disabled && (i.t || 0) >= b.since - 1500);
      return fresh.length ? shape(fresh, pref) : [];
    }
    // the page's own video only: a player that shows another video (a
    // preview on a home page) is looked up for that video
    if (!isMain(b.video)) return [];
    const mine = ownLink(b.video);
    if (!mine || isVideoPage(location.href) || mine === cleanLink(location.href)) {
      const shaped = shape(items, pref);
      // If main player has a direct https MP4/WebM src and none of the captured items match it,
      // prefer the main player's own direct src instead of a related-video preview!
      if (dsrc && !shaped.some((i) => i.yt) && !shaped.some((i) => i.url && i.url.split("?")[0] === dsrc.split("?")[0])) {
        const ext = (/\.([a-z0-9]{2,4})(\?|#|$)/i.exec(dsrc) || [])[1] || "mp4";
        return [{ label: `Video · ${ext.toUpperCase()}`, sub: dsrc, url: dsrc, ext }];
      }
      return shaped;
    }
    return [];
  }

  function lookUp(b, stream, quiet) {
    // another video on the page (or nothing found for it yet): look it up now
    // (quiet: ahead of time, while the mouse rests on it: nothing opens, no error shows)
    b.loading = true;
    b.open = !quiet;
    const hover = !isMain(b.video) && !isAudioTarget(b.video);
    const asked = videoKey(b.video);
    b.asked = asked;
    renderOne(b, quiet ? undefined : "Looking for the video qualities…");
    safeSend(
      // its own post / video link, or its own file; the page only when
      // neither is there
      {
        type: "swiftget-resolve-video",
        resolve: stream || "",
        // in a frame that is only a player: the add-in uses the page around it
        page: ownLink(b.video) || (genericCards.has(b.video) && !quiet ? cleanLink(b.video.href) : hover || directSrc(b.video) || !TOP || inFeed() ? "" : location.href),
        // a video the mouse is on (a hover preview): its own streams, those opened since the
        // mouse came to it, are this video; the page around it is not
        hover,
        since: b.since || 0,
        feed: TOP && inFeed(),
        src: directSrc(b.video),
        frame: !TOP,
      },
      (res) => {
        b.loading = false;
        if (quiet && !b.open) {
          // nobody pressed it meanwhile: keep what was found, say nothing about a failure
          if (chrome.runtime.lastError || !res || res.error) return renderOne(b);
        }
        if (chrome.runtime.lastError || !res) return notRunning(b, () => lookUp(b, stream));
        if (res.error) {
          if (/not running/i.test(res.error)) return notRunning(b, () => lookUp(b, stream));
          return renderOne(b, res.error, true);
        }
        // the player went on to another video meanwhile: not its qualities
        if (videoKey(b.video) !== asked) {
          b.open = false;
          return renderOne(b);
        }
        b.own = res.items || [];
        b.ownFor = asked;
        renderOne(b);
      }
    );
  }

  function clicked(b) {
    const list = itemsOf(b);
    if (!list.length && b.loading) {
      // being looked up ahead of time: show that it is on its way
      b.open = true;
      return renderOne(b, "Looking for the video qualities…");
    }
    if (!list.length && !b.loading) return lookUp(b);
    b.help = false;
    b.open = !b.open;
    renderOne(b);
  }

  // The app is closed: offer to open it, then do what the user wanted.
  function notRunning(b, retry) {
    b.open = true;
    renderOne(b, "MediaLab Downloader is not running.", true, {
      text: "Open MediaLab Downloader",
      run: () => {
        // the program registers "medialab-downloader:" when it is installed
        const a = document.createElement("a");
        a.href = "medialab-downloader://open";
        a.style.display = "none";
        document.documentElement.appendChild(a);
        a.click();
        a.remove();
        renderOne(b, "Opening MediaLab Downloader…");
        let tries = 0;
        const wait = setInterval(() => {
          tries++;
          safeSend({ type: "swiftget-status" }, (res) => {
            if (chrome.runtime.lastError) return;
            if (res && res.ok) {
              clearInterval(wait);
              retry();
            } else if (tries >= 25) {
              clearInterval(wait);
              renderOne(b, "MediaLab Downloader did not start. Open it from the Start menu and try again.", true);
            }
          });
        }, 1000);
      },
    });
  }

  function heightOf(q) {
    const m = /^(\d{3,4})p/.exec(q || "");
    return m ? Number(m[1]) : 0;
  }

  // One line of the menu, in plain words: "MP4 file · 1080p [Full HD] AV1",
  // under it "12:34 · 2,500 kbps · 245 MB".
  function describe(m) {
    const y = m.yt;
    if (!y) return { main: m.label, tag: "", codec: "", sub: m.sub || "" };
    const audio = y.quality === "audio" || y.quality === "mp3" || /^audio\|/.test(y.key || "");
    const ext = (y.ext || "mp4").toUpperCase();
    const q = audio ? "" : y.quality || "";
    const tag = audio ? "" : y.tag || tagOf(heightOf(q));
    const codec = audio ? "" : y.codec || (/\bAV1\b/.test(m.label || "") ? "AV1" : "");
    const kbps = y.kbps || (y.size && y.duration ? Math.round((y.size * 8) / y.duration / 1000) : 0);
    const sub = [
      fmtLen(y.duration),
      kbps ? `${kbps.toLocaleString("en")} kbps` : "",
      y.size ? (y.quality === "mp3" ? "about " : "") + fmtSize(y.size) : "",
      y.quality === "mp3" ? "made into MP3 after the download" : "",
      // some players play only the sound of an AV1 video
      codec === "AV1" ? "AV1: smaller file, needs a newer player" : "",
    ]
      .filter(Boolean)
      .join(" · ");
    const kind = audio ? `${ext} audio` : `${ext} file`;
    return { main: q ? `${kind} · ${q}` : kind, tag, codec, sub };
  }

  // "Download all": the whole playlist (YouTube list), or every file found
  function downloadAllOf(b, usable) {
    if (TOP && /youtube\.com/i.test(location.hostname) && /[?&]list=/.test(location.search)) {
      return { text: "Download all videos of this playlist", run: () => sendPlaylist(b) };
    }
    const files = usable.filter((m) => !m.yt && m.url);
    if (files.length >= 2) {
      return {
        text: `Download all (${files.length} files)`,
        run: () => files.forEach((m, i) => setTimeout(() => download(b, m), i * 300)),
      };
    }
    return null;
  }

  function sendPlaylist(b) {
    safeSend({ type: "swiftget-playlist", url: location.href }, (res) => {
      if (chrome.runtime.lastError || !res || !res.ok) return notRunning(b, () => sendPlaylist(b));
      flashOne(b, "The playlist is open in MediaLab Downloader ✔", false);
    });
  }

  // the list may open up or down: decided again after every change of it
  function renderOne(b, note, isError, action) {
    renderBubble(b, note, isError, action);
    // a protected (DRM) video: the button says so with a lock
    const locked = /🔒/.test(note || "") || itemsOf(b).some((i) => i.drm);
    b.root.getElementById("main").classList.toggle("locked", locked);
    placeOne(b);
  }

  function renderBubble(b, note, isError, action) {
    const list = itemsOf(b);
    const usable = list.filter((i) => !i.disabled);
    const busy = b.loading || (!usable.length && list.some((i) => i.disabled && /Getting/.test(i.label)));
    b.root.getElementById("label").textContent = usable.length > 1 && !b.loading ? `Download this video (${usable.length})` : "Download this video";
    b.root.getElementById("spin").hidden = !busy;
    b.root.querySelector("svg").style.display = busy ? "none" : "";
    b.root.getElementById("main").classList.toggle("open", b.open);
    const box = b.root.getElementById("list");
    box.hidden = !b.open;
    box.replaceChildren();
    if (b.help) {
      box.appendChild(
        el("div", {
          class: "help",
          text: "Click the button (or press Enter on it) to choose a quality. Drag it to an edge of the video: it stays there on this site. ✕ hides it for this video. Its size can be changed in the MediaLab Downloader add-in menu.",
        })
      );
      const never = el("div", { class: "act", tabindex: "0", role: "button", text: "Don't show the button on this site" });
      never.addEventListener("click", (e) => userPress(e) && noButtonOnThisSite());
      never.addEventListener("keydown", (e) => e.key === "Enter" && e.isTrusted && noButtonOnThisSite());
      box.appendChild(never);
    }
    if (note) {
      // dir "auto": a note in Arabic reads right to left (its full stop at the end)
      const d = el("div", { class: "msg" + (isError ? " err" : ""), dir: "auto", text: note });
      if (action) {
        const a = el("div", { class: "act", text: action.text });
        a.addEventListener("click", action.run);
        d.append(el("br"), a);
      }
      box.appendChild(d);
      return;
    }
    if (!list.length) {
      box.appendChild(el("div", { class: "msg", text: "Looking for the video qualities…" }));
      return;
    }
    const title = (list.find((m) => m.yt && m.yt.title) || {}).yt;
    box.appendChild(el("div", { class: "head", dir: "auto", title: (title && title.title) || cleanTitle(), text: (title && title.title) || cleanTitle() }));
    // two tabs: the whole video (never a part), or a part of it
    const partOk = usable.some(canCut);
    const partTab = b.clipMode && partOk;
    if (partOk) {
      const tab = (on, text, part) => {
        const t = el("div", { class: "tab" + (part ? " part" : "") + (on ? " on" : ""), text });
        t.addEventListener("click", () => {
          if (b.clipMode === part) return;
          b.clipMode = part;
          if (part && !b.clip) {
            const v = b.video;
            const at = Math.floor(v.currentTime || 0);
            const dur = Number.isFinite(v.duration) ? v.duration : 0;
            b.clip = { from: at, to: dur ? Math.min(dur, at + 30) : at + 30, exact: false };
          }
          if (!part) stopPart(b);
          renderOne(b);
        });
        return t;
      };
      box.appendChild(el("div", { class: "tabs" }, tab(!partTab, "⬇ Whole video", false), tab(partTab, "✂ Part", true)));
    }
    if (partTab) {
      box.appendChild(clipPanel(b, usable));
    } else {
      const all = downloadAllOf(b, usable);
      if (all) {
        const row = el("div", { class: "item" }, el("span", { class: "num", text: "⇊" }), el("div", { class: "body" }, el("div", { class: "t all", text: all.text })));
        row.addEventListener("click", all.run);
        box.appendChild(row);
      }
    }
    if (partTab) return;
    let n = 0;
    list.forEach((m) => {
      const d = describe(m);
      const t = el("div", { class: "t" }, el("span", { text: d.main }));
      if (d.tag) t.append(el("span", { class: "tag " + d.tag.replace(/\s/g, "").replace(/^(\d)K$/, "K$1"), text: d.tag }));
      if (d.codec) t.append(el("span", { class: "codec", text: d.codec }));
      const sub = d.sub.length > 110 ? d.sub.slice(0, 110) + "…" : d.sub;
      const row = el(
        "div",
        { class: "item" + (m.disabled ? " off" : "") },
        el("span", { class: "num", text: m.disabled ? "" : `${++n}.` }),
        el("div", { class: "body" }, t, el("div", { class: "s", text: sub }))
      );
      if (!m.disabled) {
        row.setAttribute("tabindex", "0");
        row.setAttribute("role", "button");
        row.addEventListener("click", () => download(b, m));
        row.addEventListener("keydown", (e) => {
          if (e.key === "Enter" && e.isTrusted) {
            e.preventDefault();
            download(b, m);
          }
        });
      }
      box.appendChild(row);
    });
  }

  // a quality that can be cut: a video / sound the app downloads itself
  function canCut(m) {
    if (m.disabled || m.drm || m.resolve) return false;
    if (m.yt) return true;
    return !!m.url && /\.(mp4|m4v|webm|mkv|mov|m3u8|mp3|m4a)(\?|$)/i.test(m.url);
  }

  // keys typed in our boxes stay ours (not the player's shortcuts)
  function keepKeys(input) {
    for (const t of ["keydown", "keyup", "keypress"]) input.addEventListener(t, (e) => e.stopPropagation());
  }

  // a short name of a quality for the part ("1080p", "MP3")
  function chipOf(m) {
    const y = m.yt;
    if (y) {
      if (y.quality === "mp3") return "MP3";
      if (y.quality === "audio" || /^audio\|/.test(y.key || "")) return (y.ext || "M4A").toUpperCase();
      return (y.quality || (y.ext || "MP4").toUpperCase()) + (y.codec ? " " + y.codec : "");
    }
    const h = heightOf(m.label || "");
    return h ? `${h}p` : (m.ext || (m.url || "").split("?")[0].split(".").pop() || "file").toUpperCase();
  }

  // The "✂ Part" tab: From / To, quick or exact, the quality, a look at the
  // part on the page's own player, and its own button
  function clipPanel(b, usable) {
    const c = b.clip;
    const v = b.video;
    const dur = Number.isFinite(v.duration) ? v.duration : 0;
    const choices = usable.filter(canCut);
    if (!choices.some((m) => m === b.cutPick)) {
      b.cutPick = choices.find((m) => m.yt && m.yt.quality === "720p") || choices.find((m) => heightOf(m.label || "") === 720) || choices[0];
    }
    const len = el("span", { class: "len" });
    const ok = () => c.to > c.from && (!dur || c.from < dur);
    const showLen = () => {
      len.textContent = ok() ? clock(c.to - c.from) : "!";
      len.title = ok() ? "Length of the part" : "The end must come after the start.";
      len.classList.toggle("err", !ok());
    };
    const time = (label, key) => {
      const input = el("input", { type: "text", value: clock(c[key]), "aria-label": label });
      keepKeys(input);
      input.addEventListener("input", () => {
        const t = parseClock(input.value);
        input.classList.toggle("bad", t == null);
        if (t != null) {
          c[key] = dur ? Math.min(t, dur) : t;
          showLen();
        }
      });
      const now = el("span", { class: "now", title: "The time the video is at now", text: "⏱ Now" });
      now.addEventListener("click", () => {
        c[key] = Math.floor(v.currentTime || 0);
        input.value = clock(c[key]);
        input.classList.remove("bad");
        showLen();
      });
      return { label: el("b", { text: label }), input, now };
    };
    const from = time("From", "from");
    const to = time("To", "to");
    const seg = el("div", { class: "seg" });
    const showSeg = () => {
      seg.replaceChildren();
      for (const [exact, text, words] of [
        [false, "Quick cut", "Takes seconds, the quality stays as it is; it may start a second or two early."],
        [true, "Exact cut", "Starts on the very second you chose; the picture is made again, so it takes longer."],
      ]) {
        const k = el("span", { class: c.exact === exact ? "on" : "", text, title: words });
        k.addEventListener("click", () => {
          c.exact = exact;
          showSeg();
        });
        seg.appendChild(k);
      }
    };
    const qs = el("div", { class: "qs" });
    const showQs = () => {
      qs.replaceChildren();
      for (const m of choices) {
        const d = describe(m);
        const q = el("span", { class: m === b.cutPick ? "on" : "", text: chipOf(m), title: [d.main, d.sub].filter(Boolean).join(" · ") });
        q.addEventListener("click", () => {
          b.cutPick = m;
          showQs();
        });
        qs.appendChild(q);
      }
    };
    const preview = el("span", { class: "pv", text: "▶ Preview" });
    preview.addEventListener("click", () => playPart(b));
    const go = el("span", { class: "go", text: "✂ Download the part" });
    go.addEventListener("click", () => b.cutPick && downloadPart(b, b.cutPick));
    const box = el(
      "div",
      { class: "cut" },
      el("div", { class: "lead", text: "Only the part you choose is downloaded" }),
      el("div", { class: "times" }, from.label, from.input, to.label, to.input, to.now, len),
      seg,
      qs,
      el("div", { class: "acts" }, preview, go)
    );
    showLen();
    showSeg();
    showQs();
    return box;
  }

  // the page's own player plays the part (nothing is downloaded)
  function playPart(b) {
    const v = b.video;
    const c = b.clip;
    if (!(c.to > c.from)) return;
    stopPart(b);
    const stop = () => {
      if (v.currentTime >= c.to || v.currentTime < c.from - 1) {
        v.pause();
        stopPart(b);
      }
    };
    b.partWatch = stop;
    try {
      v.currentTime = c.from;
      v.addEventListener("timeupdate", stop);
      const p = v.play();
      if (p && p.catch) p.catch(() => {});
    } catch (_) {
      // a player that does not let us move it: nothing to show
    }
  }

  function stopPart(b) {
    if (b.partWatch) b.video.removeEventListener("timeupdate", b.partWatch);
    b.partWatch = null;
  }

  function downloadPart(b, m) {
    const c = b.clip;
    const dur = Number.isFinite(b.video.duration) ? b.video.duration : 0;
    if (!(c.to > c.from) || (dur && c.from >= dur)) return flashOne(b, "The end must come after the start.", true);
    const clip = { start: c.from, end: dur ? Math.min(c.to, dur) : c.to, exact: !!c.exact };
    const fileName = `${cleanTitle()}.${m.ext || "mp4"}`;
    stopPart(b);
    safeSend(
      { type: "swiftget-download", item: m, title: document.title, fileName, referrer: location.href, clip, part: true },
      (res) => {
        if (chrome.runtime.lastError || !res || !res.ok) notRunning(b, () => downloadPart(b, m));
        else {
          b.clipMode = false;
          flashOne(b, `The part ${clock(clip.start)} → ${clock(clip.end)} was sent to MediaLab Downloader ✔`, false);
        }
      }
    );
  }

  // a free place (fractions of the video, after a drag) put on its nearest
  // edge; near a corner, in the corner
  function snapToEdge(at) {
    const d = { left: at.x, right: 1 - at.x, top: at.y, bottom: 1 - at.y };
    const edge = Object.keys(d).reduce((a, k) => (d[a] <= d[k] ? a : k));
    const c = (n) => (n < 0.08 ? 0 : n > 0.92 ? 1 : n);
    if (edge === "left") return { x: 0, y: c(at.y) };
    if (edge === "right") return { x: 1, y: c(at.y) };
    if (edge === "top") return { x: c(at.x), y: 0 };
    return { x: c(at.x), y: 1 };
  }

  // is one of the page's own buttons (much smaller than the video) under this spot?
  function onPageControl(b, left, top, w, h, r) {
    const area = (x) => Math.max(0, x.width) * Math.max(0, x.height);
    const small = (e) => area(e.getBoundingClientRect()) < area(r) / 5;
    const points = [[left + w / 2, top + h / 2], [left + 3, top + 3], [left + w - 3, top + 3]];
    for (const [px, py] of points) {
      let list = [];
      try {
        list = document.elementsFromPoint(px, py);
      } catch (_) {
        return false;
      }
      for (const e of list) {
        if (e === b.host) continue;
        if (e === b.video || e.contains(b.video)) break;
        const c = e.closest && e.closest("button, [role=button], a[href], input, select");
        if (c && !c.contains(b.video) && small(c)) return true;
      }
    }
    return false;
  }

  // where the button sits on its video: the user's place on this site, else
  // the top right corner, or the top left one when a button of the page's
  // own is there (kept a moment, so it does not jump about)
  function spotFor(b, r, w, h) {
    if (b.place) return b.place;
    // a card: always its top left corner (the preview that opens over it puts its own buttons on
    // the right: the button does not move to and fro because of them)
    if (isCard(b.video)) return { x: 0, y: 0 };
    const now = Date.now();
    // decided once for this video, again only when its size really changes (full screen…)
    if (b.auto && b.auto.v === b.video && Math.abs(r.width - b.auto.w) < b.auto.w * 0.15) return b.auto.at;
    let at = { x: 1, y: 0 };
    for (const c of [{ x: 1, y: 0 }, { x: 0, y: 0 }]) {
      const left = r.left + 8 + c.x * Math.max(0, r.width - w - 16);
      const top = r.top + 8 + c.y * Math.max(0, r.height - h - 16);
      if (!onPageControl(b, left, top, w, h, r)) {
        at = c;
        break;
      }
    }
    b.auto = { v: b.video, at, t: now, w: r.width };
    return at;
  }

  function placeOne(b) {
    const fs = document.fullscreenElement || document.webkitFullscreenElement;
    const r = rectOfB(b);
    // closed with its X: it stays closed (also after full screen, a new size…)
    // until the page shows another video; in full screen only when the user
    // asked for it (the add-in's window)
    const [minW, minH] = minSize(b.video);
    const onScreen =
      !b.dismissed && (!fs || showInFullscreen) &&
      r.bottom > 0 && r.top < innerHeight && r.right > 0 && r.left < innerWidth &&
      r.width >= minW && r.height >= minH && (connected(b.video) || b.ghost) &&
      !(fs && fs.tagName === "VIDEO") && (!fs || (b.video.nodeType === 1 && fs.contains(b.video)) || fs.shadowRoot);
    const posOk = r.bottom > 0 && r.top < innerHeight && r.right > 0 && r.left < innerWidth;
    const zeroRect = r.width === 0 && r.height === 0; // the page swaps the video element for a moment
    if (!onScreen && !b.dismissed && (posOk || zeroRect || b.loading || b.hovered || b.open) && b.lastOkAt && Date.now() - b.lastOkAt < 2500 && (connected(b.video) || b.ghost)) {
      return; // a video that changes its size while it loads: the button stays where it was
    }
    b.host.style.display = onScreen ? "block" : "none";
    if (!onScreen) return;
    b.lastOkAt = Date.now();
    if (b.host.parentNode !== layer()) layer().appendChild(b.host);
    promote(b);
    // the size of the button itself (the user can make it smaller or bigger);
    // its list floats and never moves it
    const mainRect = b.root.getElementById("main").getBoundingClientRect();
    const w = mainRect.width || 62;
    const h = mainRect.height || 22;
    let x;
    let y;
    if (b.dx != null) {
      // being dragged
      x = r.left + b.dx;
      y = r.top + b.dy;
    } else {
      const at = spotFor(b, r, w, h);
      x = r.left + 8 + at.x * Math.max(0, r.width - w - 16);
      y = r.top + 8 + at.y * Math.max(0, r.height - h - 16);
    }
    x = Math.max(r.left, Math.min(x, r.right - 60));
    y = Math.max(r.top, Math.min(y, r.bottom - h));
    const left = Math.max(4, Math.min(x, innerWidth - w));
    let top = Math.max(4, Math.min(y, innerHeight - h - 4));
    // a card scrolled under the page's own fixed header (YouTube's top bars): the button
    // slides down to the part of the card that can be seen, or hides while none of it is
    if (!b.ghost && b.dx == null && b.video.nodeType === 1 && !isAudioTarget(b.video)) {
      // (looked at again only when the place changed, or every second)
      const key = `${Math.round(left)}|${Math.round(top)}|${Math.round(r.bottom)}`;
      const nowMs = Date.now();
      if (b.coverKey !== key || nowMs - (b.coverAt || 0) > 1000) {
        b.coverKey = key;
        b.coverAt = nowMs;
        let shown = false;
        for (let step = 0; step < 12 && !shown; step++) {
          const ty = top + step * 14;
          if (ty + h > r.bottom + 1) break;
          if (!coveredByBar(b, left + 6, ty + 6)) {
            top = ty;
            shown = true;
          }
        }
        b.coverTop = shown ? top : null;
      }
      if (b.coverTop == null) {
        b.host.style.display = "none";
        return;
      }
      top = b.coverTop;
    }
    b.host.style.left = `${left}px`;
    b.host.style.top = `${top}px`;
    // where the list opens: away from the near edge of the screen
    const wrap = b.root.querySelector(".wrap");
    if (wrap) {
      const listW = 330 * zoom;
      const listH = Math.min(380, (b.root.getElementById("list") || {}).scrollHeight || 380) * zoom;
      wrap.classList.toggle("toright", left + w - listW < 4);
      wrap.classList.toggle("up", top + h + listH > innerHeight - 4 && top - listH > 4);
    }
  }

  // is the point under a wide fixed / sticky bar of the page (a header), not part of the target?
  function coveredByBar(b, x, y) {
    let list = [];
    try {
      list = document.elementsFromPoint(x, y);
    } catch (_) {
      return false;
    }
    for (const e of list) {
      if (e === b.host) continue;
      if (e === b.video || (e.contains && (e.contains(b.video) || b.video.contains(e)))) return false;
      let n = e;
      for (let depth = 0; n && n !== document.documentElement && depth < 14; depth++, n = n.parentElement) {
        const pos = getComputedStyle(n).position;
        if (pos === "fixed" || pos === "sticky") {
          const nr = n.getBoundingClientRect();
          if (nr.width >= innerWidth * 0.6 && nr.height < innerHeight * 0.5) return true;
        }
      }
      return false; // the top element is something else (a preview over the card): fine
    }
    return false;
  }

  // keeps the button above everything the page draws (the browser's top layer: the last one
  // that was put there is the top one)
  function promote(b) {
    const now = Date.now();
    try {
      if (!b.host.matches(":popover-open")) {
        b.promotedAt = now;
        b.host.showPopover();
        return;
      }
      if (now - (b.promotedAt || 0) < 1500) return;
      b.promotedAt = now;
      const rr = b.host.getBoundingClientRect();
      if (rr.width < 4 || rr.height < 4) return;
      const top = document.elementFromPoint(rr.left + Math.min(8, rr.width / 2), rr.top + Math.min(8, rr.height / 2));
      if (top && top !== b.host && !b.host.contains(top)) {
        b.host.hidePopover();
        b.host.showPopover();
      }
    } catch (_) {
      /* no popover support: z-index alone */
    }
  }

  function targetAlive(t) {
    if (!t || !connected(t)) return false;
    if (isAudioTarget(t)) return audioItems().length > 0;
    const r = rectOfTarget(t);
    const [mw, mh] = minSize(t);
    return r.bottom > 0 && r.top < innerHeight && r.right > 0 && r.left < innerWidth && r.width >= mw && r.height >= mh;
  }

  // what the button is on now: what the user works with, else what the mouse chose, else the
  // page's own video, else the sound of the page
  function chooseTarget() {
    const now = Date.now();
    const b = theBubble;
    // the one being worked with stays, even when the page took its video away
    if (b && b.video && (b.open || b.loading || b.hovered) && b.video !== hiddenTarget) {
      if (targetAlive(b.video)) return b.video;
      if (b.lastRect) {
        b.ghost = !connected(b.video);
        return b.video;
      }
    }
    if (cur && cur !== hiddenTarget) {
      if (targetAlive(cur)) return cur;
      if (b && b.video === cur && b.lastRect) {
        if (!connected(cur)) {
          // a hover preview that ended under the mouse: its place is kept a moment
          if (!b.goneAt) b.goneAt = now;
          if (now - b.goneAt < 3000) {
            b.ghost = true;
            return cur;
          }
          cur = null;
        } else if (b.lastOkAt && now - b.lastOkAt < 2500) {
          // momentarily 0x0 during DOM/preview transition (YouTube inline preview)
          return cur;
        }
      } else if (!connected(cur)) {
        cur = null;
      }
    }
    // the page's own video (the one that plays / the biggest)
    const mv = mainVideo();
    const mvr = mv ? mv.getBoundingClientRect() : null;
    const big = !!mvr && (mvr.width >= innerWidth * 0.4 || mvr.height >= innerHeight * 0.45 || !TOP);
    // (once the button is on the video it stays: a video that is loading is "not playing" for a moment)
    const keepOn = !!(theBubble && theBubble.video === mv);
    if (mv && big && mv !== hiddenTarget && targetAlive(mv) && (items.length || playing(mv) || keepOn)) return mv;
    if (!TOP) {
      // an embedded player: its own video
      let best = null;
      let area = 0;
      for (const v of allVideos()) {
        if (v === hiddenTarget || !targetAlive(v) || !(playing(v) || directSrc(v))) continue;
        const r = v.getBoundingClientRect();
        if (r.width * r.height > area) {
          area = r.width * r.height;
          best = v;
        }
      }
      if (best) return best;
    }
    // a player in a frame the page lays a see-through layer over (Google Drive)
    if (TOP && items.length && !mv) {
      for (const f of coveredPlayers()) if (f !== hiddenTarget) return f;
    }
    if (TOP && audioSlot !== hiddenTarget && audioItems().length) return audioSlot;
    return null;
  }

  function place() {
    if (dead) return;
    lastPlaceAt = Date.now();
    if (!panelAllowed()) return;
    if (hiddenByOtherFrame()) {
      if (theBubble) theBubble.host.style.display = "none";
      return;
    }
    const t = chooseTarget();
    if (!t) {
      // nothing to be on for a moment (a hover preview that is replaced): it does not blink away
      if (theBubble) {
        const tb = theBubble;
        let onNow = false;
        try {
          if (tb.lastOkAt && Date.now() - tb.lastOkAt < 1200 && !hiddenTarget && connected(tb.video)) {
            const rr = rectOfTarget(tb.video);
            onNow = (rr.width === 0 && rr.height === 0) || (rr.bottom > 0 && rr.top < innerHeight && rr.right > 0 && rr.left < innerWidth); // (scrolled away: not a blip)
          }
        } catch (_) {
          onNow = false;
        }
        if (!onNow) tb.host.style.display = "none";
      }
      return;
    }
    let b = theBubble;
    if (!b) {
      b = theBubble = makeBubble(t);
      claimButton(true);
      prefetchLater(b);
      tellMeta(b);
      return;
    }
    if (b.video !== t) {
      retarget(b, t);
      if (!hiddenByOtherFrame()) claimButton(false);
    }
    b.dismissed = false;
    tellMeta(b);
    placeOne(b);
  }

  function coveredPlayers() {
    const out = [];
    for (const f of document.querySelectorAll("iframe")) {
      const r = f.getBoundingClientRect();
      if (r.width < 300 || r.height < 170 || r.bottom < 60 || r.top > innerHeight - 60) continue;
      const x = Math.min(r.right - 40, innerWidth - 5);
      const y = Math.max(r.top + 16, 5);
      const top = document.elementFromPoint(x, y);
      if (top && top !== f && !(theBubble && theBubble.video === f && top === theBubble.host)) out.push(f);
      if (out.length >= 2) break;
    }
    return out;
  }

  function flashOne(b, text, isError) {
    b.open = true;
    renderOne(b, text, isError);
    setTimeout(() => {
      b.open = false;
      renderOne(b);
    }, 2500);
  }

  function download(b, m) {
    // a stream whose qualities are not known yet: ask the app for them
    if (m.resolve) return lookUp(b, m.resolve);
    const fileName = `${cleanTitle()}.${m.ext || "mp4"}`;
    safeSend(
      { type: "swiftget-download", item: m, title: document.title, fileName, referrer: location.href },
      (res) => {
        if (chrome.runtime.lastError || !res || !res.ok) notRunning(b, () => download(b, m));
        else flashOne(b, "Sent to MediaLab Downloader ✔", false);
      }
    );
  }

  function update(newItems) {
    if (!TOP) return; // frames look up their own videos
    items = newItems || [];
    // a new page / video: "closed" is forgotten
    if (!items.length) hiddenTarget = null;
    if (!panelAllowed()) return;
    place();
    for (const b of bubbles.values()) if (!b.own && !b.loading) renderOne(b);
  }

  // File links (.zip, .exe, .mp4…): a click goes straight to MediaLab Downloader,
  // so the browser never starts its own download (and never asks where to
  // save it). The rules are the program's own (Options > File Types).
  const wildcard = (pattern, text) =>
    new RegExp(
      "^" + String(pattern).toLowerCase().replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".") + "$"
    ).test(String(text).toLowerCase());
  let linkRules = null;
  const refreshLinkRules = () =>
    safeSend({ type: "swiftget-link-rules" }, (res) => {
      linkRules = chrome.runtime.lastError ? null : res || null;
    });
  refreshLinkRules();
  every(refreshLinkRules, 60000);
  // shown by the browser itself, not downloaded: never taken from a click
  // pages and pictures open in the browser; a PDF too, unless PDF is one of
  // the file types the app takes (then a click on its link goes to the app:
  // once it is open in the browser's PDF viewer, the viewer's own download
  // button always asks where to save, and that can't be stopped)
  const VIEWED = /^(html?|xhtml|php\d?|aspx?|jsp|cgi|pl|cfm|do|action|json|xml|txt|css|js|jpe?g|png|gif|webp|svg|bmp|ico|avif)$/;
  const keyHeld = (e, k) => (k === "alt" ? e.altKey : k === "ctrl" ? e.ctrlKey : k === "shift" ? e.shiftKey : false);
  function wantedLink(e, href) {
    const r = linkRules;
    if (!r || !switchedOn) return false;
    let u;
    try {
      u = new URL(href);
    } catch {
      return false;
    }
    if (!/^https?:$/.test(u.protocol)) return false;
    if (r.skipKey !== "none" && keyHeld(e, r.skipKey)) return false;
    const forced = r.forceKey !== "none" && keyHeld(e, r.forceKey);
    // Ctrl / Shift / Meta + click: a new tab or window, unless that is the "take it" key
    if (!forced && (e.ctrlKey || e.shiftKey || e.metaKey || e.altKey)) return false;
    const host = u.hostname.toLowerCase();
    if ((r.skipSites || []).some((s) => hostMatches(host, s))) return false;
    if ((r.skipAddresses || []).some((a) => wildcard(a, href))) return false;
    const last = decodeURIComponent(u.pathname.split("/").pop() || "");
    const dot = last.lastIndexOf(".");
    const ext = dot > 0 ? last.slice(dot + 1).toLowerCase() : "";
    if (!ext || VIEWED.test(ext)) return false;
    if (ext === "pdf" && !(r.exts || []).some((x) => wildcard(x, ext))) return false;
    // a .torrent file opens in the program's torrent window
    if (forced || ext === "torrent") return true;
    return (r.exts || []).some((x) => wildcard(x, ext));
  }
  // Heard after the page's own click code (not before it, and the click is
  // not stopped): file sites often make their link work in that code (a
  // request saying "the download starts", a cookie); stopped, the link stayed
  // "403 Forbidden" for the program while the browser and other programs got
  // the file. Only the browser's own download is held back.
  addEventListener(
    "click",
    (e) => {
      if (e.button !== 0 || e.defaultPrevented) return;
      const a = e.composedPath ? e.composedPath().find((n) => n && n.tagName === "A" && n.href) : null;
      if (!a || a.dataset.medialabPass) return;
      const href = String(a.href);
      if (!wantedLink(e, href)) return;
      e.preventDefault();
      safeSend({ type: "swiftget-link", url: href }, (res) => {
        // not taken (the app is closed, the user chose the browser): the browser's way
        if (chrome.runtime.lastError || !res || !res.ok) {
          const tmp = document.createElement("a");
          tmp.href = href;
          if (a.hasAttribute("download")) tmp.setAttribute("download", a.getAttribute("download") || "");
          tmp.dataset.medialabPass = "1";
          document.documentElement.appendChild(tmp);
          tmp.click();
          tmp.remove();
        }
      });
    },
    false
  );

  // magnet links of torrents go to MediaLab Downloader (Alt + click: to the browser)
  addEventListener(
    "click",
    (e) => {
      if (e.button !== 0 || e.altKey || e.defaultPrevented || !switchedOn) return;
      const a = e.composedPath ? e.composedPath().find((n) => n && n.tagName === "A" && n.href) : null;
      const href = a ? String(a.href) : "";
      if (!/^magnet:\?/i.test(href) || !/xt=urn:bt[im]h:/i.test(href)) return;
      e.preventDefault();
      e.stopPropagation();
      safeSend({ type: "swiftget-magnet", url: href }, (res) => {
        // not taken (the app is closed, or sending is off): the browser's way
        if (chrome.runtime.lastError || !res || !res.ok) location.href = href;
      });
    },
    true
  );

  // a click anywhere else closes an open menu
  addEventListener(
    "mousedown",
    (e) => {
      const path = e.composedPath ? e.composedPath() : [];
      for (const b of bubbles.values()) {
        if (b.open && !path.includes(b.host)) {
          b.open = false;
          b.help = false;
          renderOne(b);
        }
      }
    },
    true
  );
  addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    for (const b of bubbles.values()) {
      if (b.open) {
        b.open = false;
        renderOne(b);
      }
    }
  });
  for (const ev of ["fullscreenchange", "webkitfullscreenchange"]) {
    document.addEventListener(ev, () => setTimeout(() => bubbles.forEach((b) => placeOne(b)), 50));
  }

  // every link of the page (or the selection) for "Download all links"
  function collectLinks(selectionOnly) {
    const sel = selectionOnly ? getSelection() : null;
    const inSel = (el) => !sel || (sel.rangeCount > 0 && sel.containsNode(el, true));
    const out = [];
    const seen = new Set();
    const add = (url, text) => {
      if (!url || !/^https?:/i.test(url)) return;
      url = url.split("#")[0];
      if (seen.has(url)) return;
      seen.add(url);
      out.push({ url, text: (text || "").replace(/\s+/g, " ").trim().slice(0, 200) });
    };
    // the page itself and the parts built as web components
    const roots = [document];
    try {
      for (const el of document.querySelectorAll("*")) if (el.shadowRoot) roots.push(el.shadowRoot);
    } catch (_) {
      /* a strange page */
    }
    for (const root of roots) {
      for (const a of root.querySelectorAll("a[href]")) if (inSel(a)) add(a.href, a.innerText || a.title);
      for (const el of root.querySelectorAll("img[src], video[src], audio[src], source[src], embed[src]")) {
        if (inSel(el)) add(el.src, el.alt || el.title || "");
      }
      // buttons and boxes that keep their file's address in data-* (many
      // download pages): made absolute against the page
      for (const el of root.querySelectorAll("[data-href], [data-url], [data-download], [data-file], [data-link]")) {
        if (!inSel(el)) continue;
        for (const k of ["href", "url", "download", "file", "link"]) {
          const v = el.dataset && el.dataset[k];
          if (v && !/^(javascript|data):/i.test(v)) {
            try {
              add(new URL(v, location.href).href, el.innerText || el.title || "");
            } catch (_) {
              /* not an address */
            }
          }
        }
      }
    }
    // addresses written as plain text (pages that show a list of links, a
    // note or a paste): what the user sees is what is collected
    const text = sel ? String(sel) : (document.body && document.body.innerText) || "";
    for (const m of text.slice(0, 2000000).matchAll(/\bhttps?:\/\/[^\s"'<>()\[\]{}]+/gi)) {
      add(m[0].replace(/[.,;:!?]+$/, ""), "");
      if (out.length > 5000) break;
    }
    return { page: location.href, links: out };
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.type === "swiftget-media") update(msg.items);
    if (msg.type === "swiftget-collect-links") {
      if (!TOP) return false; // the page itself answers
      sendResponse(collectLinks(!!msg.selection));
      return true;
    }
    if (msg.type === "swiftget-open-panel") {
      const v = biggestVideo();
      if (!v) return false;
      hiddenTarget = null;
      cur = v;
      place();
      const b = theBubble;
      if (!b) return false;
      if (b.video !== v) retarget(b, v);
      b.dismissed = false;
      layer().appendChild(b.host);
      b.open = true;
      if (!itemsOf(b).length) lookUp(b);
      else renderOne(b);
      placeOne(b);
    }
    // the add-in was switched off and on: start again, like a reload of the page
    if (msg.type === "swiftget-scan-media") {
      scanPageCards();
      sendResponse({ ok: true });
      return false;
    }
    if (msg.type === "swiftget-reset") resetAll();
    return false;
  });
  safeSend({ type: "swiftget-config" }, (res) => {
    if (!chrome.runtime.lastError && res) {
      panel = res;
      if (!panelAllowed()) {
        for (const b of bubbles.values()) b.host.remove();
        bubbles.clear();
      }
    }
  });
  if (TOP) {
    // keys held while clicking a link: Alt = let the browser download it, etc.
    addEventListener(
      "mousedown",
      (e) => {
        safeSend({ type: "swiftget-keys", alt: e.altKey, ctrl: e.ctrlKey, shift: e.shiftKey });
      },
      true
    );
    // media detected before this script loaded
    safeSend({ type: "swiftget-media-request" }, (res) => {
      if (!chrome.runtime.lastError) update(res);
    });
  }

  addEventListener("scroll", place, { passive: true, capture: true });
  addEventListener("resize", place, { passive: true });
  every(place, 700);
  every(watchVideos, 1500);
  document.addEventListener("play", () => setTimeout(() => (watchVideos(), place()), 300), true);
  addEventListener("popstate", () => setTimeout(watchVideos, 500));
})();
