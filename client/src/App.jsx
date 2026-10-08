import { useEffect, useRef, useState } from "react";

const API = "http://localhost:5000/api";
const STORAGE_KEY = "laundryq_auth";
const ROLL_NO_PATTERN = /^\d{2}[A-Z]{3}\d{4}$/;
const MIN_PASSWORD_LENGTH = 6;

const colors = {
  free: "#16a34a",
  running: "#2563eb",
  done: "#ea580c",
  reserved: "#9333ea",
  out_of_order: "#64748b",
};

function formatTime(seconds) {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

function hourLabel(h) {
  if (h === 0) return "12 AM";
  if (h < 12) return `${h} AM`;
  if (h === 12) return "12 PM";
  return `${h - 12} PM`;
}

async function api(path, { method = "GET", body, token } = {}) {
  const headers = { "Content-Type": "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;

  const res = await fetch(`${API}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json();
  if (!res.ok) {
    const err = new Error(data.error || "Something went wrong");
    err.status = res.status;
    err.code = data.code;
    throw err;
  }
  return data;
}

function notify(title, body) {
  if ("Notification" in window && Notification.permission === "granted") {
    new Notification(title, { body });
  }
}

// ---------- Login / Register page ----------
function LoginPage({ onLogin, notice }) {
  const [mode, setMode] = useState("login");
  const [regNo, setRegNo] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState("");
  const [showForgot, setShowForgot] = useState(false);

  const isRegister = mode === "register";
  const cleaned = regNo.trim().toUpperCase();
  const formatOk = ROLL_NO_PATTERN.test(cleaned);

  function switchMode() {
    setMode(isRegister ? "login" : "register");
    setError("");
    setConfirm("");
    setShowForgot(false);
  }

  async function handleSubmit(e) {
    e.preventDefault();
    setError("");

    if (isRegister && !formatOk) {
      return setError("Roll number must look like 26BCE1697");
    }
    if (isRegister && password.length < MIN_PASSWORD_LENGTH) {
      return setError(`Password must be at least ${MIN_PASSWORD_LENGTH} characters`);
    }
    if (isRegister && password !== confirm) {
      return setError("Passwords don't match");
    }

    try {
      const data = await api(isRegister ? "/register" : "/login", {
        method: "POST",
        body: { regNo: cleaned, password },
      });
      onLogin(data);
    } catch (err) {
      setError(err.message);
    }
  }

  return (
    <div className="page">
      <div className="login-card">
        <h1>LaundryQ</h1>
        <p className="sub">{isRegister ? "Create your account" : "Log in to continue"}</p>

        {notice && <p className="hint">{notice}</p>}

        <form onSubmit={handleSubmit}>
          <label>Roll number</label>
          <input
            value={regNo}
            onChange={(e) => setRegNo(e.target.value.toUpperCase())}
            placeholder="e.g. 26BCE1697"
            maxLength={9}
          />
          {isRegister && regNo && !formatOk && (
            <p className="hint">Format: 2 digits + 3 letters + 4 digits (26BCE1697)</p>
          )}

          <label>Password</label>
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} />

          {isRegister && (
            <>
              <label>Confirm password</label>
              <input type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} />
            </>
          )}

          {error && <p className="error">{error}</p>}

          <button type="submit">{isRegister ? "Register" : "Log in"}</button>
        </form>

        {!isRegister && (
          <button type="button" className="link-btn" onClick={() => setShowForgot(!showForgot)}>
            Forgot password?
          </button>
        )}
        {showForgot && (
          <div className="info-box">
            Ask the hostel admin (warden) to reset your password. They will give you a{" "}
            <b>temporary password</b>. Log in with it, and you'll be asked to choose a new one.
          </div>
        )}

        <p className="hint">{isRegister ? "Already have an account?" : "New here?"}</p>
        <button className="secondary" type="button" onClick={switchMode}>
          {isRegister ? "Go to Log in" : "Create an account"}
        </button>
      </div>
    </div>
  );
}

// ---------- Change password form (used in 2 places) ----------
function ChangePasswordForm({ token, onSuccess, onAuthError, submitLabel = "Change password" }) {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState("");

  async function handleSubmit(e) {
    e.preventDefault();
    setError("");

    if (next.length < MIN_PASSWORD_LENGTH) {
      return setError(`New password must be at least ${MIN_PASSWORD_LENGTH} characters`);
    }
    if (next !== confirm) return setError("New passwords don't match");

    try {
      await api("/change-password", {
        method: "POST",
        body: { currentPassword: current, newPassword: next },
        token,
      });
      setCurrent("");
      setNext("");
      setConfirm("");
      onSuccess();
    } catch (err) {
      if (err.status === 401) onAuthError();
      else setError(err.message);
    }
  }

  return (
    <form className="pw-form" onSubmit={handleSubmit}>
      <label>Current password</label>
      <input type="password" value={current} onChange={(e) => setCurrent(e.target.value)} />

      <label>New password</label>
      <input type="password" value={next} onChange={(e) => setNext(e.target.value)} />

      <label>Confirm new password</label>
      <input type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} />

      {error && <p className="error">{error}</p>}

      <button type="submit">{submitLabel}</button>
    </form>
  );
}

// ---------- Forced change after an admin reset ----------
function ForcedChangePage({ auth, onDone, onLogout }) {
  return (
    <div className="page">
      <div className="login-card">
        <h1>Set a new password</h1>
        <p className="sub">
          Hi <b>{auth.regNo}</b>, you logged in with a temporary password. Choose a new one to continue.
        </p>
        <ChangePasswordForm
          token={auth.token}
          submitLabel="Save new password"
          onSuccess={onDone}
          onAuthError={() => onLogout("Session expired. Please log in again.")}
        />
        <button className="secondary logout-small" type="button" onClick={() => onLogout()}>
          Log out
        </button>
      </div>
    </div>
  );
}

// ---------- Admin: residents panel ----------
function ResidentsPanel({ token, handleError }) {
  const [residents, setResidents] = useState([]);
  const [text, setText] = useState("");
  const [search, setSearch] = useState("");
  const [result, setResult] = useState({ text: "", isError: false });
  const [tempPw, setTempPw] = useState(null); // { regNo, password }

  async function load() {
    try {
      const data = await api("/admin/residents", { token });
      setResidents(data.residents);
    } catch (err) {
      handleError(err);
    }
  }

  useEffect(() => {
    load();
  }, []);

  async function addResidents() {
    if (!text.trim()) return;
    try {
      const data = await api("/admin/residents", { method: "POST", body: { text }, token });
      let msg = `Added ${data.added}.`;
      if (data.alreadyThere) msg += ` ${data.alreadyThere} already on the list.`;
      if (data.invalid.length) msg += ` Skipped invalid: ${data.invalid.join(", ")}`;
      setResult({ text: msg, isError: data.invalid.length > 0 });
      setText("");
      load();
    } catch (err) {
      handleError(err);
    }
  }

  async function remove(regNo) {
    if (!window.confirm(`Remove ${regNo}? They will be logged out and can no longer use LaundryQ.`)) return;
    try {
      await api(`/admin/residents/${regNo}`, { method: "DELETE", token });
      setResult({ text: `${regNo} removed`, isError: false });
      load();
    } catch (err) {
      handleError(err);
    }
  }

  async function resetPassword(regNo) {
    if (!window.confirm(`Reset ${regNo}'s password? They will be logged out and must set a new password.`)) return;
    try {
      const data = await api(`/admin/residents/${regNo}/reset-password`, { method: "POST", token });
      setTempPw({ regNo: data.regNo, password: data.tempPassword });
    } catch (err) {
      handleError(err);
    }
  }

  function copyTempPw() {
    navigator.clipboard?.writeText(tempPw.password);
  }

  const shown = residents.filter((r) => r.regNo.includes(search.trim().toUpperCase()));
  const registeredCount = residents.filter((r) => r.registered).length;

  return (
    <div className="residents">
      <h2>Residents <span className="hint">({registeredCount} of {residents.length} registered)</span></h2>
      <p className="hint">Only roll numbers on this list can register.</p>

      <textarea
        rows={3}
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder={"Paste roll numbers (one per line, or separated by commas)\n26BCE1697\n26BCE1698"}
      />
      <button onClick={addResidents}>Add to list</button>

      {result.text && <p className={result.isError ? "error" : "success"}>{result.text}</p>}

      {tempPw && (
        <div className="temp-pw">
          <p>
            Temporary password for <b>{tempPw.regNo}</b>:
          </p>
          <p className="temp-pw-value">{tempPw.password}</p>
          <p className="hint">Give it to the student in person. It is shown only once.</p>
          <div className="row">
            <button className="secondary" onClick={copyTempPw}>Copy</button>
            <button onClick={() => setTempPw(null)}>Done</button>
          </div>
        </div>
      )}

      {residents.length > 0 && (
        <>
          <input
            className="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search roll number"
          />
          <div className="resident-list">
            {shown.map((r) => (
              <div key={r.regNo} className="resident-row">
                <span><b>{r.regNo}</b></span>
                <span className="hint">{r.registered ? "✅ Registered" : "⏳ Not yet"}</span>
                <div className="row">
                  {r.registered && (
                    <button className="secondary" onClick={() => resetPassword(r.regNo)}>Reset password</button>
                  )}
                  <button className="secondary" onClick={() => remove(r.regNo)}>Remove</button>
                </div>
              </div>
            ))}
            {shown.length === 0 && <p className="hint">No match</p>}
          </div>
        </>
      )}
    </div>
  );
}

// ---------- Busiest hours chart ----------
function BusiestHours() {
  const [data, setData] = useState(null);

  useEffect(() => {
    const load = () => api("/stats/busiest-hours").then(setData).catch(() => {});
    load();
    const timer = setInterval(load, 60000);
    return () => clearInterval(timer);
  }, []);

  if (!data) return null;

  const max = Math.max(1, ...data.hours.map((h) => h.count));
  const busiest = data.hours.reduce((a, b) => (b.count > a.count ? b : a));
  const nowHour = new Date().getHours();
  const nowCount = data.hours[nowHour].count;
  const isBusyNow = nowCount >= max * 0.6;

  return (
    <div className="stats">
      <h2>Busiest hours</h2>
      <p className="hint">Cycles started per hour, last {data.days} days ({data.total} total)</p>

      {data.total === 0 ? (
        <p className="hint">No data yet. Start some cycles!</p>
      ) : (
        <>
          <p>
            Busiest: <b>{hourLabel(busiest.hour)}</b> · Right now ({hourLabel(nowHour)}):{" "}
            <b className={isBusyNow ? "flag" : "success"}>{isBusyNow ? "usually busy" : "usually quiet"}</b>
          </p>

          <div className="chart">
            {data.hours.map((h) => (
              <div key={h.hour} className="bar-col" title={`${hourLabel(h.hour)}: ${h.count} cycles`}>
                <div className="bar-area">
                  <div
                    className={`bar ${h.hour === busiest.hour ? "peak" : ""} ${h.hour === nowHour ? "now" : ""}`}
                    style={{ height: `${(h.count / max) * 100}%` }}
                  />
                </div>
                <span className="bar-label">{h.hour % 3 === 0 ? hourLabel(h.hour) : ""}</span>
              </div>
            ))}
          </div>

          <div className="legend">
            <span><i className="dot peak" /> Busiest hour</span>
            <span><i className="dot now" /> Current hour</span>
          </div>
        </>
      )}
    </div>
  );
}

// ---------- One machine card ----------
function MachineCard({ m, me, isAdmin, hasStuckClothes, token, onDone, showMessage, handleError }) {
  const [minutes, setMinutes] = useState(1);
  const isMine = m.status === "reserved" && m.reservedFor === me;
  const canCollect = m.regNo === me || m.overdue || isAdmin;

  async function action(path, successText, confirmText) {
    if (confirmText && !window.confirm(confirmText)) return;
    try {
      await api(`/machines/${m.id}/${path}`, { method: "POST", token });
      showMessage(successText);
      onDone();
    } catch (err) {
      handleError(err);
    }
  }

  async function start() {
    try {
      await api(`/machines/${m.id}/start`, { method: "POST", body: { cycleMinutes: Number(minutes) }, token });
      showMessage(`Machine ${m.id} started`);
      onDone();
    } catch (err) {
      handleError(err);
    }
  }

  async function markOutOfOrder() {
    const questions = {
      free: `Mark Machine ${m.id} as out of order?`,
      reserved: `Machine ${m.id} is held for ${m.reservedFor}. Mark it out of order? They will get another machine or the front of the queue.`,
      running: `Machine ${m.id} is running for ${m.regNo}. Stop it and mark out of order? Their clothes stay inside, and they get priority for another machine.`,
      done: `Machine ${m.id} has ${m.regNo}'s finished load inside. Mark out of order? They will be told to remove their clothes.`,
    };
    if (!window.confirm(questions[m.status])) return;

    try {
      const data = await api(`/machines/${m.id}/out-of-order`, { method: "POST", token });
      showMessage(
        data.movedTo
          ? `Machine ${m.id} marked out of order. ${data.priorityPerson} moved to ${data.movedTo}.`
          : `Machine ${m.id} marked out of order`
      );
      onDone();
    } catch (err) {
      handleError(err);
    }
  }

  function backInService() {
    const question = m.regNo
      ? `${m.regNo}'s clothes are still marked as inside Machine ${m.id}. Have they been removed? Put it back in service?`
      : null;
    action("back-in-service", `Machine ${m.id} is back in service`, question);
  }

  const cardClass = `card ${isMine ? "mine" : ""} ${m.overdue ? "overdue" : ""}`;
  const borderColor = m.overdue ? "#dc2626" : colors[m.status];
  const badgeText = m.overdue ? "UNCOLLECTED" : m.status.replace(/_/g, " ").toUpperCase();

  const startForm = (
    <div className="row">
      <input type="number" min="1" value={minutes} onChange={(e) => setMinutes(e.target.value)} />
      <span>min</span>
      <button onClick={start} disabled={hasStuckClothes}>Start</button>
    </div>
  );

  return (
    <div className={cardClass} style={{ borderColor }}>
      <h2>Machine {m.id}</h2>
      <span className="badge" style={{ background: borderColor }}>{badgeText}</span>

      {m.status === "running" && (
        <p>{m.regNo === me ? "You" : m.regNo} · {formatTime(m.timeLeftSeconds)} left</p>
      )}

      {m.status === "done" && (
        <>
          <p>Done. Waiting for {m.regNo === me ? "you" : m.regNo} to collect</p>
          <p className={m.overdue ? "flag" : "hint"}>
            {m.overdue ? "⚠️ Left for " : "Finished "}
            {formatTime(m.waitingSeconds)}
            {m.overdue ? "" : " ago"}
          </p>
          {canCollect ? (
            <button onClick={() => action("collect", `Machine ${m.id} collected`)}>Collect</button>
          ) : (
            <p className="hint">Only the owner can collect (anyone after 10 min)</p>
          )}
        </>
      )}

      {m.status === "free" && (
        <>
          <p>Available</p>
          {startForm}
        </>
      )}

      {m.status === "reserved" && (
        isMine ? (
          <>
            <p>Your turn! Start within <b>{formatTime(m.reserveSecondsLeft)}</b></p>
            {hasStuckClothes && <p className="flag">Remove your clothes from the broken machine first</p>}
            {startForm}
            <button
              className="secondary give-up"
              onClick={() => action("release", `You gave up Machine ${m.id}`, `Give up Machine ${m.id}? It will go to the next person.`)}
            >
              Give up
            </button>
          </>
        ) : (
          <>
            <p>Held for {m.reservedFor}</p>
            <p className="hint">Passes on in {formatTime(m.reserveSecondsLeft)} if not started</p>
          </>
        )
      )}

      {m.status === "out_of_order" && (
        <>
          <p>🔧 Not available right now</p>
          {m.regNo && (
            <>
              <p className="flag">
                🧺 {m.regNo === me ? "Your" : `${m.regNo}'s`} clothes are inside. Please remove them.
              </p>
              {(m.regNo === me || isAdmin) && (
                <button
                  onClick={() =>
                    action(
                      "clothes-removed",
                      "Clothes marked as removed",
                      m.regNo === me
                        ? `Have you taken your clothes out of Machine ${m.id}?`
                        : `Confirm ${m.regNo}'s clothes have been removed from Machine ${m.id}?`
                    )
                  }
                >
                  ✅ {m.regNo === me ? "I've removed my clothes" : "Mark clothes removed"}
                </button>
              )}
            </>
          )}
        </>
      )}

      {isAdmin && m.status !== "out_of_order" && (
        <button className="secondary admin-btn" onClick={markOutOfOrder}>
          🔧 Mark out of order
        </button>
      )}
      {isAdmin && m.status === "out_of_order" && (
        <button className="secondary admin-btn" onClick={backInService}>
          🔄 Back in service
        </button>
      )}
    </div>
  );
}

// ---------- Main board (after login) ----------
function Board({ auth, onLogout, onAuthUpdate }) {
  const me = auth.regNo;
  const token = auth.token;

  const [isAdmin, setIsAdmin] = useState(!!auth.isAdmin);
  const [machines, setMachines] = useState([]);
  const [queue, setQueue] = useState([]);
  const [message, setMessage] = useState({ text: "", isError: false });
  const [showChangePw, setShowChangePw] = useState(false);
  const [notifStatus, setNotifStatus] = useState(
    "Notification" in window ? Notification.permission : "unsupported"
  );
  const prevStatusRef = useRef({});

  function showMessage(text, isError = false) {
    setMessage({ text, isError });
  }

  function handleError(err) {
    if (err.status === 401) onLogout("Session expired. Please log in again.");
    else if (err.code === "MUST_CHANGE_PASSWORD") onAuthUpdate({ mustChangePassword: true });
    else showMessage(err.message, true);
  }

  function checkForAlerts(newMachines) {
    const prev = prevStatusRef.current;
    newMachines.forEach((m) => {
      const before = prev[m.id];
      if (!before) return;
      if (before === "running" && m.status === "done" && m.regNo === me) {
        notify("Your laundry is done! 🧺", `Machine ${m.id} finished. Please collect it.`);
      }
      if (before !== "reserved" && m.status === "reserved" && m.reservedFor === me) {
        notify("Your turn! 🎉", `Machine ${m.id} is held for you. Start it now.`);
      }
      if (before !== "out_of_order" && m.status === "out_of_order" && m.regNo === me) {
        notify("Machine broke down 🔧", `Machine ${m.id} is out of order with your clothes inside. Please remove them.`);
      }
    });
    const next = {};
    newMachines.forEach((m) => (next[m.id] = m.status));
    prevStatusRef.current = next;
  }

  async function loadAll() {
    try {
      const [machineData, queueData] = await Promise.all([api("/machines"), api("/queue")]);
      checkForAlerts(machineData);
      setMachines(machineData);
      setQueue(queueData);
    } catch {
      showMessage("Cannot reach server. Is it running?", true);
    }
  }

  useEffect(() => {
    api("/me", { token })
      .then((data) => {
        setIsAdmin(data.isAdmin);
        if (data.mustChangePassword) onAuthUpdate({ mustChangePassword: true });
      })
      .catch((err) => {
        if (err.status === 401) onLogout("Session expired. Please log in again.");
      });

    loadAll();
    const timer = setInterval(loadAll, 1000);
    return () => clearInterval(timer);
  }, []);

  async function enableNotifications() {
    const result = await Notification.requestPermission();
    setNotifStatus(result);
    if (result === "granted") notify("Notifications on ✅", "We'll tell you when your laundry is done.");
  }

  async function joinQueue() {
    try {
      const data = await api("/queue", { method: "POST", token });
      showMessage(`Joined queue at position ${data.position}`);
      loadAll();
    } catch (err) {
      handleError(err);
    }
  }

  async function leaveQueue() {
    try {
      await api("/queue", { method: "DELETE", token });
      showMessage("You left the queue");
      loadAll();
    } catch (err) {
      handleError(err);
    }
  }

  async function logout() {
    try {
      await api("/logout", { method: "POST", token });
    } catch {
      // ignore
    }
    onLogout();
  }

  const allBusy = machines.length > 0 && machines.every((m) => m.status !== "free");
  const myPosition = queue.find((q) => q.regNo === me)?.position;
  const myReserved = machines.find((m) => m.status === "reserved" && m.reservedFor === me);
  const myStuck = machines.find((m) => m.status === "out_of_order" && m.regNo === me);
  const overdueCount = machines.filter((m) => m.overdue).length;

  return (
    <div className="page">
      <div className="topbar">
        <div>
          <h1>LaundryQ</h1>
          <p className="sub">No more waiting for a washing machine</p>
        </div>
        <div className="row">
          <span>
            Logged in as <b>{me}</b>
            {isAdmin && <span className="admin-tag">ADMIN</span>}
          </span>
          <button className="secondary" onClick={() => setShowChangePw(!showChangePw)}>
            {showChangePw ? "Close" : "Change password"}
          </button>
          <button className="secondary" onClick={logout}>Log out</button>
        </div>
      </div>

      {showChangePw && (
        <div className="panel">
          <h2>Change password</h2>
          <ChangePasswordForm
            token={token}
            onSuccess={() => {
              setShowChangePw(false);
              showMessage("Password changed. Your other devices were logged out.");
            }}
            onAuthError={() => onLogout("Session expired. Please log in again.")}
          />
        </div>
      )}

      <div className="row top">
        {notifStatus === "default" && (
          <button onClick={enableNotifications}>🔔 Enable notifications</button>
        )}
        {notifStatus === "granted" && <span className="hint">🔔 Notifications on</span>}
        {notifStatus === "denied" && <span className="hint">🔕 Notifications blocked in browser</span>}
      </div>

      {myStuck && (
        <p className="flag-banner">
          🔧 Machine {myStuck.id} broke down with your clothes inside. Remove them, then click
          "I've removed my clothes" on Machine {myStuck.id}.
        </p>
      )}

      {myReserved && (
        <p className="alert">
          🎉 Machine {myReserved.id} is held for you. Start within {formatTime(myReserved.reserveSecondsLeft)}!
        </p>
      )}

      {overdueCount > 0 && (
        <p className="flag-banner">
          ⚠️ {overdueCount} load{overdueCount > 1 ? "s" : ""} left uncollected for over 10 minutes
        </p>
      )}

      {message.text && (
        <p className={message.isError ? "error" : "success"}>{message.text}</p>
      )}

      <div className="board">
        {machines.map((m) => (
          <MachineCard
            key={m.id}
            m={m}
            me={me}
            isAdmin={isAdmin}
            hasStuckClothes={!!myStuck}
            token={token}
            onDone={loadAll}
            showMessage={showMessage}
            handleError={handleError}
          />
        ))}
      </div>

      <div className="queue">
        <h2>Queue</h2>

        {myPosition ? (
          <div className="row">
            <span>You are <b>#{myPosition}</b> in line</span>
            <button className="secondary" onClick={leaveQueue}>Leave queue</button>
          </div>
        ) : (
          <button onClick={joinQueue} disabled={!allBusy}>Join queue</button>
        )}
        {!allBusy && !myPosition && <p className="hint">A machine is free, so no need to queue</p>}

        {queue.length === 0 ? (
          <p className="hint">No one is waiting</p>
        ) : (
          <ol>
            {queue.map((q) => (
              <li key={q.regNo} className={q.regNo === me ? "me" : ""}>
                {q.regNo === me ? `${q.regNo} (you)` : q.regNo}
              </li>
            ))}
          </ol>
        )}
      </div>

      <BusiestHours />

      {isAdmin && <ResidentsPanel token={token} handleError={handleError} />}
    </div>
  );
}

// ---------- App: login, forced change, or board ----------
export default function App() {
  const [auth, setAuth] = useState(() => {
    try {
      return JSON.parse(localStorage.getItem(STORAGE_KEY));
    } catch {
      return null;
    }
  });
  const [notice, setNotice] = useState("");

  function saveAuth(value) {
    if (value) localStorage.setItem(STORAGE_KEY, JSON.stringify(value));
    else localStorage.removeItem(STORAGE_KEY);
    setAuth(value);
  }

  function handleLogin(data) {
    setNotice("");
    saveAuth({
      token: data.token,
      regNo: data.regNo,
      isAdmin: data.isAdmin,
      mustChangePassword: data.mustChangePassword,
    });
  }

  function handleLogout(msg = "") {
    setNotice(msg);
    saveAuth(null);
  }

  function handleAuthUpdate(changes) {
    saveAuth({ ...auth, ...changes });
  }

  if (!auth) return <LoginPage onLogin={handleLogin} notice={notice} />;

  if (auth.mustChangePassword) {
    return (
      <ForcedChangePage
        auth={auth}
        onDone={() => handleAuthUpdate({ mustChangePassword: false })}
        onLogout={handleLogout}
      />
    );
  }

  return <Board auth={auth} onLogout={handleLogout} onAuthUpdate={handleAuthUpdate} />;
}