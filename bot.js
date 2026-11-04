// بوت واتساب - استوديو أرح قلبك (نسخة 3: تأكيد الحجز من الإدارة + حجوزات الأسبوع)
// التشغيل: npm i express  ثم  node bot.js   (Node 18 أو أحدث)
// المتغيرات المطلوبة: TOKEN, PHONE_ID, VERIFY_TOKEN, OWNER_NUMBER (بصيغة 20xxxxxxxxxx)
// اختيارية: APP_SECRET (للتحقق من إن الطلبات جاية من ميتا), PORT
//
// لوحة الإدارة: من رقم OWNER_NUMBER ابعت للبوت "ادمن" (أو أي رسالة)
// اختصارات للإدارة: "طلبات" / "الأسبوع" / "القادم"

const express = require("express");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const { TOKEN, PHONE_ID, VERIFY_TOKEN, OWNER_NUMBER, APP_SECRET } = process.env;
for (const [k, v] of Object.entries({ TOKEN, PHONE_ID, VERIFY_TOKEN, OWNER_NUMBER })) {
  if (!v) { console.error(`❌ المتغير ${k} مش موجود`); process.exit(1); }
}
const API = `https://graph.facebook.com/v21.0/${PHONE_ID}/messages`;

// ====== عدّل هنا ======
const STUDIO = "استوديو أرح قلبك";
const SERVICES = {
  svc_audio: { name: "تسجيل صوت", info: "تسجيل صوتي بجودة عالية، والخدمة مجانية بالكامل 🤍" },
  svc_video: { name: "تسجيل فيديو", info: "تسجيل فيديو بجودة عالية، والخدمة مجانية بالكامل 🤍" },
  svc_khatma: { name: "تسجيل ختمة", info: "تسجيل ختمة كاملة بجودة عالية، والخدمة مجانية بالكامل 🤍" },
};
const TIMEZONE = "Africa/Cairo";
const DAYS_AHEAD = 6;                 // عدد أيام العمل اللي تظهر للحجز
const OFF_DAYS = [5];                 // 5 = الجمعة (0 = الأحد ... 6 = السبت)
const WEEK_START = 6;                 // الأسبوع يبدأ يوم السبت
const HOURS = [14, 15, 16, 17, 18, 19, 20, 21]; // بداية كل موعد (آخر موعد 9 وينتهي 10)
const ADDRESS = "التجمع الخامس - كمبوند تمر حنة 1 - فيلا 172";
const MAPS_LINK = "https://maps.app.goo.gl/84zdCkdqwwqb9MVn6";
const LOCATION = { latitude: 30.0423336, longitude: 31.5334625, name: STUDIO, address: ADDRESS };
const TELEGRAM_LINK = "https://t.me/Astudio_ak";
const SOCIAL_LINK =
  "▶️ يوتيوب: https://youtube.com/@studio.ak1\n" +
  "📘 فيسبوك: https://www.facebook.com/share/1EJEc2SBLj/\n" +
  "📸 إنستجرام: https://www.instagram.com/astudio.ak\n" +
  "✈️ تليجرام: https://t.me/Astudio_ak";
const WORK_HOURS = "من السبت إلى الخميس، من 2 مساءً إلى 10 مساءً";
const MENU_WORDS = ["قائمة", "القائمة", "منيو", "menu", "0", "ابدأ", "start", "رجوع"];
const ADMIN_WORDS = ["ادمن", "أدمن", "admin", "لوحة", "الإدارة", "الادارة"];
const SESSION_TTL = 30 * 60 * 1000;   // الجلسة تنتهي بعد 30 دقيقة من غير رد
// ======================

const AR_DAYS = ["الأحد", "الاثنين", "الثلاثاء", "الأربعاء", "الخميس", "الجمعة", "السبت"];
const hourLabel = (h) => `${h > 12 ? h - 12 : h}:00 ${h >= 12 ? "مساءً" : "صباحاً"}`;
const isOwner = (phone) => phone === OWNER_NUMBER;

// ---------- التاريخ والوقت بتوقيت مصر ----------
function nowInTZ() {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone: TIMEZONE, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hour12: false,
    }).formatToParts(new Date()).map((x) => [x.type, x.value])
  );
  return { date: `${p.year}-${p.month}-${p.day}`, hour: Number(p.hour) % 24 };
}
const toUTC = (iso) => { const [y, m, d] = iso.split("-").map(Number); return new Date(Date.UTC(y, m - 1, d)); };
const addDays = (iso, n) => { const d = toUTC(iso); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const dayLabel = (iso) => `${AR_DAYS[toUTC(iso).getUTCDay()]} ${iso.slice(8, 10)}/${iso.slice(5, 7)}`;
const isPast = (date, hour) => { const n = nowInTZ(); return date < n.date || (date === n.date && hour <= n.hour); };

// بداية ونهاية الأسبوع (السبت → الجمعة). offset = 0 الحالي، 1 القادم
function weekRange(offset) {
  const today = nowInTZ().date;
  const back = (toUTC(today).getUTCDay() - WEEK_START + 7) % 7;
  const start = addDays(today, -back + 7 * offset);
  return { start, end: addDays(start, 6) };
}

// ---------- الحجوزات (محفوظة في ملف) ----------
// status: pending (بانتظار التأكيد) | alt_proposed (اتقترح موعد بديل) | confirmed | rejected
const STATUS_LABEL = {
  pending: "⏳ بانتظار تأكيد الإدارة",
  alt_proposed: "🔄 مقترح موعد بديل - بانتظار ردك",
  confirmed: "✅ مؤكد",
  rejected: "❌ مرفوض",
};
const DB_FILE = path.join(__dirname, "bookings.json");
let bookings = [];
try { bookings = JSON.parse(fs.readFileSync(DB_FILE, "utf8")); } catch { bookings = []; }
// ترحيل الحجوزات القديمة (من النسخة اللي قبل كده) لتعتبر مؤكدة
let nextId = 1;
for (const b of bookings) { b.status ||= "confirmed"; nextId = Math.max(nextId, (b.id || 0) + 1); }
for (const b of bookings) if (!b.id) b.id = nextId++;
const saveBookings = () => fs.writeFileSync(DB_FILE, JSON.stringify(bookings, null, 2));
const findBooking = (id) => bookings.find((b) => b.id === Number(id));

// الموعد يعتبر محجوز فقط لو فيه حجز "مؤكد" عليه
const confirmedAt = (date, hour, exceptId) =>
  bookings.find((b) => b.status === "confirmed" && b.date === date && b.hour === hour && b.id !== exceptId);
const svcName = (b) => SERVICES[b.service]?.name || b.service;
const bookingDetails = (b) =>
  `الاسم: ${b.name}\nالخدمة: ${svcName(b)}\nاليوم: ${dayLabel(b.date)}\nالساعة: ${hourLabel(b.hour)}`;

function freeHours(date) {
  return HOURS.filter((h) => !confirmedAt(date, h) && !isPast(date, h));
}
function upcomingDays() {
  const today = nowInTZ().date;
  const out = [];
  for (let i = 0; out.length < DAYS_AHEAD && i < 30; i++) {
    const iso = addDays(today, i);
    if (OFF_DAYS.includes(toUTC(iso).getUTCDay())) continue;
    if (freeHours(iso).length === 0) continue; // اليوم ده مليان
    out.push({ iso, label: dayLabel(iso) });
  }
  return out;
}

// ---------- الجلسات ----------
const sessions = new Map(); // phone -> { step, ... , t }
const getSession = (from) => {
  const s = sessions.get(from);
  if (!s || Date.now() - s.t > SESSION_TTL) { sessions.delete(from); return { step: "idle" }; }
  return s;
};
const setSession = (from, s) => sessions.set(from, { ...s, t: Date.now() });
setInterval(() => { for (const [k, s] of sessions) if (Date.now() - s.t > SESSION_TTL) sessions.delete(k); }, 10 * 60 * 1000);

// ---------- الإرسال ----------
async function send(payload) {
  try {
    const r = await fetch(API, {
      method: "POST",
      headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({ messaging_product: "whatsapp", ...payload }),
    });
    if (!r.ok) console.error("send error:", await r.text());
    return r.ok;
  } catch (e) { console.error("network error:", e.message); return false; }
}
const text = (to, body) => send({ to, type: "text", text: { body, preview_url: true } });
const list = (to, body, button, title, rows) =>
  send({
    to, type: "interactive",
    interactive: { type: "list", body: { text: body }, action: { button, sections: [{ title, rows: rows.slice(0, 10) }] } },
  });
// أزرار سريعة (حد أقصى 3، وعنوان الزرار 20 حرف)
const buttons = (to, body, btns) =>
  send({
    to, type: "interactive",
    interactive: {
      type: "button", body: { text: body },
      action: { buttons: btns.slice(0, 3).map((b) => ({ type: "reply", reply: { id: b.id, title: b.title } })) },
    },
  });
const markRead = (id) => send({ status: "read", message_id: id });

async function notifyOwner(msg) {
  const ok = await text(OWNER_NUMBER, msg);
  if (!ok) console.warn("⚠️ مقدرتش أبعت للمالك. ابعت أي رسالة للبوت من رقم المالك (نافذة الـ 24 ساعة).");
  return ok;
}

async function sendLocation(to) {
  await send({ to, type: "location", location: LOCATION });
  return text(to, `📍 العنوان: ${ADDRESS}\n🗺️ اللوكيشن على الخريطة:\n${MAPS_LINK}`);
}

const BACK_ROW = { id: "back", title: "↩️ القائمة الرئيسية" };

// ======================================================================
//                              قائمة العميل
// ======================================================================
const menu = (to) =>
  list(to, `السلام عليكم 🌙\nأهلاً بيك في ${STUDIO}\nتحب نساعدك في إيه؟`, "اختر الخدمة", "الخدمات", [
    { id: "svc_audio", title: "🎙️ تسجيل صوت" },
    { id: "svc_video", title: "🎬 تسجيل فيديو" },
    { id: "svc_khatma", title: "📖 تسجيل ختمة" },
    { id: "book", title: "📅 حجز موعد تسجيل" },
    { id: "my_booking", title: "🗂️ حجوزاتي" },
    { id: "receive", title: "📥 استلام التسجيلات" },
    { id: "location", title: "📍 موقع الاستوديو" },
    { id: "social", title: "🌐 مواقع التواصل" },
    { id: "support", title: "💬 تواصل مع الدعم" },
  ]);

const serviceRows = () => [...Object.entries(SERVICES).map(([id, s]) => ({ id, title: s.name })), BACK_ROW];

// prefix: "day_"/"hour_" للعميل، "altday_"/"althour_" للإدارة (اقتراح موعد بديل)
async function askDay(to, prefix = "day_") {
  const days = upcomingDays();
  if (!days.length) {
    sessions.delete(to);
    return text(to, "للأسف كل المواعيد محجوزة حالياً 🙏\nاكتب: دعم وهنتواصل معاك، أو اكتب: قائمة");
  }
  return list(to, "اختار اليوم المناسب:", "اختر اليوم", "الأيام",
    [...days.map((d) => ({ id: `${prefix}${d.iso}`, title: d.label })), BACK_ROW]);
}
async function askHour(to, date, prefix = "hour_") {
  const hours = freeHours(date);
  return list(to, `اختار الساعة المناسبة (${dayLabel(date)}):`, "اختر الساعة", "المواعيد المتاحة",
    [...hours.map((h) => ({ id: `${prefix}${h}`, title: hourLabel(h) })), BACK_ROW]);
}

async function handleCustomer(from, id, body, s) {
  // الاسم (آخر خطوة في الحجز) ← الطلب يروح للإدارة
  if (s.step === "name") {
    if (!body) return text(from, "من فضلك اكتب اسمك كتابة ✍️ (أو اكتب: قائمة للإلغاء)");
    if (body.length < 2 || body.length > 50) return text(from, "الاسم لازم يكون بين 2 و 50 حرف، اكتبه تاني من فضلك:");
    if (confirmedAt(s.date, s.hour) || isPast(s.date, s.hour)) {
      setSession(from, { ...s, step: "hour" });
      await text(from, "للأسف الموعد ده مبقاش متاح 😅 اختار موعد تاني:");
      return askHour(from, s.date);
    }
    const b = {
      id: nextId++, name: body, phone: from, service: s.service, date: s.date, hour: s.hour,
      status: "pending", createdAt: new Date().toISOString(),
    };
    bookings.push(b); saveBookings();
    sessions.delete(from);
    await text(from,
      `📨 طلب حجزك وصل وبانتظار تأكيد الإدارة\n\nرقم الطلب: #${b.id}\n${bookingDetails(b)}\n\n` +
      `هيوصلك تأكيد هنا أول ما الإدارة توافق 🌙\nتقدر تتابع طلبك من «حجوزاتي» في القائمة.`);
    return sendRequestToOwner(b, "📩 طلب حجز جديد");
  }

  if (id && Object.hasOwn(SERVICES, id)) {
    setSession(from, { step: "day", service: id });
    await text(from, `*${SERVICES[id].name}*\n${SERVICES[id].info}\n\nمواعيد العمل: ${WORK_HOURS}`);
    return askDay(from);
  }

  if (id?.startsWith("day_") && s.step === "day") {
    const date = id.slice(4);
    if (!upcomingDays().some((d) => d.iso === date)) { await text(from, "اليوم ده مبقاش متاح، اختار يوم تاني:"); return askDay(from); }
    setSession(from, { ...s, step: "hour", date });
    return askHour(from, date);
  }

  if (id?.startsWith("hour_") && s.step === "hour") {
    const hour = Number(id.slice(5));
    if (!freeHours(s.date).includes(hour)) { await text(from, "الموعد ده مبقاش متاح، اختار موعد تاني:"); return askHour(from, s.date); }
    const dup = bookings.find((b) => b.phone === from && b.date === s.date && b.hour === hour && ["pending", "confirmed"].includes(b.status));
    if (dup) { sessions.delete(from); return text(from, `عندك طلب بالفعل على نفس الموعد (#${dup.id}) - ${STATUS_LABEL[dup.status]}\nاكتب: قائمة`); }
    setSession(from, { ...s, step: "name", hour });
    return text(from, "تمام 👌 اكتب اسمك لإرسال طلب الحجز:");
  }

  // رد العميل على موعد بديل اقترحته الإدارة
  if (id?.startsWith("cus_acc_") || id?.startsWith("cus_dec_")) {
    const b = findBooking(id.slice(8));
    if (!b || b.phone !== from || b.status !== "alt_proposed") return text(from, "العرض ده مبقاش متاح. اكتب: قائمة");
    if (id.startsWith("cus_dec_")) {
      b.status = "rejected"; b.note = "العميل رفض الموعد البديل"; saveBookings();
      await text(from, "تمام، تم إلغاء الطلب 🙏\nتقدر تحجز موعد تاني يناسبك من القائمة، أو اكتب: دعم");
      return notifyOwner(`❌ العميل رفض الموعد البديل\nطلب #${b.id}\n${bookingDetails({ ...b, ...b.alt })}\nالرقم: ${b.phone}`);
    }
    // موافقة ← نتحقق إن الموعد لسه فاضي ثم نأكد
    const { date, hour } = b.alt;
    const taken = confirmedAt(date, hour, b.id);
    if (taken || isPast(date, hour)) {
      b.status = "pending"; saveBookings();
      await text(from, "للأسف الموعد ده اتحجز قبل ما توافق 😅 الإدارة هتتواصل معاك بموعد تاني قريب.");
      return sendRequestToOwner(b, `⚠️ العميل وافق على الموعد البديل (${dayLabel(date)} ${hourLabel(hour)}) لكنه اتحجز لحد تاني.\nاقترح موعد جديد:`);
    }
    b.date = date; b.hour = hour; delete b.alt;
    return confirmBooking(b, "✅ العميل وافق على الموعد البديل وتم تأكيد الحجز");
  }

  // ضغط على زرار قديم من حجز منتهي
  if (id?.startsWith("day_") || id?.startsWith("hour_")) {
    await text(from, "الجلسة انتهت، ابدأ الحجز من جديد 👇");
    return menu(from);
  }

  switch (id) {
    case "book":
      setSession(from, { step: "service" });
      return list(from, "تحب تحجز أنهي خدمة؟", "اختر الخدمة", "الخدمات", serviceRows());

    case "my_booking": {
      const today = nowInTZ().date;
      const mine = bookings
        .filter((b) => b.phone === from && b.status !== "rejected" && (b.alt?.date || b.date) >= today)
        .sort((a, b) => (a.date + a.hour).localeCompare(b.date + b.hour));
      if (!mine.length) return text(from, "مفيش حجوزات قادمة باسمك.\nلو عايز تحجز اكتب: قائمة");
      const lines = mine.map((b) => {
        const d = b.status === "alt_proposed" ? b.alt : b;
        return `#${b.id} ${svcName(b)} - ${dayLabel(d.date)} - ${hourLabel(d.hour)}\n   ${STATUS_LABEL[b.status]}`;
      });
      return text(from, `🗂️ حجوزاتك القادمة:\n\n${lines.join("\n\n")}\n\nلتعديل أو إلغاء حجز اكتب: دعم`);
    }

    case "receive":
      return text(from, `لاستلام تسجيلاتك، ادخل على تليجرام من الرابط ده 👇\n${TELEGRAM_LINK}\n\nولو احتجت مساعدة اكتب: قائمة`);

    case "social":
      return text(from, `تابعنا على مواقع التواصل 👇\n${SOCIAL_LINK}\n\nلو عايز ترجع للقائمة اكتب: قائمة`);

    case "location":
      await sendLocation(from);
      return text(from, `مواعيد العمل: ${WORK_HOURS}\nلو عايز ترجع للقائمة اكتب: قائمة`);

    case "support":
      return handleSupport(from);

    default:
      return menu(from);
  }
}

async function handleSupport(from) {
  await text(from, "تمام، هيتواصل معاك أحد أعضاء فريق الدعم في أقرب وقت 🤝");
  await notifyOwner(`💬 عميل عايز دعم: ${from}\nhttps://wa.me/${from}`);
}

// ======================================================================
//                              لوحة الإدارة
// ======================================================================
const adminMenu = (to) => {
  const pending = bookings.filter((b) => b.status === "pending").length;
  return list(to, "🛠️ لوحة الإدارة\nاختار اللي عايز تشوفه:", "القائمة", "الإدارة", [
    { id: "adm_pending", title: `⏳ طلبات بانتظار التأكيد`, description: `${pending} طلب` },
    { id: "adm_week0", title: "📅 الأسبوع الحالي", description: "الحجوزات المؤكدة (السبت ← الجمعة)" },
    { id: "adm_week1", title: "🗓️ الأسبوع القادم", description: "الحجوزات المؤكدة (السبت ← الجمعة)" },
    { id: "adm_alts", title: "🔄 مواعيد بديلة معلّقة", description: "مستنية رد العميل" },
    { id: "adm_customer", title: "👤 قائمة العملاء", description: "تجربة البوت كعميل" },
  ]);
};

// يبعت للإدارة تفاصيل الطلب ومعاه 3 أزرار
function sendRequestToOwner(b, header) {
  const sameSlot = bookings.filter((x) => x.id !== b.id && x.status === "pending" && x.date === b.date && x.hour === b.hour);
  const warn = sameSlot.length ? `\n\n⚠️ فيه ${sameSlot.length} طلب تاني على نفس الموعد: ${sameSlot.map((x) => "#" + x.id).join("، ")}` : "";
  const taken = confirmedAt(b.date, b.hour, b.id);
  const warn2 = taken ? `\n⛔ الموعد ده متأكد بالفعل لـ #${taken.id} (${taken.name})` : "";
  return buttons(OWNER_NUMBER,
    `${header}\n\nرقم الطلب: #${b.id}\n${bookingDetails(b)}\nالرقم: ${b.phone}\nhttps://wa.me/${b.phone}${warn}${warn2}`,
    [
      { id: `adm_ok_${b.id}`, title: "✅ تأكيد الحجز" },
      { id: `adm_alt_${b.id}`, title: "🔄 موعد بديل" },
      { id: `adm_no_${b.id}`, title: "❌ رفض" },
    ]);
}

// تأكيد الحجز: إرسال تأكيد + اللوكيشن للعميل وإبلاغ الإدارة
async function confirmBooking(b, ownerMsg) {
  b.status = "confirmed"; b.confirmedAt = new Date().toISOString(); saveBookings();
  await text(b.phone,
    `✅ تم تأكيد حجزك\n\nرقم الحجز: #${b.id}\n${bookingDetails(b)}\n\n` +
    `ياريت تكون موجود قبل الموعد بـ 10 دقايق. في انتظارك 🌙`);
  await sendLocation(b.phone);
  await notifyOwner(`${ownerMsg}\n#${b.id} - ${b.name} - ${dayLabel(b.date)} ${hourLabel(b.hour)}\n(اتبعت للعميل التأكيد واللوكيشن)`);
  // تنبيه بالطلبات التانية اللي على نفس الموعد
  const others = bookings.filter((x) => x.status === "pending" && x.date === b.date && x.hour === b.hour);
  for (const o of others) await sendRequestToOwner(o, "⚠️ الطلب ده على موعد اتأكد لحد تاني - اقترح موعد بديل أو ارفض");
}

function weekReport(offset) {
  const { start, end } = weekRange(offset);
  const items = bookings
    .filter((b) => b.status === "confirmed" && b.date >= start && b.date <= end)
    .sort((a, b) => (a.date + String(a.hour).padStart(2, "0")).localeCompare(b.date + String(b.hour).padStart(2, "0")));
  const title = offset === 0 ? "📅 حجوزات الأسبوع الحالي" : "🗓️ حجوزات الأسبوع القادم";
  const head = `${title}\n(${dayLabel(start)} ← ${dayLabel(end)})\n`;
  if (!items.length) return `${head}\nمفيش حجوزات مؤكدة.`;
  const byDay = {};
  for (const b of items) (byDay[b.date] ||= []).push(b);
  const parts = Object.entries(byDay).map(([d, arr]) =>
    `*${dayLabel(d)}*\n` + arr.map((b) => `• ${hourLabel(b.hour)} - ${b.name} - ${svcName(b)} (#${b.id})\n  ${b.phone}`).join("\n"));
  return `${head}\nالإجمالي: ${items.length} حجز\n\n${parts.join("\n\n")}`;
}

async function handleAdmin(from, id, body, s) {
  // اختصارات بالكتابة
  if (body === "طلبات") id = "adm_pending";
  if (body === "الأسبوع" || body === "الاسبوع") id = "adm_week0";
  if (body === "القادم") id = "adm_week1";

  if (id === "adm_pending") {
    const pend = bookings.filter((b) => b.status === "pending").sort((a, b) => a.id - b.id);
    if (!pend.length) return text(from, "👌 مفيش طلبات بانتظار التأكيد.\nاكتب: ادمن للرجوع للوحة");
    const rows = pend.slice(0, 9).map((b) => ({
      id: `adm_view_${b.id}`,
      title: `#${b.id} ${b.name}`.slice(0, 24),
      description: `${svcName(b)} - ${dayLabel(b.date)} - ${hourLabel(b.hour)}`.slice(0, 72),
    }));
    const more = pend.length > 9 ? `\n(بيظهر أول 9 من ${pend.length} - أكد أو ارفض عشان يظهر الباقي)` : "";
    return list(from, `⏳ طلبات بانتظار التأكيد: ${pend.length}${more}\nاختار طلب عشان تأكده أو ترفضه:`, "عرض الطلبات", "الطلبات",
      [...rows, { id: "adm_home", title: "↩️ لوحة الإدارة" }]);
  }
  if (id === "adm_week0" || id === "adm_week1") return text(from, weekReport(Number(id.slice(-1))) + "\n\nاكتب: ادمن للرجوع للوحة");
  if (id === "adm_alts") {
    const alts = bookings.filter((b) => b.status === "alt_proposed");
    if (!alts.length) return text(from, "مفيش مواعيد بديلة مستنية رد العميل.");
    return text(from, "🔄 مستنية رد العميل:\n\n" +
      alts.map((b) => `#${b.id} ${b.name} - ${dayLabel(b.alt.date)} ${hourLabel(b.alt.hour)}\n  ${b.phone}`).join("\n\n"));
  }
  if (id === "adm_customer") { sessions.delete(from); return menu(from); }
  if (id === "adm_home" || (id === "back" && s.step?.startsWith("alt"))) { sessions.delete(from); return adminMenu(from); }

  if (id?.startsWith("adm_view_")) {
    const b = findBooking(id.slice(9));
    if (!b || b.status !== "pending") return text(from, "الطلب ده اتعامل معاه بالفعل.");
    return sendRequestToOwner(b, "📋 تفاصيل الطلب");
  }

  // ✅ تأكيد
  if (id?.startsWith("adm_ok_")) {
    const b = findBooking(id.slice(7));
    if (!b) return text(from, "الطلب مش موجود.");
    if (b.status !== "pending") return text(from, `الطلب #${b.id} حالته: ${STATUS_LABEL[b.status]}`);
    if (isPast(b.date, b.hour)) return buttons(from, `⌛ موعد الطلب #${b.id} عدّى. اقترح موعد بديل أو ارفض:`, [
      { id: `adm_alt_${b.id}`, title: "🔄 موعد بديل" }, { id: `adm_no_${b.id}`, title: "❌ رفض" }]);
    const taken = confirmedAt(b.date, b.hour, b.id); // منع الحجز المزدوج
    if (taken) return buttons(from,
      `⛔ مينفعش تأكيد #${b.id}\nالموعد ${dayLabel(b.date)} ${hourLabel(b.hour)} متأكد بالفعل لـ #${taken.id} (${taken.name}).\nاقترح موعد بديل أو ارفض:`,
      [{ id: `adm_alt_${b.id}`, title: "🔄 موعد بديل" }, { id: `adm_no_${b.id}`, title: "❌ رفض" }]);
    return confirmBooking(b, "✅ تم تأكيد الحجز");
  }

  // ❌ رفض
  if (id?.startsWith("adm_no_")) {
    const b = findBooking(id.slice(7));
    if (!b || !["pending", "alt_proposed"].includes(b.status)) return text(from, "الطلب ده اتعامل معاه بالفعل.");
    b.status = "rejected"; saveBookings();
    await text(b.phone,
      `نعتذر منك 🙏 مقدرناش نأكد طلب الحجز #${b.id} (${dayLabel(b.date)} - ${hourLabel(b.hour)}).\n` +
      `تقدر تختار موعد تاني من القائمة، أو اكتب: دعم وهنتواصل معاك.`);
    return text(from, `❌ تم رفض الطلب #${b.id} وإبلاغ العميل.`);
  }

  // 🔄 اقتراح موعد بديل: يوم ← ساعة ← يتبعت للعميل
  if (id?.startsWith("adm_alt_")) {
    const b = findBooking(id.slice(8));
    if (!b || b.status !== "pending") return text(from, "الطلب ده اتعامل معاه بالفعل.");
    setSession(from, { step: "alt_day", bookingId: b.id });
    await text(from, `🔄 اقتراح موعد بديل للطلب #${b.id} (${b.name})`);
    return askDay(from, "altday_");
  }
  if (id?.startsWith("altday_") && s.step === "alt_day") {
    const date = id.slice(7);
    setSession(from, { ...s, step: "alt_hour", date });
    return askHour(from, date, "althour_");
  }
  if (id?.startsWith("althour_") && s.step === "alt_hour") {
    const hour = Number(id.slice(8));
    const b = findBooking(s.bookingId);
    sessions.delete(from);
    if (!b || b.status !== "pending") return text(from, "الطلب ده اتعامل معاه بالفعل.");
    if (confirmedAt(s.date, hour) || isPast(s.date, hour)) return text(from, "الموعد ده مبقاش متاح، ابدأ تاني من «طلبات».");
    b.alt = { date: s.date, hour }; b.status = "alt_proposed"; saveBookings();
    const ok = await buttons(b.phone,
      `🔄 بخصوص طلب الحجز #${b.id}\nالموعد اللي اخترته (${dayLabel(b.date)} - ${hourLabel(b.hour)}) مش متاح للأسف.\n\n` +
      `نقترح عليك:\n📅 ${dayLabel(s.date)}\n🕐 ${hourLabel(hour)}\n\nيناسبك؟`,
      [{ id: `cus_acc_${b.id}`, title: "✅ موافق" }, { id: `cus_dec_${b.id}`, title: "❌ مش مناسب" }]);
    return text(from, ok
      ? `📤 اتبعت للعميل الموعد البديل: ${dayLabel(s.date)} ${hourLabel(hour)}\nهيوصلك إشعار لما يرد.`
      : `⚠️ مقدرتش أبعت للعميل (غالباً عدّى 24 ساعة على آخر رسالة منه). كلمه مباشرة: https://wa.me/${b.phone}`);
  }
  if (id?.startsWith("altday_") || id?.startsWith("althour_")) return text(from, "الجلسة انتهت، ابدأ تاني من «طلبات».");

  return null; // مش أمر إدارة
}

// ======================================================================
//                               التوجيه
// ======================================================================
async function handle(from, msg) {
  const s = getSession(from);
  const id = msg.type === "interactive"
    ? (msg.interactive?.list_reply || msg.interactive?.button_reply)?.id || null
    : null;
  const body = msg.type === "text" ? msg.text.body.trim() : "";

  if (isOwner(from)) {
    if (ADMIN_WORDS.includes(body.toLowerCase())) { sessions.delete(from); return adminMenu(from); }
    const handled = await handleAdmin(from, id, body, s);
    if (handled !== null) return;
    // المالك بيجرب قائمة العملاء: يكمّل عادي، ولو رسالة مش مفهومة تظهر له لوحة الإدارة
    const inCustomerFlow = id || ["day", "hour", "name", "service"].includes(s.step);
    if (!inCustomerFlow && !MENU_WORDS.includes(body.toLowerCase())) return adminMenu(from);
  }

  // أزرار الإدارة ممنوعة على غير المالك
  if (!isOwner(from) && (id?.startsWith("adm_") || id?.startsWith("alt"))) return menu(from);

  if (id === "back" || MENU_WORDS.includes(body.toLowerCase())) { sessions.delete(from); return menu(from); }
  if (body === "دعم") return handleSupport(from);

  return handleCustomer(from, id, body, s);
}

// ---------- السيرفر ----------
const app = express();
app.use(express.json({ verify: (req, _res, buf) => { req.rawBody = buf; } }));

// التحقق من الـ Webhook (ميتا)
app.get("/webhook", (req, res) => {
  if (req.query["hub.mode"] === "subscribe" && req.query["hub.verify_token"] === VERIFY_TOKEN)
    return res.status(200).send(req.query["hub.challenge"]);
  res.sendStatus(403);
});

function validSignature(req) {
  if (!APP_SECRET) return true; // التحقق اختياري لو مفيش APP_SECRET
  const sig = req.get("x-hub-signature-256") || "";
  const expected = "sha256=" + crypto.createHmac("sha256", APP_SECRET).update(req.rawBody || "").digest("hex");
  return sig.length === expected.length && crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
}

// معالجة رسائل كل شخص بالترتيب (عشان الضغطات السريعة متلخبطش الحجز)
const queues = new Map();
function enqueue(from, fn) {
  const prev = queues.get(from) || Promise.resolve();
  const next = prev.then(fn).catch((e) => console.error(e));
  queues.set(from, next);
  next.finally(() => { if (queues.get(from) === next) queues.delete(from); });
}

const seen = new Map(); // منع تكرار نفس الرسالة لو ميتا بعتتها مرتين
app.post("/webhook", (req, res) => {
  if (!validSignature(req)) return res.sendStatus(401);
  res.sendStatus(200);
  for (const entry of req.body?.entry || []) {
    for (const change of entry.changes || []) {
      for (const msg of change.value?.messages || []) {
        if (seen.has(msg.id)) continue;
        seen.set(msg.id, Date.now());
        markRead(msg.id);
        enqueue(msg.from, () => handle(msg.from, msg));
      }
    }
  }
  if (seen.size > 5000) for (const [k, t] of seen) if (Date.now() - t > 3600000) seen.delete(k);
});

app.get("/", (_req, res) => res.send("Bot is running ✅"));
app.listen(process.env.PORT || 3000, () => console.log("Bot running"));
