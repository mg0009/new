const express = require('express');
const fs = require('fs');
const app = express();

app.use(express.json());

/* ---------------- CONFIG (remote control) ---------------- */

let config = {
    phone: "9999999999"
};

// get config (app yahan se number lega)
app.get('/config', (req, res) => {
    res.json(config);
});

// browser se number change karo
app.get('/set', (req, res) => {
    if (req.query.phone) {
        config.phone = req.query.phone;
    }
    res.send("Updated phone: " + config.phone);
});

/* ---------------- TRACKING ---------------- */

app.post('/track', (req, res) => {
    const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;

    const data = {
        ip: ip,
        userAgent: req.headers['user-agent'],
        body: req.body,
        time: new Date()
    };

    console.log("---- New User ----");
    console.log(data);

    // save logs
    fs.appendFileSync("logs.json", JSON.stringify(data) + "\n");

    res.send("Tracked");
});

/* ---------------- VIEW LOGS ---------------- */

app.get('/users', (req, res) => {
    try {
        const data = fs.readFileSync("logs.json", "utf-8");
        res.send(data);
    } catch {
        res.send("No data yet");
    }
});

/* ---------------- HOME ---------------- */

app.get('/', (req, res) => {
    res.send("Server running");
});

/* ---------------- START SERVER ---------------- */

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log("Server running on port", PORT);
});