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

async function init() {
  document.getElementById("settings").addEventListener("click", () => {
    chrome.runtime.openOptionsPage();
    window.close();
  });

  // the on / off switch: off = the browser keeps its downloads, no buttons
  // on videos, nothing is looked up (the add-in stays installed)
  const on = document.getElementById("enabled");
  const showOn = (v) => {
    on.checked = v;
    document.body.classList.toggle("off", !v);
    document.getElementById("onText").textContent = v ? "MediaLab Downloader is on" : "MediaLab Downloader is paused";
    document.getElementById("onHint").textContent = v
      ? "Downloads and videos of this browser go to MediaLab Downloader"
      : "The browser keeps its downloads, no buttons on videos";
  };
  chrome.storage.local.get({ enabled: true }, (o) => showOn(o.enabled !== false));
  on.addEventListener("change", () => {
    chrome.storage.local.set({ enabled: on.checked });
    showOn(on.checked);
    // off: "disconnected", and what was caught is forgotten; on: everything is looked up again
    setTimeout(() => location.reload(), 350);
  });

  const look = document.getElementById("look");
  const lookList = customSelect(look);
  chrome.storage.local.get({ bubbleStyle: "compact" }, (o) => {
    look.value = o.bubbleStyle || "compact";
    lookList.render();
  });
  look.addEventListener("change", () => chrome.storage.local.set({ bubbleStyle: look.value }));

  // how solid the button is on the video (the mouse on it: always solid)
  const solid = document.getElementById("solid");
  const solidText = document.getElementById("solidText");
  const showSolid = (v) => {
    solid.value = String(v);
    solidText.textContent = `${v}%`;
  };
  chrome.storage.local.get({ bubbleOpacity: 0.9 }, (o) => showSolid(Math.round((Number(o.bubbleOpacity) || 0.9) * 100)));
  solid.addEventListener("input", () => {
    showSolid(Number(solid.value));
    chrome.storage.local.set({ bubbleOpacity: Number(solid.value) / 100 });
  });

  // full screen: the button stays out of the way unless the user wants it
  const fullscreen = document.getElementById("fullscreen");
  chrome.storage.local.get({ bubbleFullscreen: false }, (o) => (fullscreen.checked = !!o.bubbleFullscreen));
  fullscreen.addEventListener("change", () => chrome.storage.local.set({ bubbleFullscreen: fullscreen.checked }));

  // size of the "Download this video" button on pages (also in the settings page)
  const scale = document.getElementById("scale");
  const scaleText = document.getElementById("scaleText");
  const OLD = { small: 85, normal: 100, large: 125 };
  const show = (v) => {
    scale.value = String(v);
    scaleText.textContent = `${v}%`;
  };
  chrome.storage.local.get({ bubbleScale: null, bubbleSize: "normal" }, (o) =>
    show(o.bubbleScale != null ? Math.round(o.bubbleScale * 100) : OLD[o.bubbleSize] || 100)
  );
  const save = (v) => {
    show(v);
    chrome.storage.local.set({ bubbleScale: v / 100 });
  };
  scale.addEventListener("input", () => save(Number(scale.value)));
  document.getElementById("scaleReset").addEventListener("click", () => save(100));

  // why the last download stayed in the browser (the last ten minutes)
  const WHY = {
    "not-running": "MediaLab Downloader was not running or did not answer.",
    small: "it is smaller than the size set in the add-in's settings.",
    rules: "MediaLab Downloader's Options leave this kind of file, or this site, to the browser.",
    "cant-fetch": "the site gives this file to the browser only (a sign-in of the page, or a link that works once).",
    form: "it comes from a form that sends a file, which can't be sent again.",
  };
  chrome.storage.local.get({ lastLeft: null }, ({ lastLeft }) => {
    const box = document.getElementById("left");
    if (!lastLeft || !WHY[lastLeft.why] || Date.now() - lastLeft.at > 10 * 60 * 1000) return;
    const name = lastLeft.name ? `"${lastLeft.name}"` : "The last download";
    box.textContent = `${name} stayed in the browser: ${WHY[lastLeft.why]}`;
    box.hidden = false;
  });

  // the button was turned off on this site (from its own help): back on
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    let site = "";
    try {
      site = new URL((tabs && tabs[0] && tabs[0].url) || "").hostname.toLowerCase();
    } catch {
      return;
    }
    chrome.storage.local.get({ noButtonSites: [] }, ({ noButtonSites }) => {
      if (!site || !(noButtonSites || []).includes(site)) return;
      const again = document.createElement("button");
      again.className = "act";
      again.textContent = `Show the video button on ${site} again`;
      again.addEventListener("click", () => {
        chrome.storage.local.set({ noButtonSites: noButtonSites.filter((h) => h !== site) }, () => {
          again.textContent = "Done - reload the page";
          again.disabled = true;
        });
      });
      document.querySelector("section").appendChild(again);
    });
  });

  chrome.runtime.sendMessage({ type: "swiftget-status" }, (res) => {
    const el = document.getElementById("status");
    const ok = res && res.ok;
    const nokey = res && res.state === "nokey";
    el.textContent = ok ? "connected" : nokey ? "not connected" : res && res.state === "off" ? "disconnected" : "app not running";
    el.classList.toggle("on", !!ok);
    if (nokey) {
      // the program runs but does not know this add-in (yet): connect again
      const again = document.createElement("button");
      again.className = "act";
      again.textContent = "Connect again";
      again.addEventListener("click", () => {
        again.textContent = "Connecting… (answer in MediaLab Downloader if it asks)";
        again.disabled = true;
        chrome.runtime.sendMessage({ type: "swiftget-reconnect" }, (r) => {
          again.disabled = false;
          again.textContent = r && r.ok ? "Connected ✔" : "Not connected - try again";
          if (r && r.ok) {
            el.textContent = "connected";
            el.classList.add("on");
          }
        });
      });
      document.querySelector("section").appendChild(again);
    } else if (!ok) {
      // the program registers "medialab-downloader:" when it is installed
      const open = document.createElement("a");
      open.href = "medialab-downloader://open";
      open.className = "open";
      open.textContent = "Open MediaLab Downloader";
      open.addEventListener("click", () => setTimeout(() => window.close(), 300));
      document.querySelector("section").appendChild(open);
    }
  });

  // Firefox: the add-in talks to the program through the program's helper
  // only once the user allows it (once); until then it uses the port
  if (/Firefox\//.test(navigator.userAgent) && chrome.permissions) {
    chrome.permissions.contains({ permissions: ["nativeMessaging"] }).then((has) => {
      if (has) return;
      const direct = document.createElement("button");
      direct.className = "act";
      direct.textContent = "Connect directly (recommended)";
      direct.title = "Firefox asks once: the add-in then talks to MediaLab Downloader without a port";
      direct.addEventListener("click", () => {
        chrome.permissions.request({ permissions: ["nativeMessaging"] }).then((yes) => {
          direct.textContent = yes ? "Connected directly ✔" : "Not allowed";
          direct.disabled = !!yes;
        });
      });
      document.querySelector("section").appendChild(direct);
    }, () => {});
  }

  quickBox();

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) return;
  liveMedia(tab, on.checked);
}

// the list follows the page while the popup is open: a video that starts to play is in it a moment later
function liveMedia(tab, enabled) {
  const state = { sig: null, pics: new Map(), asked: new Set(), tries: {}, items: [] };
  const draw = () => showMedia(tab, state.items, state.pics);
  const scanPage = () => {
    if (!enabled || !tab || tab.id == null || !chrome.tabs || !chrome.tabs.sendMessage) return;
    try {
      chrome.tabs.sendMessage(tab.id, { type: "swiftget-scan-media" }, () => void chrome.runtime.lastError);
    } catch {}
  };
  const pull = () =>
    chrome.runtime.sendMessage({ type: "swiftget-get-media", tabId: tab.id }, (items) => {
      if (chrome.runtime.lastError) return;
      const list = enabled ? items || [] : [];
      state.items = list;
      // the small pictures: asked for once for each video, then kept
      const need = [...new Set(list.map((i) => i.metaId).filter((id) => id && !state.asked.has(id)))];
      if (need.length) {
        need.forEach((id) => state.asked.add(id));
        chrome.runtime.sendMessage({ type: "swiftget-get-pics", tabId: tab.id, ids: need }, (res) => {
          if (chrome.runtime.lastError || !res) return;
          for (const [id, p] of Object.entries(res)) state.pics.set(id, p);
          state.sig = null; // draw again with the pictures
          draw();
        });
      }
      // pictures taken a moment after the video started: asked again for the ones that had none
      for (const [id, p] of state.pics) {
        if (p.thumb || (p.frames && p.frames.length)) continue;
        state.tries[id] = (state.tries[id] || 0) + 1;
        if (state.tries[id] <= 6) state.asked.delete(id); // (a few times, not for ever)
      }
      const sig = JSON.stringify(list.map((i) => [i.label, i.url || i.resolve || "", i.name || "", i.thumb || "", i.previewSeg || "", i.t || 0])) + state.pics.size;
      if (sig === state.sig) return;
      state.sig = sig;
      draw();
    });
  document.getElementById("mediaClear").addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    chrome.runtime.sendMessage({ type: "swiftget-clear-tab", tabId: tab.id }, () => {
      state.sig = null;
      scanPage();
      pull();
    });
  });
  scanPage();
  pull();
  setTimeout(pull, 350);
  setInterval(pull, 1200);
}

// the list of styles in the add-in's own colours (the browser's own list is blue)
function customSelect(sel) {
  const wrap = document.createElement("div");
  wrap.className = "dd";
  const btn = document.createElement("button");
  btn.type = "button";
  const list = document.createElement("ul");
  list.hidden = true;
  const render = () => {
    const o = sel.options[sel.selectedIndex];
    btn.textContent = o ? o.text : "";
    for (const li of list.children) li.classList.toggle("on", li.dataset.v === sel.value);
  };
  for (const o of sel.options) {
    const li = document.createElement("li");
    li.textContent = o.text;
    li.dataset.v = o.value;
    li.addEventListener("click", () => {
      sel.value = o.value;
      sel.dispatchEvent(new Event("change"));
      list.hidden = true;
      render();
    });
    list.appendChild(li);
  }
  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    list.hidden = !list.hidden;
  });
  document.addEventListener("click", () => (list.hidden = true));
  sel.style.display = "none";
  sel.after(wrap);
  wrap.append(btn, list);
  render();
  return { render };
}

// ---- the link box: a YouTube link + a quality go to the program at once ----------------------
function quickBox() {
  const input = document.getElementById("qlink");
  const status = document.getElementById("qstatus");
  const buttons = [...document.querySelectorAll("#qq button")];
  let quality = "best";
  const say = (text, cls) => {
    status.textContent = text;
    status.className = "qstatus" + (cls ? " " + cls : "");
  };
  const mark = (q) => {
    quality = q;
    buttons.forEach((b) => b.classList.toggle("on", b.dataset.q === q));
  };
  chrome.storage.local.get({ quickQuality: "best" }, (o) => mark(o.quickQuality || "best"));
  buttons.forEach((b) =>
    b.addEventListener("click", () => {
      mark(b.dataset.q);
      chrome.storage.local.set({ quickQuality: b.dataset.q });
      // a link is already there and was not sent yet (or failed): the new quality is used
      if (input.value.trim() && !sending) go();
    })
  );
  let sending = false;
  const youtubeLink = (t) => /^https?:\/\/(www\.|m\.|music\.)?(youtube\.com\/(watch\?|shorts\/|live\/|embed\/)|youtu\.be\/)/i.test(t);
  const go = () => {
    const link = input.value.trim();
    if (!link) return;
    if (!youtubeLink(link)) return say("YouTube video links only.", "bad");
    sending = true;
    say("Sending to MediaLab Downloader…");
    chrome.runtime.sendMessage({ type: "swiftget-quick-download", link, quality }, (res) => {
      sending = false;
      if (chrome.runtime.lastError || !res) return say("MediaLab Downloader is not running.", "bad");
      if (!res.ok) return say(res.error || "Could not send it.", "bad");
      say(`Sent ✔ ${res.title ? res.title + " · " : ""}${res.label || ""}`, "ok");
    });
  };
  document.getElementById("qpaste").addEventListener("click", async () => {
    try {
      input.value = (await navigator.clipboard.readText()).trim();
    } catch {
      say("The browser did not give the copied text: paste it in the box with Ctrl+V.", "bad");
      input.focus();
      return;
    }
    go();
  });
  input.addEventListener("paste", () => setTimeout(go, 50));
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") go();
  });
}

// ---- Media on this page: Video and Audio apart, one entry per video, with its name ----------
const isAudioItem = (m) => (m.yt ? m.yt.quality === "audio" || m.yt.quality === "mp3" : !!m.audio);
const heightOfItem = (m) => {
  const x = /(\d{3,4})p/i.exec((m.yt && m.yt.quality) || m.label || "");
  return x ? Number(x[1]) : 0;
};
// the streams of one video share the start of their address (or its UUID / hash)
const familyOf = (url) => {
  try {
    const u = new URL(url);
    const id = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{20,}/i.exec(u.pathname);
    if (id) return u.host + "/" + id[0].toLowerCase();
    return u.host + u.pathname.split("/").slice(0, 5).join("/");
  } catch {
    return url;
  }
};
const isCodeName = (s) =>
  !s ||
  /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.test(s) ||
  /^[0-9a-f_-]{14,}$/i.test(s) ||
  /^(index|master|playlist|manifest|video|audio|stream|chunklist|media|hls|dash|content|footage|artgrid|artlist|stills|clips?|assets?|artifacts?|public|cdn|preview|watermarked|renditions?|transcode|\d{3,4}p?|\d+k|sd|hd|uhd|fhd|h264|h265|avc1?|vp9|av1|[0-9_-]+)$/i.test(s) ||
  /^(footage|video|audio|media|stream|hls|dash|cdn|content|asset|clip)[-_](footage|video|audio|media|stream|hls|dash|cdn|content|asset|clip|mp4|ts)$/i.test(s);
const slugFromUrl = (url) => {
  try {
    const parts = new URL(url).pathname
      .split("/")
      .filter(Boolean)
      .map((p) => decodeURIComponent(p).replace(/\.[a-z0-9]{2,5}$/i, "").trim());
    for (let i = parts.length - 1; i >= 0; i--) {
      const seg = parts[i];
      if (!isCodeName(seg) && /[a-z\u0600-\u06ff]{3}/i.test(seg)) {
        const w = seg.replace(/[-_]+\d{5,}$/, "").replace(/[-_]+/g, " ").trim();
        if (w.length >= 3) return w;
      }
    }
  } catch {}
  return "";
};
const fileTitle = (url) => {
  try {
    const last = decodeURIComponent(new URL(url).pathname.split("/").filter(Boolean).pop() || "").replace(/\.[a-z0-9]{2,5}$/i, "");
    // a code (uuid / hash / "index" / "master") is no name
    if (!isCodeName(last)) return last;
    const slug = slugFromUrl(url);
    if (slug) return slug;
    return `Video from ${new URL(url).hostname.replace(/^www\./, "")}`;
  } catch {
    return "Media";
  }
};

// Live video frame snapshot cache and extraction queue (for HLS .m3u8/.ts/.m4s and MP4 streams)
const capturedPics = new Map();
const capturePending = new Set();
let captureActive = 0;
const captureQueue = [];

function runNextCapture() {
  while (captureActive < 3 && captureQueue.length) {
    const job = captureQueue.shift();
    captureActive++;
    job().finally(() => {
      captureActive--;
      runNextCapture();
    });
  }
}

function isBlackCanvas(ctx, w, h) {
  try {
    const px = ctx.getImageData(0, 0, w, h).data;
    let sum = 0;
    let count = 0;
    for (let i = 0; i < px.length; i += 64) {
      sum += px[i] + px[i + 1] + px[i + 2];
      count++;
    }
    return !count || sum / count / 3 < 12;
  } catch {
    return false;
  }
}

function drawSourceToJpeg(source, srcW, srcH, allowBlack = false) {
  try {
    if (!srcW || !srcH) return "";
    const c = document.createElement("canvas");
    c.width = 160;
    c.height = Math.max(1, Math.round((160 * srcH) / srcW));
    const ctx = c.getContext("2d");
    ctx.drawImage(source, 0, 0, c.width, c.height);
    if (!allowBlack && isBlackCanvas(ctx, c.width, c.height)) return "";
    const d = c.toDataURL("image/jpeg", 0.65);
    return d && d.length > 800 && d.length < 38000 ? d : "";
  } catch {
    return "";
  }
}

async function ensurePreviewRules(url, referrer) {
  if (!url || !/^https?:/i.test(url) || typeof chrome === "undefined" || !chrome.runtime) return;
  await new Promise((r) => {
    try {
      chrome.runtime.sendMessage({ type: "swiftget-preview-rules", url, referrer: referrer || "" }, () => {
        void chrome.runtime.lastError;
        r();
      });
    } catch {
      r();
    }
  });
}

async function fetchHeadBytes(url, maxBytes = 524288) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 7000);
  try {
    const res = await fetch(url, { credentials: "include", signal: ctl.signal });
    if (!res.ok) return null;
    if (!res.body || !res.body.getReader) {
      const ab = await res.arrayBuffer();
      return new Uint8Array(ab.slice(0, maxBytes));
    }
    const reader = res.body.getReader();
    const chunks = [];
    let total = 0;
    while (total < maxBytes) {
      const { done, value } = await reader.read();
      if (done || !value) break;
      chunks.push(value);
      total += value.byteLength;
    }
    try {
      reader.cancel();
    } catch {}
    const out = new Uint8Array(Math.min(total, maxBytes));
    let at = 0;
    for (const c of chunks) {
      const take = Math.min(c.byteLength, out.byteLength - at);
      if (take <= 0) break;
      out.set(c.subarray(0, take), at);
      at += take;
    }
    return out;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// Extract H.264 Annex-B keyframe and P-frame access units from an MPEG-TS (.ts) segment
function extractTsVideoChunks(u8) {
  if (!u8 || u8.length < 376) return null;
  let sync = -1;
  for (let i = 0; i < Math.min(u8.length - 376, 1000); i++) {
    if (u8[i] === 0x47 && u8[i + 188] === 0x47 && u8[i + 376] === 0x47) {
      sync = i;
      break;
    }
  }
  if (sync < 0) return null;
  let videoPid = -1;
  const parts = [];
  let total = 0;
  for (let p = sync; p + 188 <= u8.length; p += 188) {
    if (u8[p] !== 0x47) continue;
    const pusi = !!(u8[p + 1] & 0x40);
    const pid = ((u8[p + 1] & 0x1f) << 8) | u8[p + 2];
    const afc = (u8[p + 3] >> 4) & 0x3;
    if (!(afc & 1)) continue;
    let off = p + 4 + (afc & 2 ? 1 + u8[p + 4] : 0);
    if (off >= p + 188) continue;
    if (pusi && off + 9 <= p + 188 && u8[off] === 0 && u8[off + 1] === 0 && u8[off + 2] === 1) {
      const sid = u8[off + 3];
      if ((sid & 0xf0) === 0xe0 && (videoPid < 0 || videoPid === pid)) {
        videoPid = pid;
        off += 9 + u8[off + 8];
      }
    }
    if (pid === videoPid && off < p + 188) {
      const sub = u8.subarray(off, p + 188);
      parts.push(sub);
      total += sub.length;
    }
  }
  if (!total) return null;
  const es = new Uint8Array(total);
  let at = 0;
  for (const c of parts) {
    es.set(c, at);
    at += c.length;
  }
  const nals = [];
  for (let i = 0; i + 4 < es.length; i++) {
    if (es[i] === 0 && es[i + 1] === 0 && (es[i + 2] === 1 || (es[i + 2] === 0 && es[i + 3] === 1))) {
      const sc = es[i + 2] === 1 ? 3 : 4;
      const hdr = i + sc;
      if (nals.length) nals[nals.length - 1].end = i;
      nals.push({ start: i, hdr, end: es.length, type: es[hdr] & 0x1f });
      i = hdr;
    }
  }
  const sps = nals.find((n) => n.type === 7 && n.hdr + 3 < n.end);
  const pps = nals.find((n) => n.type === 8);
  const idrIdx = nals.findIndex((n) => n.type === 5);
  if (!sps || !pps || idrIdx < 0) return null;
  const hex2 = (n) => n.toString(16).padStart(2, "0");
  const codec = `avc1.${hex2(es[sps.hdr + 1])}${hex2(es[sps.hdr + 2])}${hex2(es[sps.hdr + 3])}`;
  const idrSlices = [nals[idrIdx]];
  let nextIdx = idrIdx + 1;
  for (; nextIdx < nals.length; nextIdx++) {
    if (nals[nextIdx].type === 5) idrSlices.push(nals[nextIdx]);
    else if (nals[nextIdx].type === 1 || nals[nextIdx].type === 9 || nals[nextIdx].type === 7) break;
  }
  const packNals = (list) => {
    const len = list.reduce((s, n) => s + (n.end - n.start), 0);
    const out = new Uint8Array(len);
    let pos = 0;
    for (const n of list) {
      out.set(es.subarray(n.start, n.end), pos);
      pos += n.end - n.start;
    }
    return out;
  };
  const keyData = packNals([sps, pps, ...idrSlices]);
  const deltas = [];
  let curDelta = [];
  for (let k = nextIdx; k < nals.length && deltas.length < 8; k++) {
    const n = nals[k];
    if (n.type === 9) {
      if (curDelta.length) {
        deltas.push(packNals(curDelta));
        curDelta = [];
      }
    } else if (n.type === 1 || n.type === 5) {
      const firstMbZero = n.hdr + 1 < n.end && (es[n.hdr + 1] & 0x80) !== 0;
      if (firstMbZero && curDelta.length) {
        deltas.push(packNals(curDelta));
        curDelta = [];
      }
      curDelta.push(n);
    }
  }
  if (curDelta.length && deltas.length < 8) deltas.push(packNals(curDelta));
  return { codec, keyData, deltas };
}

async function decodeTsSnapshot(u8) {
  if (typeof VideoDecoder === "undefined" || typeof EncodedVideoChunk === "undefined") return "";
  const parsed = extractTsVideoChunks(u8);
  if (!parsed) return "";
  return new Promise((resolve) => {
    let bestPic = "";
    let fallbackPic = "";
    let settled = false;
    const finish = (pic) => {
      if (settled) return;
      settled = true;
      try {
        if (dec.state !== "closed") dec.close();
      } catch {}
      resolve(pic || fallbackPic || "");
    };
    const timer = setTimeout(() => finish(bestPic), 2500);
    let dec;
    try {
      dec = new VideoDecoder({
        output(frame) {
          try {
            const w = frame.displayWidth || frame.codedWidth || 160;
            const h = frame.displayHeight || frame.codedHeight || 90;
            if (!bestPic) {
              const pic = drawSourceToJpeg(frame, w, h, false);
              if (pic) bestPic = pic;
              else if (!fallbackPic) fallbackPic = drawSourceToJpeg(frame, w, h, true);
            }
          } finally {
            try {
              frame.close();
            } catch {}
          }
        },
        error() {
          clearTimeout(timer);
          finish(bestPic);
        },
      });
      dec.configure({ codec: parsed.codec });
      dec.decode(new EncodedVideoChunk({ type: "key", timestamp: 0, data: parsed.keyData }));
      let ts = 33333;
      for (const d of parsed.deltas) {
        dec.decode(new EncodedVideoChunk({ type: "delta", timestamp: ts, data: d }));
        ts += 33333;
      }
      dec
        .flush()
        .then(() => {
          clearTimeout(timer);
          finish(bestPic);
        })
        .catch(() => {
          clearTimeout(timer);
          finish(bestPic);
        });
    } catch {
      clearTimeout(timer);
      finish("");
    }
  });
}

function captureVideoUrlFrame(srcUrl, isBlob = false) {
  return new Promise((resolve) => {
    const v = document.createElement("video");
    v.muted = true;
    v.playsInline = true;
    v.preload = "auto";
    let done = false;
    let sought = false;
    const finish = (pic) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try {
        v.pause();
        v.removeAttribute("src");
        v.load();
      } catch {}
      if (isBlob) {
        try {
          URL.revokeObjectURL(srcUrl);
        } catch {}
      }
      resolve(pic || "");
    };
    const timer = setTimeout(() => finish(""), 5000);
    const tryGrab = () => {
      const pic = drawSourceToJpeg(v, v.videoWidth, v.videoHeight, sought);
      if (pic) return finish(pic);
      if (!sought && v.duration > 0.4) {
        sought = true;
        try {
          v.currentTime = Math.min(2.0, v.duration * 0.35);
          return;
        } catch {}
      }
      finish(drawSourceToJpeg(v, v.videoWidth, v.videoHeight, true));
    };
    v.addEventListener("loadedmetadata", () => {
      if (v.duration > 1.2) {
        sought = true;
        try {
          v.currentTime = Math.min(1.5, v.duration * 0.25);
          return;
        } catch {}
      }
    });
    v.addEventListener("loadeddata", () => {
      if (!sought) tryGrab();
    });
    v.addEventListener("seeked", tryGrab);
    v.addEventListener("error", () => finish(""));
    v.src = srcUrl;
  });
}

async function resolveHlsSegments(hlsUrl, referrer) {
  await ensurePreviewRules(hlsUrl, referrer);
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 5000);
  let text = "";
  try {
    const r = await fetch(hlsUrl, { credentials: "include", signal: ctl.signal });
    if (!r.ok) return null;
    text = (await r.text()).slice(0, 262144);
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
  if (!/^\s*#EXTM3U/i.test(text)) return null;
  const lines = text.split(/\r?\n/).map((l) => l.trim());
  if (/#EXT-X-STREAM-INF/i.test(text)) {
    const variants = [];
    for (let i = 0; i < lines.length; i++) {
      if (!/^#EXT-X-STREAM-INF:/i.test(lines[i])) continue;
      for (let j = i + 1; j < lines.length; j++) {
        if (lines[j] && !lines[j].startsWith("#")) {
          try {
            const u = new URL(lines[j], hlsUrl).toString();
            const res = /RESOLUTION=\d+x(\d+)/i.exec(lines[i]);
            variants.push({ url: u, h: res ? Number(res[1]) : 9999 });
          } catch {}
          break;
        }
      }
    }
    if (!variants.length) return null;
    variants.sort((a, b) => a.h - b.h);
    const pick = variants.find((v) => v.h >= 360) || variants[0];
    return resolveHlsSegments(pick.url, referrer);
  }
  let initSeg = "";
  const segs = [];
  for (const l of lines) {
    if (!l) continue;
    if (/^#EXT-X-MAP:/i.test(l)) {
      const m = /URI=["']([^"']+)["']/i.exec(l);
      if (m && m[1]) {
        try {
          initSeg = new URL(m[1], hlsUrl).toString();
        } catch {}
      }
      continue;
    }
    if (l.startsWith("#")) continue;
    try {
      const u = new URL(l, hlsUrl).toString();
      if (/^https?:/i.test(u) && !/\.m3u8(\?|$)/i.test(u)) segs.push(u);
    } catch {}
  }
  if (!segs.length) return null;
  const mid = segs[Math.floor(segs.length / 2)];
  const p1 = segs[Math.min(1, segs.length - 1)];
  const p3 = segs[Math.floor(segs.length * 0.75)];
  return { previewSegs: [...new Set([mid, p1, p3].filter(Boolean))], initSeg };
}

function scheduleFrameCapture(g, tab, onCaptured) {
  if (!g || !g.key) return;
  if (capturedPics.has(g.key)) {
    onCaptured(capturedPics.get(g.key));
    return;
  }
  if (capturePending.has(g.key)) return;
  capturePending.add(g.key);
  const referrer = (tab && tab.url) || "";
  captureQueue.push(async () => {
    try {
      const frames = [];
      // 1. HLS stream (.m3u8 or .ts / .m4s segments)
      if (g.previewSeg || (g.previewSegs && g.previewSegs.length) || g.hlsUrl) {
        let segs = g.previewSegs && g.previewSegs.length ? g.previewSegs : g.previewSeg ? [g.previewSeg] : [];
        let initSeg = g.initSeg || "";
        if (!segs.length && g.hlsUrl) {
          const info = await resolveHlsSegments(g.hlsUrl, referrer);
          if (info) {
            segs = info.previewSegs;
            initSeg = info.initSeg;
          }
        }
        let initBytes = null;
        if (initSeg) {
          await ensurePreviewRules(initSeg, referrer);
          initBytes = await fetchHeadBytes(initSeg, 262144);
        }
        for (const segUrl of segs.slice(0, 2)) {
          await ensurePreviewRules(segUrl, referrer);
          const u8 = await fetchHeadBytes(segUrl, 524288);
          if (!u8 || u8.length < 200) continue;
          let pic = await decodeTsSnapshot(u8);
          if (!pic) {
            const parts = initBytes ? [initBytes, u8] : [u8];
            const blob = new Blob(parts, { type: "video/mp4" });
            pic = await captureVideoUrlFrame(URL.createObjectURL(blob), true);
          }
          if (pic && !frames.includes(pic)) {
            frames.push(pic);
            if (frames.length === 1) {
              const firstRes = { thumb: pic, frames: [...frames] };
              capturedPics.set(g.key, firstRes);
              onCaptured(firstRes);
            }
          }
        }
      }
      // 2. Direct MP4 / WebM / YouTube stream
      if (!frames.length && g.clip) {
        await ensurePreviewRules(g.clip, referrer);
        let pic = "";
        const u8 = await fetchHeadBytes(g.clip, 1572864);
        if (u8 && u8.length > 1024) {
          const blob = new Blob([u8], { type: "video/mp4" });
          pic = await captureVideoUrlFrame(URL.createObjectURL(blob), true);
        }
        if (!pic) pic = await captureVideoUrlFrame(g.clip, false);
        if (pic) frames.push(pic);
      }
      if (frames.length) {
        const result = { thumb: frames[0], frames };
        capturedPics.set(g.key, result);
        onCaptured(result);
        if (typeof chrome !== "undefined" && chrome.runtime && tab && tab.id != null) {
          chrome.runtime.sendMessage(
            {
              type: "swiftget-save-pic",
              tabId: tab.id,
              family: g.key,
              metaId: g.metaId || "",
              url: g.hlsUrl || g.clip || "",
              name: g.name || "",
              thumb: result.thumb,
              frames: result.frames,
            },
            () => void chrome.runtime.lastError
          );
        }
      }
    } catch {} finally {
      capturePending.delete(g.key);
    }
  });
  runNextCapture();
}

// The small picture of a video; with the mouse on it a part of the video plays (a YouTube video:
// three pictures from it one after the other; a video file: a few seconds of it, silent)
function makeThumb(g, tab) {
  const box = document.createElement("div");
  box.className = "thumb";
  if (!g.thumb && g.key && capturedPics.has(g.key)) {
    const cached = capturedPics.get(g.key);
    g.thumb = cached.thumb;
    if (!g.frames && cached.frames && cached.frames.length) g.frames = cached.frames;
  }
  const applyPic = (res) => {
    if (!res || !res.thumb) return;
    g.thumb = res.thumb;
    if (res.frames && res.frames.length) g.frames = res.frames;
    box.textContent = "";
    box.style.backgroundImage = `url("${g.thumb.replace(/"/g, "%22")}")`;
  };
  if (g.thumb) {
    box.style.backgroundImage = `url("${g.thumb.replace(/"/g, "%22")}")`;
    if (/^https?:/i.test(g.thumb)) {
      const probe = new Image();
      probe.onerror = () => {
        g.thumb = "";
        box.style.backgroundImage = "";
        box.textContent = "▶";
        scheduleFrameCapture(g, tab, applyPic);
      };
      probe.src = g.thumb;
    }
  } else {
    box.textContent = "▶";
    scheduleFrameCapture(g, tab, applyPic);
  }
  let timer = null;
  let video = null;
  const stop = () => {
    clearInterval(timer);
    timer = null;
    if (video) {
      video.pause();
      video.remove();
      video = null;
    }
    if (g.thumb) box.style.backgroundImage = `url("${g.thumb.replace(/"/g, "%22")}")`;
  };
  box.addEventListener("mouseenter", () => {
    if (g.frames && g.frames.length) {
      let i = 0;
      timer = setInterval(() => {
        box.style.backgroundImage = `url("${g.frames[i++ % g.frames.length]}")`;
      }, 650);
      box.style.backgroundImage = `url("${g.frames[0]}")`;
      i = 1;
    } else if (g.clip) {
      chrome.runtime.sendMessage({ type: "swiftget-preview-rules", url: g.clip, referrer: tab.url }, () => {
        void chrome.runtime.lastError;
        if (!box.matches(":hover") || video) return;
        video = document.createElement("video");
        video.muted = true;
        video.playsInline = true;
        video.loop = true;
        video.src = g.clip;
        video.addEventListener("loadedmetadata", () => {
          if (video && video.duration > 6) video.currentTime = video.duration * 0.3;
          if (video) video.play().catch(() => {});
        });
        video.addEventListener("error", stop);
        box.appendChild(video);
      });
    }
  });
  box.addEventListener("mouseleave", stop);
  return box;
}

// Video and Audio apart: one entry per video (its qualities inside), one per sound file
function groupMedia(real, tab, pageName, pics = new Map()) {
  // --- video: one entry per video (the qualities of it inside), audio: one per sound file
  const videoGroups = new Map();
  const audios = [];
  for (const m of real) {
    if (isAudioItem(m)) {
      if (m.yt) {
        const g = videoGroups.get("yt:audio") || { yt: true, audio: true, opts: [], name: m.yt.title || pageName };
        g.opts.push(m);
        videoGroups.set("yt:audio", g);
      } else audios.push(m);
      continue;
    }
    const key = m.yt ? "yt:" + (m.yt.source || "") : m.resolve ? "resolve" : "s:" + (m.family || familyOf(m.url || ""));
    const g = videoGroups.get(key) || { key, yt: !!m.yt, opts: [], name: (m.yt && m.yt.title) || "" };
    g.opts.push(m);
    videoGroups.set(key, g);
  }
  const groups = [...videoGroups.values()];
  // "other qualities of this stream" only when nothing better is there
  const hasReal = groups.some((g) => !g.audio && g.opts.some((o) => !o.resolve));
  const videoList = groups.filter((g) => !g.audio && (hasReal ? g.opts.some((o) => !o.resolve) : true));
  const audioList = [...groups.filter((g) => g.audio), ...audios.map((m) => ({ file: m, opts: [m], name: fileTitle(m.url) }))];
  const cleanTabTitle = (t) =>
    String(t || "")
      .replace(/\s*[-|·—]\s*(YouTube|Artlist|Pexels|Pixabay|Storyblocks|Vimeo|Dailymotion|Shutterstock|Envato|Pond5).*$/i, "")
      .trim();
  videoList.forEach((g, i) => {
    g.opts = g.opts.filter((o) => !(hasReal && o.resolve));
    // the same quality twice: once
    const seen = new Set();
    g.opts = g.opts.filter((o) => {
      const k = o.yt ? o.yt.key || o.label : o.label;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
    // qualities with a size first (best on top); "Video" (no size known) after them
    g.opts.sort((a, b) => heightOfItem(b) - heightOfItem(a));
    if (g.opts.some((o) => heightOfItem(o)) && g.opts.length > 1) g.opts = g.opts.filter((o) => heightOfItem(o) || !/^video\b/i.test(o.label));
    if (!g.name) {
      const metaName = (g.opts.find((o) => o.name && !isCodeName(o.name)) || {}).name || "";
      const firstUrl = (g.opts[0] && g.opts[0].url) || "";
      const urlSlug = slugFromUrl(firstUrl);
      if (metaName) g.name = metaName;
      else if (videoList.length === 1) g.name = (tab && tab.title) || pageName || urlSlug || fileTitle(firstUrl);
      else if (urlSlug) g.name = urlSlug;
      else {
        const baseTitle = cleanTabTitle((tab && tab.title) || pageName);
        g.name = baseTitle && !/^video$/i.test(baseTitle) ? `${baseTitle} #${i + 1}` : fileTitle(firstUrl);
      }
    }
    g.metaId = (g.opts.find((o) => o.metaId) || {}).metaId || "";
    // its picture, and what plays when the mouse is on it
    const ytId = (u) => {
      const x = /[?&]v=([\w-]{11})|youtu\.be\/([\w-]{11})|\/(?:shorts|live|embed)\/([\w-]{11})/.exec(String(u || ""));
      return x ? x[1] || x[2] || x[3] : "";
    };
    const id = g.yt ? ytId(g.opts[0] && g.opts[0].yt && g.opts[0].yt.source) : "";
    const pic = (g.opts.map((o) => pics.get(o.metaId)).find((x) => x && (x.thumb || (x.frames && x.frames.length))) || {});
    g.thumb = id ? `https://i.ytimg.com/vi/${id}/mqdefault.jpg` : pic.thumb || (g.opts.find((o) => o.thumb) || {}).thumb || "";
    if (id) g.frames = [1, 2, 3].map((n) => `https://i.ytimg.com/vi/${id}/${n}.jpg`);
    const file = g.opts.find((o) => o.url && /^(mp4|webm|mov|m4v|ogv)$/i.test(o.ext || "") && !/\.m3u8(\?|$)/i.test(o.url));
    if (file) g.clip = file.url;
    else if (g.yt) {
      const ytVid = g.opts.find((o) => o.yt && o.yt.videoUrl && /^https?:/i.test(o.yt.videoUrl));
      if (ytVid) g.clip = ytVid.yt.videoUrl;
    }
    const hlsOpt = g.opts[g.opts.length - 1] || g.opts[0];
    if (hlsOpt && (/\.m3u8(\?|$)/i.test(hlsOpt.url || "") || hlsOpt.ext === "ts" || hlsOpt.previewSeg)) {
      g.hlsUrl = hlsOpt.url || "";
      g.previewSeg = (g.opts.find((o) => o.previewSeg) || {}).previewSeg || "";
      g.previewSegs = (g.opts.find((o) => o.previewSegs && o.previewSegs.length) || {}).previewSegs || (g.previewSeg ? [g.previewSeg] : []);
      g.initSeg = (g.opts.find((o) => o.initSeg) || {}).initSeg || "";
    }
    // pictures taken from the playing video (any site)
    const fr = pic.frames && pic.frames.length ? pic.frames : (g.opts.find((o) => o.frames && o.frames.length) || {}).frames;
    if (!g.frames && fr && fr.length) g.frames = fr;
    if (!g.thumb && g.frames) g.thumb = g.frames[0];
  });
  return { videoList, audioList };
}

function showMedia(tab, all, pics = new Map()) {
  const box = document.getElementById("media");
  const tabV = document.getElementById("tabVideo");
  const tabA = document.getElementById("tabAudio");
  const real = all.filter((m) => !m.disabled);
  const pageName = (tab.title || "video").replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_").slice(0, 120);

  const { videoList, audioList } = groupMedia(real, tab, pageName, pics);
  tabV.textContent = `Video (${videoList.length})`;
  tabA.textContent = `Audio (${audioList.length})`;

  const send = (item, fileBase, btn) => {
    btn.disabled = true;
    btn.textContent = "…";
    const finish = (r) => {
      btn.disabled = false;
      btn.textContent = r && r.ok ? "Sent ✔" : "App not running";
    };
    if (item.resolve) {
      // a stream: its qualities come from the program, shown in its place
      chrome.runtime.sendMessage({ type: "swiftget-resolve-video", resolve: item.resolve }, (res) => {
        if (!res || res.error || !res.items) {
          btn.disabled = false;
          btn.textContent = (res && res.error) || "App not running";
          return;
        }
        const row = btn.closest(".media");
        const rows = res.items.map((it) => {
          const r = document.createElement("div");
          r.className = "media";
          const inf = document.createElement("div");
          inf.textContent = it.label;
          const go = document.createElement("button");
          go.textContent = "Download";
          go.addEventListener("click", () => send(it, fileBase, go));
          r.append(inf, go);
          return r;
        });
        row.replaceWith(...rows);
      });
      return;
    }
    chrome.runtime.sendMessage(
      { type: "swiftget-download", item, title: fileBase, referrer: tab.url, fileName: `${fileBase}.${item.ext || (isAudioItem(item) ? "mp3" : "mp4")}` },
      finish
    );
  };

  const safe = (t) => String(t || "video").replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_").slice(0, 120);
  // one sound plays at a time (also across the list drawing itself again)
  const stopPlayer = () => {
    const p = showMedia.player;
    if (p) {
      p.audio.pause();
      p.btn.textContent = "▶";
      showMedia.player = null;
    }
  };
  const drawVideo = () => {
    box.replaceChildren();
    // a YouTube playlist: all of its videos in the program's playlist window
    if (/youtube\.com/i.test(tab.url || "") && /[?&]list=/.test(tab.url || "")) {
      const row = document.createElement("div");
      row.className = "media";
      const info = document.createElement("div");
      info.textContent = "All videos of this playlist";
      const btn = document.createElement("button");
      btn.className = "all";
      btn.textContent = "Download all";
      btn.addEventListener("click", () =>
        chrome.runtime.sendMessage({ type: "swiftget-playlist", url: tab.url }, (res) => {
          btn.textContent = res && res.ok ? "Opened ✔" : "App not running";
        })
      );
      row.append(info, btn);
      box.appendChild(row);
    }
    if (!videoList.length) {
      const e = document.createElement("div");
      e.className = "empty";
      e.textContent = "No video detected yet. Start playing the video.";
      box.appendChild(e);
      return;
    }
    videoList.forEach((g) => {
      const row = document.createElement("div");
      row.className = "media";
      const thumb = makeThumb(g, tab);
      const info = document.createElement("div");
      const nm = document.createElement("div");
      nm.className = "name";
      nm.textContent = g.name;
      nm.title = g.name;
      info.appendChild(nm);
      let sel = null;
      if (g.opts.length > 1) {
        sel = document.createElement("select");
        g.opts.forEach((o, i) => sel.add(new Option(o.label, String(i))));
        info.appendChild(sel);
      } else {
        const small = document.createElement("small");
        small.textContent = g.opts[0] ? g.opts[0].label : "";
        info.appendChild(small);
      }
      const btn = document.createElement("button");
      btn.textContent = "Download";
      btn.addEventListener("click", () => send(g.opts[sel ? Number(sel.value) : 0], safe(g.name), btn));
      row.append(thumb, info, btn);
      box.appendChild(row);
    });
  };
  const drawAudio = () => {
    box.replaceChildren();
    if (!audioList.length) {
      const e = document.createElement("div");
      e.className = "empty";
      e.textContent = "No sound detected yet. Play the sound on the page.";
      box.appendChild(e);
      return;
    }
    audioList.forEach((g) => {
      const row = document.createElement("div");
      row.className = "media";
      const play = document.createElement("button");
      play.className = "play";
      play.textContent = "▶";
      const m = g.file || null;
      const playable = !!(m && m.url && !/\.m3u8(\?|$)/i.test(m.url));
      if (!playable) {
        play.disabled = true;
        play.title = g.file ? "This sound comes as a stream: it can't be played before it is downloaded" : "Listen after it is downloaded";
      } else {
        play.title = "Listen before downloading";
        play.addEventListener("click", () => {
          if (showMedia.player && showMedia.player.btn === play) return stopPlayer();
          stopPlayer();
          // the site's own page is the Referer, as for the page's player
          chrome.runtime.sendMessage({ type: "swiftget-preview-rules", url: m.url, referrer: tab.url }, () => {
            const audio = new Audio(m.url);
            showMedia.player = { audio, btn: play };
            play.textContent = "…";
            audio.addEventListener("playing", () => (play.textContent = "❚❚"));
            audio.addEventListener("ended", stopPlayer);
            audio.addEventListener("error", () => {
              play.textContent = "✕";
              play.title = "The site did not give this sound for listening";
              showMedia.player = null;
            });
            audio.play().catch(() => {});
          });
        });
      }
      const info = document.createElement("div");
      const nm = document.createElement("div");
      nm.className = "name";
      nm.textContent = g.name;
      nm.title = g.name;
      const small = document.createElement("small");
      small.textContent = g.file ? [g.file.ext && g.file.ext.toUpperCase(), fmtSize(g.file.size)].filter(Boolean).join(" · ") : g.opts.map((o) => o.label).join(" · ");
      info.append(nm, small);
      const btn = document.createElement("button");
      btn.textContent = "Download";
      btn.addEventListener("click", () => send(g.opts[0], safe(g.name), btn));
      row.append(play, info, btn);
      box.appendChild(row);
    });
  };
  const show = (which) => {
    stopPlayer();
    tabV.classList.toggle("on", which === "video");
    tabA.classList.toggle("on", which === "audio");
    if (which === "video") drawVideo();
    else drawAudio();
  };
  tabV.onclick = () => ((showMedia.which = "video"), show("video"));
  tabA.onclick = () => ((showMedia.which = "audio"), show("audio"));
  const first = !showMedia.which;
  if (first || (showMedia.which === "video" && !videoList.length && audioList.length)) showMedia.which = !videoList.length && audioList.length ? "audio" : "video";
  show(showMedia.which);
}

init();
