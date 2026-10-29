/* ============================================================
   AVA Fleet — driver app  (v4.0)
   Offline-first: everything is written to IndexedDB first, then
   uploaded in the background by sync.js (and by the service worker
   if the phone regains signal while the app is closed).
   ============================================================ */
(function () {
  "use strict";

  const VERSION = "4.2.0";
  const $ = id => document.getElementById(id);
  const CFG = (window.AVA_CONFIG || {});
  const KEY = { token: "ava_token", me: "ava_me", dev: "ava_dev", last: "ava_last" };

  const state = {
    me: null,
    token: "",
    apiUrl: "",
    records: [],       // from the server (cache) — this month + last month only
    month: "cur",      // "cur" = this month, "prev" = last month
    curMonth: "",      // "2026-10"
    prevMonth: "",     // "2026-09"
    queue: [],         // waiting to upload
    counts: { checkin: 0, expense: 0, trip: 0, pending: 0 },
    filter: "all",
    photo: { ci: null, ex: null },
    photoTarget: null,
    syncing: false,
    lastError: "",
    online: navigator.onLine
  };

  /* ---------------------------- tiny utils ---------------------------- */
  const esc = s => String(s == null ? "" : s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  let toastT = null;
  function toast(msg, ms) {
    const t = $("toast");
    t.textContent = msg;
    t.classList.add("show");
    clearTimeout(toastT);
    toastT = setTimeout(() => t.classList.remove("show"), ms || 3000);
  }
  const pad = n => String(n).padStart(2, "0");
  function localDate(d) {
    d = d || new Date();
    return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate());
  }
  const normPhone = s => String(s || "").replace(/\D/g, "");
  const phoneKey = s => { const d = normPhone(s); return d.length > 9 ? d.slice(-9) : d; };
  function uid() {
    if (window.crypto && crypto.randomUUID) return "R" + crypto.randomUUID().replace(/-/g, "").slice(0, 22);
    const rnd = () => Math.random().toString(36).slice(2, 10);
    return "R" + Date.now().toString(36) + rnd() + rnd();
  }
  async function sha256(s) {
    const b = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
    return Array.from(new Uint8Array(b)).map(x => x.toString(16).padStart(2, "0")).join("");
  }
  function deviceName() {
    let d = localStorage.getItem(KEY.dev);
    if (d) return d;
    const ua = navigator.userAgent;
    const m = /Android[^;)]*;\s*([^;)]+?)(?:\s+Build|\))/.exec(ua);
    d = m ? "Android " + m[1].trim() : /iPhone/.test(ua) ? "iPhone" : /iPad/.test(ua) ? "iPad" : "Phone";
    d = d.slice(0, 40);
    localStorage.setItem(KEY.dev, d);
    return d;
  }
  function fmt(iso, withTime) {
    const d = new Date(iso);
    if (isNaN(d)) return "";
    const opts = withTime === false
      ? { day: "2-digit", month: "short" }
      : { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" };
    return d.toLocaleString("en-GB", opts);
  }
  const isConfigured = () => /^https:\/\/script\.google\.com\/.+\/exec$/.test(state.apiUrl);

  /* ---------------------------- boot ---------------------------- */
  async function boot() {
    // The backend is fixed by the office in config.js. A driver can never change it.
    state.apiUrl = String(CFG.API_URL || "").trim();
    if (state.apiUrl.indexOf("PASTE_") === 0) state.apiUrl = "";
    state.token = localStorage.getItem(KEY.token) || "";
    try { state.me = JSON.parse(localStorage.getItem(KEY.me) || "null"); } catch (e) { state.me = null; }
    $("loginPhone").value = localStorage.getItem("ava_phone") || "";

    await loadLocal();
    paint();

    if (state.me && state.token) enterApp();
    else {
      $("loginView").classList.remove("hidden");
      if (!isConfigured()) { // never a server-entry screen: the office owns the URL
        $("loginBtn").disabled = true;
        $("loginMsg").textContent = "This app is not connected yet — please contact the office.";
      }
    }

    // mirror what the service worker needs
    AVA_DB.metaSet("apiUrl", state.apiUrl);
    if (state.token) AVA_DB.metaSet("token", state.token);

    registerSW();
    if (state.me && state.token) {
      flush();      // upload anything left from last time
      refresh();    // then pull the latest from the server
    }
  }

  async function loadLocal() {
    try {
      state.queue = (await AVA_DB.all("queue")).sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
      state.records = await AVA_DB.all("records");
    } catch (e) {
      state.queue = []; state.records = [];
      toast("Local storage is blocked — use a normal browser, not private mode", 6000);
    }
  }

  function enterApp() {
    const d = state.me;
    $("loginView").classList.add("hidden");
    $("appView").classList.remove("hidden");
    $("drvName").textContent = String(d.name || "").toUpperCase();
    $("ciBus").value = d.bus || "";
    $("exBus").value = d.bus || "";
    $("trDate").value = localDate();
    paint();
  }

  /* ---------------------------- network state ---------------------------- */
  function netUI() {
    state.online = navigator.onLine;
    document.body.classList.toggle("offline", !state.online);
    const p = $("syncPill");
    if (!state.me) { p.textContent = "Not signed in"; p.className = ""; return; }
    const waiting = state.queue.filter(q => !q.permanent).length;
    const stuck = state.queue.filter(q => q.permanent).length;
    if (stuck) { p.textContent = stuck + " need attention"; p.className = "bad"; }
    else if (waiting && !state.online) { p.textContent = waiting + " saved offline"; p.className = "warn"; }
    else if (waiting) { p.textContent = state.syncing ? "Uploading…" : waiting + " to upload"; p.className = "warn"; }
    else if (state.syncing) { p.textContent = "Syncing…"; p.className = ""; }
    else { p.textContent = "✓ Synced"; p.className = "ok"; }
  }
  window.addEventListener("online", () => { netUI(); flush(); refresh(); });
  window.addEventListener("offline", netUI);
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden && state.me) { flush(); refresh(); }
  });
  setInterval(() => { if (state.me && navigator.onLine) flush(); }, 60000);
  setInterval(netUI, 15000);

  /* ---------------------------- API ---------------------------- */
  async function api(action, payload, timeout) {
    if (!isConfigured()) throw new Error("The app is not connected yet — please contact the office.");
    return AVA_SYNC.post(state.apiUrl, Object.assign({ action, token: state.token }, payload || {}), timeout || 60000);
  }

  /* ---------------------------- sync ---------------------------- */
  async function flush() {
    if (!state.me || !state.token || !navigator.onLine || state.syncing) return;
    if (!state.queue.length) { netUI(); return; }
    state.syncing = true;
    netUI();
    try {
      await AVA_DB.metaSet("apiUrl", state.apiUrl);
      await AVA_DB.metaSet("token", state.token);
      const res = await AVA_SYNC.flush({ apiUrl: state.apiUrl, token: state.token });
      if (res.auth) { sessionExpired(); return; }
      if (res.sent) {
        localStorage.setItem(KEY.last, new Date().toISOString());
        await AVA_DB.metaSet("lastSync", new Date().toISOString());
      }
      await loadLocal();
      if (res.offline) state.lastError = "No connection";
      if (res.errors.length) state.lastError = res.errors[0].error;
    } catch (e) {
      state.lastError = e.message || "Upload failed";
    } finally {
      state.syncing = false;
    }
    paint();
    if (!state.queue.some(q => !q.permanent)) refresh();
  }

  function askBackgroundSync() {
    if (!("serviceWorker" in navigator) || !("SyncManager" in window)) return;
    navigator.serviceWorker.ready
      .then(r => r.sync.register("ava-upload"))
      .catch(() => {});
  }

  async function refresh() {
    if (!state.me || !state.token || !navigator.onLine || !isConfigured()) return;
    if (document.hidden) return;
    try {
      const r = await api("myData", {}, 60000);
      if (r.code === "AUTH" || /sign in again/i.test(r.error || "") && !r.ok) { sessionExpired(); return; }
      if (!r.ok) return;
      if (r.driver && r.driver.name) {
        state.me = Object.assign({}, state.me, r.driver);
        localStorage.setItem(KEY.me, JSON.stringify(state.me));
        $("drvName").textContent = String(state.me.name || "").toUpperCase();
      }
      state.records = (r.records || []);
      state.counts = r.counts || state.counts;
      if (r.curMonth) state.curMonth = r.curMonth;
      if (r.prevMonth) state.prevMonth = r.prevMonth;
      localStorage.setItem(KEY.last, new Date().toISOString());
      await AVA_DB.clear("records");
      await AVA_DB.putMany("records", state.records);
      paint();
    } catch (e) { /* offline or busy: keep what we have */ }
  }

  function sessionExpired() {
    localStorage.removeItem(KEY.token);
    state.token = "";
    AVA_DB.metaSet("token", "");
    toast("Session expired — please sign in again", 4000);
    setTimeout(() => { $("appView").classList.add("hidden"); $("loginView").classList.remove("hidden"); netUI(); }, 1200);
  }

  /* ---------------------------- login ---------------------------- */
  $("loginBtn").addEventListener("click", async () => {
    const phone = normPhone($("loginPhone").value);
    const pin = $("loginPin").value.trim();
    const msg = $("loginMsg");
    if (!phone || !pin) { msg.textContent = "Enter your phone number and PIN."; return; }

    if (!navigator.onLine) {
      // Offline sign-in: allowed only if this exact phone+PIN was used here before.
      let ok = false;
      try {
        const cached = await AVA_DB.metaGet("pinHash", "");
        ok = !!(state.me && phoneKey(state.me.phone) === phoneKey(phone) &&
          cached && cached === (await sha256(phoneKey(phone) + "|" + pin)) && localStorage.getItem(KEY.token));
      } catch (e) {}
      if (ok) { enterApp(); toast("Signed in offline — entries upload when you're back online"); }
      else msg.textContent = "No internet. Signing in for the first time needs a connection.";
      return;
    }

    $("loginBtn").disabled = true;
    msg.innerHTML = '<span class="spin"></span>Signing in…';
    try {
      const r = await api("login", { phone, pin }, 45000);
      if (!r.ok) throw new Error(r.error || "Sign in failed");
      state.token = r.token;
      state.me = r.driver;
      localStorage.setItem(KEY.token, r.token);
      localStorage.setItem(KEY.me, JSON.stringify(r.driver));
      localStorage.setItem("ava_phone", phone);
      localStorage.setItem("ava_pin", await sha256(phoneKey(phone) + "|" + pin));
      await AVA_DB.metaSet("pinHash", await sha256(phoneKey(phone) + "|" + pin));
      await AVA_DB.metaSet("token", r.token);
      await AVA_DB.metaSet("apiUrl", state.apiUrl);
      $("loginPin").value = "";
      msg.textContent = "";
      enterApp();
      flush();
      refresh();
    } catch (e) {
      msg.textContent = e.message === "timeout" ? "No answer from the office server. Try again."
        : e.message === "bad-json" ? "The service is not ready — please tell the office."
          : (e.message === "Failed to fetch" ? "No internet. Check your connection and try again." : e.message);
    }
    $("loginBtn").disabled = false;
  });
  $("loginPin").addEventListener("keydown", e => { if (e.key === "Enter") $("loginBtn").click(); });
  // No "change server" link on the driver side — the backend comes from config.js only.

  /* ---------------------------- sheets ---------------------------- */
  function openSheet(name) {
    if (name === "trip" && !$("trDate").value) $("trDate").value = localDate();
    $("sheet-" + name).classList.add("open");
  }
  function closeSheets() { document.querySelectorAll(".sheet").forEach(s => s.classList.remove("open")); }
  document.querySelectorAll(".sheet").forEach(s => s.addEventListener("click", e => { if (e.target === s) closeSheets(); }));
  document.querySelectorAll("[data-close]").forEach(b => b.addEventListener("click", closeSheets));
  $("btnCheckin").addEventListener("click", () => openSheet("checkin"));
  $("btnExpense").addEventListener("click", () => openSheet("expense"));
  $("btnTrip").addEventListener("click", () => openSheet("trip"));

  $("exTypes").addEventListener("click", e => {
    const b = e.target.closest("button[data-v]");
    if (!b) return;
    document.querySelectorAll("#exTypes button").forEach(x => x.classList.remove("on"));
    b.classList.add("on");
  });
  ["exVol", "exPrice"].forEach(id => $(id).addEventListener("input", () => {
    const v = parseFloat(($("exVol").value || "").replace(",", "."));
    const p = parseFloat(($("exPrice").value || "").replace(",", "."));
    if (v > 0 && p > 0) $("exAmt").value = (Math.round(v * p * 100) / 100).toFixed(2);
  }));

  /* ---------------------------- photo ---------------------------- */
  $("ciPhotoBtn").addEventListener("click", () => takePhoto("ci"));
  $("exPhotoBtn").addEventListener("click", () => takePhoto("ex"));
  function takePhoto(t) { state.photoTarget = t; $("camInput").click(); }

  $("camInput").addEventListener("change", e => {
    const f = e.target.files && e.target.files[0];
    e.target.value = "";
    if (!f) return;
    stampPhoto(f, state.photoTarget);
  });

  function getPosition(ms) {
    return new Promise(resolve => {
      if (!navigator.geolocation) return resolve(null);
      let done = false;
      const t = setTimeout(() => { if (!done) { done = true; resolve(null); } }, ms || 8000);
      navigator.geolocation.getCurrentPosition(
        p => { if (!done) { done = true; clearTimeout(t); resolve({ lat: p.coords.latitude, lng: p.coords.longitude, acc: Math.round(p.coords.accuracy || 0) }); } },
        () => { if (!done) { done = true; clearTimeout(t); resolve(null); } },
        { enableHighAccuracy: true, timeout: ms || 8000, maximumAge: 20000 }
      );
    });
  }

  function stampPhoto(file, target) {
    toast("Adding time, driver and GPS to the photo…", 2500);
    Promise.all([getPosition(8000), new Promise((res) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => { URL.revokeObjectURL(url); res(img); };
      img.onerror = () => { URL.revokeObjectURL(url); res(null); };
      img.src = url;
    })]).then(([pos, img]) => {
      if (!img) return toast("That file is not a photo — try again");
      const now = new Date();
      const MAX = 1280;
      const scale = Math.min(1, MAX / Math.max(img.width, img.height));
      const w = Math.round(img.width * scale), h = Math.round(img.height * scale);
      const c = document.createElement("canvas");
      c.width = w; c.height = h;
      const ctx = c.getContext("2d");
      ctx.drawImage(img, 0, 0, w, h);

      const barH = Math.max(64, Math.round(h * 0.115));
      ctx.fillStyle = "rgba(0,0,0,0.66)";
      ctx.fillRect(0, h - barH, w, barH);
      ctx.fillStyle = "#fff";
      const f1 = Math.max(15, Math.round(barH * 0.26));
      ctx.font = "bold " + f1 + "px Arial, sans-serif";
      ctx.fillText(now.toLocaleDateString("en-GB") + "  " + now.toLocaleTimeString("en-GB", { hour12: false }), 12, h - barH + f1 + 6);
      const f2 = Math.max(12, Math.round(barH * 0.20));
      ctx.font = f2 + "px Arial, sans-serif";
      ctx.fillText((state.me ? state.me.name : "") + "  •  BUS " + (($(target === "ci" ? "ciBus" : "exBus").value) || (state.me && state.me.bus) || ""), 12, h - barH + f1 + f2 + 14);
      const f3 = Math.max(11, Math.round(barH * 0.18));
      ctx.font = f3 + "px Arial, sans-serif";
      ctx.fillText(pos ? "GPS " + pos.lat.toFixed(5) + ", " + pos.lng.toFixed(5) + (pos.acc ? "  ±" + pos.acc + "m" : "") : "GPS not available", 12, h - 10);

      // shrink until it fits comfortably under the server limit
      let q = 0.72, dataUrl = c.toDataURL("image/jpeg", q);
      while (dataUrl.length > 1.6 * 1024 * 1024 && q > 0.35) {
        q -= 0.12;
        dataUrl = c.toDataURL("image/jpeg", q);
      }
      state.photo[target] = { dataUrl: dataUrl, meta: { lat: pos ? pos.lat : null, lng: pos ? pos.lng : null, accuracy: pos ? pos.acc : null, time: now.toISOString() } };
      const pv = $(target + "Preview");
      pv.innerHTML = "";
      const im = document.createElement("img");
      im.src = dataUrl;
      pv.appendChild(im);
      toast(pos ? "Photo ready ✓" : "Photo ready — no GPS signal", 2200);
    });
  }

  /* ---------------------------- submissions ---------------------------- */
  function basePayload(kind, bus) {
    return {
      id: uid(),
      kind: kind,
      bus: bus || (state.me && state.me.bus) || "",
      createdAt: new Date().toISOString(),
      device: deviceName()
    };
  }

  /** Writes to IndexedDB FIRST. Once this resolves the record cannot be lost. */
  async function enqueue(payload, photo) {
    const item = {
      id: payload.id,
      createdAt: payload.createdAt,
      kind: payload.kind,
      payload: payload,
      hasPhoto: !!photo,
      tries: 0,
      permanent: false,
      lastError: ""
    };
    try {
      if (photo) await AVA_DB.put("photos", photo.dataUrl, payload.id);
      await AVA_DB.put("queue", item);
    } catch (e) {
      toast("Could not save on this phone — free some storage and try again", 5000);
      return false;
    }
    state.queue.push(item);
    paint();
    askBackgroundSync();
    if (navigator.onLine) flush();
    else toast("Saved offline ✓ — uploads automatically", 3200);
    return true;
  }

  const PH_CI = '<div class="pc">📷</div><b>Take the ODO photo</b><div class="mut">Time &amp; location are printed on it</div>';
  const PH_EX = '<div class="pc">🧾</div><b>Add the receipt</b><div class="mut">Time &amp; location are printed on it</div>';

  $("ciSubmit").addEventListener("click", async () => {
    const bus = $("ciBus").value.trim();
    const odo = $("ciOdo").value.trim();
    if (!bus) return toast("Enter the bus number");
    if (!/^\d{1,7}$/.test(odo)) return toast("Enter the ODO reading (numbers only)");
    if (!state.photo.ci) return toast("The ODO photo is required");

    const last = state.records
      .filter(r => r.kind === "checkin" && r.bus === bus && r.odo !== "" && r.status !== "Rejected")
      .map(r => Number(r.odo)).filter(v => isFinite(v));
    if (last.length) {
      const max = Math.max.apply(null, last);
      if (Number(odo) < max && !confirm("ODO " + odo + " is lower than your last reading (" + max + "). Save anyway?")) return;
    }

    const p = basePayload("checkin", bus);
    p.odo = odo;
    p.meta = state.photo.ci.meta;
    $("ciSubmit").disabled = true;
    const ok = await enqueue(p, state.photo.ci);
    $("ciSubmit").disabled = false;
    if (!ok) return;
    $("ciOdo").value = "";
    state.photo.ci = null;
    $("ciPreview").innerHTML = PH_CI;
    closeSheets();
  });

  $("exSubmit").addEventListener("click", async () => {
    const onBtn = document.querySelector("#exTypes button.on");
    const type = onBtn ? onBtn.dataset.v : "Other";
    const num = id => ($(id).value || "").trim().replace(",", ".");
    const amt = num("exAmt"), vol = num("exVol"), price = num("exPrice"), odo = $("exOdo").value.trim();
    if (!/^\d+(\.\d{1,2})?$/.test(amt) || !(parseFloat(amt) > 0)) return toast("Enter the total amount, e.g. 228.00");
    if (odo && !/^\d{1,7}$/.test(odo)) return toast("ODO must be numbers only");
    if (vol && !/^\d+(\.\d+)?$/.test(vol)) return toast("Litres must be a number");
    if (price && !/^\d+(\.\d+)?$/.test(price)) return toast("Unit price must be a number");

    const p = basePayload("expense", $("exBus").value.trim());
    p.expType = type;
    p.odo = odo; p.volume = vol; p.unitPrice = price; p.amount = amt;
    p.details = $("exDet").value.trim();
    if (state.photo.ex) p.meta = state.photo.ex.meta;

    $("exSubmit").disabled = true;
    const ok = await enqueue(p, state.photo.ex);
    $("exSubmit").disabled = false;
    if (!ok) return;
    ["exOdo", "exVol", "exPrice", "exAmt", "exDet"].forEach(id => ($(id).value = ""));
    state.photo.ex = null;
    $("exPreview").innerHTML = PH_EX;
    closeSheets();
  });

  $("trSubmit").addEventListener("click", async () => {
    const route = $("trRoute").value.trim();
    if (!route) return toast("Enter the route");
    if (!$("trDate").value) return toast("Choose the date");
    const p = basePayload("trip");
    p.date = $("trDate").value;
    p.route = route;
    p.time = $("trTime").value;
    p.details = $("trDet").value.trim();
    if ($("trCount").value.trim()) p.details = (p.details ? p.details + " · " : "") + $("trCount").value.trim() + " trips";
    $("trSubmit").disabled = true;
    const ok = await enqueue(p, null);
    $("trSubmit").disabled = false;
    if (!ok) return;
    $("trRoute").value = ""; $("trTime").value = ""; $("trDet").value = ""; $("trCount").value = "";
    closeSheets();
  });

  /* ---------------------------- rendering ---------------------------- */
  function monthLabel(key) {
    const y = Number(String(key).slice(0, 4)), m = Number(String(key).slice(5, 7));
    if (!y || !m) return key;
    return new Date(y, m - 1, 1).toLocaleDateString("en-GB", { month: "long", year: "numeric" });
  }
  function recMonth(r) {
    if (r.month) return r.month;
    const d = new Date(r.date || r.createdAt);
    if (isNaN(d)) return "";
    return d.getFullYear() + "-" + pad(d.getMonth() + 1);
  }
  /** Only the month selected in the "This month / Last month" tabs. */
  function mergedList() {
    const want = state.month === "prev" ? state.prevMonth : state.curMonth;
    const keep = r => !want || recMonth(r) === want;
    const queued = state.queue
      .map(q => Object.assign({}, q.payload, { _queued: true, _err: q.permanent ? (q.lastError || "Not accepted") : "", _tries: q.tries }))
      .filter(keep);
    const seen = {};
    queued.forEach(q => (seen[q.id] = true));
    const server = state.records.filter(r => !seen[r.id]).map(r => Object.assign({}, r, { _queued: false })).filter(keep);
    return queued.concat(server).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  }

  function statusBadge(r) {
    if (r._queued && r._err) return '<span class="b b-bad">⚠ Not sent</span>';
    if (r._queued) return '<span class="b b-q">⏳ Waiting to upload</span>';
    if (r.status === "Approved") return '<span class="b b-ok">Approved</span>';
    if (r.status === "Rejected") return '<span class="b b-bad">Rejected</span>';
    return '<span class="b b-pend">Pending</span>';
  }
  function rowTitle(r) {
    if (r.kind === "checkin") return "Check-in · " + esc(r.bus || "") + " · ODO " + esc(r.odo);
    if (r.kind === "expense") return esc(r.expType || "Expense") + " · AED " + esc(r.amount);
    return esc(r.route || "Extra trip");
  }
  function rowIcon(r) {
    if (r.kind === "checkin") return "📷";
    if (r.kind === "expense") return "🧾";
    return "🗺️";
  }

  function paint() {
    netUI();
    if (!state.me) return;
    // Month tabs are labelled from the server keys ("2026-10" -> "October 2026").
    const curB = document.querySelector('#mtabs button[data-m="cur"]');
    const prevB = document.querySelector('#mtabs button[data-m="prev"]');
    if (curB && state.curMonth) curB.textContent = monthLabel(state.curMonth);
    if (prevB && state.prevMonth) prevB.textContent = monthLabel(state.prevMonth);

    const mine = mergedList();
    const k3 = k => mine.filter(r => r.kind === k).length;
    $("cCheck").textContent = k3("checkin");
    $("cExp").textContent = k3("expense");
    $("cTrip").textContent = k3("trip");
    $("cPend").textContent = mine.filter(r => (r._queued ? !r._err : r.status === "Pending")).length;

    const all = mergedList();
    const list = state.filter === "all" ? all
      : state.filter === "unsent" ? all.filter(r => r._queued)
        : all.filter(r => r.kind === state.filter);
    $("activityCount").textContent = all.length ? "(" + all.length + ")" : "";
    const el = $("activity");
    if (!list.length) {
      el.innerHTML = '<p class="small center" style="padding:18px 0">' +
        (state.filter === "all" ? "Nothing yet. Use the buttons above to add your first entry." : "Nothing here yet.") + '</p>';
      return;
    }
    el.innerHTML = list.slice(0, 120).map(r => {
      const thumb = r.photoThumb ? '<img src="' + esc(r.photoThumb) + '" loading="lazy" alt="">' : rowIcon(r);
      const right = r.kind === "expense" ? '<div class="amt">AED ' + esc(r.amount) + '</div>' : "";
      return '<div class="rec" data-open="' + esc(r.id) + '"><div class="thumb">' + thumb + '</div>' +
        '<div class="body"><b>' + rowTitle(r) + '</b>' +
        '<small>' + fmt(r.createdAt) + ' ' + statusBadge(r) + '</small></div>' + right + '</div>';
    }).join("");
  }

  $("mtabs").addEventListener("click", e => {
    const b = e.target.closest("button[data-m]");
    if (!b) return;
    document.querySelectorAll("#mtabs button").forEach(x => x.classList.remove("on"));
    b.classList.add("on");
    state.month = b.getAttribute("data-m");
    paint();
  });

  $("activity").addEventListener("click", e => {
    const card = e.target.closest("[data-open]");
    if (!card) return;
    showDetail(card.getAttribute("data-open"));
  });
  /* A record the server refused can still be retried or removed, from its detail sheet. */
  async function retryQueued(id) {
    const q = state.queue.find(x => x.id === id);
    if (!q) return;
    q.permanent = false; q.tries = 0; q.nextTryAt = 0; q.lastError = "";
    await AVA_DB.put("queue", q);
    closeSheets(); await loadLocal(); paint(); flush();
  }
  async function dropQueued(id) {
    if (!confirm("Delete this unsent record from the phone? It will not be sent.")) return;
    await AVA_DB.del("queue", id);
    await AVA_DB.del("photos", id);
    closeSheets(); await loadLocal(); paint();
  }
  document.addEventListener("click", e => {
    const r = e.target.closest("[data-retry]"), d = e.target.closest("[data-drop]");
    if (r) return retryQueued(r.getAttribute("data-retry"));
    if (d) return dropQueued(d.getAttribute("data-drop"));
  });

  async function showDetail(id) {
    const r = mergedList().find(x => x.id === id);
    if (!r) return;
    $("dTitle").textContent = r.kind === "checkin" ? "📷 Check-in" : r.kind === "expense" ? "🧾 Expense" : "🗺️ Extra trip";
    $("dStatus").innerHTML = statusBadge(r) + (r.flags ? ' <span class="b b-off">' + esc(String(r.flags).replace(/,/g, " · ")) + '</span>' : "");
    const rows = [];
    const add = (k, v) => { if (v !== "" && v !== undefined && v !== null) rows.push("<dt>" + k + "</dt><dd>" + esc(v) + "</dd>"); };
    add("BUS", r.bus);
    add("WHEN", r.createdAt ? fmt(r.createdAt) : "");
    if (r.kind === "checkin") add("ODO", r.odo + " km");
    if (r.kind === "expense") {
      add("TYPE", r.expType);
      add("AMOUNT", "AED " + r.amount);
      if (r.volume) add("LITRES", r.volume);
      if (r.unitPrice) add("UNIT PRICE", "AED " + r.unitPrice);
      if (r.odo) add("ODO", r.odo + " km");
    }
    if (r.kind === "trip") {
      add("TRIP DATE", r.date);
      add("ROUTE", r.route);
      add("TIME", r.time);
    }
    add("DETAILS", r.details);
    if (r.lat && r.lng) add("GPS", Number(r.lat).toFixed(5) + ", " + Number(r.lng).toFixed(5) + (r.accuracy ? " ±" + r.accuracy + "m" : ""));
    if (!r._queued) {
      add("STATUS", r.status);
      if (r.decidedAt) add("DECIDED", fmt(r.decidedAt));
      if (r.adminNote) add("OFFICE NOTE", r.adminNote);
    }
    if (r._queued && r._err) add("PROBLEM", r._err);
    $("dBody").innerHTML = rows.join("") || '<dt>—</dt><dd>No details</dd>';

    const oldActs = $("dActs");
    if (oldActs) oldActs.remove();
    if (r._queued) {
      $("dBody").insertAdjacentHTML("afterend", '<div id="dActs" style="display:flex;gap:9px;margin-top:16px">' +
        (r._err ? '<button class="cta" data-retry="' + esc(r.id) + '" style="margin:0;font-size:14px">Try again</button>' : "") +
        '<button class="cta ghost" data-drop="' + esc(r.id) + '" style="margin:0;font-size:14px">Delete from phone</button></div>');
    }
    const wrap = $("dPhotoWrap");
    wrap.innerHTML = "";
    if (r._queued) {
      try {
        const p = await AVA_DB.get("photos", r.id);
        if (p) wrap.innerHTML = '<img class="dphoto" src="' + p + '" alt="Photo">';
      } catch (e) {}
    } else if (r.photoUrl) {
      wrap.innerHTML = '<img class="dphoto" src="' + esc(r.photoUrl) + '" alt="Photo">' +
        (r.photoView ? '<p class="center" style="margin-top:8px"><a href="' + esc(r.photoView) + '" target="_blank" rel="noopener" style="color:#0369a1;font-size:13px">Open full size in Drive ↗</a></p>' : "");
    }
    openSheet("detail");
  }

  /* ---------------------------- toolbar ---------------------------- */
  $("ftabs").addEventListener("click", e => {
    const b = e.target.closest("button[data-f]");
    if (!b) return;
    document.querySelectorAll("#ftabs button").forEach(x => x.classList.remove("on"));
    b.classList.add("on");
    state.filter = b.getAttribute("data-f");
    paint();
  });

  $("btnLogout").addEventListener("click", async e => {
    e.preventDefault();
    const waiting = state.queue.filter(q => !q.permanent).length;
    if (waiting && !confirm(waiting + " entr(y/ies) have not uploaded yet. They stay on this phone. Sign out anyway?")) return;
    localStorage.removeItem(KEY.token);
    localStorage.removeItem(KEY.me);
    localStorage.removeItem("ava_pin");
    state.token = ""; state.me = null;
    await AVA_DB.metaSet("token", "");
    await AVA_DB.metaSet("pinHash", ""); // also kills the offline re-login shortcut
    location.reload();
  });

  /* ---------------------------- service worker ---------------------------- */
  let deferredInstall = null;
  function registerSW() {
    if (!("serviceWorker" in navigator)) return;
    const hadController = !!navigator.serviceWorker.controller;
    navigator.serviceWorker.addEventListener("controllerchange", () => {
      if (hadController) $("updateBar").classList.remove("hidden");
    });
    navigator.serviceWorker.addEventListener("message", ev => {
      if (ev.data && ev.data.type === "SYNCED") { loadLocal().then(paint); refresh(); }
    });
    navigator.serviceWorker.register("sw.js").catch(() => {});
  }
  $("updateBtn").addEventListener("click", () => location.reload());

  function renderInstall() {
    const bar = $("installBar");
    if (!bar) return;
    const standalone = window.matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;
    if (standalone) { bar.classList.add("hidden"); return; }
    if (deferredInstall) {
      $("installTxt").textContent = "Install AVA Fleet on this phone";
      $("installBtn").classList.remove("hidden");
      bar.classList.remove("hidden");
    } else if (/iPhone|iPad|iPod/.test(navigator.userAgent)) {
      $("installTxt").textContent = "To install: tap Share → “Add to Home Screen”";
      $("installBtn").classList.add("hidden");
      bar.classList.remove("hidden");
    } else bar.classList.add("hidden");
  }
  window.addEventListener("beforeinstallprompt", e => { e.preventDefault(); deferredInstall = e; renderInstall(); });
  window.addEventListener("appinstalled", () => { deferredInstall = null; renderInstall(); });
  $("installBtn").addEventListener("click", async () => {
    if (!deferredInstall) return;
    deferredInstall.prompt();
    try { await deferredInstall.userChoice; } catch (e) {}
    deferredInstall = null;
    renderInstall();
  });

  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
  renderInstall();
  boot();
})();
