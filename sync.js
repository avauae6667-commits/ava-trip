/* ============================================================
   AVA Fleet — upload engine
   Shared by the driver page and the service worker (Background Sync),
   so it must be DOM-free. Classic script, no modules, no build step.

   Guarantees:
     • one record at a time, oldest first  → no giant multi-MB requests
     • a record is only removed from the queue after the server says ok
     • retries use exponential backoff with jitter
     • every record carries a permanent client-generated id, so a retry
       after a lost reply is de-duplicated on the server (idempotent)
     • a network failure stops the run; the rest of the queue is kept
   ============================================================ */
(function (g) {
  "use strict";

  var BACKOFF_S = [5, 15, 60, 180, 600, 900, 1800]; // seconds
  var HARD_CAP = 3600000; // 1 hour

  function backoffMs(tries) {
    var i = Math.min(Math.max(tries | 0, 0), BACKOFF_S.length - 1);
    return BACKOFF_S[i] * 1000 + Math.floor(Math.random() * 4000);
  }

  function post(url, body, timeoutMs) {
    return new Promise(function (resolve, reject) {
      var done = false, ctl = null;
      try { if (g.AbortController) ctl = new g.AbortController(); } catch (e) {}
      var timer = setTimeout(function () {
        if (done) return;
        done = true;
        try { if (ctl) ctl.abort(); } catch (e) {}
        reject(new Error("timeout"));
      }, timeoutMs || 120000);

      var opts = {
        method: "POST",
        redirect: "follow",
        headers: { "Content-Type": "text/plain;charset=utf-8" },
        body: JSON.stringify(body)
      };
      if (ctl) opts.signal = ctl.signal;

      fetch(url, opts)
        .then(function (res) { return res.text(); })
        .then(function (txt) {
          if (done) return;
          done = true; clearTimeout(timer);
          var out;
          try { out = JSON.parse(txt); } catch (e) { return reject(new Error("bad-json")); }
          resolve(out);
        })
        .catch(function (err) {
          if (done) return;
          done = true; clearTimeout(timer);
          reject(err);
        });
    });
  }

  function pendingCount() {
    return g.AVA_DB.all("queue").then(function (q) {
      return { all: q.length, waiting: q.filter(function (x) { return !x.permanent; }).length };
    });
  }

  /**
   * flush({ apiUrl, token }) → { sent, remaining, waiting, auth, offline, errors }
   */
  function flush(opts) {
    opts = opts || {};
    var url = opts.apiUrl, token = opts.token;
    var out = { sent: 0, remaining: 0, waiting: 0, auth: false, offline: false, errors: [] };

    if (!url || !token || !/^https:\/\/script\.google\.com\/.+$/.test(url)) {
      out.auth = true;
      return Promise.resolve(out);
    }

    return g.AVA_DB.all("queue").then(function (queue) {
      queue.sort(function (a, b) { return String(a.createdAt).localeCompare(String(b.createdAt)); });
      out.remaining = queue.length;

      // Sequential: keeps each Apps Script call short and the order predictable.
      return queue.reduce(function (chain, item) {
        return chain.then(function (stop) {
          if (stop) return stop;
          if (item.permanent) return false;
          if (item.nextTryAt && item.nextTryAt > Date.now()) return false;

          var photoP = item.hasPhoto
            ? g.AVA_DB.get("photos", item.id).catch(function () { return null; })
            : Promise.resolve(null);

          return photoP.then(function (photo) {
            return post(url, {
              action: "submit",
              token: token,
              record: item.payload,
              photo: photo || "",
              sentAt: Date.now()
            }, opts.timeout || 120000).then(function (res) {
              if (res && res.ok) {
                out.sent++;
                return Promise.all([
                  g.AVA_DB.del("queue", item.id),
                  g.AVA_DB.del("photos", item.id)
                ]).then(function () { return false; });
              }
              var msg = (res && res.error) || "Upload failed";

              if (res && res.code === "AUTH") { out.auth = true; return true; } // stop everything

              if (res && res.permanent) {
                item.permanent = true;
                item.lastError = msg;
                item.lastTryAt = Date.now();
                return g.AVA_DB.put("queue", item).then(function () { return false; });
              }

              item.tries = (item.tries || 0) + 1;
              item.lastError = msg;
              item.lastTryAt = Date.now();
              item.nextTryAt = Date.now() + (item.tries >= 8 ? HARD_CAP : backoffMs(item.tries));
              out.errors.push({ id: item.id, error: msg });
              return g.AVA_DB.put("queue", item).then(function () { return false; });
            }, function (err) {
              // Network/timeout: keep this record AND the rest of the queue.
              out.offline = true;
              item.lastError = err && err.message === "timeout" ? "Timed out" : "No connection";
              item.lastTryAt = Date.now();
              return g.AVA_DB.put("queue", item).then(function () { return true; });
            });
          });
        });
      }, Promise.resolve(false)).then(function () {
        return g.AVA_DB.all("queue").then(function (q) {
          out.remaining = q.length;
          out.waiting = q.filter(function (x) { return !x.permanent; }).length;
          return out;
        });
      });
    });
  }

  g.AVA_SYNC = { flush: flush, post: post, backoffMs: backoffMs, pendingCount: pendingCount };
})(self);
