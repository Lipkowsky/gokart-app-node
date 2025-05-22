const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const puppeteer = require("puppeteer");

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

const port = 3000;

// 👇 JEDYNA rzecz do zmiany, gdy zmieni się tor
const LIVE_URL =
  "https://gs21.gokartsystem.pl/pl/api/live_www__tid_60_h_e72641d13c07348c3b3b4bec9072f915";

const browsers = new Map();

io.on("connection", (socket) => {
  console.log("Client connected:", socket.id);

  socket.on("startTracking", async (driverName) => {
    if (!driverName) {
      socket.emit("error", "Driver name required");
      return;
    }

    if (browsers.has(socket.id)) {
      try {
        await browsers.get(socket.id).close();
      } catch (e) {
        console.error("Error closing browser for", socket.id, e);
      }
      browsers.delete(socket.id);
    }

    socket.join(driverName);

    try {
      // 🔍 Parsujemy tid i host z LINKU
      const parsedUrl = new URL(LIVE_URL);
      const tidMatch = parsedUrl.pathname.match(/tid_(\d+)_/);
      if (!tidMatch) {
        socket.emit("error", "Nieprawidłowy link w konfiguracji");
        return;
      }
      const tid = tidMatch[1];
      const host = parsedUrl.origin;

      const browser = await puppeteer.launch({ headless: true });
      browsers.set(socket.id, browser);

      const page = await browser.newPage();
      await page.goto(LIVE_URL, { waitUntil: "networkidle2" });

      await page.exposeFunction("handleDriverNotFound", () => {
        io.to(driverName).emit("driverNotFound");
      });

      await page.exposeFunction("handleData", (data) => {
        io.to(driverName).emit("lapData", data);
      });

      await page.evaluate(
        ({ driverName, tid, host }) => {
          let lastLapNumber = null;
          let driverFoundOnce = false;

          const extractTextFromHTML = (htmlString, selector) => {
            const tempDiv = document.createElement("div");
            tempDiv.innerHTML = htmlString;
            if (selector) {
              const element = tempDiv.querySelector(selector);
              return element ? element.textContent.trim() : null;
            }
            return tempDiv.textContent.trim();
          };

          const es = new EventSource(`${host}/bramka/live_new.php?tid=${tid}`);

          es.addEventListener("message", (event) => {
            const data = JSON.parse(event.data);

            const driverKey = Object.keys(data).find((key) =>
              data[key].includes(driverName)
            );

            if (!driverKey) {
              if (!driverFoundOnce) {
                window.handleDriverNotFound();
              }
              return;
            }

            if (!driverFoundOnce) {
              driverFoundOnce = true;
            }

            const driverId = driverKey.match(/\d+/)[0];
            const rData = data[`r_data_${driverId}`];
            const qData = data[`q_data_${driverId}`];
            const rlData = data[`rl_data_${driverId}`];
            const qlData = data[`ql_data_${driverId}`];

            const currentLap =
              extractTextFromHTML(rData, `#lapsr_${driverId}`) ||
              extractTextFromHTML(qData, `.laps`);

            const lastLapTime =
              extractTextFromHTML(rData, `#lastlapr_${driverId}`) ||
              extractTextFromHTML(qData, `#lastlap_${driverId}`) ||
              extractTextFromHTML(rlData, `.lastlap`);

            const bestLapTime =
              extractTextFromHTML(rData, `.bestlapr`) ||
              extractTextFromHTML(qData, `#bestlap_${driverId}`) ||
              extractTextFromHTML(qlData, `.bestlap`);

            if (currentLap && currentLap !== lastLapNumber) {
              lastLapNumber = currentLap;

              window.handleData({
                driverName,
                currentLap,
                lastLapTime,
                bestLapTime,
              });
            }
          });

          es.onerror = (err) => {
            console.error("EventSource error:", err);
          };
        },
        { driverName, tid, host }
      );
    } catch (err) {
      console.error("Error launching Puppeteer:", err);
      socket.emit("error", "Internal server error");
    }
  });

  socket.on("disconnect", async () => {
    console.log("Client disconnected:", socket.id);
    if (browsers.has(socket.id)) {
      try {
        await browsers.get(socket.id).close();
      } catch (e) {
        console.error("Error closing browser on disconnect:", e);
      }
      browsers.delete(socket.id);
    }
  });
});

server.listen(port, () => {
  console.log(`🚀 Server running at http://localhost:${port}`);
});
