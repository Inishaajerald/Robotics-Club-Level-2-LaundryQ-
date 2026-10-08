# LaundryQ 🧺

**No more waiting for a washing machine.**

In many hostels, a handful of washing machines are shared by a whole floor. You carry a full bucket down only to find every machine busy, or a finished load that nobody has collected. LaundryQ is a web app that shows a live board of the machines, runs a fair queue, and tells you when it's your turn.

---

## Features

### Core
- **Live board** of all machines: free, running (with time left), done, held, or out of order. Updates every second.
- **Start a cycle**: pick a machine and a cycle length. The server stores when it started.
- **Fair queue**: when every machine is busy, join the queue. When a load is collected, the machine is **held for the first person in line**, and only they can start it.
- **Uncollected flag**: loads left for more than 10 minutes turn red on the board.

### Stretch goals
- **Browser notifications** when your cycle ends, when it's your turn, or if your machine breaks down.
- **Busiest-hours chart** showing cycles started per hour over the last 30 days.
- **Admin out-of-order**: mark a machine broken and put it back in service.

### Extras
- **Accounts with hashed passwords** (scrypt + salt). The server identifies users from a session token, never from a typed roll number.
- **Residents list**: only roll numbers added by the admin can register, and each roll number can have exactly one account.
- **Roll number format check** (e.g. `26BCE1697`).
- **Change password** (logs out your other devices) and **forgot password** (admin issues a one-time temporary password, and the student must set a new one on next login).
- **Fairness rules**: one machine per person at a time, and you can't skip a machine held for you.
- **Hold timeout**: a held machine passes to the next person if not started within 5 minutes.
- **Leave queue / give up a held machine.**
- **Breakdown handling**: if a machine breaks mid-cycle, the owner's clothes are tracked, they get priority for another machine, and they must confirm their clothes are removed before starting a new load.
- **Data survives restarts** (SQLite database).

---

## Tech stack

| Part | Technology |
|---|---|
| Frontend | React (Vite) |
| Backend | Node.js + Express |
| Database | SQLite (built into Node 22.5+, via `node:sqlite`) |
| Auth | Session tokens, scrypt password hashing (Node `crypto`) |

No external database or UI libraries are needed.

---

## Project structure

```
laundryq/
├── client/              React frontend
│   └── src/
│       ├── App.jsx      All screens and components
│       └── index.css    Styles
└── server/              Node backend
    ├── index.js         API, business rules, database
    └── seed-demo.js     Adds sample data for the chart
```

---

## Getting started

### Requirements
- **Node.js 22.5 or newer** (built with Node 24)

### 1. Start the server
```bash
cd server
npm install
node index.js
```
The server runs on `http://localhost:5000` and creates `laundryq.db` on first start.

### 2. Start the frontend (in a second terminal)
```bash
cd client
npm install
npm run dev
```
Open the link it prints, usually `http://localhost:5173`.

### 3. First-time setup
1. Log in as **`ADMIN`** with password **`admin1234`**, then **change it** via *Change password*.
   (Or set your own before the first start: `ADMIN_PASSWORD=yourpassword node index.js`.)
2. In the **Residents** panel, paste the hostel's roll numbers.
3. Students can now **Create an account** with their roll number.

### Optional: sample data for the chart
```bash
cd server
node seed-demo.js        # adds 2 weeks of sample cycles
node seed-demo.js clear  # removes them
```
Sample rows are tagged `DEMO` and never mix with real data.

---

## Configuration

Settings are constants at the top of `server/index.js`:

| Setting | Default | Meaning |
|---|---|---|
| `MACHINE_COUNT` | 3 | Number of machines created on first start |
| `OVERDUE_MINUTES` | 10 | When an uncollected load is flagged |
| `RESERVE_MINUTES` | 5 | How long a held machine waits before passing on |
| `MAX_MACHINES_PER_PERSON` | 1 | Fairness limit |
| `STATS_DAYS` | 30 | Window for the busiest-hours chart |
| `MIN_PASSWORD_LENGTH` | 6 | Minimum password length |

Tip: set the minute values to `1` for a quick live demo.

---

## API

| Method | Endpoint | Who | Purpose |
|---|---|---|---|
| POST | `/api/register` | Anyone on the residents list | Create an account |
| POST | `/api/login` | Anyone | Log in, returns a token |
| POST | `/api/logout` | Logged in | Log out |
| GET | `/api/me` | Logged in | Current user |
| POST | `/api/change-password` | Logged in | Change own password |
| GET | `/api/machines` | Public | Live machine board |
| POST | `/api/machines/:id/start` | Logged in | Start a cycle |
| POST | `/api/machines/:id/collect` | Owner, anyone once overdue, admin | Collect a finished load |
| POST | `/api/machines/:id/release` | Person it's held for | Give up a held machine |
| POST | `/api/machines/:id/clothes-removed` | Clothes owner, admin | Confirm clothes taken out of a broken machine |
| GET | `/api/queue` | Public | Current queue |
| POST | `/api/queue` | Logged in | Join the queue (only when all machines are busy) |
| DELETE | `/api/queue` | Logged in | Leave the queue |
| GET | `/api/stats/busiest-hours` | Public | Cycles per hour of day |
| POST | `/api/machines/:id/out-of-order` | Admin | Mark a machine broken |
| POST | `/api/machines/:id/back-in-service` | Admin | Put a machine back |
| GET | `/api/admin/residents` | Admin | List residents |
| POST | `/api/admin/residents` | Admin | Add roll numbers (bulk paste) |
| DELETE | `/api/admin/residents/:regNo` | Admin | Remove a resident |
| POST | `/api/admin/residents/:regNo/reset-password` | Admin | Issue a temporary password |

Protected endpoints expect the header `Authorization: Bearer <token>`.

---

## Key design decisions

- **Every rule is enforced on the server.** The UI hides buttons for convenience, but the server checks identity, ownership, and fairness on every request, so editing the frontend can't bypass anything.
- **Times are stored, not countdowns.** The server saves *when* a cycle started and calculates time left from the clock, so timers stay correct across restarts.
- **No background timers.** Each request first brings the data up to date (finished cycles, expired holds), which keeps the code simple and reliable.
- **Transactions** make multi-step changes atomic. For example, "collect a load and hand the machine to the next person" either fully happens or not at all.
- **Database constraints** (`PRIMARY KEY`, `UNIQUE`) guarantee one account per roll number and one queue entry per person.
- **Passwords are never stored**, only salted scrypt hashes. Temporary passwords are shown once and stored hashed.

---

## Possible improvements

- Real-time updates with WebSockets instead of polling every second
- College email OTP to prove a student owns their roll number
- HTTPS and online deployment
- Automated tests
- Session expiry and rate limiting on login

---

## Testing the main scenario

1. Admin adds three roll numbers to the residents list.
2. Fill every machine with 1-minute cycles from different accounts.
3. From another account (e.g. an Incognito window), join the queue.
4. When a cycle finishes, collect it. The machine is now held for the person who queued, and only they can start it.
