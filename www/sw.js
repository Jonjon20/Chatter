/* Chatter service worker — push notifications with actions.
   Put this file next to index.html (same folder). */
const SUPABASE_URL = "https://ykyphsopgnhfdnvytswp.supabase.co";
const SUPABASE_KEY = "sb_publishable_lzh6KRFUa8tG2ObZcaDK4w_LJ_QUqUO";
const PUSH_FN = SUPABASE_URL + "/functions/v1/chatter-push";

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", e => e.waitUntil(self.clients.claim()));

const closeByTag = async tag => (await self.registration.getNotifications({tag})).forEach(n => n.close());
const note = (title, opt) => self.registration.showNotification(title, opt);
// Chrome requires every push to show something; swap the ringing notification for a silent one, then remove it
const quietClose = async tag => { await note("Call ended", {tag, silent: true, body: ""}); await new Promise(r => setTimeout(r, 600)); await closeByTag(tag); };

self.addEventListener("push", e => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch (err) { d = {title: "Chatter", body: e.data ? e.data.text() : ""}; }
  e.waitUntil((async () => {
    const wins = await self.clients.matchAll({type: "window", includeUncontrolled: true});
    const appOpen = wins.some(w => w.visibilityState === "visible");
    if (d.type === "call-cancel") return appOpen ? closeByTag("call-" + d.room) : quietClose("call-" + d.room);
    // app is on screen: it already plays its own sounds, so don't show a second notification
    if (appOpen && d.type !== "call") return;
    if (d.type === "call") {
      if (d.ts && Date.now() - d.ts > 45000) return appOpen ? undefined : quietClose("call-" + d.room); // stale ring
      if (appOpen) return;                            // the in-app ring screen handles it
      return note((d.name || "Someone") + " is calling", {
        body: d.video ? "Video call" : "Voice call", tag: "call-" + d.room, renotify: true, requireInteraction: true,
        vibrate: [600, 250, 600, 250, 600, 250, 600, 250, 600], timestamp: d.ts || Date.now(),
        actions: [{action: "answer", title: "Answer"}, {action: "decline", title: "Decline"}], data: d
      });
    }
    if (d.type === "msg") {
      return note(d.title || "Chatter", {
        body: d.body || "", tag: "msg-" + d.room, renotify: true, vibrate: [200, 100, 200], timestamp: d.at || Date.now(),
        actions: [{action: "reply", type: "text", title: "Reply", placeholder: "Write a reply…"}], data: d
      });
    }
    // any other push (likes, comments, friend requests… from the older function)
    return note(d.title || "Chatter", {body: d.body || "", tag: d.tag, vibrate: [200, 100, 200], data: d});
  })());
});

self.addEventListener("notificationclick", e => {
  const n = e.notification, d = n.data || {};
  n.close();
  e.waitUntil((async () => {
    if (d.type === "call" && e.action === "decline") {
      // tell the caller (same inbox channel the app uses), then close
      await fetch(SUPABASE_URL + "/realtime/v1/api/broadcast", {
        method: "POST", headers: {apikey: SUPABASE_KEY, "Content-Type": "application/json"},
        body: JSON.stringify({messages: [{topic: "inbox:" + d.from, event: "decline", payload: {room: d.room, from: d.to}, private: false}]})
      }).catch(() => {});
      return;
    }
    if (d.type === "msg" && e.action === "reply") {
      const text = (e.reply || "").trim();
      if (text) {
        let ok = false;
        try {
          const r = await fetch(PUSH_FN, {method: "POST", headers: {apikey: SUPABASE_KEY, "Content-Type": "application/json"}, body: JSON.stringify({action: "reply", token: d.token, text})});
          ok = r.ok;
        } catch (err) {}
        await note(ok ? "Reply sent" : "Couldn't send your reply", {body: ok ? text : "Tap to open Chatter and try again.", tag: "msg-" + d.room, silent: true, data: ok ? {type: "done"} : d});
        if (ok) { await new Promise(r => setTimeout(r, 2500)); await closeByTag("msg-" + d.room); }
        return;
      }
      // no inline text box on this browser/phone: fall through and open the chat so they can type there
    }
    if (d.type === "done") return;
    // open / focus the app
    const q = d.type === "call" ? {call: d.room, from: d.from, video: d.video ? "1" : "0", ts: d.ts, act: e.action === "answer" ? "answer" : "ring"} : {room: d.room};
    const base = new URL(self.registration.scope);
    const wins = await self.clients.matchAll({type: "window", includeUncontrolled: true});
    const w = wins[0];
    if (w) { try { await w.focus(); } catch (err) {} w.postMessage({type: "launch", q}); return; }
    Object.keys(q).forEach(k => q[k] != null && base.searchParams.set(k, q[k]));
    await self.clients.openWindow(base.href);
  })());
});
