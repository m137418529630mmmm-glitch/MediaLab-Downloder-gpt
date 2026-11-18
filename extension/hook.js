// Runs inside the page itself (not in the add-in's own world) and only reports the addresses
// of streams (.m3u8 / .mpd) the page asks for, plus video names and thumbnails from the page's
// own JSON data so every stream in "Media on this page" gets its real name and picture.
(() => {
  if (window.__medialabHook) return;
  window.__medialabHook = true;
  const re = /\.(m3u8|mpd)(\?|#|$)/i;
  const directRe = /\.(mp4|webm|mov|m4v|mp3|wav|m4a|ogg|aac)(\?|#|$)/i;
  const told = new Map();
  const tell = (u, allowDirect = false) => {
    try {
      const url = new URL(String(u), location.href).href;
      if (!/^https?:/i.test(url)) return;
      const isStream = re.test(url);
      const isDirect = allowDirect && directRe.test(url) && !/googlevideo\.com/i.test(url);
      if (!isStream && !isDirect) return;
      const now = Date.now();
      if (told.has(url) && now - told.get(url) < 3000) return;
      told.set(url, now);
      window.postMessage(isStream ? { __medialabStream: url } : { __medialabDirectMedia: url }, "*");
    } catch (_) {
      /* not an address */
    }
  };

  const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|\b[0-9a-f]{24,64}\b/gi;
  const BAD_TITLE = /^(play|pause|video|audio|watch|download|image|thumbnail|preview|photo|more|menu|clip|mp4|webm|hls|dash|stream|default|original|watermarked|true|false|null|undefined|none|hd|4k|sd|fhd|uhd|free|pro|new)$/i;
  const TITLE_KEYS = ["title", "name", "clipName", "clip_name", "videoTitle", "video_title", "headline", "caption", "alt", "label", "description", "slug"];
  const THUMB_KEYS = ["thumbnailUrl", "thumbnail_url", "thumbnail", "posterUrl", "poster_url", "poster", "stillUrl", "still_url", "still", "imageUrl", "image_url", "coverUrl", "cover_url", "previewImage", "preview_image", "thumbUrl", "thumb_url", "thumb", "image", "picture"];

  const cleanText = (v, isSlug) => {
    if (typeof v !== "string") return "";
    let s = v.replace(/\s+/g, " ").trim();
    if (!s || s.length < 3 || s.length > 180 || /^https?:|^\/\//i.test(s)) return "";
    if (/^[0-9a-f]{8}-[0-9a-f-]{12,}$|^[0-9a-f_-]{16,}$/i.test(s) || BAD_TITLE.test(s)) return "";
    if (isSlug && /^[a-z0-9-]+$/i.test(s) && s.includes("-")) {
      s = s.replace(/-\d{4,}$/, "").replace(/[-_]+/g, " ").trim();
      if (s.length >= 3) s = s.charAt(0).toUpperCase() + s.slice(1);
    }
    return s;
  };

  const normImg = (v) => {
    if (!v) return "";
    if (typeof v === "object") v = v.url || v.src || v.large || v.medium || v.small || v.default || "";
    if (typeof v !== "string") return "";
    v = v.trim();
    if (v.startsWith("//")) v = "https:" + v;
    if (!/^https?:/i.test(v) || /\.(m3u8|mpd|mp4|webm|ts|m4s|mp3|wav)(\?|#|$)/i.test(v)) return "";
    return v;
  };

  const collectKeys = (obj, out, depth) => {
    if (!obj || depth > 2) return;
    if (typeof obj === "string") {
      for (const m of obj.matchAll(UUID_RE)) out.add(m[0].toLowerCase());
      if (re.test(obj)) {
        try {
          out.add(new URL(obj, location.href).href);
        } catch (_) {}
      }
      return;
    }
    if (typeof obj !== "object") return;
    if (Array.isArray(obj)) {
      for (let i = 0; i < Math.min(obj.length, 12); i++) collectKeys(obj[i], out, depth + 1);
      return;
    }
    for (const [k, v] of Object.entries(obj)) {
      if (typeof v === "string") {
        for (const m of v.matchAll(UUID_RE)) out.add(m[0].toLowerCase());
        if (re.test(v)) {
          tell(v);
          try {
            out.add(new URL(v, location.href).href);
          } catch (_) {}
        }
        if (/^(id|uuid|clipId|clip_id|videoId|video_id|assetId|asset_id|footageId|footage_id|mediaId|media_id)$/i.test(k) && v.length >= 5 && v.length <= 64) {
          out.add(v.toLowerCase());
        }
      } else if (typeof v === "number" && /^(id|clipId|clip_id|videoId|video_id|assetId|asset_id|footageId|footage_id)$/i.test(k) && v >= 10000) {
        out.add(String(v));
      } else if (v && typeof v === "object" && depth < 2 && /video|stream|hls|dash|media|asset|file|source|preview|rendition|poster|thumb|image|still|url/i.test(k)) {
        collectKeys(v, out, depth + 1);
      }
    }
  };

  const scanJson = (data) => {
    try {
      const found = [];
      let visited = 0;
      const walk = (node, depth) => {
        if (!node || typeof node !== "object" || depth > 10 || ++visited > 3000) return;
        if (Array.isArray(node)) {
          for (let i = 0; i < node.length && visited <= 3000; i++) walk(node[i], depth + 1);
          return;
        }
        let title = "";
        for (const k of TITLE_KEYS) {
          if (k in node) {
            title = cleanText(node[k], k === "slug");
            if (title) break;
          }
        }
        let thumb = "";
        for (const k of THUMB_KEYS) {
          if (k in node) {
            thumb = normImg(node[k]);
            if (thumb) break;
          }
        }
        if (title || thumb) {
          const keys = new Set();
          collectKeys(node, keys, 0);
          if (keys.size) found.push({ keys: [...keys].slice(0, 12), title, thumb });
        }
        for (const v of Object.values(node)) {
          if (v && typeof v === "object") walk(v, depth + 1);
        }
      };
      walk(data, 0);
      if (found.length) window.postMessage({ __medialabMetaList: found.slice(0, 80) }, "*");
    } catch (_) {}
  };

  const scanScripts = () => {
    try {
      for (const s of document.querySelectorAll('script#__NEXT_DATA__, script[type="application/ld+json"], script[type="application/json"]')) {
        const t = s.textContent;
        if (t && t.length > 20 && t.length < 2000000) {
          try {
            scanJson(JSON.parse(t));
          } catch (_) {}
        }
      }
    } catch (_) {}
  };
  if (document.readyState === "loading") addEventListener("DOMContentLoaded", scanScripts, { once: true });
  else setTimeout(scanScripts, 0);

  try {
    const of = window.fetch;
    if (of) {
      window.fetch = function (input, ...rest) {
        try {
          tell(input && input.url ? input.url : input);
        } catch (_) {
          /* ignore */
        }
        const p = of.call(this, input, ...rest);
        try {
          if (p && p.then) {
            p.then((res) => {
              try {
                const ct = (res && res.headers && res.headers.get && res.headers.get("content-type")) || "";
                if (/json/i.test(ct) && res.clone) {
                  res.clone().json().then(scanJson).catch(() => {});
                }
              } catch (_) {}
            }).catch(() => {});
          }
        } catch (_) {}
        return p;
      };
    }
    const xo = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function (method, url, ...rest) {
      try {
        tell(url);
        this.addEventListener(
          "load",
          function () {
            try {
              const ct = (this.getResponseHeader && this.getResponseHeader("content-type")) || "";
              if (!/json/i.test(ct)) return;
              if (this.responseType === "json" && this.response) scanJson(this.response);
              else if ((!this.responseType || this.responseType === "text") && typeof this.responseText === "string" && this.responseText.length < 2000000) {
                scanJson(JSON.parse(this.responseText));
              }
            } catch (_) {}
          },
          { once: true }
        );
      } catch (_) {
        /* ignore */
      }
      return xo.call(this, method, url, ...rest);
    };
    const d = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, "src");
    if (d && d.set) {
      Object.defineProperty(HTMLMediaElement.prototype, "src", {
        ...d,
        set(v) {
          try {
            tell(v, true);
          } catch (_) {
            /* ignore */
          }
          return d.set.call(this, v);
        },
      });
    }
  } catch (_) {
    /* a page that locks these: the browser's request list still sees the streams */
  }
})();
