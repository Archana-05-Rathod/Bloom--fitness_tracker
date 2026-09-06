"""
Fitness Tracker - Flask Backend
================================
This file is the "brain" of the app. It does four jobs:

1. Handles login/signup so each person has their own private data.
2. Talks to MongoDB to save/read/update/delete data, scoped to whoever
   is currently logged in.
3. Exposes that data to the browser through a small REST API
   (a set of URLs that return JSON instead of HTML).
4. Serves the HTML pages (the login page, and the main app page).

Beginner tip: every API route below follows the same recipe:
    @app.route("/api/something", methods=["GET"])
    @api_login_required
    def function_name():
        user_id = session["user_id"]
        ... talk to the database, filtered by user_id ...
        return jsonify(some_python_dict_or_list)
"""

from functools import wraps
from flask import Flask, request, jsonify, render_template, session, redirect, url_for, flash
from werkzeug.security import generate_password_hash, check_password_hash
from pymongo import MongoClient
from bson.objectid import ObjectId
from datetime import datetime, timedelta
from collections import defaultdict
import statistics
import os
from dotenv import load_dotenv

load_dotenv()  # reads the .env file and makes its values available via os.environ
from flask_wtf.csrf import CSRFProtect

# ─── App + Database setup ──────────────────────────────────────
app = Flask(__name__)

# Both of these now come from the .env file instead of being hardcoded.
# os.environ["SECRET_KEY"] would crash immediately if missing -- that's
# actually good here, since running with no secret key is a mistake we
# want to catch loudly, not silently fall back from.
app.secret_key = os.environ["SECRET_KEY"]
csrf = CSRFProtect(app)

client = MongoClient(os.environ.get("MONGO_URI", "mongodb://localhost:27017/"))
db = client["fitness_tracker_db"]

users_col = db["users"]         # one document per registered user
workouts_col = db["workouts"]   # one document per logged workout
profile_col = db["profile"]     # one document per user's profile info
goals_col = db["goals"]         # one document per user's goals

# Indexes -- these run every time the app starts, but MongoDB is smart
# enough to skip the work if the index already exists, so this is safe
# to leave in permanently rather than being a one-off script.
users_col.create_index("username", unique=True)
workouts_col.create_index([("user_id", 1), ("date", -1)])
profile_col.create_index("user_id", unique=True)
goals_col.create_index("user_id", unique=True)

# Calories burned per minute for each exercise type
EXERCISE_CALORIES = {
    "running":  8.5,
    "cycling":  6.0,
    "swimming": 7.0,
    "yoga":     3.0,
    "gym":      5.5,
    "walking":  3.5,
}

# The set of avatar images a user can choose from on the Profile tab.
# These are developer-provided images living in static/img/avatars/ --
# users pick one, they don't upload their own. Keeping the list here
# (not hardcoded in the frontend) makes it the single source of truth.
AVATAR_OPTIONS = [
    "avatar-1.svg", "avatar-2.svg", "avatar-3.svg", "avatar-4.svg",
    "avatar-5.svg", "avatar-6.svg", "avatar-7.svg", "avatar-8.svg",
]
DEFAULT_AVATAR = AVATAR_OPTIONS[0]


# ─── Small helper functions ────────────────────────────────────
def doc_to_json(doc):
    """MongoDB documents contain an ObjectId, which isn't valid JSON.
    This helper copies the document and turns _id into a plain string
    so jsonify() doesn't crash."""
    if doc is None:
        return None
    doc = dict(doc)
    doc["_id"] = str(doc["_id"])
    return doc


def get_week_key(date_str):
    """Turn a 'YYYY-MM-DD' string into a 'Week NN, YYYY' label,
    so we can group workouts by week."""
    date = datetime.strptime(date_str, "%Y-%m-%d")
    return date.strftime("Week %U, %Y")


def start_of_this_week():
    """Return the date (midnight) of the most recent Monday."""
    today = datetime.now()
    return today - timedelta(days=today.weekday())


def get_lifetime_stats(user_id):
    """Total workouts + total calories burned, ever, for this user.
    Used to power the fun stat pills on the Profile tab."""
    records = list(workouts_col.find({"user_id": user_id}))
    total_workouts = len(records)
    total_calories = round(sum(w["calories"] for w in records), 0)
    return {"total_workouts": total_workouts, "total_calories": total_calories}


# ─── Login helpers ──────────────────────────────────────────────
def login_required(f):
    """Use this on PAGE routes (ones that return HTML). If nobody is
    logged in, send them to the login page instead."""
    @wraps(f)
    def wrapper(*args, **kwargs):
        if "user_id" not in session:
            return redirect(url_for("login"))
        return f(*args, **kwargs)
    return wrapper


def api_login_required(f):
    """Use this on API routes (ones that return JSON). If nobody is
    logged in, return a 401 error instead of redirecting — redirecting
    would send back an HTML login page, which would break the
    JavaScript expecting JSON."""
    @wraps(f)
    def wrapper(*args, **kwargs):
        if "user_id" not in session:
            return jsonify({"error": "Not logged in"}), 401
        return f(*args, **kwargs)
    return wrapper


# ─── Auth pages ─────────────────────────────────────────────────
@app.route("/login", methods=["GET"])
def login():
    if "user_id" in session:
        return redirect(url_for("index"))
    return render_template("login.html")


@app.route("/login", methods=["POST"])
def login_submit():
    username = request.form["username"].strip()
    password = request.form["password"]

    user = users_col.find_one({"username": username})
    if not user or not check_password_hash(user["password_hash"], password):
        flash("Incorrect username or password.")
        return redirect(url_for("login"))

    session["user_id"] = str(user["_id"])
    session["username"] = user["username"]
    return redirect(url_for("index"))


@app.route("/signup", methods=["POST"])
def signup_submit():
    username = request.form["username"].strip()
    password = request.form["password"]
    confirm_password = request.form.get("confirm_password", "")

    if len(username) < 3:
        flash("Username must be at least 3 characters.")
        return redirect(url_for("login"))
    if len(password) < 6:
        flash("Password must be at least 6 characters.")
        return redirect(url_for("login"))
    if password != confirm_password:
        flash("Passwords do not match.")
        return redirect(url_for("login"))
    if users_col.find_one({"username": username}):
        flash("That username is already taken.")
        return redirect(url_for("login"))

    new_user = {
        "username": username,
        "password_hash": generate_password_hash(password),
    }
    result = users_col.insert_one(new_user)

    session["user_id"] = str(result.inserted_id)
    session["username"] = username
    return redirect(url_for("index"))


@app.route("/logout")
def logout():
    session.clear()
    return redirect(url_for("login"))


# ─── Main page route ────────────────────────────────────────────
@app.route("/")
@login_required
def index():
    return render_template("index.html", username=session.get("username"))


# ─── Profile API ────────────────────────────────────────────────
@app.route("/api/account/username", methods=["POST"])
@csrf.exempt
@api_login_required
def update_username():
    """The username is now the one and only 'name' shown across the
    app (dashboard greeting, profile) -- there's no separate display
    name anymore, so this is the only place that changes it."""
    data = request.json
    new_username = str(data.get("username", "")).strip()

    if len(new_username) < 3:
        return jsonify({"error": "Username must be at least 3 characters."}), 400

    existing = users_col.find_one({"username": new_username})
    if existing and str(existing["_id"]) != session["user_id"]:
        return jsonify({"error": "That username is already taken."}), 400

    users_col.update_one(
        {"_id": ObjectId(session["user_id"])},
        {"$set": {"username": new_username}},
    )
    session["username"] = new_username  # keep the session in sync immediately
    return jsonify({"username": new_username})


@app.route("/api/avatars", methods=["GET"])
@api_login_required
def list_avatars():
    return jsonify(AVATAR_OPTIONS)


@app.route("/api/profile", methods=["GET"])
@api_login_required
def get_profile():
    profile = profile_col.find_one({"user_id": session["user_id"]})
    profile_json = doc_to_json(profile) or {}
    profile_json.setdefault("avatar", DEFAULT_AVATAR)
    profile_json["username"] = session["username"]  # single source of truth for display name

    # Attach fun lifetime stats every time, so they're always fresh
    # (workouts change constantly, so we compute this on the fly
    # rather than storing a possibly-stale copy on the profile).
    profile_json.update(get_lifetime_stats(session["user_id"]))

    return jsonify(profile_json)


@app.route("/api/profile", methods=["POST"])
@csrf.exempt
@api_login_required
def save_profile():
    """Saves the profile. Works for BOTH cases:
      - the full form (age, weight, height, avatar all sent at once)
      - a single inline edit (e.g. just {"age": 26} sent by itself)
    We only $set the fields that were actually included in the request,
    so editing one field in place never wipes out the others."""
    data = request.json or {}
    update_fields = {}

    if "age" in data and data["age"] not in (None, ""):
        try:
            age = int(data["age"])
        except (TypeError, ValueError):
            return jsonify({"error": "Age must be a whole number."}), 400
        if age <= 0 or age > 150:
            return jsonify({"error": "Please enter a realistic age."}), 400
        update_fields["age"] = age

    if "weight" in data and data["weight"] not in (None, ""):
        try:
            weight = float(data["weight"])
        except (TypeError, ValueError):
            return jsonify({"error": "Weight must be a number."}), 400
        if weight <= 0 or weight > 500:
            return jsonify({"error": "Please enter a realistic weight (up to 500 kg)."}), 400
        update_fields["weight"] = weight

    if "height" in data and data["height"] not in (None, ""):
        try:
            height = float(data["height"])
        except (TypeError, ValueError):
            return jsonify({"error": "Height must be a number."}), 400
        if height <= 0 or height > 300:
            return jsonify({"error": "Please enter a realistic height (up to 300 cm)."}), 400
        update_fields["height"] = height

    if "avatar" in data and data["avatar"] in AVATAR_OPTIONS:
        update_fields["avatar"] = data["avatar"]

    if update_fields:
        profile_col.update_one(
            {"user_id": session["user_id"]},
            {"$set": update_fields},
            upsert=True,
        )

    profile = profile_col.find_one({"user_id": session["user_id"]})
    if profile and profile.get("weight") and profile.get("height"):
        bmi = round(profile["weight"] / ((profile["height"] / 100) ** 2), 2)
        profile_col.update_one({"user_id": session["user_id"]}, {"$set": {"bmi": bmi}})
        profile["bmi"] = bmi

    profile_json = doc_to_json(profile) or {}
    profile_json.setdefault("avatar", DEFAULT_AVATAR)
    profile_json["username"] = session["username"]
    profile_json.update(get_lifetime_stats(session["user_id"]))
    return jsonify(profile_json)
   


# ─── Goals API ───────────────────────────────────────────────────
@app.route("/api/goals", methods=["GET"])
@api_login_required
def get_goals():
    goals = goals_col.find_one({"user_id": session["user_id"]})
    if not goals:
        goals = {"weekly_calorie_goal": 2000, "weekly_workout_goal": 4}
    return jsonify(doc_to_json(goals) if "_id" in goals else goals)


@app.route("/api/goals", methods=["POST"])
@csrf.exempt
@api_login_required
def save_goals():
    data = request.json or {}

    try:
        calorie_goal = float(data["weekly_calorie_goal"])
        workout_goal = int(data["weekly_workout_goal"])
    except (KeyError, TypeError, ValueError):
        return jsonify({"error": "Please enter valid numbers for both goals."}), 400

    if calorie_goal < 0 or workout_goal < 0:
        return jsonify({"error": "Goals can't be negative."}), 400

    new_goals = {
        "user_id": session["user_id"],
        "weekly_calorie_goal": calorie_goal,
        "weekly_workout_goal": workout_goal,
    }
    goals_col.replace_one({"user_id": session["user_id"]}, new_goals, upsert=True)
    return jsonify(new_goals)


# ─── Workouts API (Create, Read, Update, Delete) ────────────────
@app.route("/api/workouts", methods=["GET"])
@api_login_required
def list_workouts():
    records = list(
        workouts_col.find({"user_id": session["user_id"]}).sort("_id", -1).limit(50)
    )
    return jsonify([doc_to_json(w) for w in records])


@app.route("/api/workouts", methods=["POST"])
@csrf.exempt
@api_login_required
def log_workout():
    data = request.json or {}

    if not data.get("exercise") or data.get("duration") in (None, ""):
        return jsonify({"error": "Exercise and duration are required."}), 400

    try:
        duration = float(data["duration"])
    except (TypeError, ValueError):
        return jsonify({"error": "Duration must be a number."}), 400

    if duration <= 0:
        return jsonify({"error": "Duration must be greater than 0."}), 400

    exercise = data["exercise"].lower().strip()
    duration = float(data["duration"])
    cal_per_min = EXERCISE_CALORIES.get(exercise, 4.0)
    calories = round(cal_per_min * duration, 1)

    now = datetime.now()
    entry = {
        "user_id": session["user_id"],
        "date": data.get("date") or now.strftime("%Y-%m-%d"),
        "time": now.strftime("%H:%M"),
        "exercise": exercise,
        "duration": duration,
        "calories": calories,
    }
    result = workouts_col.insert_one(entry)
    entry["_id"] = str(result.inserted_id)
    return jsonify(entry), 201


@app.route("/api/workouts/<workout_id>", methods=["PUT"])
@csrf.exempt
@api_login_required
def update_workout(workout_id):
    """Edit an existing workout. We recompute calories in case the
    exercise type or duration changed. We only touch the date if one
    was actually sent — otherwise we'd wipe it out with None. We also
    filter by user_id so nobody can edit someone else's workout by
    guessing an ID."""
    data = request.json or {}

    if not data.get("exercise") or data.get("duration") in (None, ""):
        return jsonify({"error": "Exercise and duration are required."}), 400

    try:
        duration = float(data["duration"])
    except (TypeError, ValueError):
        return jsonify({"error": "Duration must be a number."}), 400

    if duration <= 0:
        return jsonify({"error": "Duration must be greater than 0."}), 400

    exercise = str(data["exercise"]).lower().strip()
    cal_per_min = EXERCISE_CALORIES.get(exercise, 4.0)
    calories = round(cal_per_min * duration, 1)

    update_fields = {
        "exercise": exercise,
        "duration": duration,
        "calories": calories,
    }
    if data.get("date"):
        update_fields["date"] = data["date"]

    workouts_col.update_one(
        {"_id": ObjectId(workout_id), "user_id": session["user_id"]},
        {"$set": update_fields}
    )
    updated = workouts_col.find_one({"_id": ObjectId(workout_id)})
    return jsonify(doc_to_json(updated))


@app.route("/api/workouts/<workout_id>", methods=["DELETE"])
@csrf.exempt
@api_login_required
def delete_workout(workout_id):
    workouts_col.delete_one({"_id": ObjectId(workout_id), "user_id": session["user_id"]})
    return jsonify({"deleted": True})


# ─── Weekly summary (table view) ────────────────────────────────
@app.route("/api/summary/weekly", methods=["GET"])
@api_login_required
def weekly_summary():
    records = list(workouts_col.find({"user_id": session["user_id"]}))
    weekly = defaultdict(list)
    for w in records:
        weekly[get_week_key(w["date"])].append(w["calories"])

    summary = []
    for week, cals in weekly.items():
        summary.append({
            "week": week,
            "total": round(sum(cals), 0),
            "avg": round(statistics.mean(cals), 0),
            "sessions": len(cals),
        })
    summary.reverse()  # most recent week first
    return jsonify(summary)


# ─── Chart data: calories burned over time ──────────────────────
@app.route("/api/stats/calories-over-time", methods=["GET"])
@api_login_required
def calories_over_time():
    records = list(workouts_col.find({"user_id": session["user_id"]}))
    by_date = defaultdict(float)
    for w in records:
        by_date[w["date"]] += w["calories"]

    sorted_dates = sorted(by_date.keys())[-14:]
    return jsonify([{"date": d, "calories": round(by_date[d], 1)} for d in sorted_dates])


# ─── Dashboard: this week's progress vs goals ───────────────────
@app.route("/api/dashboard", methods=["GET"])
@api_login_required
def dashboard():
    user_id = session["user_id"]
    goals = goals_col.find_one({"user_id": user_id}) or {
        "weekly_calorie_goal": 2000,
        "weekly_workout_goal": 4,
    }

    week_start = start_of_this_week().strftime("%Y-%m-%d")
    records = list(workouts_col.find({"user_id": user_id, "date": {"$gte": week_start}}))

    calories_so_far = sum(w["calories"] for w in records)
    workouts_so_far = len(records)

    calorie_goal = goals.get("weekly_calorie_goal", 2000)
    workout_goal = goals.get("weekly_workout_goal", 4)

    return jsonify({
        "calories_so_far": round(calories_so_far, 1),
        "calorie_goal": calorie_goal,
        "calorie_pct": round(min(calories_so_far / calorie_goal, 1) * 100) if calorie_goal else 0,
        "workouts_so_far": workouts_so_far,
        "workout_goal": workout_goal,
        "workout_pct": round(min(workouts_so_far / workout_goal, 1) * 100) if workout_goal else 0,
    })

# ─── Custom error pages ─────────────────────────────────────────
@app.errorhandler(404)
def page_not_found(e):
    return render_template("404.html"), 404


@app.errorhandler(500)
def internal_error(e):
    return render_template("500.html"), 500

if __name__ == "__main__":
    # Reads FLASK_DEBUG from .env -- "True" locally (auto-reload + full
    # error pages), and you'll set this to "False" on your live server.
    debug_mode = os.environ.get("FLASK_DEBUG", "False") == "True"
    app.run(debug=debug_mode, host="0.0.0.0", port=5000)