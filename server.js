// server.js
const express = require("express");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const multer = require("multer");
const sqlite3 = require("sqlite3").verbose();

const app = express();
const PORT = process.env.PORT || 3000;

const DATA_DIR = path.join(__dirname, "data");
const UPLOADS_DIR = path.join(__dirname, "uploads");
fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(UPLOADS_DIR, { recursive: true });

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// statics
app.use(express.static(path.join(__dirname, "public"))); // tu trzymaj login.html/admin.html/seller.html/app.js/app.css

// --- DB ---
const dbPath = path.join(DATA_DIR, "app.sqlite");
const db = new sqlite3.Database(dbPath);

function run(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
      if (err) return reject(err);
      resolve({ lastID: this.lastID, changes: this.changes });
    });
  });
}
function get(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) return reject(err);
      resolve(row);
    });
  });
}
function all(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) return reject(err);
      resolve(rows);
    });
  });
}

async function ensureSchema() {
  await run(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT UNIQUE NOT NULL,
      password TEXT NOT NULL,
      role TEXT NOT NULL CHECK(role IN ('admin','seller')),
      display_name TEXT,
      is_banned INTEGER DEFAULT 0,
      warning_active INTEGER DEFAULT 0,
      warning_text TEXT DEFAULT '',
      warning_ack_at TEXT
    )
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS products (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      buy_price_gross REAL NOT NULL DEFAULT 0,
      is_active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL
    )
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      seller_id INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'new' CHECK(status IN ('new','done','problem')),
      total_buy_gross REAL NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      pdf_path TEXT,
      pdf_downloaded_at TEXT,
      problem_reason TEXT,
      problem_note TEXT,

      -- soft-delete:
      is_deleted INTEGER NOT NULL DEFAULT 0,
      deleted_at TEXT,
      deleted_by INTEGER,
      deleted_reason TEXT,

      FOREIGN KEY (seller_id) REFERENCES users(id)
    )
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS order_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_id INTEGER NOT NULL,
      product_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      qty INTEGER NOT NULL,
      buy_price_gross REAL NOT NULL,
      FOREIGN KEY (order_id) REFERENCES orders(id),
      FOREIGN KEY (product_id) REFERENCES products(id)
    )
  `);

  // seed demo users if not exists
  const admin = await get(`SELECT id FROM users WHERE email=?`, ["admin@demo.pl"]);
  if (!admin) {
    await run(
      `INSERT INTO users(email,password,role,display_name) VALUES (?,?,?,?)`,
      ["admin@demo.pl", "admin123", "admin", "Admin"]
    );
  }
  const seller = await get(`SELECT id FROM users WHERE email=?`, ["seller@demo.pl"]);
  if (!seller) {
    await run(
      `INSERT INTO users(email,password,role,display_name) VALUES (?,?,?,?)`,
      ["seller@demo.pl", "seller123", "seller", "Seller demo"]
    );
  }
}

function nowSql() {
  // YYYY-MM-DD HH:mm:ss
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(
    d.getMinutes()
  )}:${pad(d.getSeconds())}`;
}

// --- AUTH (prosta sesja w pamięci) ---
const sessions = new Map(); // token -> {id,email,role}

function makeToken() {
  return crypto.randomBytes(24).toString("hex");
}
function authRequired(req, res, next) {
  const token = req.header("x-auth-token");
  if (!token) return res.status(401).json({ error: "Brak tokenu" });
  const s = sessions.get(token);
  if (!s) return res.status(401).json({ error: "Nieprawidłowy token" });
  req.user = s;
  next();
}
function requireRole(role) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: "Brak tokenu" });
    if (req.user.role !== role) return res.status(403).json({ error: "Brak uprawnień" });
    next();
  };
}

// --- FILE UPLOAD ---
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOADS_DIR),
  filename: (req, file, cb) => {
    const safe = file.originalname.replace(/[^a-zA-Z0-9._-]/g, "_");
    cb(null, `${Date.now()}_${crypto.randomBytes(6).toString("hex")}_${safe}`);
  },
});
const upload = multer({
  storage,
  limits: { fileSize: 20 * 1024 * 1024 }, // 20MB
});

// --- helpers: fetch orders with items ---
async function getOrders(whereSql = "1=1", params = []) {
  const rows = await all(
    `
    SELECT
      o.*,
      u.email AS seller_email
    FROM orders o
    JOIN users u ON u.id = o.seller_id
    WHERE ${whereSql}
    ORDER BY o.id DESC
  `,
    params
  );

  const ids = rows.map((r) => r.id);
  if (!ids.length) return [];

  const items = await all(
    `
    SELECT order_id, product_id, name, qty, buy_price_gross
    FROM order_items
    WHERE order_id IN (${ids.map(() => "?").join(",")})
    ORDER BY id ASC
  `,
    ids
  );

  const map = new Map();
  for (const it of items) {
    if (!map.has(it.order_id)) map.set(it.order_id, []);
    map.get(it.order_id).push(it);
  }

  return rows.map((o) => ({
    id: o.id,
    seller_id: o.seller_id,
    seller_email: o.seller_email,
    status: o.status,
    total_buy_gross: o.total_buy_gross,
    created_at: o.created_at,
    pdf_downloaded_at: o.pdf_downloaded_at,
    problem_reason: o.problem_reason,
    problem_note: o.problem_note,
    is_deleted: o.is_deleted,
    items: map.get(o.id) || [],
  }));
}

function parseDateParam(s) {
  // input type=date -> YYYY-MM-DD
  if (!s) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  return s;
}

// --- PDF generator without deps (very simple) ---
function simpleTextPdfBuffer(title, lines) {
  // minimal PDF syntax (enough for most viewers)
  const esc = (t) =>
    String(t)
      .replace(/\\/g, "\\\\")
      .replace(/\(/g, "\\(")
      .replace(/\)/g, "\\)");

  const contentLines = [
    "BT",
    "/F1 18 Tf",
    "72 760 Td",
    `(${esc(title)}) Tj`,
    "/F1 12 Tf",
    "0 -28 Td",
    ...lines.flatMap((ln) => [`(${esc(ln)}) Tj`, "0 -16 Td"]),
    "ET",
  ].join("\n");

  const objs = [];
  objs.push("1 0 obj<< /Type /Catalog /Pages 2 0 R >>endobj");
  objs.push("2 0 obj<< /Type /Pages /Kids [3 0 R] /Count 1 >>endobj");
  objs.push(
    "3 0 obj<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources<< /Font<< /F1 4 0 R >> >> /Contents 5 0 R >>endobj"
  );
  objs.push("4 0 obj<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>endobj");
  objs.push(`5 0 obj<< /Length ${Buffer.byteLength(contentLines, "utf8")} >>stream\n${contentLines}\nendstream\nendobj`);

  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  for (const obj of objs) {
    offsets.push(Buffer.byteLength(pdf, "utf8"));
    pdf += obj + "\n";
  }
  const xrefStart = Buffer.byteLength(pdf, "utf8");
  pdf += `xref\n0 ${objs.length + 1}\n`;
  pdf += `0000000000 65535 f \n`;
  for (let i = 1; i < offsets.length; i++) {
    pdf += `${String(offsets[i]).padStart(10, "0")} 00000 n \n`;
  }
  pdf += `trailer<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF`;
  return Buffer.from(pdf, "utf8");
}

// --- ROUTES ---

// login
app.post("/api/login", async (req, res) => {
  try {
    const { email, password } = req.body || {};
    if (!email || !password) return res.status(400).json({ error: "Podaj email i hasło" });

    const u = await get(`SELECT * FROM users WHERE email=?`, [email.trim()]);
    if (!u || u.password !== password) return res.status(401).json({ error: "Błędny login lub hasło" });
    if (u.role === "seller" && u.is_banned === 1) return res.status(403).json({ error: "Konto zablokowane" });

    const token = makeToken();
    sessions.set(token, { id: u.id, email: u.email, role: u.role });
    res.json({ token, role: u.role, email: u.email });
  } catch (e) {
    res.status(500).json({ error: "Błąd serwera" });
  }
});

// products (admin & seller)
app.get("/api/products", authRequired, async (req, res) => {
  try {
    if (req.user.role === "seller") {
      const u = await get(`SELECT is_banned FROM users WHERE id=?`, [req.user.id]);
      if (u && u.is_banned === 1) return res.status(403).json({ error: "Konto zablokowane" });

      const rows = await all(
        `SELECT id,name,buy_price_gross,is_active FROM products WHERE is_active=1 ORDER BY id DESC`
      );
      return res.json(rows);
    } else {
      const rows = await all(`SELECT id,name,buy_price_gross,is_active FROM products ORDER BY id DESC`);
      return res.json(rows);
    }
  } catch (e) {
    res.status(500).json({ error: "Błąd" });
  }
});

app.post("/api/products", authRequired, requireRole("admin"), async (req, res) => {
  try {
    const { name, buy_price_gross } = req.body || {};
    const nm = String(name || "").trim();
    const price = Number(buy_price_gross);
    if (!nm || !Number.isFinite(price)) return res.status(400).json({ error: "Złe dane" });

    await run(
      `INSERT INTO products(name,buy_price_gross,is_active,created_at) VALUES (?,?,1,?)`,
      [nm, price, nowSql()]
    );
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: "Błąd" });
  }
});

app.delete("/api/products/:id", authRequired, requireRole("admin"), async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!id) return res.status(400).json({ error: "Złe ID" });
    await run(`UPDATE products SET is_active=0 WHERE id=?`, [id]);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: "Błąd" });
  }
});

// seller warning
app.get("/api/seller/warning", authRequired, requireRole("seller"), async (req, res) => {
  try {
    const u = await get(`SELECT warning_active, warning_text, warning_ack_at, is_banned FROM users WHERE id=?`, [req.user.id]);
    if (u && u.is_banned === 1) return res.status(403).json({ error: "Konto zablokowane" });
    res.json({
      warning_active: u ? u.warning_active === 1 : 0,
      warning_text: u ? u.warning_text : "",
      warning_ack_at: u ? u.warning_ack_at : null,
    });
  } catch (e) {
    res.status(500).json({ error: "Błąd" });
  }
});

app.post("/api/seller/warning/ack", authRequired, requireRole("seller"), async (req, res) => {
  try {
    await run(`UPDATE users SET warning_ack_at=? WHERE id=?`, [nowSql(), req.user.id]);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: "Błąd" });
  }
});

// orders list for admin (exclude deleted)
app.get("/api/orders", authRequired, requireRole("admin"), async (req, res) => {
  try {
    const list = await getOrders(`o.is_deleted=0`);
    res.json(list);
  } catch (e) {
    res.status(500).json({ error: "Błąd" });
  }
});

// seller orders list (exclude deleted)
app.get("/api/my-orders", authRequired, requireRole("seller"), async (req, res) => {
  try {
    const u = await get(`SELECT is_banned FROM users WHERE id=?`, [req.user.id]);
    if (u && u.is_banned === 1) return res.status(403).json({ error: "Konto zablokowane" });

    const rows = await getOrders(`o.is_deleted=0 AND o.seller_id=?`, [req.user.id]);
    // seller UI expects o.total (they used total), so map:
    res.json(
      rows.map((o) => ({
        id: o.id,
        created_at: o.created_at,
        status: o.status,
        total: o.total_buy_gross,
        items: o.items,
        problem_reason: o.problem_reason,
        problem_note: o.problem_note,
        pdf_downloaded_at: o.pdf_downloaded_at,
      }))
    );
  } catch (e) {
    res.status(500).json({ error: "Błąd" });
  }
});

// seller create order (pdf required)
app.post(
  "/api/orders",
  authRequired,
  requireRole("seller"),
  upload.single("pdf"),
  async (req, res) => {
    try {
      const u = await get(`SELECT is_banned FROM users WHERE id=?`, [req.user.id]);
      if (u && u.is_banned === 1) return res.status(403).json({ error: "Konto zablokowane" });

      if (!req.file) return res.status(400).json({ error: "PDF jest obowiązkowy" });

      let items = [];
      try {
        items = JSON.parse(req.body.items || "[]");
      } catch {
        return res.status(400).json({ error: "Złe items" });
      }
      if (!Array.isArray(items) || items.length === 0) return res.status(400).json({ error: "Brak pozycji" });

      // fetch product data
      const ids = items.map((i) => Number(i.product_id)).filter(Boolean);
      const prows = await all(
        `SELECT id,name,buy_price_gross,is_active FROM products WHERE id IN (${ids.map(() => "?").join(",")})`,
        ids
      );
      const pmap = new Map(prows.map((p) => [p.id, p]));
      for (const it of items) {
        const p = pmap.get(Number(it.product_id));
        if (!p || p.is_active !== 1) return res.status(400).json({ error: "Produkt nieaktywny lub nie istnieje" });
        const qty = Number(it.qty);
        if (!Number.isInteger(qty) || qty < 1) return res.status(400).json({ error: "Zła ilość" });
      }

      let total = 0;
      for (const it of items) {
        const p = pmap.get(Number(it.product_id));
        total += Number(it.qty) * Number(p.buy_price_gross);
      }

      const createdAt = nowSql();
      const oIns = await run(
        `INSERT INTO orders(seller_id,status,total_buy_gross,created_at,pdf_path,is_deleted) VALUES (?,?,?,?,?,0)`,
        [req.user.id, "new", total, createdAt, req.file.path]
      );
      const orderId = oIns.lastID;

      for (const it of items) {
        const p = pmap.get(Number(it.product_id));
        await run(
          `INSERT INTO order_items(order_id,product_id,name,qty,buy_price_gross) VALUES (?,?,?,?,?)`,
          [orderId, p.id, p.name, Number(it.qty), Number(p.buy_price_gross)]
        );
      }

      res.json({ ok: true, order_id: orderId });
    } catch (e) {
      res.status(500).json({ error: "Błąd tworzenia zamówienia" });
    }
  }
);

// admin download order pdf -> mark done + set pdf_downloaded_at
app.get("/api/orders/:id/pdf", authRequired, requireRole("admin"), async (req, res) => {
  try {
    const id = Number(req.params.id);
    const o = await get(`SELECT * FROM orders WHERE id=?`, [id]);
    if (!o || o.is_deleted === 1) return res.status(404).json({ error: "Nie znaleziono" });
    if (!o.pdf_path || !fs.existsSync(o.pdf_path)) return res.status(404).json({ error: "Brak pliku PDF" });

    // mark done if not problem
    const downloadedAt = nowSql();
    const newStatus = o.status === "problem" ? "problem" : "done";
    await run(`UPDATE orders SET pdf_downloaded_at=?, status=? WHERE id=?`, [downloadedAt, newStatus, id]);

    const filename = `order-${id}.pdf`;
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    fs.createReadStream(o.pdf_path).pipe(res);
  } catch (e) {
    res.status(500).json({ error: "Błąd" });
  }
});

// admin mark problem / clear
app.patch("/api/orders/:id/problem", authRequired, requireRole("admin"), async (req, res) => {
  try {
    const id = Number(req.params.id);
    const { reason, note } = req.body || {};
    const o = await get(`SELECT id,is_deleted FROM orders WHERE id=?`, [id]);
    if (!o || o.is_deleted === 1) return res.status(404).json({ error: "Nie znaleziono" });

    await run(`UPDATE orders SET status='problem', problem_reason=?, problem_note=? WHERE id=?`, [
      String(reason || "inne"),
      String(note || ""),
      id,
    ]);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: "Błąd" });
  }
});

app.patch("/api/orders/:id/clear-problem", authRequired, requireRole("admin"), async (req, res) => {
  try {
    const id = Number(req.params.id);
    const o = await get(`SELECT id,is_deleted FROM orders WHERE id=?`, [id]);
    if (!o || o.is_deleted === 1) return res.status(404).json({ error: "Nie znaleziono" });

    await run(`UPDATE orders SET status='new', problem_reason=NULL, problem_note=NULL WHERE id=?`, [id]);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: "Błąd" });
  }
});

// ✅ NEW: admin delete order (soft-delete) -> removed from stats
app.delete("/api/admin/orders/:id", authRequired, requireRole("admin"), async (req, res) => {
  try {
    const id = Number(req.params.id);
    const reason = String((req.body && req.body.reason) || "usuniete przez admina");
    const o = await get(`SELECT * FROM orders WHERE id=?`, [id]);
    if (!o || o.is_deleted === 1) return res.status(404).json({ error: "Nie znaleziono" });

    await run(
      `UPDATE orders SET is_deleted=1, deleted_at=?, deleted_by=?, deleted_reason=? WHERE id=?`,
      [nowSql(), req.user.id, reason, id]
    );
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: "Błąd" });
  }
});

// admin sellers
app.get("/api/admin/sellers", authRequired, requireRole("admin"), async (req, res) => {
  try {
    const rows = await all(
      `SELECT id,email,display_name,is_banned,warning_active FROM users WHERE role='seller' ORDER BY id DESC`
    );
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: "Błąd" });
  }
});

app.post("/api/admin/sellers", authRequired, requireRole("admin"), async (req, res) => {
  try {
    const { email, password, display_name } = req.body || {};
    const em = String(email || "").trim();
    const pw = String(password || "").trim();
    if (!em || !pw) return res.status(400).json({ error: "Email i hasło są wymagane" });

    await run(
      `INSERT INTO users(email,password,role,display_name,is_banned,warning_active,warning_text) VALUES (?,?, 'seller', ?, 0, 0, '')`,
      [em, pw, String(display_name || "").trim()]
    );
    res.json({ ok: true });
  } catch (e) {
    if (String(e.message || "").includes("UNIQUE")) return res.status(400).json({ error: "Taki email już istnieje" });
    res.status(500).json({ error: "Błąd" });
  }
});

app.patch("/api/admin/sellers/:id", authRequired, requireRole("admin"), async (req, res) => {
  try {
    const id = Number(req.params.id);
    const { is_banned, warning_active, warning_text } = req.body || {};

    const u = await get(`SELECT id FROM users WHERE id=? AND role='seller'`, [id]);
    if (!u) return res.status(404).json({ error: "Nie znaleziono" });

    // partial updates
    if (typeof is_banned !== "undefined") await run(`UPDATE users SET is_banned=? WHERE id=?`, [Number(is_banned) ? 1 : 0, id]);
    if (typeof warning_active !== "undefined") await run(`UPDATE users SET warning_active=? WHERE id=?`, [Number(warning_active) ? 1 : 0, id]);
    if (typeof warning_text !== "undefined") await run(`UPDATE users SET warning_text=? WHERE id=?`, [String(warning_text || ""), id]);

    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: "Błąd" });
  }
});

// admin seller profile + stats all + optional range
app.get("/api/admin/sellers/:id", authRequired, requireRole("admin"), async (req, res) => {
  try {
    const id = Number(req.params.id);
    const from = parseDateParam(req.query.from);
    const to = parseDateParam(req.query.to);

    const seller = await get(
      `SELECT id,email,display_name,is_banned,warning_active,warning_text FROM users WHERE id=? AND role='seller'`,
      [id]
    );
    if (!seller) return res.status(404).json({ error: "Nie znaleziono" });

    // ALL (exclude deleted)
    const allStats = await get(
      `
      SELECT
        COUNT(*) AS total_orders,
        COALESCE(SUM(total_buy_gross),0) AS total_turnover
      FROM orders
      WHERE is_deleted=0 AND seller_id=?
    `,
      [id]
    );

    // TODAY
    const today = new Date();
    const pad = (n) => String(n).padStart(2, "0");
    const todayStr = `${today.getFullYear()}-${pad(today.getMonth() + 1)}-${pad(today.getDate())}`;
    const todayStats = await get(
      `
      SELECT
        COUNT(*) AS today_orders,
        COALESCE(SUM(total_buy_gross),0) AS today_turnover
      FROM orders
      WHERE is_deleted=0 AND seller_id=? AND substr(created_at,1,10)=?
    `,
      [id, todayStr]
    );

    const all = {
      total_orders: Number(allStats.total_orders || 0),
      total_turnover: Number(allStats.total_turnover || 0),
      today_orders: Number(todayStats.today_orders || 0),
      today_turnover: Number(todayStats.today_turnover || 0),
    };

    let range = { total_orders: 0, total_turnover: 0, orders: [] };
    if (from && to) {
      const rangeRows = await getOrders(
        `o.is_deleted=0 AND o.seller_id=? AND substr(o.created_at,1,10) >= ? AND substr(o.created_at,1,10) <= ?`,
        [id, from, to]
      );
      range.total_orders = rangeRows.length;
      range.total_turnover = rangeRows.reduce((s, o) => s + Number(o.total_buy_gross || 0), 0);
      range.orders = rangeRows;
    }

    res.json({ seller, all, range });
  } catch (e) {
    res.status(500).json({ error: "Błąd" });
  }
});

// ✅ admin export PDF for seller range
app.get("/api/admin/sellers/:id/export.pdf", authRequired, requireRole("admin"), async (req, res) => {
  try {
    const id = Number(req.params.id);
    const from = parseDateParam(req.query.from);
    const to = parseDateParam(req.query.to);
    if (!from || !to) return res.status(400).json({ error: "Brak dat od/do" });

    const seller = await get(`SELECT email,display_name FROM users WHERE id=? AND role='seller'`, [id]);
    if (!seller) return res.status(404).json({ error: "Nie znaleziono sprzedawcy" });

    const rows = await getOrders(
      `o.is_deleted=0 AND o.seller_id=? AND substr(o.created_at,1,10) >= ? AND substr(o.created_at,1,10) <= ?`,
      [id, from, to]
    );

    const total = rows.reduce((s, o) => s + Number(o.total_buy_gross || 0), 0);

    const lines = [
      `Sprzedawca: ${seller.display_name ? `${seller.display_name} (${seller.email})` : seller.email}`,
      `Zakres: ${from} -> ${to}`,
      `Zamowien: ${rows.length}`,
      `Suma brutto: ${total.toFixed(2)} zl`,
      "",
      "Pozycje:",
    ];

    for (const o of rows) {
      lines.push(`#${o.id} ${o.created_at}  ${o.status.toUpperCase()}  ${Number(o.total_buy_gross || 0).toFixed(2)} zl`);
      const prod = (o.items || []).map((it) => `- ${it.name} x${it.qty}`).join(", ");
      if (prod) lines.push(`   ${prod}`);
    }

    const pdf = simpleTextPdfBuffer("Faktura zbiorcza", lines);

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="faktura_zbiorcza_seller_${id}_${from}_${to}.pdf"`
    );
    res.send(pdf);
  } catch (e) {
    res.status(500).json({ error: "Nie udało się pobrać faktury PDF" });
  }
});

// ✅ NEW: sales summary for all sellers (exclude deleted)
app.get("/api/admin/sales-summary", authRequired, requireRole("admin"), async (req, res) => {
  try {
    const from = parseDateParam(req.query.from);
    const to = parseDateParam(req.query.to);
    if (!from || !to) return res.status(400).json({ error: "Brak dat od/do" });

    const rows = await all(
      `
      SELECT
        oi.name AS name,
        SUM(oi.qty) AS qty,
        SUM(oi.qty * oi.buy_price_gross) AS value
      FROM orders o
      JOIN order_items oi ON oi.order_id = o.id
      WHERE
        o.is_deleted=0
        AND substr(o.created_at,1,10) >= ?
        AND substr(o.created_at,1,10) <= ?
      GROUP BY oi.name
      ORDER BY qty DESC, name ASC
    `,
      [from, to]
    );

    res.json({
      items: rows.map((r) => ({
        name: r.name,
        qty: Number(r.qty || 0),
        value: Number(r.value || 0),
      })),
    });
  } catch (e) {
    res.status(500).json({ error: "Błąd" });
  }
});

(async () => {
  await ensureSchema();
  app.listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`));
})();
