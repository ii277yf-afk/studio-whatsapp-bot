// بوت واتساب - استوديو أرح قلبك
// التشغيل: npm i express  ثم  node bot.js   (Node 18 أو أحدث)
// المتغيرات المطلوبة: TOKEN, PHONE_ID, VERIFY_TOKEN, OWNER_NUMBER (بصيغة 20xxxxxxxxxx)

const express = require("express");
const app = express();
app.use(express.json({ limit: '256kb', verify(req, res, buf) { req.rawBody = buf; } }));

const { TOKEN, PHONE_ID, VERIFY_TOKEN, OWNER_NUMBER } = process.env;
const { createHmac, timingSafeEqual } = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const { mkdirSync } = require('node:fs');
const { dirname } = require('node:path');
const DB_PATH = process.env.DB_PATH || './data/bookings.sqlite';
mkdirSync(dirname(DB_PATH), {recursive:true});
const db = new DatabaseSync(DB_PATH);
db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
CREATE TABLE IF NOT EXISTS bookings (
 id INTEGER PRIMARY KEY, message_id TEXT UNIQUE NOT NULL, phone TEXT NOT NULL,
 name TEXT NOT NULL, service TEXT NOT NULL, day TEXT NOT NULL, hour INTEGER NOT NULL,
 status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','confirmed','rejected','cancelled')));
CREATE UNIQUE INDEX IF NOT EXISTS confirmed_slot ON bookings(day,hour) WHERE status='confirmed';
CREATE TABLE IF NOT EXISTS inbox(id TEXT PRIMARY KEY, payload TEXT NOT NULL, done INTEGER DEFAULT 0);
CREATE TABLE IF NOT EXISTS outbox(id INTEGER PRIMARY KEY, payload TEXT NOT NULL, done INTEGER DEFAULT 0);
CREATE TABLE IF NOT EXISTS sessions(phone TEXT PRIMARY KEY,payload TEXT NOT NULL);
`);
const TZ = process.env.STUDIO_TIMEZONE || 'Africa/Cairo';
const WEEK_START = Number(process.env.WEEK_START || 6); // السبت
const localParts = (date=new Date()) => Object.fromEntries(new Intl.DateTimeFormat('en-GB',{
 timeZone:TZ,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'
}).formatToParts(date).filter(p=>p.type!=='literal').map(p=>[p.type,p.value]));
function today(){const p=localParts();return p.year+'-'+p.month+'-'+p.day;}
function addDays(day,n){const d=new Date(day+'T12:00:00Z');d.setUTCDate(d.getUTCDate()+n);return d.toISOString().slice(0,10);}
function future(day,hour){const p=localParts();return day>today() || (day===today() && hour>Number(p.hour));}
function dates(){return Array.from({length:10},(_,i)=>addDays(today(),i)).filter(d=>new Date(d+'T12:00:00Z').getUTCDay()!==5);}
function dateLabel(day){return new Intl.DateTimeFormat('ar-EG',{timeZone:'UTC',weekday:'long',month:'numeric',day:'numeric',year:'numeric'}).format(new Date(day+'T12:00:00Z'));}
const API = `https://graph.facebook.com/${process.env.GRAPH_API_VERSION || "v21.0"}/${PHONE_ID}/messages`;

// ====== عدّل هنا ======
const STUDIO = "استوديو أرح قلبك";
const SERVICES = {
  svc_audio: { name: "تسجيل صوت", info: "تسجيل صوتي بجودة عالية، والخدمة مجانية بالكامل 🤍" },
  svc_video: { name: "تسجيل فيديو", info: "تسجيل فيديو بجودة عالية، والخدمة مجانية بالكامل 🤍" },
  svc_khatma: { name: "تسجيل ختمة", info: "تسجيل ختمة كاملة بجودة عالية، والخدمة مجانية بالكامل 🤍" },
};
const DAYS = ["السبت", "الأحد", "الاثنين", "الثلاثاء", "الأربعاء", "الخميس"];
const HOURS = ["2:00 مساءً", "3:00 مساءً", "4:00 مساءً", "5:00 مساءً",
               "6:00 مساءً", "7:00 مساءً", "8:00 مساءً", "9:00 مساءً"]; // آخر موعد يبدأ 9 وينتهي 10
const LOCATION = { latitude: 30.0444, longitude: 31.2357, name: STUDIO, address: "اكتب العنوان هنا" };
const TELEGRAM_LINK = "https://t.me/Astudio_ak";
const SOCIAL_LINK =
  "▶️ يوتيوب: https://youtube.com/@studio.ak1\n" +
  "📘 فيسبوك: https://www.facebook.com/share/1EJEc2SBLj/\n" +
  "📸 إنستجرام: https://www.instagram.com/astudio.ak\n" +
  "✈️ تليجرام: https://t.me/Astudio_ak";
const WORK_HOURS = "من السبت إلى الخميس، من 2 مساءً إلى 10 مساءً";
// ======================

const sessions = {
 get(phone){const r=db.prepare('SELECT payload FROM sessions WHERE phone=?').get(phone);return r?JSON.parse(r.payload):undefined;},
 set(phone,value){db.prepare('INSERT OR REPLACE INTO sessions VALUES (?,?)').run(phone,JSON.stringify(value));},
 delete(phone){db.prepare('DELETE FROM sessions WHERE phone=?').run(phone);}
}; // phone -> { step, service, day, hour }

async function send(payload) {
 db.prepare('INSERT INTO outbox(payload) VALUES (?)').run(JSON.stringify(payload));
}
let delivering=false;
async function flushOutbox(){
 if(delivering || processing)return;delivering=true;
 try {for(const row of db.prepare('SELECT * FROM outbox WHERE done=0 ORDER BY id LIMIT 50').all()){
  try {const r=await fetch(API,{method:'POST',signal:AbortSignal.timeout(15000),headers:{Authorization:'Bearer '+TOKEN,'Content-Type':'application/json'},body:JSON.stringify({messaging_product:'whatsapp',...JSON.parse(row.payload)})});
   if(r.ok)db.prepare('UPDATE outbox SET done=1 WHERE id=?').run(row.id);
   else console.error('WhatsApp delivery failed; queued for retry',row.id,r.status);
  }catch(e){console.error('WhatsApp connection failed; queued for retry',row.id);}
 }}finally{delivering=false;}
}
const text = (to, body) => send({ to, type: "text", text: { body } });
const list = (to, body, button, title, rows) =>
  send({
    to, type: "interactive",
    interactive: {
      type: "list", body: { text: body },
      action: { button, sections: [{ title, rows }] },
    },
  });

const menu = (to) =>
  list(to, `السلام عليكم 🌙\nأهلاً بيك في ${STUDIO}\nتحب نساعدك في إيه؟`, "اختر الخدمة", "الخدمات", [
    { id: "svc_audio", title: "🎙️ تسجيل صوت" },
    { id: "svc_video", title: "🎬 تسجيل فيديو" },
    { id: "svc_khatma", title: "📖 تسجيل ختمة" },
    { id: "book", title: "📅 حجز موعد تسجيل" },
    { id: "receive", title: "📥 استلام التسجيلات" },
    { id: "location", title: "📍 موقع الاستوديو" },
    { id: "social", title: "🌐 مواقع التواصل" },
    { id: "support", title: "💬 تواصل مع الدعم" },
  ]);

const serviceRows = () => Object.entries(SERVICES).map(([id, s]) => ({ id, title: s.name }));
const askDay = to => list(to,'اختار التاريخ المناسب:','اختر اليوم','الأيام',dates().map(d=>({id:'date_'+d,title:dateLabel(d)})));
const askHour = (to,day) => {
 const taken=db.prepare("SELECT hour FROM bookings WHERE day=? AND status='confirmed'").all(day).map(r=>r.hour);
 const rows=HOURS.map((title,i)=>({id:'hour_'+i,title})).filter((_,i)=>future(day,14+i)&&!taken.includes(14+i));
 return rows.length?list(to,'اختار الساعة المناسبة:','اختر الساعة','المواعيد',rows):text(to,'لا توجد مواعيد متاحة في اليوم ده. اكتب قائمة لاختيار يوم آخر.');
};
const bookingSummary = b => '#'+b.id+' | '+b.name+'\n'+b.phone+'\n'+SERVICES[b.service].name+'\n'+dateLabel(b.day)+' — '+HOURS[b.hour-14];
const ownerMenu = to => list(to,'إدارة حجوزات الاستوديو','اختر','الإدارة',[
 {id:'admin_pending_0',title:'طلبات بانتظار التأكيد'},
 {id:'admin_week_0',title:'حجوزات الأسبوع الحالي'},
 {id:'admin_week_1',title:'حجوزات الأسبوع القادم'}]);
async function adminAction(from,id,body){
 if(from!==OWNER_NUMBER)return false;
 if(['إدارة','ادارة'].includes(body)){await ownerMenu(from);return true;}
 if(body==='حجوزات الأسبوع')id='admin_week_0';
 if(body==='حجوزات الأسبوع القادم')id='admin_week_1';
 if(body==='طلبات بانتظار التأكيد')id='admin_pending_0';
 if(/^admin_week_[01]$/.test(id||'')){
  const shift=Number(id.slice(-1));const d=today();const dow=new Date(d+'T12:00:00Z').getUTCDay();
  const first=addDays(d,-((dow-WEEK_START+7)%7)+shift*7),end=addDays(first,7);
  const rows=db.prepare("SELECT * FROM bookings WHERE status='confirmed' AND day>=? AND day<? ORDER BY day,hour").all(first,end);
  await text(from,'📅 الحجوزات المؤكدة من '+first+' إلى '+addDays(end,-1)+'\nالعدد: '+rows.length);
  for(const b of rows)await text(from,bookingSummary(b));return true;
 }
 if(/^admin_pending_\d+$/.test(id||'')){
  const offset=Number(id.split('_')[2]);const rows=db.prepare("SELECT * FROM bookings WHERE status='pending' ORDER BY day,hour,id LIMIT 9 OFFSET ?").all(offset);
  for(const b of rows)await send({to:from,type:'interactive',interactive:{type:'button',body:{text:'⏳ طلب بانتظار قرارك\n'+bookingSummary(b)},action:{buttons:[
   {type:'reply',reply:{id:'confirm_'+b.id,title:'تأكيد الحجز'}},{type:'reply',reply:{id:'reject_'+b.id,title:'رفض الحجز'}}]}}});
  if(!rows.length)await text(from,'لا توجد طلبات أخرى بانتظار التأكيد.');
  if(rows.length===9)await list(from,'عرض باقي الطلبات','التالي','الطلبات',[{id:'admin_pending_'+(offset+9),title:'الطلبات التالية'}]);return true;
 }
 if(/^(confirm|reject)_\d+$/.test(id||'')){
  const [action,key]=id.split('_');const b=db.prepare('SELECT * FROM bookings WHERE id=?').get(Number(key));
  if(!b||b.status!=='pending'){await text(from,'الطلب غير موجود أو تم التعامل معه بالفعل.');return true;}
  if(action==='confirm'&&!future(b.day,b.hour)){await text(from,'الموعد مضى؛ ارفض الطلب واطلب من العميل اختيار موعد جديد.');return true;}
  try{db.prepare("UPDATE bookings SET status=? WHERE id=? AND status='pending'").run(action==='confirm'?'confirmed':'rejected',b.id);}
  catch(e){if(e.code?.startsWith('ERR_SQLITE')&&db.prepare("SELECT id FROM bookings WHERE day=? AND hour=? AND status='confirmed'").get(b.day,b.hour)){
   await text(from,'الموعد محجوز بالفعل. لا يمكن تأكيد حجزين لنفس الساعة.');return true;}throw e;}
  await text(from,action==='confirm'?'✅ تم التأكيد وإضافة الحجز إلى قائمة أسبوعه.':'تم رفض الطلب.');
  await text(b.phone,(action==='confirm'?'✅ أكدت الإدارة حجزك\n':'لم يتم قبول موعدك. اكتب قائمة لاختيار موعد آخر.\n')+bookingSummary(b));return true;
 }
 return false;
}

async function handle(from, msg) {
  const s = sessions.get(from) || { step: "idle" };
  const id = msg.type === "interactive"
    ? (msg.interactive?.list_reply || msg.interactive?.button_reply)?.id
    : null;
  const body = msg.type === "text" ? msg.text.body.trim() : "";

  if(await adminAction(from,id,body))return;
  if(id && /^(admin_|confirm_|reject_)/.test(id))return text(from,'الخيار متاح للإدارة فقط.');
  // الرجوع للقائمة في أي وقت
  if (body === "قائمة" || body === "menu") { sessions.delete(from); return menu(from); }

  // الاسم (آخر خطوة في الحجز)
  if (s.step === "name" && body) {
    if(body.length>100)return text(from,'اكتب اسمًا لا يتجاوز 100 حرف.');
    if(!future(s.day,s.hour)||db.prepare("SELECT id FROM bookings WHERE day=? AND hour=? AND status='confirmed'").get(s.day,s.hour)){
     sessions.set(from,{step:'day',service:s.service});await text(from,'الموعد لم يعد متاحًا؛ اختار تاريخًا جديدًا.');return askDay(from);
    }
    const result=db.prepare('INSERT INTO bookings(message_id,phone,name,service,day,hour) VALUES (?,?,?,?,?,?)').run(msg.id,from,body,s.service,s.day,s.hour);
    const b=db.prepare('SELECT * FROM bookings WHERE id=?').get(Number(result.lastInsertRowid));
    await text(from,'⏳ وصل طلبك وهو بانتظار تأكيد الإدارة. الموعد غير مؤكد حتى تصلك رسالة التأكيد.\n'+bookingSummary(b));
    await text(OWNER_NUMBER,'📩 طلب حجز جديد\n'+bookingSummary(b)+'\nاكتب: إدارة لعرض الطلبات وتأكيدها.');
    sessions.delete(from);
    return;
  }

  switch (true) {
    case id && id in SERVICES:
      sessions.set(from, { step: "day", service: id });
      await text(from, `*${SERVICES[id].name}*\n${SERVICES[id].info}\n\nمواعيد العمل: ${WORK_HOURS}`);
      return askDay(from);

    case id === "book":
      sessions.set(from, { step: "service" });
      return list(from, "تحب تحجز أنهي خدمة؟", "اختر الخدمة", "الخدمات", serviceRows());

    case id && id.startsWith('date_') && s.step==='day': {
      const day=id.slice(5);if(!dates().includes(day))return askDay(from);
      s.day=day;s.step='hour';sessions.set(from,s);return askHour(from,day);
    }
    case id && /^hour_[0-7]$/.test(id) && s.step==='hour':
      s.hour=14+Number(id.slice(5));s.step='name';sessions.set(from,s);
      return text(from,'اكتب اسمك لإرسال طلب الحجز للإدارة:');

    case id === "receive":
      return text(from, `لاستلام تسجيلاتك، ادخل على تليجرام من الرابط ده 👇\n${TELEGRAM_LINK}\n\nولو احتجت مساعدة اكتب: قائمة`);

    case id === "social":
      return text(from, `تابعنا على مواقع التواصل 👇\n${SOCIAL_LINK}\n\nلو عايز ترجع للقائمة اكتب: قائمة`);

    case id === "location":
      await send({ to: from, type: "location", location: LOCATION });
      return text(from, `مواعيد العمل: ${WORK_HOURS}\nلو عايز ترجع للقائمة اكتب: قائمة`);

    case id === "support":
      await text(from, "تمام، هيتواصل معاك أحد أعضاء فريق الدعم في أقرب وقت 🤝");
      if (OWNER_NUMBER) await text(OWNER_NUMBER, `💬 عميل عايز دعم: ${from}`);
      return;

    default:
      return menu(from);
  }
}

// التحقق من الـ Webhook (ميتا)
app.get("/webhook", (req, res) => {
  if (req.query["hub.mode"] === "subscribe" && req.query["hub.verify_token"] === VERIFY_TOKEN)
    return res.status(200).send(req.query["hub.challenge"]);
  res.sendStatus(403);
});

// التحقق من التوقيع قبل حفظ جميع الرسائل الواردة.
app.post('/webhook',(req,res)=>{
 const signature=req.get('x-hub-signature-256')||'';
 const expected='sha256='+createHmac('sha256',process.env.APP_SECRET).update(req.rawBody||Buffer.alloc(0)).digest('hex');
 if(!/^sha256=[a-f0-9]{64}$/.test(signature)||!timingSafeEqual(Buffer.from(signature),Buffer.from(expected)))return res.sendStatus(403);
 try{
  for(const entry of req.body?.entry||[])for(const change of entry.changes||[]){
   const value=change.value;if(value?.metadata?.phone_number_id!==PHONE_ID)continue;
   for(const msg of value.messages||[])if(msg.id&&msg.from)db.prepare('INSERT OR IGNORE INTO inbox(id,payload) VALUES (?,?)').run(msg.id,JSON.stringify(msg));
  }
  res.sendStatus(200);void processInbox();
 }catch(e){console.error('Could not persist webhook');res.sendStatus(503);}
});
let processing=false;
async function processInbox(){
 if(processing)return;processing=true;
 try{for(const row of db.prepare('SELECT * FROM inbox WHERE done=0 ORDER BY rowid LIMIT 100').all()){
  db.exec('BEGIN IMMEDIATE');
  try{const current=db.prepare('SELECT done FROM inbox WHERE id=?').get(row.id);if(!current.done){const msg=JSON.parse(row.payload);await handle(msg.from,msg);db.prepare('UPDATE inbox SET done=1 WHERE id=?').run(row.id);}db.exec('COMMIT');}
  catch(e){db.exec('ROLLBACK');console.error('Message processing failed',row.id,e.message);}
 }}finally{processing=false;}
 void flushOutbox();
}
function start(){
 for(const key of ['TOKEN','PHONE_ID','VERIFY_TOKEN','OWNER_NUMBER','APP_SECRET'])if(!process.env[key])throw new Error('Missing '+key);
 if(!/^\d{8,15}$/.test(OWNER_NUMBER))throw new Error('OWNER_NUMBER must contain country code and digits only');
 if(!Number.isInteger(WEEK_START)||WEEK_START<0||WEEK_START>6)throw new Error('Invalid WEEK_START');
 localParts();
 app.listen(process.env.PORT||3000,()=>console.log('Bot running'));
 setInterval(()=>void processInbox(),5000);setInterval(()=>void flushOutbox(),30000);void processInbox();
}
if(require.main===module)start();
module.exports={app,db,handle,processInbox,today,addDays,adminAction};
