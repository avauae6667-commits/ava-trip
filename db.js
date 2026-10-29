/* ============================================================
   AVA Fleet — local database (IndexedDB)
   Used by the driver page AND by the service worker, so it must
   never touch `window`, `document` or `localStorage`.
   Stores:
     queue   : records waiting to be uploaded  (keyPath id)
     photos  : the JPEG data URL for a record  (out-of-line key = record id)
     records : a cache of the driver's records from the server (keyPath id)
     meta    : small key/value (token, apiUrl, lastSync ...)
   ============================================================ */
(function (g) {
  "use strict";
  var NAME = "ava_fleet", VER = 3, dbp = null;

  function open() {
    if (dbp) return dbp;
    dbp = new Promise(function (res, rej) {
      if (!g.indexedDB) return rej(new Error("no-indexeddb"));
      var rq = g.indexedDB.open(NAME, VER);
      rq.onupgradeneeded = function () {
        var db = rq.result;
        if (!db.objectStoreNames.contains("queue")) db.createObjectStore("queue", { keyPath: "id" });
        if (!db.objectStoreNames.contains("photos")) db.createObjectStore("photos");
        if (!db.objectStoreNames.contains("records")) db.createObjectStore("records", { keyPath: "id" });
        if (!db.objectStoreNames.contains("meta")) db.createObjectStore("meta");
      };
      rq.onsuccess = function () { res(rq.result); };
      rq.onerror = function () { rej(rq.error || new Error("idb-open")); };
      rq.onblocked = function () { rej(new Error("idb-blocked")); };
    });
    return dbp;
  }

  /** run(storeName, mode, fn) — fn gets the object store and a setResult callback. */
  function run(store, mode, fn) {
    return open().then(function (db) {
      return new Promise(function (res, rej) {
        var out, t;
        try { t = db.transaction(store, mode); } catch (e) { return rej(e); }
        t.oncomplete = function () { res(out); };
        t.onerror = function () { rej(t.error || new Error("idb-error")); };
        t.onabort = function () { rej(t.error || new Error("idb-abort")); };
        try {
          fn(t.objectStore(store), function (v) { out = v; });
        } catch (e) { try { t.abort(); } catch (_) {} rej(e); }
      });
    });
  }

  var DB = {
    open: open,
    all: function (store) {
      return run(store, "readonly", function (s, set) {
        var rq = s.getAll ? s.getAll() : s.openCursor();
        if (rq.onsuccess) {
          if (s.getAll) set(rq.result || []);
          else {
            var acc = [];
            rq.onsuccess = function () {
              var c = rq.result;
              if (c) { acc.push(c.value); c.continue(); } else set(acc);
            };
          }
        }
      }).then(function (v) { return v || []; });
    },
    get: function (store, key) {
      return run(store, "readonly", function (s, set) {
        var rq = s.get(key);
        rq.onsuccess = function () { set(rq.result); };
      });
    },
    put: function (store, val, key) {
      return run(store, "readwrite", function (s) {
        if (key === undefined) s.put(val); else s.put(val, key);
      });
    },
    del: function (store, key) {
      return run(store, "readwrite", function (s) { s.delete(key); }).catch(function () {});
    },
    clear: function (store) {
      return run(store, "readwrite", function (s) { s.clear(); }).catch(function () {});
    },
    putMany: function (store, list) {
      return run(store, "readwrite", function (s) {
        list.forEach(function (v) { try { s.put(v); } catch (e) {} });
      });
    },
    /* meta helpers */
    metaGet: function (k, dflt) {
      return DB.get("meta", k).then(function (v) { return v === undefined || v === null ? dflt : v.v; });
    },
    metaSet: function (k, v) { return DB.put("meta", { k: k, v: v }).catch(function () {}); }
  };

  g.AVA_DB = DB;
})(self);
