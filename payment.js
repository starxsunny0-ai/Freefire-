// FamGateway payment - Netlify function (runs on the server; the API key never goes into the app).
// Netlify > Project configuration > Environment variables, add these 3:
//   FAM_API_KEY              = your FamGateway API key (FamGateway dashboard > API Keys)
//   FIREBASE_SERVICE_ACCOUNT = Firebase service-account JSON (the whole file content)
//   SITE_URL                 = your site address, e.g. https://freefireearningturnament.netlify.app
//
// How a deposit works:
//   1. The app asks this function to "create" an order. We create it at FamGateway and send back its checkout page link.
//   2. The user pays on that page. FamGateway calls this function (webhook), and the app also asks "check" every few seconds.
//   3. Both ways do the same safe thing: ask FamGateway directly (verify-order) whether the order is really paid,
//      and only then add the money to the wallet, exactly once.

const crypto = require("crypto");
const admin = require("firebase-admin");
const FAM = "https://famgateway.in";

// Started on the first request (not when the file loads), so a missing setting gives a clear message instead of a crash.
let db = null;
const start = () => {
  if (db) return db;
  if (!process.env.FIREBASE_SERVICE_ACCOUNT || !process.env.FAM_API_KEY || !process.env.SITE_URL) throw new Error("NOT_SET_UP");
  if (!admin.apps.length) admin.initializeApp({ credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)) });
  return (db = admin.firestore());
};
const reply = (code, obj) => ({ statusCode: code, headers: { "Content-Type": "application/json" }, body: JSON.stringify(obj) });
const famHeaders = () => ({ Authorization: "Bearer " + process.env.FAM_API_KEY, "Content-Type": "application/json", Accept: "application/json" });
// who is asking: the app sends the Firebase login token; a wrong or old token gives a clear "log in again"
const who = async (token) => { try { return await admin.auth().verifyIdToken(token); } catch (e) { throw new Error("AUTH"); } };
const inner = (d) => (d && typeof d.data === "object" && d.data) || {};


// ---------- rewards: invite codes, daily check-in, gift cards (the server moves all the money) ----------
class UErr extends Error {}
const num = (v, d) => (v === undefined || v === null || v === "" || !Number.isFinite(Number(v))) ? d : Number(v);
const rupee = (x) => Math.round(x * 100) / 100;
const istDay = (off = 0) => new Date(Date.now() + 19800000 + off).toISOString().slice(0, 10);
const txRow = (t, note, amt) => ({ t, note, amt, at: Date.now(), pend: false });
const pushTx = (usr, ...rows) => [...rows, ...(usr.tx || [])].slice(0, 40);
const LADDER0 = [{ n: 5, b: 50 }, { n: 15, b: 200 }, { n: 30, b: 500 }, { n: 50, b: 1000 }];
// settings the owner changes in Master admin > Rewards (stored in settings/app)
async function cfg() {
  const s = await db.collection("settings").doc("app").get(), d = s.exists ? s.data() : {};
  const cap = (v, dflt, mx) => Math.min(Math.max(num(v, dflt), 0), mx);
  return {
    refOn: d.refOn !== false, refReferrer: cap(d.refReferrer, 10, 1000), refFriend: cap(d.refFriend, 10, 1000), refMin: cap(d.refMin, 100, 10000),
    ladder: (Array.isArray(d.refLadder) ? d.refLadder : LADDER0).map((x) => ({ n: num(x.n, 0), b: cap(x.b, 0, 10000) })).filter((x) => x.n > 0),
    daily: Array.isArray(d.dailyRewards) && d.dailyRewards.length === 7 ? d.dailyRewards.map((x) => cap(x, 0, 100)) : [1, 1, 1, 2, 2, 2, 4],
    giftOn: d.giftOn !== false, giftMin: Math.max(cap(d.giftMin, 10, 100000), 1), giftMax: cap(d.giftMax, 5000, 100000), giftFee: cap(d.giftFee, 0, 20),
    spinOn: d.spinOn !== false, spin: Array.isArray(d.spinPrizes) && d.spinPrizes.length === 8 ? d.spinPrizes.map((x) => cap(x, 0, 100)) : [0, 0, 0, 1, 1, 1, 2, 4], spinMin: cap(d.spinMin, 100, 100000),
    fdPct: cap(d.fdPct, 10, 100), fdMax: cap(d.fdMax, 100, 10000)
  };
}
const GALPHA = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";   // no I, L, O, 0, 1: easy to read and type
const genBody = () => Array.from(crypto.randomBytes(12), (b) => GALPHA[b % GALPHA.length]).join("");
const normCode = (c) => { let x = String(c || "").toUpperCase().replace(/[^A-Z0-9]/g, ""); if (x.length === 14 && x.startsWith("FL")) x = x.slice(2); return x; };
const needProfile = (usr) => { if (!usr.name) throw new UErr("Finish your profile first."); if (usr.banned) throw new UErr("Your account is suspended."); };

async function rewardsAction(body) {
  const user = await who(body.token), users = db.collection("users"), uref = users.doc(user.uid), c = await cfg();

  if (body.action === "ref_apply") {
    if (!c.refOn) throw new UErr("The invite program is paused right now.");
    const code = String(body.code || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
    if (code.length < 4) throw new UErr("Enter a valid invite code.");
    const me = (await uref.get()).data() || {}; needProfile(me);
    if (me.refBy) throw new UErr("You already used an invite code.");
    if (me.refDone) throw new UErr("An invite code can only be used before your first deposit.");
    const paid = await db.collection("orders").where("uid", "==", user.uid).where("status", "==", "paid").limit(1).get();
    if (!paid.empty) throw new UErr("An invite code can only be used before your first deposit.");
    const f = await users.where("refCode", "==", code).limit(2).get();
    if (f.empty) throw new UErr("This invite code does not exist.");
    const ref = f.docs[0];
    if (ref.id === user.uid) throw new UErr("You cannot use your own code.");
    if ((ref.data() || {}).banned) throw new UErr("This invite code is not valid.");
    await uref.update({ refBy: ref.id });
    return { ok: true, friend: c.refFriend, min: c.refMin };
  }

  if (body.action === "daily") {
    const today = istDay(), yest = istDay(-864e5);
    const res = await db.runTransaction(async (t) => {
      const usr = (await t.get(uref)).data() || {}; needProfile(usr);
      const d = usr.daily || {}; if (d.last === today) return { done: true };
      const streak = d.last === yest ? (d.streak || 0) + 1 : 1, amt = c.daily[(streak - 1) % 7];
      const upd = { daily: { last: today, streak } };
      if (amt > 0) { upd.play = rupee((usr.play || 0) + amt); upd.tx = pushTx(usr, txRow("bonus", "Daily check-in, day " + (((streak - 1) % 7) + 1), amt)); }
      t.update(uref, upd); return { amount: amt, streak };
    });
    if (res.done) throw new UErr("You already checked in today. Come back tomorrow.");
    return res;
  }

  if (body.action === "spin") {
    if (!c.spinOn) throw new UErr("Lucky spin is paused right now.");
    const today = istDay(), index = crypto.randomInt(8);   // server picks the slot, the app only animates it
    // the wheel unlocks once the user has added the owner's minimum in total (counted from paid orders)
    let dep = ((await uref.get()).data() || {}).depTotal || 0;
    if (dep < c.spinMin) { const ps = await db.collection("orders").where("uid", "==", user.uid).where("status", "==", "paid").limit(200).get(); dep = Math.max(dep, ps.docs.reduce((a, d) => a + (d.data().amount || 0), 0)); }
    if (dep < c.spinMin) throw new UErr("The lucky spin unlocks after you add \u20b9" + c.spinMin + " in total. Add money to unlock it.");
    const res = await db.runTransaction(async (t) => {
      const usr = (await t.get(uref)).data() || {}; needProfile(usr);
      if ((usr.spin || {}).last === today) return { done: true };
      const amt = c.spin[index], upd = { spin: { last: today } };
      if (amt > 0) { upd.play = rupee((usr.play || 0) + amt); upd.tx = pushTx(usr, txRow("bonus", "Lucky spin win", amt)); }
      t.update(uref, upd); return { index, amount: amt };
    });
    if (res.done) throw new UErr("You already spun today. Come back tomorrow.");
    return res;
  }

  if (body.action === "gift_create") {
    if (!c.giftOn) throw new UErr("Gift cards are paused right now.");
    const amount = rupee(num(body.amount, 0));
    if (!(amount >= c.giftMin && amount <= c.giftMax)) throw new UErr("Gift amount must be \u20b9" + c.giftMin + " to \u20b9" + c.giftMax + ".");
    const cost = rupee(amount + amount * c.giftFee / 100), note = String(body.note || "").replace(/[<>]/g, "").trim().slice(0, 60);
    let card = null;
    for (let i = 0; i < 3 && !card; i++) {
      const id = genBody(), gref = db.collection("giftcards").doc(id);
      card = await db.runTransaction(async (t) => {
        const usr = (await t.get(uref)).data() || {}; needProfile(usr);
        const play = usr.play || 0, win = usr.win || 0;
        if (play + win < cost) throw new UErr("Not enough balance in your wallet.");
        if ((await t.get(gref)).exists) return null;
        const fp = Math.min(play, cost);   // play balance first, then winnings
        t.update(uref, { play: rupee(play - fp), win: rupee(win - (cost - fp)), tx: pushTx(usr, txRow("gift", "Gift card created", -cost)) });
        const doc = { code: id, amount, fee: rupee(cost - amount), note, by: user.uid, byName: usr.name, status: "active", at: Date.now() };
        t.set(gref, doc); return doc;
      });
    }
    if (!card) throw new UErr("Could not create the card. Please try again.");
    return { card };
  }

  if (body.action === "gift_redeem") {
    if (!c.giftOn) throw new UErr("Gift cards are paused right now.");
    const id = normCode(body.code), today = istDay();
    const res = await db.runTransaction(async (t) => {
      const usr = (await t.get(uref)).data() || {}; needProfile(usr);
      const fails = usr.giftFail && usr.giftFail.d === today ? usr.giftFail.c : 0;
      if (fails >= 8) return { bad: "Too many wrong codes today. Try again tomorrow." };
      const gref = db.collection("giftcards").doc(id.length === 12 ? id : "none"), g = await t.get(gref);
      if (!g.exists || g.data().status !== "active") { t.update(uref, { giftFail: { d: today, c: fails + 1 } }); return { bad: "This code is not valid or was already used." }; }
      const card = g.data();
      if (card.by === user.uid) return { bad: "This is your own gift card. Open My cards and tap Cancel to get the money back." };
      t.update(gref, { status: "redeemed", to: user.uid, toName: usr.name, redeemedAt: Date.now() });
      t.update(uref, { play: rupee((usr.play || 0) + card.amount), tx: pushTx(usr, txRow("gift", "Gift card from " + card.byName, card.amount)) });
      return { amount: card.amount };
    });
    if (res.bad) throw new UErr(res.bad);
    return res;
  }

  if (body.action === "gift_cancel") {
    const id = normCode(body.code), gref = db.collection("giftcards").doc(id.length === 12 ? id : "none");
    return db.runTransaction(async (t) => {
      const usr = (await t.get(uref)).data() || {}, g = await t.get(gref);
      if (!g.exists || g.data().by !== user.uid || g.data().status !== "active") throw new UErr("This card cannot be cancelled.");
      const amt = g.data().amount;
      t.update(gref, { status: "cancelled", cancelledAt: Date.now() });
      t.update(uref, { play: rupee((usr.play || 0) + amt), tx: pushTx(usr, txRow("refund", "Gift card cancelled", amt)) });
      return { amount: amt };
    });
  }

  if (body.action === "gift_mine") {
    const s = await db.collection("giftcards").where("by", "==", user.uid).limit(50).get();
    return { cards: s.docs.map((d) => d.data()).sort((a, b) => b.at - a.at).map((g) => ({ code: g.code, amount: g.amount, note: g.note, status: g.status, at: g.at, toName: g.toName || "", byName: g.byName })) };
  }
  throw new UErr("Bad request");
}


// ---------- customer care tools: only the owner can use these ----------
const OWNER = (process.env.ADMIN_EMAIL || "starxsunny0@gmail.com").toLowerCase();
async function supportAction(body) {
  const tok = await who(body.token);
  if ((tok.email || "").toLowerCase() !== OWNER || tok.email_verified === false) throw new UErr("Only the owner can do this.");
  const uid = String(body.uid || "").replace(/[^A-Za-z0-9_-]/g, ""); if (!uid) throw new UErr("Missing user.");
  const uref = db.collection("users").doc(uid);

  if (body.action === "admin_adjust") {
    const amt = rupee(num(body.amount, 0)), wal = body.wallet === "win" ? "win" : "play", reason = String(body.reason || "").replace(/[<>]/g, "").trim().slice(0, 80);
    if (!amt || Math.abs(amt) > 100000) throw new UErr("Enter an amount between -1,00,000 and 1,00,000.");
    if (!reason) throw new UErr("Write a short reason. The user sees it.");
    await db.runTransaction(async (t) => {
      const u = await t.get(uref); if (!u.exists) throw new UErr("User not found.");
      const usr = u.data(), cur = usr[wal] || 0;
      if (cur + amt < 0) throw new UErr("That would make the balance negative (it is " + cur + " now).");
      t.update(uref, { [wal]: rupee(cur + amt), tx: pushTx(usr, txRow("adjust", "Support: " + reason, amt)) });
      t.set(db.collection("audit").doc(), { by: tok.email, uid, wallet: wal, amount: amt, reason, at: Date.now() });
    });
    return { ok: true };
  }

  if (body.action === "support_fix") {
    if (body.type === "credit_order") {
      const o = await db.collection("orders").doc(String(body.orderId)).get();
      if (!o.exists || o.data().uid !== uid) throw new UErr("That order does not belong to this user.");
      const st = await verifyAndCredit(o.id);   // asks the gateway again, so we only credit money that was really paid
      return { msg: st === "paid" ? "Credited." : "The gateway does not show it as paid (" + st + ")." };
    }
    if (body.type === "refund_entry") {
      const mref = db.collection("matches").doc(String(body.matchId));
      await db.runTransaction(async (t) => {
        const m = await t.get(mref), u = await t.get(uref); if (!m.exists || !u.exists) throw new UErr("Not found.");
        const mm = m.data(), usr = u.data();
        if (mm.status !== "cancelled" || !(mm.players || {})[uid]) throw new UErr("This match was not cancelled for this user.");
        if ((mm.rf || {})[uid] || (usr.tx || []).some((x) => x.t === "refund" && String(x.note).includes(mm.title))) throw new UErr("Already refunded.");
        t.update(mref, { ["rf." + uid]: true });
        t.update(uref, { play: rupee((usr.play || 0) + mm.fee), tx: pushTx(usr, txRow("refund", "Refund: " + mm.title, mm.fee)) });
      });
      return { msg: "Refunded." };
    }
    throw new UErr("Unknown fix.");
  }

  if (body.action === "support_check") {
    const u = await uref.get(); if (!u.exists) throw new UErr("User not found.");
    const usr = u.data(), checks = [], add = (level, text, fix) => checks.push({ level, text, ...(fix ? { fix } : {}) });
    if (usr.banned) add("bad", "This account is banned."); else add("ok", "Account is active and not banned.");
    if (!usr.name) add("warn", "Profile is not finished (no game name yet).");
    // deposits
    const os = await db.collection("orders").where("uid", "==", uid).limit(30).get(), orders = os.docs.map((d) => ({ id: d.id, ...d.data() })).sort((a, b) => (b.at || 0) - (a.at || 0));
    const paid = orders.filter((o) => o.status === "paid"), open = orders.filter((o) => o.status !== "paid");
    for (const o of open.slice(0, 5)) {
      let gate = "unknown";
      if (o.famOrderId) { try { const r = await fetch(FAM + "/api/verify-order.php?order_id=" + encodeURIComponent(o.famOrderId), { headers: famHeaders() }); gate = isPaid(await r.json().catch(() => ({}))) ? "paid" : "unpaid"; } catch (e) { /* gateway down */ } }
      const when = Math.max(1, Math.round((Date.now() - (o.at || Date.now())) / 60000)) + " min ago";
      if (gate === "paid") add("bad", "Deposit of Rs " + o.amount + " (" + when + ") is PAID at the gateway but not in the wallet.", { type: "credit_order", orderId: o.id, label: "Credit Rs " + o.amount });
      else if (gate === "unpaid") add("ok", "Deposit attempt of Rs " + o.amount + " (" + when + ") was never paid at the gateway. No money was taken.");
      else add("warn", "Deposit of Rs " + o.amount + " (" + when + "): could not ask the gateway just now. Try again in a minute.");
    }
    // withdrawals
    const ws = await db.collection("withdrawals").where("uid", "==", uid).limit(20).get();
    ws.docs.map((d) => ({ id: d.id, ...d.data() })).forEach((w) => {
      const at = w.at || Number(String(w.id).slice(1)) || 0, hrs = Math.round((Date.now() - at) / 3600000);
      if (w.st === "pending") add(hrs >= 24 ? "warn" : "ok", "Withdrawal of Rs " + w.a + " to " + w.upi + " is waiting for you (" + hrs + " h). Mark it paid or reject it in Withdrawals.");
      else if (w.st === "rejected") add("ok", "Withdrawal of Rs " + w.a + " was rejected and the money was returned to the wallet.");
    });
    // matches
    for (const mid of Object.keys(usr.joined || {}).slice(-15)) {
      const m = await db.collection("matches").doc(mid).get(); if (!m.exists) continue; const mm = m.data();
      if (mm.status === "cancelled" && mm.fee > 0) {
        const got = (mm.rf || {})[uid] || (usr.tx || []).some((x) => x.t === "refund" && String(x.note).includes(mm.title));
        if (!got) add("bad", "Match \"" + mm.title + "\" was cancelled but the entry fee of Rs " + mm.fee + " was not refunded.", { type: "refund_entry", matchId: mid, label: "Refund Rs " + mm.fee });
      }
      const r = (mm.res || {})[uid];
      if (mm.status === "completed" && r && r.a > 0) {
        const got = (usr.tx || []).some((x) => x.t === "prize" && String(x.note).includes(mm.title));
        if (got) add("ok", "Prize of Rs " + r.a + " for \"" + mm.title + "\" is in the wallet history.");
        else add("warn", "The result of \"" + mm.title + "\" says Rs " + r.a + " prize, but it is not in the recent wallet history (only the last 40 entries are kept). Ask the user, and use Manage user if it is truly missing.");
      }
    }
    return { facts: { play: usr.play || 0, win: usr.win || 0, deposits: paid.length, depTotal: paid.reduce((a, o) => a + (o.amount || 0), 0) }, checks: checks.slice(0, 20) };
  }
  throw new UErr("Bad request");
}

// FamGateway says an order is paid in one of these ways (field names differ a little between endpoints)
const isPaid = (d) => {
  const x = inner(d);
  const words = [d && d.status, d && d.payment_status, x.status, x.payment_status].map((v) => String(v || "").toLowerCase());
  return (d && (d.is_paid === true || d.paid === true)) || x.is_paid === true || x.paid === true || words.some((w) => ["success", "successful", "paid", "captured", "completed"].includes(w));
};

// Ask FamGateway if the order is paid; if yes, add the money once. Returns "paid", "pending", "missing" or "mismatch".
async function verifyAndCredit(orderId) {
  const ref = db.collection("orders").doc(orderId), snap = await ref.get();
  if (!snap.exists) return "missing";
  const o = snap.data();
  if (o.status === "paid") return "paid";
  if (!o.famOrderId) return "pending";
  const r = await fetch(FAM + "/api/verify-order.php?order_id=" + encodeURIComponent(o.famOrderId), { headers: famHeaders() });
  let d = {}; try { d = await r.json(); } catch (e) { /* not json */ }
  console.log("verify-order", orderId, r.status, JSON.stringify(d).slice(0, 400));
  if (!isPaid(d)) return "pending";
  const x = inner(d), got = Number([x.amount, x.payable_amount, d.amount, d.payable_amount].find((v) => v != null));
  if (got && Math.abs(got - o.amount) > 1) { console.error("amount mismatch", orderId, got, o.amount); return "mismatch"; }   // FamGateway may add a few paise
  const c = await cfg().catch(() => null);
  const prior = c && c.fdPct > 0 ? await db.collection("orders").where("uid", "==", o.uid).where("status", "==", "paid").limit(1).get() : null;
  await db.runTransaction(async (t) => {
    const fresh = await t.get(ref);
    if (!fresh.exists || fresh.data().status === "paid") return;                          // never credit twice
    const uref = db.collection("users").doc(o.uid), u = await t.get(uref), usr = u.data() || {};
    // invite reward: only on the friend's first successful deposit of at least the minimum the owner set
    const rewardable = c && c.refOn && usr.refBy && !usr.refDone && o.amount >= c.refMin;
    let rref = null, rusr = null;
    if (rewardable) { rref = db.collection("users").doc(usr.refBy); const r = await t.get(rref); rusr = r.exists ? r.data() : null; }
    let play = (usr.play || 0) + o.amount, tx = pushTx(usr, txRow("deposit", "Added money", o.amount));
    const upd = { depTotal: rupee((usr.depTotal || 0) + o.amount) };
    if (prior && prior.empty && !usr.fdDone) {   // first deposit bonus, set by the owner in Rewards
      const fb = rupee(Math.min(c.fdMax, o.amount * c.fdPct / 100));
      if (fb > 0) { play += fb; tx = pushTx({ tx }, txRow("bonus", "First deposit bonus", fb)); }
      upd.fdDone = true;
    }
    if (rewardable) {
      upd.refDone = true;
      if (rusr && !rusr.banned) {
        if (c.refFriend > 0) { play += c.refFriend; tx = pushTx({ tx }, txRow("bonus", "Welcome bonus (friend invite)", c.refFriend)); }
        const cnt = (rusr.refCount || 0) + 1, rows = []; let add = 0;
        if (c.refReferrer > 0) { add += c.refReferrer; rows.push(txRow("bonus", "Invite reward: a friend joined", c.refReferrer)); }
        c.ladder.filter((x) => x.n === cnt && x.b > 0).forEach((x) => { add += x.b; rows.push(txRow("bonus", "Rank reward: " + cnt + " friends", x.b)); });
        t.update(rref, { refCount: cnt, refEarn: rupee((rusr.refEarn || 0) + add), play: rupee((rusr.play || 0) + add), tx: pushTx(rusr, ...rows.reverse()) });
      }
    }
    t.update(uref, { play: rupee(play), tx, ...upd });
    t.update(ref, { status: "paid", paidAt: Date.now() });
  });
  return "paid";
}

exports.handler = async (e) => {
  try {
    start();
    const raw = e.isBase64Encoded ? Buffer.from(e.body || "", "base64").toString() : (e.body || "");
    let body = {}; try { body = JSON.parse(raw || "{}"); } catch (err) { /* webhook body is not json */ }
    const q = e.queryStringParameters || {};

    // 1) From the app: create a new payment order
    if (body.action === "create") {
      const user = await who(body.token);
      const amount = Math.round(Number(body.amount) * 100) / 100;
      if (!(amount >= 10 && amount <= 10000)) return reply(400, { error: "Amount must be 10 to 10000." });
      const orderId = "ord_" + Date.now() + "_" + user.uid.slice(0, 6), site = process.env.SITE_URL.replace(/\/$/, "");
      const res = await fetch(FAM + "/api/create-order", {
        method: "POST", headers: famHeaders(),
        // our own order id travels inside the webhook address, so we can find the order when FamGateway calls back
        body: JSON.stringify({ amount, customer_name: user.uid, redirect_url: site + "/app.html", webhook_url: site + "/.netlify/functions/payment?o=" + orderId })
      });
      let data = {}; try { data = await res.json(); } catch (err) { /* not json */ }
      const x = inner(data), url = data.checkout_url || x.checkout_url, famOrderId = data.order_id || x.order_id || "";
      if (!url) { console.error("FamGateway create failed", res.status, JSON.stringify(data).slice(0, 400)); return reply(502, { error: "Payment could not start." }); }
      await db.collection("orders").doc(orderId).set({ uid: user.uid, amount, famOrderId, status: "pending", at: Date.now() });
      return reply(200, { url, orderId });
    }

    // customer care tools (owner only)
    if (["support_check", "support_fix", "admin_adjust"].includes(body.action)) return reply(200, await supportAction(body));

    // rewards (invite code, daily check-in, gift cards)
    if (["ref_apply", "daily", "spin", "gift_create", "gift_redeem", "gift_cancel", "gift_mine"].includes(body.action)) return reply(200, await rewardsAction(body));

    // 2) From the app, while the user is paying: "is it paid yet?"
    if (body.action === "check") {
      const user = await who(body.token);
      const snap = await db.collection("orders").doc(String(body.orderId || "")).get();
      if (!snap.exists || snap.data().uid !== user.uid) return reply(404, { error: "Order not found." });
      return reply(200, { status: await verifyAndCredit(snap.id) });
    }

    // 3) From FamGateway: webhook. We do not trust what it says; we ask FamGateway directly (verify-order) before adding money.
    if (q.o) {
      const sig = String(e.headers["x-famgateway-signature"] || "").replace(/^sha256=/, "");
      const want = crypto.createHmac("sha256", process.env.FAM_API_KEY).update(raw).digest("hex");
      console.log("webhook", q.o, sig ? (sig === want ? "signature ok" : "signature differs") : "no signature");
      await verifyAndCredit(q.o);
      return reply(200, { ok: true });
    }
    return reply(400, { error: "Bad request" });
  } catch (err) {
    if (err && err.message === "NOT_SET_UP") return reply(503, { error: "Payment is not set up yet." });
    if (err instanceof UErr) return reply(400, { error: err.message });
    if (err && err.message === "AUTH") return reply(401, { error: "Please log in again." });
    console.error(err); return reply(500, { error: "Server error" });
  }
};
