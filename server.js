const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const root = __dirname;
const dataDirectory = path.join(root, "data");
const ordersFile = path.join(dataDirectory, "orders.json");
const port = Number(process.env.PORT || 3000);
const adminPassword = process.env.ADMIN_PASSWORD || "change-this-admin-password";
const sessions = new Map();
fs.mkdirSync(dataDirectory, { recursive: true });
if (!fs.existsSync(ordersFile)) fs.writeFileSync(ordersFile, "[]\n");

function readOrders() { return JSON.parse(fs.readFileSync(ordersFile, "utf8")); }
function writeOrders(orders) { fs.writeFileSync(ordersFile, JSON.stringify(orders, null, 2)); }
function send(res, status, value) { res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" }); res.end(JSON.stringify(value)); }
function jsonBody(req) { return new Promise((resolve, reject) => { let body = ""; req.on("data", chunk => { body += chunk; if (body.length > 100000) req.destroy(); }); req.on("end", () => { try { resolve(body ? JSON.parse(body) : {}); } catch { reject(new Error("Invalid JSON")); } }); }); }
function authorized(req) { const match = /^Bearer (.+)$/.exec(req.headers.authorization || ""); return Boolean(match && sessions.has(match[1]) && sessions.get(match[1]) > Date.now()); }
function confirmationKey() { return crypto.randomBytes(4).toString("hex").toUpperCase().slice(0, 6); }

const mime = { ".html": "text/html", ".css": "text/css", ".js": "text/javascript", ".json": "application/json", ".jpg": "image/jpeg", ".svg": "image/svg+xml" };
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  try {
    if (req.method === "POST" && url.pathname === "/api/admin/login") {
      const { password } = await jsonBody(req);
      if (password !== adminPassword) return send(res, 401, { error: "Incorrect password" });
      const token = crypto.randomBytes(24).toString("hex"); sessions.set(token, Date.now() + 8 * 60 * 60 * 1000);
      return send(res, 200, { token });
    }
    if (req.method === "POST" && url.pathname === "/api/orders") {
      const body = await jsonBody(req);
      const order = { id: Date.now(), items: Array.isArray(body.items) ? body.items.map(item => ({ name: String(item.name).slice(0, 100), price: Number(item.price), quantity: Number(item.quantity) })) : [], total: Number(body.total), deliveryFee: Number(body.deliveryFee), grandTotal: Number(body.grandTotal), location: String(body.location || ""), deliveryTime: String(body.deliveryTime || ""), customerName: String(body.customerName || ""), phone: String(body.phone || ""), address: String(body.address || ""), payment: String(body.payment || "Cash"), status: "Awaiting Admin Confirmation", confirmationStatus: "pending", createdAt: new Date().toISOString() };
      const orders = readOrders(); orders.unshift(order); writeOrders(orders); return send(res, 201, { id: order.id });
    }
    if (req.method === "POST" && url.pathname === "/api/confirmations/validate") {
      const { key } = await jsonBody(req); const order = readOrders().find(item => item.confirmationStatus === "approved" && item.confirmationKey === String(key || "").toUpperCase());
      return send(res, 200, { valid: Boolean(order), orderId: order?.id });
    }
    if (url.pathname.startsWith("/api/admin/orders") && req.method === "GET") {
      if (!authorized(req)) return send(res, 401, { error: "Unauthorized" }); return send(res, 200, readOrders());
    }
    const action = url.pathname.match(/^\/api\/admin\/orders\/([^/]+)\/(approve|decline)$/);
    if (action && req.method === "POST") {
      if (!authorized(req)) return send(res, 401, { error: "Unauthorized" });
      const orders = readOrders(); const order = orders.find(item => String(item.id) === action[1]); if (!order) return send(res, 404, { error: "Order not found" });
      if (action[2] === "approve") { order.confirmationStatus = "approved"; order.confirmationKey = confirmationKey(); order.status = "Delivery Approved"; }
      else { order.confirmationStatus = "declined"; order.confirmationKey = ""; order.status = "Delivery Declined — Payment refused"; }
      writeOrders(orders); return send(res, 200, { order });
    }
    if (req.method !== "GET" && req.method !== "HEAD") return send(res, 405, { error: "Method not allowed" });
    let filePath = path.resolve(root, `.${url.pathname === "/" ? "/index.html" : url.pathname}`);
    if (!filePath.startsWith(root + path.sep)) return send(res, 403, { error: "Forbidden" });
    if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) filePath = path.join(root, "index.html");
    const type = mime[path.extname(filePath)] || "application/octet-stream";
    res.writeHead(200, { "Content-Type": type.startsWith("text/") || type === "application/json" || type === "image/svg+xml" ? `${type}; charset=utf-8` : type }); fs.createReadStream(filePath).pipe(res);
  } catch (error) { send(res, 500, { error: "Server error" }); }
});
server.listen(port, () => console.log(`Akara & Koko running at http://localhost:${port}`));
