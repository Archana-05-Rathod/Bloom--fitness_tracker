/*
 * Fitness Tracker - Frontend JavaScript
 * =====================================
 * This file is the "remote control" for the page. It:
 *   1. Switches between tabs (Dashboard / Log / History / Goals / Profile)
 *   2. Calls the Flask API with fetch() to load and save data
 *   3. Draws the progress rings and the Chart.js line chart
 *   4. Wires up edit/delete buttons and a small popup (modal) for editing
 *   5. Runs the Profile tab's avatar picker + inline field editing
 *
 * Note: if any fetch() call gets a 401 response, it means the session
 * expired or was never logged in — apiFetch() bounces back to /login.
 */

const RING_CIRCUMFERENCE = 2 * Math.PI * 52; // matches r=52 in the ring SVGs

// ─── A small wrapper around fetch() that handles "logged out" ──
async function apiFetch(url, options) {
  const res = await fetch(url, options);
  if (res.status === 401) {
    window.location.href = "/login";
    throw new Error("Not logged in");
  }
  return res;
}

// ─── Tiny helpers used all over this file ──────────────────────
function showToast(message) {
  const toast = document.getElementById("toast");
  toast.textContent = message;
  toast.classList.add("show");
  setTimeout(() => toast.classList.remove("show"), 2200);
}

function setRing(id, percent) {
  const circle = document.querySelector(`[data-ring="${id}"] .ring-fill`);
  const offset = RING_CIRCUMFERENCE - (percent / 100) * RING_CIRCUMFERENCE;
  circle.style.strokeDashoffset = offset;
}

const exerciseEmoji = {
  running: "🏃", cycling: "🚴", swimming: "🏊",
  yoga: "🧘", gym: "🏋️", walking: "🚶",
};

// ─── Tab switching ───────────────────────────────────────────
function initTabs() {
  const buttons = document.querySelectorAll(".tab-btn[data-tab]");

  buttons.forEach((btn) => {
    btn.addEventListener("click", () => {
      buttons.forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");

      document.querySelectorAll(".tab-panel").forEach((panel) => panel.classList.remove("active"));
      document.getElementById(`panel-${btn.dataset.tab}`).classList.add("active");

      if (btn.dataset.tab === "dashboard") loadDashboard();
      if (btn.dataset.tab === "history") loadHistory();
      if (btn.dataset.tab === "profile") loadProfile();
      if (btn.dataset.tab === "log") document.getElementById("log-feedback").textContent = "";
      if (btn.dataset.tab === "goals") document.getElementById("goals-feedback").textContent = "";

      closeMobileMenu();
    });
  });
}

// ─── Hamburger menu (small screens only) ────────────────────────
function initHamburger() {
  const hamburgerBtn = document.getElementById("hamburger-btn");
  const tabNav = document.getElementById("tab-nav");

  hamburgerBtn.addEventListener("click", () => {
    const isOpen = tabNav.classList.toggle("open");
    hamburgerBtn.setAttribute("aria-expanded", isOpen ? "true" : "false");
  });
}

function closeMobileMenu() {
  document.getElementById("tab-nav").classList.remove("open");
  document.getElementById("hamburger-btn").setAttribute("aria-expanded", "false");
}

// ─── Dashboard: progress rings + chart ──────────────────────────
async function loadDashboard() {
  const res = await apiFetch("/api/dashboard");
  const data = await res.json();

  setRing("calorie", data.calorie_pct);
  document.getElementById("calorie-pct").textContent = `${data.calorie_pct}%`;
  document.getElementById("calorie-detail").textContent =
    `${data.calories_so_far} / ${data.calorie_goal} kcal this week`;

  setRing("workout", data.workout_pct);
  document.getElementById("workout-pct").textContent = `${data.workout_pct}%`;
  document.getElementById("workout-detail").textContent =
    `${data.workouts_so_far} / ${data.workout_goal} sessions this week`;

  loadCaloriesChart();
}

let caloriesChartInstance = null;

async function loadCaloriesChart() {
  const res = await apiFetch("/api/stats/calories-over-time");
  const points = await res.json();

  const hint = document.getElementById("chart-empty-hint");
  const canvas = document.getElementById("caloriesChart");

  if (typeof Chart === "undefined") {
    hint.textContent = "Chart couldn't load. Your data is still saved!";
    hint.style.display = "block";
    canvas.style.display = "none";
    return;
  }

  if (points.length === 0) {
    hint.textContent = "Log a few workouts to see your trend here!";
    hint.style.display = "block";
    canvas.style.display = "none";
    return;
  }
  hint.style.display = "none";
  canvas.style.display = "block";

  const labels = points.map((p) => p.date.slice(5));
  const values = points.map((p) => p.calories);

  if (caloriesChartInstance) caloriesChartInstance.destroy();

  caloriesChartInstance = new Chart(canvas, {
    type: "line",
    data: {
      labels,
      datasets: [{
        label: "Calories burned",
        data: values,
        borderColor: "#6FAE8E",
        backgroundColor: "rgba(111, 174, 142, 0.15)",
        borderWidth: 3,
        pointBackgroundColor: "#E8836C",
        pointRadius: 4,
        tension: 0.35,
        fill: true,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { display: false } },
      scales: {
        y: { beginAtZero: true, grid: { color: "#E4EEEA" } },
        x: { grid: { display: false } },
      },
    },
  });
}

// ─── Log Workout form ────────────────────────────────────────
function initLogForm() {
  const form = document.getElementById("log-form");

  form.addEventListener("submit", async (e) => {
    e.preventDefault();

    const exercise = document.getElementById("log-exercise").value;
    const duration = document.getElementById("log-duration").value;

        const res = await apiFetch("/api/workouts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ exercise, duration }),
    });
    const entry = await res.json();

    if (!res.ok) {
      document.getElementById("log-feedback").textContent = entry.error || "Something went wrong.";
      return;
    }

    document.getElementById("log-feedback").textContent =
      `Logged! You burned ~${entry.calories} kcal. Nice work ${exerciseEmoji[exercise] || "💪"}`;
    form.reset();
    showToast("Workout logged!");

    // Clear the message after a while so it doesn't sit there forever
    // looking like it applies to whatever you do next on this tab.
    setTimeout(() => {
      document.getElementById("log-feedback").textContent = "";
    }, 4000);
  
  });
}

// ─── History: table + weekly summary + edit/delete ──────────────
async function loadHistory() {
  const [workoutsRes, summaryRes] = await Promise.all([
    apiFetch("/api/workouts"),
    apiFetch("/api/summary/weekly"),
  ]);
  const workouts = await workoutsRes.json();
  const summary = await summaryRes.json();

  const body = document.getElementById("history-body");
  const emptyHint = document.getElementById("history-empty-hint");
  body.innerHTML = "";

  if (workouts.length === 0) {
    emptyHint.style.display = "block";
  } else {
    emptyHint.style.display = "none";

    workouts.forEach((w) => {
      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td>${w.date}</td>
        <td>${exerciseEmoji[w.exercise] || ""} ${w.exercise}</td>
        <td class="mono">${w.duration} min</td>
        <td class="mono">${w.calories} kcal</td>
        <td>
          <button class="btn-icon" data-action="edit" data-id="${w._id}" data-exercise="${w.exercise}" data-duration="${w.duration}">✏️</button>
          <button class="btn-icon danger" data-action="delete" data-id="${w._id}">🗑️</button>
        </td>
      `;
      body.appendChild(tr);
    });
  }

  const summaryBody = document.getElementById("summary-body");
  summaryBody.innerHTML = "";
  summary.forEach((s) => {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${s.week}</td>
      <td class="mono">${s.total}</td>
      <td class="mono">${s.avg}</td>
      <td class="mono">${s.sessions}</td>
    `;
    summaryBody.appendChild(tr);
  });

  body.querySelectorAll("[data-action='edit']").forEach((btn) => {
    btn.addEventListener("click", () => openEditModal(btn.dataset));
  });
  body.querySelectorAll("[data-action='delete']").forEach((btn) => {
    btn.addEventListener("click", () => deleteWorkout(btn.dataset.id));
  });
}

async function deleteWorkout(id) {
  if (!confirm("Delete this workout? This can't be undone.")) return;

  await apiFetch(`/api/workouts/${id}`, { method: "DELETE" });
  showToast("Workout deleted");
  loadHistory();
}

// ─── Edit modal (the popup for editing a workout) ───────────────
function openEditModal(data) {
  document.getElementById("edit-id").value = data.id;
  document.getElementById("edit-exercise").value = data.exercise;
  document.getElementById("edit-duration").value = data.duration;
  document.getElementById("edit-modal-backdrop").classList.add("active");
}

function closeEditModal() {
  document.getElementById("edit-modal-backdrop").classList.remove("active");
}

function initEditModal() {
  document.getElementById("edit-cancel").addEventListener("click", closeEditModal);

  document.getElementById("edit-modal-backdrop").addEventListener("click", (e) => {
    if (e.target.id === "edit-modal-backdrop") closeEditModal();
  });

  document.getElementById("edit-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const id = document.getElementById("edit-id").value;
    const exercise = document.getElementById("edit-exercise").value;
    const duration = document.getElementById("edit-duration").value;

    await apiFetch(`/api/workouts/${id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ exercise, duration }),
    });

    closeEditModal();
    showToast("Workout updated");
    loadHistory();
  });
}

// ─── Goals form ──────────────────────────────────────────────
async function loadGoalsForm() {
  const res = await apiFetch("/api/goals");
  const goals = await res.json();

  const calorieGoal = goals.weekly_calorie_goal ?? 2000;
  const workoutGoal = goals.weekly_workout_goal ?? 4;

  document.getElementById("goal-calories").value = calorieGoal;
  document.getElementById("goal-workouts").value = workoutGoal;

  document.getElementById("current-goal-calories").textContent = calorieGoal;
  document.getElementById("current-goal-workouts").textContent = workoutGoal;
}

function initGoalsForm() {
  const form = document.getElementById("goals-form");
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const weekly_calorie_goal = document.getElementById("goal-calories").value;
    const weekly_workout_goal = document.getElementById("goal-workouts").value;

    const res = await apiFetch("/api/goals", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ weekly_calorie_goal, weekly_workout_goal }),
    });
    const result = await res.json();

    if (!res.ok) {
      document.getElementById("goals-feedback").textContent = result.error || "Something went wrong.";
      return;
    }

    document.getElementById("goals-feedback").textContent = "Goals saved!";
    document.getElementById("current-goal-calories").textContent = weekly_calorie_goal;
    document.getElementById("current-goal-workouts").textContent = weekly_workout_goal;
    showToast("Goals updated");

     setTimeout(() => {
      document.getElementById("goals-feedback").textContent = "";
    }, 4000);
  });
}

// ─── Profile tab: avatar picker + inline field editing ───────────
let currentProfile = {};

function avatarUrl(filename) {
  return `/static/img/avatars/${filename}`;
}

async function loadProfile() {
  const res = await apiFetch("/api/profile");
  const profile = await res.json();
  currentProfile = profile;

  document.getElementById("profile-avatar-img").src = avatarUrl(profile.avatar);
  document.getElementById("profile-display-name").textContent = profile.username;

  document.getElementById("stat-total-workouts").textContent = profile.total_workouts ?? 0;
  document.getElementById("stat-total-calories").textContent = profile.total_calories ?? 0;
  document.getElementById("stat-bmi").textContent = profile.bmi ?? "--";

  document.getElementById("view-username").textContent = profile.username;
  document.getElementById("view-age").textContent = profile.age ?? "--";
  document.getElementById("view-weight").textContent = profile.weight ? `${profile.weight} kg` : "--";
  document.getElementById("view-height").textContent = profile.height ? `${profile.height} cm` : "--";

  document.querySelectorAll(".avatar-option").forEach((btn) => {
    btn.classList.toggle("selected", btn.dataset.avatar === profile.avatar);
  });
}

let avatarsLoaded = false;

async function initAvatarPicker() {
  const editBtn = document.getElementById("avatar-edit-btn");
  const picker = document.getElementById("avatar-picker");

  editBtn.addEventListener("click", async () => {
    if (!avatarsLoaded) {
      const res = await apiFetch("/api/avatars");
      const avatars = await res.json();

      picker.innerHTML = "";
      avatars.forEach((filename) => {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "avatar-option";
        btn.dataset.avatar = filename;
        btn.innerHTML = `<img src="${avatarUrl(filename)}" alt="Avatar option">`;
        btn.addEventListener("click", () => selectAvatar(filename));
        picker.appendChild(btn);
      });
      avatarsLoaded = true;
    }

    const isOpen = picker.style.display === "grid";
    picker.style.display = isOpen ? "none" : "grid";

    picker.querySelectorAll(".avatar-option").forEach((btn) => {
      btn.classList.toggle("selected", btn.dataset.avatar === currentProfile.avatar);
    });
  });
}

async function selectAvatar(filename) {
  const res = await apiFetch("/api/profile", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ avatar: filename }),
  });
  const profile = await res.json();
  currentProfile = profile;

  document.getElementById("profile-avatar-img").src = avatarUrl(profile.avatar);
  document.querySelectorAll(".avatar-option").forEach((btn) => {
    btn.classList.toggle("selected", btn.dataset.avatar === profile.avatar);
  });
  document.getElementById("avatar-picker").style.display = "none";
  showToast("Avatar updated");
}

function initDetailRows() {
  const list = document.querySelector(".detail-list");

  list.addEventListener("click", async (e) => {
    const editBtn = e.target.closest(".edit-btn");
    const cancelBtn = e.target.closest(".cancel-btn");
    const saveBtn = e.target.closest(".save-btn");

    if (editBtn) {
      const field = editBtn.dataset.field;
      const row = editBtn.closest(".detail-row");
      const input = document.getElementById(`edit-input-${field}`);
      input.value = currentProfile[field] ?? "";
      row.querySelector(".detail-view").style.display = "none";
      row.querySelector(".detail-edit").style.display = "flex";
      input.focus();
    }

    if (cancelBtn) {
      const row = cancelBtn.closest(".detail-row");
      row.querySelector(".detail-edit").style.display = "none";
      row.querySelector(".detail-view").style.display = "flex";
    }

   if (saveBtn) {
      const field = saveBtn.dataset.field;
      const row = saveBtn.closest(".detail-row");
      const input = document.getElementById(`edit-input-${field}`);
      const value = input.value.trim();

      if (!value) return; // don't save an empty field

      // The "Username" row is special: it's not part of the regular
      // profile document, it updates your actual login username (and
      // the greeting on the dashboard) via a dedicated endpoint that
      // also checks the new name isn't already taken.
      if (field === "username") {
        const res = await fetch("/api/account/username", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ username: value }),
        });
        const result = await res.json();

        if (!res.ok) {
          showToast(result.error || "Couldn't update username");
          return; // leave the row in edit mode so they can fix it
        }

        currentProfile.username = result.username;
        document.getElementById("profile-display-name").textContent = result.username;
        document.getElementById("view-username").textContent = result.username;
        document.getElementById("dash-username").textContent = result.username;

        row.querySelector(".detail-edit").style.display = "none";
        row.querySelector(".detail-view").style.display = "flex";
        showToast("Username updated!");
        return;
      }

            const res = await apiFetch("/api/profile", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ [field]: value }),
      });
      const profile = await res.json();

      if (!res.ok) {
        showToast(profile.error || "Couldn't save that");
        return; // leave the row in edit mode so they can fix it
      }

      currentProfile = profile;

      // Refresh the fields that could have changed as a side effect
      // (BMI recalculates whenever weight or height is edited)
      document.getElementById("stat-bmi").textContent = profile.bmi ?? "--";
      document.getElementById("view-age").textContent = profile.age ?? "--";
      document.getElementById("view-weight").textContent = profile.weight ? `${profile.weight} kg` : "--";
      document.getElementById("view-height").textContent = profile.height ? `${profile.height} cm` : "--";

      row.querySelector(".detail-edit").style.display = "none";
      row.querySelector(".detail-view").style.display = "flex";
      showToast("Saved!");
    }
  });

  list.querySelectorAll(".detail-edit input").forEach((input) => {
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        input.closest(".detail-edit").querySelector(".save-btn").click();
      }
    });
  });
}

// ─── Boot: runs once the page has fully loaded ──────────────────
document.addEventListener("DOMContentLoaded", () => {
  initTabs();
  initHamburger();
  initLogForm();
  initEditModal();
  initGoalsForm();
  initAvatarPicker();
  initDetailRows();

  loadDashboard();
  loadGoalsForm();
  loadProfile();
});