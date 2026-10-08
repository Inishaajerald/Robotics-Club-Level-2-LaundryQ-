// Fills the history with fake cycles for testing the chart.
//   node seed-demo.js        → add 2 weeks of demo data
//   node seed-demo.js clear  → remove the demo data
const { DatabaseSync } = require("node:sqlite");
const db = new DatabaseSync("laundryq.db");

db.exec(`
  CREATE TABLE IF NOT EXISTS cycles (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    machine_id    INTEGER NOT NULL,
    reg_no        TEXT NOT NULL,
    started_at    INTEGER NOT NULL,
    cycle_minutes INTEGER NOT NULL
  );
`);

if (process.argv[2] === "clear") {
  const result = db.prepare("DELETE FROM cycles WHERE reg_no = 'DEMO'").run();
  console.log(`Removed ${result.changes} demo cycles`);
  process.exit(0);
}

// How busy each hour usually is (index = hour 0..23)
// Peaks: morning before class (7–9) and evening after dinner (20–23)
const weights = [
  1, 0, 0, 0, 0, 1, 3, 8, 9, 5, 3, 2,
  2, 3, 2, 2, 3, 4, 6, 8, 12, 14, 10, 4,
];
const totalWeight = weights.reduce((a, b) => a + b, 0);

function pickHour() {
  let r = Math.random() * totalWeight;
  for (let h = 0; h < 24; h++) {
    r -= weights[h];
    if (r < 0) return h;
  }
  return 23;
}

const insert = db.prepare(
  "INSERT INTO cycles (machine_id, reg_no, started_at, cycle_minutes) VALUES (?, 'DEMO', ?, ?)"
);

const COUNT = 300;
for (let i = 0; i < COUNT; i++) {
  const date = new Date();
  date.setDate(date.getDate() - Math.floor(Math.random() * 14)); // a day in the last 2 weeks
  date.setHours(pickHour(), Math.floor(Math.random() * 60), 0, 0);

  const machineId = 1 + Math.floor(Math.random() * 3);
  const minutes = [30, 40, 45, 60][Math.floor(Math.random() * 4)];
  insert.run(machineId, date.getTime(), minutes);
}

console.log(`Added ${COUNT} demo cycles`);