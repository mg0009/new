const express = require('express');
const fs = require('fs');
const path = require('path');

const app = express();

/* ================= CONFIG ================= */

const LOG_FILE = "logs.txt";
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
  } catch (e) {
    console.log("Log error:", e.message);
  }
}

/* ================= TRACK ================= */

app.post('/track', (req, res) => {

  let body = "";

  req.on('data', chunk => {
    body += chunk.toString();
  });

  req.on('end', () => {

    const data = {
      ip: getIP(req),
      raw: body,
      time: new Date().toISOString()
    };

    console.log("\n📡 TRACK =====================");
    console.log(data);

    saveLog(data);

    res.json({ status: "ok" });
  });
});

/* ================= UPLOAD ================= */

app.post('/upload', (req, res) => {

  const fileName = Date.now() + ".bin";
  const filePath = path.join(UPLOAD_DIR, fileName);

  const stream = fs.createWriteStream(filePath);
  req.pipe(stream);

  req.on('end', () => {

    console.log("\n📦 FILE RECEIVED =====================");
    console.log("File:", fileName);
    console.log("IP:", getIP(req));

    saveLog({
      type: "file",
      file: fileName,
      time: new Date().toISOString()
    });

    res.json({ status: "uploaded" });
  });

  req.on('error', () => {
    res.status(500).send("error");
  });
});

/* ================= HEALTH ================= */

app.get('/health', (req, res) => {
  res.json({ status: "running" });
});

/* ================= HOME ================= */

app.get('/', (req, res) => {
  res.send("Server running");
});

/* ================= START ================= */

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
