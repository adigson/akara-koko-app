const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { Pool } = require("pg");

const root = __dirname;
const dataDirectory = path.join(root, "data");
const ordersFile = path.join(dataDirectory, "orders.json");
const sessionsFile = path.join(dataDirectory, "sessions.json");
const adminCredentialFile = path.join(dataDirectory, "admin.json");
const port = Number(process.env.PORT || 3000);
const databaseUrl = process.env.DATABASE_URL;
const sessionDurationMs = 8 * 60 * 60 * 1000;
const loginAttempts = new Map();
const loginWindowMs = 15 * 60 * 1000;
const loginLimit = 5;

fs.mkdirSync(dataDirectory, { recursive: true });
if (!fs.existsSync(ordersFile)) fs.writeFileSync(ordersFile, "[]\n");
if (!fs.existsSync(sessionsFile)) fs.writeFileSync(sessionsFile, "[]\n");

function writeJson(file, value) {
  const temporaryFile = `${file}.tmp`;
  fs.writeFileSync(temporaryFile, JSON.stringify(value, null, 2));
  fs.renameSync(temporaryFile, file);
}
if (!databaseUrl) throw new Error("DATABASE_URL is required. Configure a PostgreSQL database before starting.");
const pool = new Pool({
  connectionString: databaseUrl,
  ssl: databaseUrl.includes("sslmode=require") ? { rejectUnauthorized: false } : undefined
});
function mapOrder(row) {
  return {
    id: Number(row.id),
    items: row.items || [],
    total: Number(row.total),
    deliveryFee: Number(row.delivery_fee),
    grandTotal: Number(row.grand_total),
    location: row.location,
    deliveryTime: row.delivery_time,
    customerName: row.customer_name,
    phone: row.phone,
    address: row.address,
    payment: row.payment,
    status: row.status,
    confirmationStatus: row.confirmation_status,
    confirmationKey: row.confirmation_key,
    createdAt: row.created_at
  };
}
async function readOrders() {
  const result = await pool.query("SELECT * FROM orders ORDER BY created_at DESC");
  return result.rows.map(mapOrder);
}
async function initializeDatabase() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS orders (
      id BIGINT PRIMARY KEY,
      items JSONB NOT NULL DEFAULT '[]'::jsonb,
      total NUMERIC NOT NULL DEFAULT 0,
      delivery_fee NUMERIC NOT NULL DEFAULT 0,
      grand_total NUMERIC NOT NULL DEFAULT 0,
      location TEXT NOT NULL DEFAULT '',
      delivery_time TEXT NOT NULL DEFAULT '',
      customer_name TEXT NOT NULL DEFAULT '',
      phone TEXT NOT NULL DEFAULT '',
      address TEXT NOT NULL DEFAULT '',
      payment TEXT NOT NULL DEFAULT 'Cash',
      status TEXT NOT NULL DEFAULT 'Awaiting Admin Confirmation',
      confirmation_status TEXT NOT NULL DEFAULT 'pending',
      confirmation_key TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS order_audit (
      id BIGSERIAL PRIMARY KEY,
      order_id BIGINT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
      action TEXT NOT NULL CHECK (action IN ('approved', 'declined', 'completed')),
      previous_status TEXT,
      new_status TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query("CREATE INDEX IF NOT EXISTS order_audit_order_id_idx ON order_audit(order_id)");
  await pool.query("CREATE INDEX IF NOT EXISTS orders_created_at_idx ON orders(created_at DESC)");

  if (!fs.existsSync(ordersFile)) return;
  const legacyOrders = JSON.parse(fs.readFileSync(ordersFile, "utf8"));
  for (const order of legacyOrders) {
    await pool.query(`
      INSERT INTO orders (
        id, items, total, delivery_fee, grand_total, location, delivery_time,
        customer_name, phone, address, payment, status, confirmation_status,
        confirmation_key, created_at
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
      ON CONFLICT (id) DO NOTHING
    `, [
      order.id, JSON.stringify(order.items || []), order.total || 0,
      order.deliveryFee || 0, order.grandTotal || 0, order.location || "",
      order.deliveryTime || "", order.customerName || "", order.phone || "",
      order.address || "", order.payment || "Cash",
      order.status || "Awaiting Admin Confirmation",
      order.confirmationStatus || "pending", order.confirmationKey || null,
      order.createdAt || new Date()
    ]);
  }
}
function readSessions() {
  try {
    const sessions = JSON.parse(fs.readFileSync(sessionsFile, "utf8"));
    const active = sessions.filter(session => Number(session.expiresAt) > Date.now());
    if (active.length !== sessions.length) writeJson(sessionsFile, active);
    return active;
  } catch {
    writeJson(sessionsFile, []);
    return [];
  }
}
function saveSessions(sessions) { writeJson(sessionsFile, sessions); }
function hashToken(token) { return crypto.createHash("sha256").update(token).digest("hex"); }
function passwordHash(password, salt) {
  return crypto.pbkdf2Sync(password, salt, 200000, 64, "sha512").toString("hex");
}
function loadAdminCredential() {
  if (fs.existsSync(adminCredentialFile)) {
    const credential = JSON.parse(fs.readFileSync(adminCredentialFile, "utf8"));
    if (!credential.salt || !credential.passwordHash) throw new Error("Invalid admin credential");
    return credential;
  }
  const password = process.env.ADMIN_PASSWORD;
  if (!password) throw new Error("Set ADMIN_PASSWORD before starting the server for the first time");
  const credential = { salt: crypto.randomBytes(16).toString("hex"), passwordHash: "" };
  credential.passwordHash = passwordHash(password, credential.salt);
  writeJson(adminCredentialFile, credential);
  fs.chmodSync(adminCredentialFile, 0o600);
  return credential;
}
const adminCredential = loadAdminCredential();
function validAdminPassword(password) {
  const candidate = passwordHash(String(password || ""), adminCredential.salt);
  const expected = Buffer.from(adminCredential.passwordHash, "hex");
  const actual = Buffer.from(candidate, "hex");
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}
function clientKey(req) { return String(req.socket.remoteAddress || "unknown"); }
function loginAllowed(req) {
  const key = clientKey(req);
  const now = Date.now();
  const attempts = (loginAttempts.get(key) || []).filter(timestamp => timestamp > now - loginWindowMs);
  loginAttempts.set(key, attempts);
  return attempts.length < loginLimit;
}
function recordFailedLogin(req) {
  const key = clientKey(req);
  const attempts = loginAttempts.get(key) || [];
  attempts.push(Date.now());
  loginAttempts.set(key, attempts);
}
function clearLoginAttempts(req) { loginAttempts.delete(clientKey(req)); }
function send(res, status, value) { res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" }); res.end(JSON.stringify(value)); }
function jsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", chunk => {
      body += chunk;
      if (body.length > 100000) req.destroy();
    });
    req.on("end", () => {
      try { resolve(body ? JSON.parse(body) : {}); }
      catch { reject(new Error("Invalid JSON")); }
    });
  });
}
function authorized(req) {
  const authorization = String(req.headers.authorization || "");
  const match = authorization.match(/^Bearer\s+(.+)$/i);
  if (!match) return false;
  const tokenHash = hashToken(match[1]);
  return readSessions().some(session => session.tokenHash === tokenHash && Number(session.expiresAt) > Date.now());
}
function confirmationKey() { return crypto.randomBytes(4).toString("hex").toUpperCase().slice(0, 6); }

const mime = { ".html": "text/html", ".css": "text/css", ".js": "text/javascript", ".json": "application/json", ".jpg": "image/jpeg", ".svg": "image/svg+xml" };
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  try {
    if (req.method === "POST" && url.pathname === "/api/admin/login") {
      const { password } = await jsonBody(req);
      if (!loginAllowed(req)) return send(res, 429, { error: "Too many login attempts. Try again later." });
      if (!validAdminPassword(password)) {
        recordFailedLogin(req);
        return send(res, 401, { error: "Incorrect password" });
      }
      clearLoginAttempts(req);
      const token = crypto.randomBytes(32).toString("hex");
      const sessions = readSessions();
      sessions.push({ tokenHash: hashToken(token), expiresAt: Date.now() + sessionDurationMs });
      saveSessions(sessions);
      return send(res, 200, { token });
    }
    if (req.method === "POST" && url.pathname === "/api/orders") {
      const body = await jsonBody(req);
      const order = { id: Date.now(), items: Array.isArray(body.items) ? body.items.map(item => ({ name: String(item.name).slice(0, 100), price: Number(item.price), quantity: Number(item.quantity) })) : [], total: Number(body.total), deliveryFee: Number(body.deliveryFee), grandTotal: Number(body.grandTotal), location: String(body.location || ""), deliveryTime: String(body.deliveryTime || ""), customerName: String(body.customerName || ""), phone: String(body.phone || ""), address: String(body.address || ""), payment: String(body.payment || "Cash"), status: "Awaiting Admin Confirmation", confirmationStatus: "pending", createdAt: new Date().toISOString() };
      await pool.query(`
        INSERT INTO orders (
          id, items, total, delivery_fee, grand_total, location, delivery_time,
          customer_name, phone, address, payment, status, confirmation_status, created_at
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
      `, [
        order.id, JSON.stringify(order.items), order.total, order.deliveryFee,
        order.grandTotal, order.location, order.deliveryTime, order.customerName,
        order.phone, order.address, order.payment, order.status,
        order.confirmationStatus, order.createdAt
      ]);
      return send(res, 201, { id: order.id });
    }
    if (req.method === "POST" && url.pathname === "/api/confirmations/validate") {
      const { key } = await jsonBody(req);
      const result = await pool.query(
        "SELECT id FROM orders WHERE confirmation_status = 'approved' AND confirmation_key = $1",
        [String(key || "").toUpperCase()]
      );
      const order = result.rows[0];
      return send(res, 200, { valid: Boolean(order), orderId: order ? Number(order.id) : undefined });
    }
    if (url.pathname.startsWith("/api/admin/orders") && req.method === "GET") {
      if (!authorized(req)) return send(res, 401, { error: "Unauthorized" });
      return send(res, 200, await readOrders());
    }
    const audit = url.pathname.match(/^\/api\/admin\/orders\/([^/]+)\/audit$/);
    if (audit && req.method === "GET") {
      if (!authorized(req)) return send(res, 401, { error: "Unauthorized" });
      const result = await pool.query(
        "SELECT id, order_id, action, previous_status, new_status, created_at FROM order_audit WHERE order_id = $1 ORDER BY created_at DESC",
        [audit[1]]
      );
      return send(res, 200, result.rows);
    }
    const action = url.pathname.match(/^\/api\/admin\/orders\/([^/]+)\/(approve|decline|complete)$/);
    if (action && req.method === "POST") {
      if (!authorized(req)) return send(res, 401, { error: "Unauthorized" });
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const existing = await client.query("SELECT * FROM orders WHERE id = $1 FOR UPDATE", [action[1]]);
        if (!existing.rows[0]) {
          await client.query("ROLLBACK");
          return send(res, 404, { error: "Order not found" });
        }
        const previousStatus = existing.rows[0].status;
        let status;
        let confirmationStatus = existing.rows[0].confirmation_status;
        let confirmationKey = existing.rows[0].confirmation_key;
        let auditAction;
        if (action[2] === "approve") {
          status = "Delivery Approved";
          confirmationStatus = "approved";
          confirmationKey = crypto.randomBytes(4).toString("hex").toUpperCase().slice(0, 6);
          auditAction = "approved";
        } else if (action[2] === "decline") {
          status = "Delivery Declined - Payment refused";
          confirmationStatus = "declined";
          confirmationKey = null;
          auditAction = "declined";
        } else {
          status = "Delivery Completed";
          auditAction = "completed";
        }
        const updated = await client.query(`
          UPDATE orders
          SET status = $2, confirmation_status = $3, confirmation_key = $4, updated_at = NOW()
          WHERE id = $1
          RETURNING *
        `, [action[1], status, confirmationStatus, confirmationKey]);
        await client.query(
          "INSERT INTO order_audit (order_id, action, previous_status, new_status) VALUES ($1,$2,$3,$4)",
          [action[1], auditAction, previousStatus, status]
        );
        await client.query("COMMIT");
        return send(res, 200, { order: mapOrder(updated.rows[0]) });
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    }
    if (req.method !== "GET" && req.method !== "HEAD") return send(res, 405, { error: "Method not allowed" });
    let filePath = path.resolve(root, `.${url.pathname === "/" ? "/index.html" : url.pathname}`);
    if (!filePath.startsWith(root + path.sep)) return send(res, 403, { error: "Forbidden" });
    if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) filePath = path.join(root, "index.html");
    const type = mime[path.extname(filePath)] || "application/octet-stream";
    res.writeHead(200, { "Content-Type": type.startsWith("text/") || type === "application/json" || type === "image/svg+xml" ? `${type}; charset=utf-8` : type });
    fs.createReadStream(filePath).pipe(res);
  } catch (error) {
    if (error.message === "Invalid JSON") return send(res, 400, { error: error.message });
    console.error(error);
    send(res, 500, { error: "Server error" });
  }
});
initializeDatabase()
  .then(() => server.listen(port, () => console.log(`Akara & Koko running at http://localhost:${port}`)))
  .catch(error => {
    console.error("Database initialization failed:", error.message);
    process.exit(1);
  });
