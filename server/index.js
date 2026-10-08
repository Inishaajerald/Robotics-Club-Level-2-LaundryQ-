const express = require("express");
const cors = require("cors");
const crypto = require("crypto");
const { DatabaseSync } = require("node:sqlite");

const app = express();
app.use(cors());
app.use(express.json());

const OVERDUE_MINUTES = 10;
const RESERVE_MINUTES = 5;
const MACHINE_COUNT = 3;
const MAX_MACHINES_PER_PERSON = 1;
const STATS_DAYS = 30;
const MIN_PASSWORD_LENGTH = 6;

const ROLL_NO_PATTERN = /^\d{2}[A-Z]{3}\d{4}$/;

const ADMIN_REG_NO = "ADMIN";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "admin1234";

// ---------- Database ----------
const db = new DatabaseSync("laundryq.db");

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    reg_no               TEXT PRIMARY KEY,
    salt                 TEXT NOT NULL,
    hash                 TEXT NOT NULL,
    created_at           INTEGER NOT NULL,
    is_admin             INTEGER NOT NULL DEFAULT 0,
    must_change_password INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS sessions (
    token      TEXT PRIMARY KEY,
    reg_no     TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS machines (
    id            INTEGER PRIMARY KEY,
    status        TEXT NOT NULL DEFAULT 'free',
    reg_no        TEXT,
    started_at    INTEGER,
    cycle_minutes INTEGER,
    finished_at   INTEGER,
    reserved_for  TEXT,
    reserved_at   INTEGER
  );

  CREATE TABLE IF NOT EXISTS queue (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    reg_no    TEXT NOT NULL UNIQUE,
    joined_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS cycles (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    machine_id    INTEGER NOT NULL,
    reg_no        TEXT NOT NULL,
    started_at    INTEGER NOT NULL,
    cycle_minutes INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_cycles_started_at ON cycles (started_at);

  CREATE TABLE IF NOT EXISTS residents (
    reg_no   TEXT PRIMARY KEY,
    added_at INTEGER NOT NULL
  );
`);

// ---------- Migrations ----------
function hasColumn(table, column) {
  return db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === column);
}

if (!hasColumn("machines", "reserved_at")) {
  db.exec("ALTER TABLE machines ADD COLUMN reserved_at INTEGER");
  console.log("Migration: added machines.reserved_at");
}
if (!hasColumn("users", "is_admin")) {
  db.exec("ALTER TABLE users ADD COLUMN is_admin INTEGER NOT NULL DEFAULT 0");
  console.log("Migration: added users.is_admin");
}
if (!hasColumn("users", "must_change_password")) {
  db.exec("ALTER TABLE users ADD COLUMN must_change_password INTEGER NOT NULL DEFAULT 0");
  console.log("Migration: added users.must_change_password");
}
db.prepare("UPDATE machines SET reserved_at = ? WHERE status = 'reserved' AND reserved_at IS NULL").run(Date.now());

const machineCount = db.prepare("SELECT COUNT(*) AS n FROM machines").get().n;
if (machineCount === 0) {
  const addMachine = db.prepare("INSERT INTO machines (id, status) VALUES (?, 'free')");
  for (let i = 1; i <= MACHINE_COUNT; i++) addMachine.run(i);
}

// ---------- Password helpers ----------
function hashPassword(password, salt) {
  return crypto.scryptSync(password, salt, 64).toString("hex");
}

function verifyPassword(user, password) {
  const attempt = hashPassword(password, user.salt);
  return crypto.timingSafeEqual(Buffer.from(attempt, "hex"), Buffer.from(user.hash, "hex"));
}

// 8 random characters, without look-alikes (no 0/O, 1/I/L)
function makeTempPassword() {
  const chars = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
  return Array.from(crypto.randomBytes(8), (b) => chars[b % chars.length]).join("");
}

// ---------- Prepared queries ----------
const findUser = db.prepare("SELECT * FROM users WHERE reg_no = ?");
const insertUser = db.prepare(
  "INSERT INTO users (reg_no, salt, hash, created_at, is_admin) VALUES (?, ?, ?, ?, ?)"
);
const setPassword = db.prepare(
  "UPDATE users SET salt = ?, hash = ?, must_change_password = ? WHERE reg_no = ?"
);
const findSession = db.prepare(`
  SELECT s.reg_no, u.is_admin, u.must_change_password
  FROM sessions s JOIN users u ON u.reg_no = s.reg_no
  WHERE s.token = ?
`);
const insertSession = db.prepare("INSERT INTO sessions (token, reg_no, created_at) VALUES (?, ?, ?)");
const deleteSession = db.prepare("DELETE FROM sessions WHERE token = ?");
const deleteSessionsFor = db.prepare("DELETE FROM sessions WHERE reg_no = ?");
const deleteOtherSessions = db.prepare("DELETE FROM sessions WHERE reg_no = ? AND token != ?");

const isResident = db.prepare("SELECT reg_no FROM residents WHERE reg_no = ?");
const addResident = db.prepare("INSERT OR IGNORE INTO residents (reg_no, added_at) VALUES (?, ?)");
const removeResident = db.prepare("DELETE FROM residents WHERE reg_no = ?");
const listResidents = db.prepare(`
  SELECT r.reg_no, r.added_at,
         CASE WHEN u.reg_no IS NULL THEN 0 ELSE 1 END AS registered
  FROM residents r LEFT JOIN users u ON u.reg_no = r.reg_no
  ORDER BY r.reg_no
`);

const getAllMachines = db.prepare("SELECT * FROM machines ORDER BY id");
const getMachine = db.prepare("SELECT * FROM machines WHERE id = ?");
const markFinished = db.prepare(`
  UPDATE machines
  SET status = 'done', finished_at = started_at + cycle_minutes * 60000
  WHERE status = 'running' AND started_at + cycle_minutes * 60000 <= ?
`);
const startMachineQuery = db.prepare(`
  UPDATE machines
  SET status = 'running', reg_no = ?, cycle_minutes = ?, started_at = ?,
      finished_at = NULL, reserved_for = NULL, reserved_at = NULL
  WHERE id = ?
`);
const clearMachineQuery = db.prepare(`
  UPDATE machines
  SET status = 'free', reg_no = NULL, started_at = NULL, cycle_minutes = NULL,
      finished_at = NULL, reserved_for = NULL, reserved_at = NULL
  WHERE id = ?
`);
const reserveMachine = db.prepare(
  "UPDATE machines SET status = 'reserved', reserved_for = ?, reserved_at = ? WHERE id = ?"
);
const markOutOfOrder = db.prepare(`
  UPDATE machines
  SET status = 'out_of_order', reg_no = ?, started_at = NULL, cycle_minutes = NULL,
      finished_at = NULL, reserved_for = NULL, reserved_at = NULL
  WHERE id = ?
`);
const findStuckFor = db.prepare("SELECT id FROM machines WHERE status = 'out_of_order' AND reg_no = ?");
const clearStuckClothes = db.prepare("UPDATE machines SET reg_no = NULL WHERE id = ? AND status = 'out_of_order'");

const findExpiredHolds = db.prepare(
  "SELECT id FROM machines WHERE status = 'reserved' AND reserved_at + ? <= ?"
);
const findFreeMachine = db.prepare("SELECT id FROM machines WHERE status = 'free' ORDER BY id LIMIT 1");
const countFree = db.prepare("SELECT COUNT(*) AS n FROM machines WHERE status = 'free'");
const findReservedFor = db.prepare("SELECT id FROM machines WHERE status = 'reserved' AND reserved_for = ?");
const countActiveFor = db.prepare(
  "SELECT COUNT(*) AS n FROM machines WHERE reg_no = ? AND status IN ('running', 'done')"
);

const getQueue = db.prepare("SELECT reg_no, joined_at FROM queue ORDER BY joined_at, id");
const firstInQueue = db.prepare("SELECT * FROM queue ORDER BY joined_at, id LIMIT 1");
const earliestJoin = db.prepare("SELECT MIN(joined_at) AS t FROM queue");
const removeQueueById = db.prepare("DELETE FROM queue WHERE id = ?");
const removeQueueByRegNo = db.prepare("DELETE FROM queue WHERE reg_no = ?");
const findInQueue = db.prepare("SELECT id FROM queue WHERE reg_no = ?");
const addToQueue = db.prepare("INSERT INTO queue (reg_no, joined_at) VALUES (?, ?)");

const insertCycle = db.prepare(
  "INSERT INTO cycles (machine_id, reg_no, started_at, cycle_minutes) VALUES (?, ?, ?, ?)"
);
const busiestHours = db.prepare(`
  SELECT CAST(strftime('%H', started_at / 1000, 'unixepoch', 'localtime') AS INTEGER) AS hour,
         COUNT(*) AS count
  FROM cycles
  WHERE started_at >= ?
  GROUP BY hour
`);

// ---------- Create the admin account once ----------
if (!findUser.get(ADMIN_REG_NO)) {
  const salt = crypto.randomBytes(16).toString("hex");
  insertUser.run(ADMIN_REG_NO, salt, hashPassword(ADMIN_PASSWORD, salt), Date.now(), 1);
  console.log(`Admin account created: ${ADMIN_REG_NO}`);
}

function transaction(fn) {
  db.exec("BEGIN");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

// ---------- Helpers ----------
function cleanRegNo(regNo) {
  return String(regNo || "").trim().toUpperCase();
}

function createSession(regNo) {
  const token = crypto.randomBytes(32).toString("hex");
  insertSession.run(token, regNo, Date.now());
  return token;
}

// Routes a user may still call while they must change their password
const ALLOWED_DURING_FORCED_CHANGE = ["/api/change-password", "/api/logout", "/api/me"];

function requireAuth(req, res, next) {
  const header = req.headers.authorization || "";
  const token = header.replace("Bearer ", "");
  const row = token ? findSession.get(token) : null;
  if (!row) return res.status(401).json({ error: "Please log in" });

  req.regNo = row.reg_no;
  req.isAdmin = row.is_admin === 1;
  req.mustChangePassword = row.must_change_password === 1;
  req.token = token;

  if (req.mustChangePassword && !ALLOWED_DURING_FORCED_CHANGE.includes(req.path)) {
    return res.status(403).json({ error: "Please set a new password first", code: "MUST_CHANGE_PASSWORD" });
  }
  next();
}

function requireAdmin(req, res, next) {
  if (!req.isAdmin) return res.status(403).json({ error: "Admins only" });
  next();
}

function toMachine(row) {
  return {
    id: row.id,
    status: row.status,
    regNo: row.reg_no,
    startedAt: row.started_at,
    cycleMinutes: row.cycle_minutes,
    finishedAt: row.finished_at,
    reservedFor: row.reserved_for,
    reservedAt: row.reserved_at,
  };
}

function isOverdue(m) {
  return m.status === "done" && Date.now() - m.finishedAt > OVERDUE_MINUTES * 60 * 1000;
}

function handOver(machineId) {
  clearMachineQuery.run(machineId);
  const next = firstInQueue.get();
  if (next) {
    reserveMachine.run(next.reg_no, Date.now(), machineId);
    removeQueueById.run(next.id);
  }
}

function addToQueueFront(regNo) {
  const earliest = earliestJoin.get().t;
  const time = earliest === null ? Date.now() : earliest - 1;
  addToQueue.run(regNo, time);
}

function givePriority(regNo) {
  const free = findFreeMachine.get();
  if (free) {
    reserveMachine.run(regNo, Date.now(), free.id);
    return `Machine ${free.id}`;
  }
  removeQueueByRegNo.run(regNo);
  addToQueueFront(regNo);
  return "front of the queue";
}

function refreshStatuses() {
  const now = Date.now();
  markFinished.run(now);
  const expired = findExpiredHolds.all(RESERVE_MINUTES * 60 * 1000, now);
  if (expired.length > 0) {
    transaction(() => expired.forEach((row) => handOver(row.id)));
  }
}

// ---------- Auth routes ----------
app.post("/api/register", (req, res) => {
  const id = cleanRegNo(req.body.regNo);
  const { password } = req.body;

  if (!ROLL_NO_PATTERN.test(id)) {
    return res.status(400).json({
      error: "Roll number must look like 26BCE1697 (2 digits, 3 letters, 4 digits)",
    });
  }
  if (!isResident.get(id)) {
    return res.status(403).json({
      error: "This roll number is not on the hostel residents list. Ask the hostel admin to add you.",
    });
  }
  if (!password || password.length < MIN_PASSWORD_LENGTH) {
    return res.status(400).json({ error: `Password must be at least ${MIN_PASSWORD_LENGTH} characters` });
  }
  if (findUser.get(id)) {
    return res.status(409).json({ error: "This roll number is already registered. Please log in." });
  }

  const salt = crypto.randomBytes(16).toString("hex");
  try {
    insertUser.run(id, salt, hashPassword(password, salt), Date.now(), 0);
  } catch {
    return res.status(409).json({ error: "This roll number is already registered. Please log in." });
  }

  const token = createSession(id);
  res.status(201).json({ token, regNo: id, isAdmin: false, mustChangePassword: false });
});

app.post("/api/login", (req, res) => {
  const id = cleanRegNo(req.body.regNo);
  const { password } = req.body;

  if (!id || !password) return res.status(400).json({ error: "Enter roll number and password" });

  const user = findUser.get(id);
  const genericError = { error: "Wrong roll number or password" };
  if (!user || !verifyPassword(user, password)) return res.status(401).json(genericError);

  if (user.is_admin !== 1 && !isResident.get(id)) {
    return res.status(403).json({ error: "Your roll number is no longer on the hostel residents list" });
  }

  const token = createSession(id);
  res.json({
    token,
    regNo: id,
    isAdmin: user.is_admin === 1,
    mustChangePassword: user.must_change_password === 1,
  });
});

app.get("/api/me", requireAuth, (req, res) => {
  res.json({ regNo: req.regNo, isAdmin: req.isAdmin, mustChangePassword: req.mustChangePassword });
});

app.post("/api/logout", requireAuth, (req, res) => {
  deleteSession.run(req.token);
  res.json({ message: "Logged out" });
});

// POST /api/change-password: logged-in user changes their own password
app.post("/api/change-password", requireAuth, (req, res) => {
  const { currentPassword, newPassword } = req.body;
  const user = findUser.get(req.regNo);

  if (!currentPassword || !newPassword) {
    return res.status(400).json({ error: "Enter your current and new password" });
  }
  // 400 (not 401) so the app doesn't log the user out for a typo
  if (!verifyPassword(user, currentPassword)) {
    return res.status(400).json({ error: "Current password is wrong" });
  }
  if (newPassword.length < MIN_PASSWORD_LENGTH) {
    return res.status(400).json({ error: `New password must be at least ${MIN_PASSWORD_LENGTH} characters` });
  }
  if (newPassword === currentPassword) {
    return res.status(400).json({ error: "New password must be different from the current one" });
  }

  const salt = crypto.randomBytes(16).toString("hex");
  transaction(() => {
    setPassword.run(salt, hashPassword(newPassword, salt), 0, req.regNo);
    deleteOtherSessions.run(req.regNo, req.token); // log out other devices, keep this one
  });

  res.json({ message: "Password changed" });
});

// ---------- Machine routes ----------
app.get("/api/machines", (req, res) => {
  refreshStatuses();
  const now = Date.now();

  const result = getAllMachines.all().map((row) => {
    const m = toMachine(row);
    let timeLeftSeconds = null;
    let waitingSeconds = null;
    let reserveSecondsLeft = null;

    if (m.status === "running") {
      const endTime = m.startedAt + m.cycleMinutes * 60 * 1000;
      timeLeftSeconds = Math.max(0, Math.round((endTime - now) / 1000));
    }
    if (m.status === "done") {
      waitingSeconds = Math.round((now - m.finishedAt) / 1000);
    }
    if (m.status === "reserved") {
      const holdEnds = m.reservedAt + RESERVE_MINUTES * 60 * 1000;
      reserveSecondsLeft = Math.max(0, Math.round((holdEnds - now) / 1000));
    }

    return { ...m, timeLeftSeconds, waitingSeconds, reserveSecondsLeft, overdue: isOverdue(m) };
  });

  res.json(result);
});

app.post("/api/machines/:id/start", requireAuth, (req, res) => {
  refreshStatuses();
  const id = Number(req.params.id);
  const cycleMinutes = Number(req.body.cycleMinutes);
  const regNo = req.regNo;

  const row = getMachine.get(id);
  if (!row) return res.status(404).json({ error: "Machine not found" });
  if (!cycleMinutes || cycleMinutes <= 0) return res.status(400).json({ error: "Enter a positive cycle length" });

  const machine = toMachine(row);
  if (machine.status === "out_of_order") {
    return res.status(400).json({ error: "This machine is out of order" });
  }
  if (machine.status === "reserved") {
    if (machine.reservedFor !== regNo) {
      return res.status(403).json({ error: "This machine is held for someone else" });
    }
  } else if (machine.status !== "free") {
    return res.status(400).json({ error: "Machine is not free" });
  }

  const stuck = findStuckFor.get(regNo);
  if (stuck) {
    return res.status(400).json({
      error: `Your clothes are still in Machine ${stuck.id}. Remove them and click "I've removed my clothes" first.`,
    });
  }

  if (countActiveFor.get(regNo).n >= MAX_MACHINES_PER_PERSON) {
    return res.status(400).json({ error: "You already have a machine in use. Collect it first." });
  }

  const held = findReservedFor.get(regNo);
  if (held && held.id !== id) {
    return res.status(400).json({ error: `Machine ${held.id} is held for you. Please use that one.` });
  }

  const now = Date.now();
  transaction(() => {
    startMachineQuery.run(regNo, cycleMinutes, now, id);
    removeQueueByRegNo.run(regNo);
    insertCycle.run(id, regNo, now, cycleMinutes);
  });

  res.json(toMachine(getMachine.get(id)));
});

app.post("/api/machines/:id/collect", requireAuth, (req, res) => {
  refreshStatuses();
  const id = Number(req.params.id);

  const row = getMachine.get(id);
  if (!row) return res.status(404).json({ error: "Machine not found" });

  const machine = toMachine(row);
  if (machine.status !== "done") return res.status(400).json({ error: "Nothing to collect yet" });

  const isOwner = machine.regNo === req.regNo;
  if (!isOwner && !isOverdue(machine) && !req.isAdmin) {
    return res.status(403).json({ error: `Only the owner can collect until ${OVERDUE_MINUTES} minutes have passed` });
  }

  transaction(() => handOver(id));
  res.json(toMachine(getMachine.get(id)));
});

app.post("/api/machines/:id/release", requireAuth, (req, res) => {
  refreshStatuses();
  const id = Number(req.params.id);
  const row = getMachine.get(id);
  if (!row) return res.status(404).json({ error: "Machine not found" });

  const machine = toMachine(row);
  if (machine.status !== "reserved" || machine.reservedFor !== req.regNo) {
    return res.status(403).json({ error: "This machine is not held for you" });
  }

  transaction(() => handOver(id));
  res.json(toMachine(getMachine.get(id)));
});

app.post("/api/machines/:id/clothes-removed", requireAuth, (req, res) => {
  const id = Number(req.params.id);
  const row = getMachine.get(id);
  if (!row) return res.status(404).json({ error: "Machine not found" });

  if (row.status !== "out_of_order" || !row.reg_no) {
    return res.status(400).json({ error: "No clothes are waiting in this machine" });
  }
  if (row.reg_no !== req.regNo && !req.isAdmin) {
    return res.status(403).json({ error: "These are not your clothes" });
  }

  clearStuckClothes.run(id);
  res.json(toMachine(getMachine.get(id)));
});

// ---------- Admin: machines ----------
app.post("/api/machines/:id/out-of-order", requireAuth, requireAdmin, (req, res) => {
  refreshStatuses();
  const id = Number(req.params.id);
  const row = getMachine.get(id);
  if (!row) return res.status(404).json({ error: "Machine not found" });
  if (row.status === "out_of_order") return res.status(400).json({ error: "Already out of order" });

  const clothesOwner = row.status === "running" || row.status === "done" ? row.reg_no : null;

  let priorityPerson = null;
  if (row.status === "reserved") priorityPerson = row.reserved_for;
  if (row.status === "running") priorityPerson = row.reg_no;

  let movedTo = null;
  transaction(() => {
    markOutOfOrder.run(clothesOwner, id);
    if (priorityPerson) movedTo = givePriority(priorityPerson);
  });

  res.json({ ...toMachine(getMachine.get(id)), movedTo, priorityPerson });
});

app.post("/api/machines/:id/back-in-service", requireAuth, requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  const row = getMachine.get(id);
  if (!row) return res.status(404).json({ error: "Machine not found" });

  if (row.status !== "out_of_order") {
    return res.status(400).json({ error: "This machine is not out of order" });
  }

  transaction(() => handOver(id));
  res.json(toMachine(getMachine.get(id)));
});

// ---------- Admin: residents ----------
app.get("/api/admin/residents", requireAuth, requireAdmin, (req, res) => {
  const residents = listResidents.all().map((r) => ({
    regNo: r.reg_no,
    addedAt: r.added_at,
    registered: r.registered === 1,
  }));
  res.json({ residents, total: residents.length });
});

app.post("/api/admin/residents", requireAuth, requireAdmin, (req, res) => {
  const raw = String(req.body.text || "");
  const items = [...new Set(raw.split(/[\s,;]+/).map(cleanRegNo).filter(Boolean))];

  const valid = items.filter((r) => ROLL_NO_PATTERN.test(r));
  const invalid = items.filter((r) => !ROLL_NO_PATTERN.test(r));

  let added = 0;
  const now = Date.now();
  transaction(() => {
    valid.forEach((r) => {
      added += addResident.run(r, now).changes;
    });
  });

  res.json({ added, alreadyThere: valid.length - added, invalid });
});

app.delete("/api/admin/residents/:regNo", requireAuth, requireAdmin, (req, res) => {
  refreshStatuses();
  const id = cleanRegNo(req.params.regNo);
  if (!isResident.get(id)) return res.status(404).json({ error: "Not on the residents list" });

  transaction(() => {
    removeResident.run(id);
    deleteSessionsFor.run(id);
    removeQueueByRegNo.run(id);
    const held = findReservedFor.get(id);
    if (held) handOver(held.id);
  });

  res.json({ message: `${id} removed` });
});

// POST /api/admin/residents/:regNo/reset-password: forgot-password flow
app.post("/api/admin/residents/:regNo/reset-password", requireAuth, requireAdmin, (req, res) => {
  const id = cleanRegNo(req.params.regNo);
  const user = findUser.get(id);
  if (!user || user.is_admin === 1) {
    return res.status(404).json({ error: "No student account for this roll number" });
  }

  const tempPassword = makeTempPassword();
  const salt = crypto.randomBytes(16).toString("hex");
  transaction(() => {
    setPassword.run(salt, hashPassword(tempPassword, salt), 1, id); // 1 = must change on next login
    deleteSessionsFor.run(id); // log them out everywhere
  });

  res.json({ regNo: id, tempPassword });
});

// ---------- Queue routes ----------
app.get("/api/queue", (req, res) => {
  refreshStatuses();
  const result = getQueue.all().map((q, index) => ({
    position: index + 1,
    regNo: q.reg_no,
    joinedAt: q.joined_at,
  }));
  res.json(result);
});

app.post("/api/queue", requireAuth, (req, res) => {
  refreshStatuses();
  const regNo = req.regNo;

  if (countFree.get().n > 0) {
    return res.status(400).json({ error: "A machine is free. Use it instead of queueing" });
  }
  if (countActiveFor.get(regNo).n >= MAX_MACHINES_PER_PERSON) {
    return res.status(400).json({ error: "You already have a machine in use" });
  }
  if (findInQueue.get(regNo)) {
    return res.status(400).json({ error: "You are already in the queue" });
  }
  if (findReservedFor.get(regNo)) {
    return res.status(400).json({ error: "A machine is already held for you" });
  }

  addToQueue.run(regNo, Date.now());
  const position = getQueue.all().findIndex((q) => q.reg_no === regNo) + 1;
  res.json({ message: "Joined queue", position });
});

app.delete("/api/queue", requireAuth, (req, res) => {
  if (!findInQueue.get(req.regNo)) {
    return res.status(400).json({ error: "You are not in the queue" });
  }
  removeQueueByRegNo.run(req.regNo);
  res.json({ message: "Left the queue" });
});

// ---------- Stats routes ----------
app.get("/api/stats/busiest-hours", (req, res) => {
  const since = Date.now() - STATS_DAYS * 24 * 60 * 60 * 1000;
  const counts = new Array(24).fill(0);

  busiestHours.all(since).forEach((row) => {
    counts[row.hour] = row.count;
  });

  const total = counts.reduce((sum, n) => sum + n, 0);
  res.json({
    days: STATS_DAYS,
    total,
    hours: counts.map((count, hour) => ({ hour, count })),
  });
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});