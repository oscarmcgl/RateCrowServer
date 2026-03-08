import os
import random
import uuid
from datetime import datetime, timedelta, timezone
from math import pow

import requests
from flask import Flask, jsonify, request
from flask_cors import CORS
from postgrest.exceptions import APIError
from supabase import Client, create_client


app = Flask(__name__)

SUPABASE_URL = os.getenv("SUPABASE_URL")
SUPABASE_KEY = os.getenv("SUPABASE_KEY")
UPLOAD_PASS = os.getenv("UPLOAD_PASS")
RESEND_API_KEY = os.getenv("RESEND_API_KEY")

if not SUPABASE_URL or not SUPABASE_KEY:
    raise RuntimeError("SUPABASE_URL and SUPABASE_KEY must be set")

supabase: Client = create_client(SUPABASE_URL, SUPABASE_KEY)

session_cache: dict[str, dict] = {}

VALID_CROW_STATUSES = {"active", "inactive", "duplicate", "retired"}

allowed_origins = [
    "https://oscarmcglone.com",
    "https://ratethiscrow.oscarmcglone.com",
    "https://crows.oscarmcglone.com",
    "https://ratethiscrow.site",
    "http://127.0.0.1:5500",
    "https://rate.oscarmcglone.com",
]

CORS(
    app,
    resources={r"/*": {"origins": allowed_origins}},
    methods=["GET", "POST", "OPTIONS"],
    allow_headers=["Content-Type"],
    supports_credentials=True,
)


def execute(query, allow_not_found: bool = False):
    try:
        return query.execute().data
    except APIError as exc:
        if allow_not_found and getattr(exc, "code", None) == "PGRST116":
            return None
        raise


def is_public_crow(crow: dict) -> bool:
    """Keep existing live behavior while allowing phased status moderation rollout."""
    status = crow.get("status")
    if status:
        return status == "active"
    return crow.get("active", True)


def status_to_active(status: str) -> bool:
    return status == "active"


def safe_int(value, default: int = 0) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


def get_public_crows() -> list[dict]:
    rows = execute(supabase.table("crows").select("*"))
    return [crow for crow in (rows or []) if is_public_crow(crow)]


def crow_win_rate(crow: dict) -> float:
    wins = safe_int(crow.get("wins"), 0)
    losses = safe_int(crow.get("losses"), 0)
    total = wins + losses
    if total <= 0:
        return 0.0
    return wins / total


def crow_match_history(crow_id: str, limit: int = 20) -> list[dict]:
    winner_rows = execute(
        supabase.table("votes")
        .select(
            "vote_id, pair_id, session_id, winner_crow_id, loser_crow_id, winner_elo_before, loser_elo_before, winner_elo_after, loser_elo_after, created_at"
        )
        .eq("winner_crow_id", crow_id)
        .order("created_at", desc=True)
        .limit(limit)
    )
    loser_rows = execute(
        supabase.table("votes")
        .select(
            "vote_id, pair_id, session_id, winner_crow_id, loser_crow_id, winner_elo_before, loser_elo_before, winner_elo_after, loser_elo_after, created_at"
        )
        .eq("loser_crow_id", crow_id)
        .order("created_at", desc=True)
        .limit(limit)
    )

    merged = sorted(
        (winner_rows or []) + (loser_rows or []),
        key=lambda row: row.get("created_at") or "",
        reverse=True,
    )[:limit]

    history = []
    for row in merged:
        is_win = row.get("winner_crow_id") == crow_id
        opponent_id = row.get("loser_crow_id") if is_win else row.get("winner_crow_id")
        elo_before = row.get("winner_elo_before") if is_win else row.get("loser_elo_before")
        elo_after = row.get("winner_elo_after") if is_win else row.get("loser_elo_after")

        history.append(
            {
                "vote_id": row.get("vote_id"),
                "pair_id": row.get("pair_id"),
                "session_id": row.get("session_id"),
                "opponent_id": opponent_id,
                "result": "win" if is_win else "loss",
                "elo_before": elo_before,
                "elo_after": elo_after,
                "created_at": row.get("created_at"),
            }
        )

    return history


def calculate_elo(winner_elo: int, loser_elo: int, k_factor: int = 32):
    expected_score_winner = 1 / (1 + pow(10, (loser_elo - winner_elo) / 400))
    expected_score_loser = 1 - expected_score_winner

    new_winner_elo = round(winner_elo + k_factor * (1 - expected_score_winner))
    new_loser_elo = round(loser_elo + k_factor * (0 - expected_score_loser))

    return {
        "new_winner_elo": new_winner_elo,
        "new_loser_elo": new_loser_elo,
        "expected_score_winner": expected_score_winner,
    }


def calculate_percentile(crow_id: str):
    try:
        crow = execute(
            supabase.table("crows").select("elo_rating").eq("crow_id", crow_id).single(),
            allow_not_found=True,
        )
        if not crow:
            return 50

        all_crows = execute(supabase.table("crows").select("elo_rating, status, active"))
        all_crows = [c for c in (all_crows or []) if is_public_crow(c)]
        if not all_crows:
            return 50

        crows_better = [c for c in all_crows if c.get("elo_rating", 0) < crow.get("elo_rating", 0)]
        return (len(crows_better) / len(all_crows)) * 100
    except Exception as exc:
        print("Error calculating percentile:", exc)
        return 50


def weighted_choice(crows: list[dict]):
    if not crows:
        return None

    weights = [1 / max(1, (crow.get("elo_rating") or 0) - 1400) for crow in crows]
    total_weight = sum(weights)
    if total_weight <= 0:
        return random.choice(crows)

    rand_value = random.uniform(0, total_weight)
    running = 0.0
    for crow, weight in zip(crows, weights):
        running += weight
        if running >= rand_value:
            return crow

    return crows[-1]


def find_similar_elo_candidates(
    crow_a: dict,
    active_crows: list[dict],
    recent_crow_ids: list[str],
    initial_window: int = 50,
    max_window: int = 600,
):
    """Pick matchup candidates close to crow_a Elo, expanding window when pool is too small."""
    crow_a_id = crow_a.get("crow_id")
    crow_a_elo = crow_a.get("elo_rating") or 1500

    window = initial_window
    while window <= max_window:
        candidates = [
            crow
            for crow in active_crows
            if crow.get("crow_id") != crow_a_id
            and crow.get("crow_id") not in recent_crow_ids
            and abs((crow.get("elo_rating") or 1500) - crow_a_elo) <= window
        ]
        if candidates:
            return candidates
        window *= 2

    # Last resort: keep matchup possible even if recency filter is too strict.
    fallback = [crow for crow in active_crows if crow.get("crow_id") != crow_a_id]
    if not fallback:
        return []

    closest_gap = min(abs((crow.get("elo_rating") or 1500) - crow_a_elo) for crow in fallback)
    return [
        crow for crow in fallback if abs((crow.get("elo_rating") or 1500) - crow_a_elo) == closest_gap
    ]


def crow_response_shape(crow: dict):
    return {
        "crow_id": crow.get("crow_id"),
        "img_url": crow.get("img_url"),
        "elo_rating": crow.get("elo_rating"),
        "is_crow_of_the_day": crow.get("is_crow_of_the_day"),
        "credit_name": crow.get("credit_name") or "Unknown",
        "credit_link": crow.get("credit_link") or "#",
    }


@app.get("/pair")
def get_pair():
    session_id = request.args.get("session_id")
    featured_crow_id = request.args.get("featured_crow_id")

    if not session_id:
        return jsonify({"error": "Missing session_id"}), 400

    try:
        execute(
            supabase.table("voting_sessions").upsert(
                [{"session_id": session_id}], on_conflict="session_id"
            )
        )

        if session_id not in session_cache:
            session_cache[session_id] = {
                "recent_crow_ids": [],
                "created_at": datetime.now(timezone.utc),
            }

        session = session_cache[session_id]

        all_crows = execute(
            supabase.table("crows")
            .select(
                "crow_id, img_url, elo_rating, is_crow_of_the_day, credit_name, credit_link, status, active"
            )
            .order("elo_rating", desc=False)
        )

        active_crows = [crow for crow in (all_crows or []) if is_public_crow(crow)]

        if not active_crows or len(active_crows) < 2:
            return jsonify({"error": "Not enough active crows"}), 404

        crow1 = None
        crow2 = None

        if featured_crow_id:
            featured = next((c for c in active_crows if c.get("crow_id") == featured_crow_id), None)
            if not featured:
                return jsonify({"error": "Featured crow not found"}), 404

            crow1 = featured
            candidates = find_similar_elo_candidates(
                crow1,
                active_crows,
                session["recent_crow_ids"],
            )
            crow2 = random.choice(candidates) if candidates else None
        else:
            available = [
                crow for crow in active_crows if crow.get("crow_id") not in session["recent_crow_ids"]
            ]

            if not available:
                session["recent_crow_ids"] = []
                available = active_crows

            crow1 = random.choice(available)
            candidates = find_similar_elo_candidates(
                crow1,
                active_crows,
                session["recent_crow_ids"],
            )
            crow2 = random.choice(candidates) if candidates else None

        if not crow1 or not crow2:
            return jsonify({"error": "Failed to select pair"}), 500

        pair_id = str(uuid.uuid4())
        execute(
            supabase.table("voting_pairs").insert(
                [
                    {
                        "pair_id": pair_id,
                        "session_id": session_id,
                        "crow1_id": crow1.get("crow_id"),
                        "crow2_id": crow2.get("crow_id"),
                    }
                ]
            )
        )

        session["recent_crow_ids"].append(crow1.get("crow_id"))
        session["recent_crow_ids"].append(crow2.get("crow_id"))
        if len(session["recent_crow_ids"]) > 20:
            session["recent_crow_ids"].pop(0)

        return jsonify(
            {
                "pair_id": pair_id,
                "crow1": crow_response_shape(crow1),
                "crow2": crow_response_shape(crow2),
            }
        )
    except Exception as exc:
        print("Error fetching pair:", exc)
        return jsonify({"error": "Failed to fetch pair"}), 500


@app.post("/vote")
def post_vote():
    payload = request.get_json(silent=True) or {}
    session_id = payload.get("session_id")
    pair_id = payload.get("pair_id")
    winner_id = payload.get("winner_id")
    loser_id = payload.get("loser_id")

    if not session_id or not pair_id or not winner_id or not loser_id:
        return jsonify({"error": "Missing required fields"}), 400

    try:
        pair_row = execute(
            supabase.table("voting_pairs").select("pair_id").eq("pair_id", pair_id).single(),
            allow_not_found=True,
        )
        if not pair_row:
            return jsonify({"error": "Invalid or missing pair_id"}), 400

        winner = execute(
            supabase.table("crows").select("*").eq("crow_id", winner_id).single(),
            allow_not_found=True,
        )
        loser = execute(
            supabase.table("crows").select("*").eq("crow_id", loser_id).single(),
            allow_not_found=True,
        )

        if not winner or not loser:
            return jsonify({"error": "Crow not found"}), 404

        k = 32
        elo = calculate_elo(winner.get("elo_rating", 1500), loser.get("elo_rating", 1500), k)
        new_winner_elo = elo["new_winner_elo"]
        new_loser_elo = elo["new_loser_elo"]

        execute(
            supabase.table("crows")
            .update(
                {
                    "elo_rating": new_winner_elo,
                    "games_played": (winner.get("games_played") or 0) + 1,
                    "wins": (winner.get("wins") or 0) + 1,
                }
            )
            .eq("crow_id", winner_id)
        )

        execute(
            supabase.table("crows")
            .update(
                {
                    "elo_rating": new_loser_elo,
                    "games_played": (loser.get("games_played") or 0) + 1,
                    "losses": (loser.get("losses") or 0) + 1,
                }
            )
            .eq("crow_id", loser_id)
        )

        try:
            execute(
                supabase.table("votes").insert(
                    [
                        {
                            "pair_id": pair_id,
                            "session_id": session_id,
                            "winner_crow_id": winner_id,
                            "loser_crow_id": loser_id,
                            "winner_elo_before": winner.get("elo_rating"),
                            "loser_elo_before": loser.get("elo_rating"),
                            "winner_elo_after": new_winner_elo,
                            "loser_elo_after": new_loser_elo,
                            "k_factor": k,
                        }
                    ]
                )
            )
        except Exception as vote_exc:
            print("Error recording vote:", vote_exc)

        winner_percentile = calculate_percentile(winner_id)

        return jsonify(
            {
                "winner_elo_before": winner.get("elo_rating"),
                "winner_elo_after": new_winner_elo,
                "loser_elo_before": loser.get("elo_rating"),
                "loser_elo_after": new_loser_elo,
                "winner_percentile": winner_percentile / 100,
            }
        )
    except Exception as exc:
        print("Error submitting vote:", exc)
        return jsonify({"error": "Failed to submit vote"}), 500


@app.post("/api/v1/vote")
def post_vote_v1():
    payload = request.get_json(silent=True) or {}
    crow_a = payload.get("crow_a")
    crow_b = payload.get("crow_b")
    winner_id = payload.get("winner")
    session_id = payload.get("session_id")
    pair_id = payload.get("pair_id")
    user_id = payload.get("user_id")

    if not crow_a or not crow_b or not winner_id:
        return jsonify({"error": "Missing crow_a, crow_b, or winner"}), 400

    if crow_a == crow_b:
        return jsonify({"error": "crow_a and crow_b must be different"}), 400

    if winner_id not in {crow_a, crow_b}:
        return jsonify({"error": "winner must match crow_a or crow_b"}), 400

    if user_id is not None:
        try:
            uuid.UUID(str(user_id))
        except ValueError:
            return jsonify({"error": "user_id must be a valid UUID or null"}), 400

    if session_id is not None:
        try:
            uuid.UUID(str(session_id))
        except ValueError:
            return jsonify({"error": "session_id must be a valid UUID or null"}), 400

    if pair_id is not None:
        try:
            uuid.UUID(str(pair_id))
        except ValueError:
            return jsonify({"error": "pair_id must be a valid UUID or null"}), 400

    try:
        crow_a_row = execute(
            supabase.table("crows").select("*").eq("crow_id", crow_a).single(),
            allow_not_found=True,
        )
        crow_b_row = execute(
            supabase.table("crows").select("*").eq("crow_id", crow_b).single(),
            allow_not_found=True,
        )

        if not crow_a_row or not crow_b_row:
            return jsonify({"error": "One or more crows not found"}), 404

        if not is_public_crow(crow_a_row) or not is_public_crow(crow_b_row):
            return jsonify({"error": "Only active crows can be voted on"}), 400

        winner_row = crow_a_row if winner_id == crow_a else crow_b_row
        loser_row = crow_b_row if winner_id == crow_a else crow_a_row
        loser_id = loser_row.get("crow_id")

        k = 32
        elo = calculate_elo(winner_row.get("elo_rating", 1500), loser_row.get("elo_rating", 1500), k)
        new_winner_elo = elo["new_winner_elo"]
        new_loser_elo = elo["new_loser_elo"]

        execute(
            supabase.table("crows")
            .update(
                {
                    "elo_rating": new_winner_elo,
                    "games_played": (winner_row.get("games_played") or 0) + 1,
                    "wins": (winner_row.get("wins") or 0) + 1,
                }
            )
            .eq("crow_id", winner_id)
        )

        execute(
            supabase.table("crows")
            .update(
                {
                    "elo_rating": new_loser_elo,
                    "games_played": (loser_row.get("games_played") or 0) + 1,
                    "losses": (loser_row.get("losses") or 0) + 1,
                }
            )
            .eq("crow_id", loser_id)
        )

        vote_id = str(uuid.uuid4())
        resolved_session_id = str(session_id) if session_id is not None else str(uuid.uuid4())
        resolved_pair_id = str(pair_id) if pair_id is not None else str(uuid.uuid4())

        execute(
            supabase.table("votes").insert(
                [
                    {
                        "vote_id": vote_id,
                        "pair_id": resolved_pair_id,
                        "session_id": resolved_session_id,
                        "winner_crow_id": winner_id,
                        "loser_crow_id": loser_id,
                        "winner_elo_before": winner_row.get("elo_rating", 1500),
                        "loser_elo_before": loser_row.get("elo_rating", 1500),
                        "winner_elo_after": new_winner_elo,
                        "loser_elo_after": new_loser_elo,
                        "k_factor": k,
                        "created_at": datetime.now(timezone.utc).isoformat(),
                        "user_id": str(user_id) if user_id is not None else None,
                    }
                ]
            )
        )

        return jsonify(
            {
                "vote_id": vote_id,
                "crow_a": crow_a,
                "crow_b": crow_b,
                "winner": winner_id,
                "session_id": resolved_session_id,
                "pair_id": resolved_pair_id,
                "user_id": user_id,
                "winner_elo_before": winner_row.get("elo_rating", 1500),
                "winner_elo_after": new_winner_elo,
                "loser_elo_before": loser_row.get("elo_rating", 1500),
                "loser_elo_after": new_loser_elo,
            }
        )
    except Exception as exc:
        print("Error submitting /api/v1/vote:", exc)
        return jsonify({"error": "Failed to submit vote"}), 500


@app.get("/crow-of-the-day")
def get_crow_of_the_day():
    try:
        today = datetime.now(timezone.utc).date().isoformat()

        cotd_history = execute(
            supabase.table("crow_of_the_day_history")
            .select("crow_id")
            .eq("selected_date", today)
            .single(),
            allow_not_found=True,
        )

        if cotd_history:
            crow = execute(
                supabase.table("crows")
                .select("*")
                .eq("crow_id", cotd_history.get("crow_id"))
                .single(),
                allow_not_found=True,
            )
            if not crow:
                return jsonify({"error": "Failed to fetch COTD"}), 500
            return jsonify(crow)

        all_crows = execute(
            supabase.table("crows")
            .select("*")
            .order("games_played", desc=False)
            .limit(10)
        )

        active_crows = [crow for crow in (all_crows or []) if is_public_crow(crow)]

        if not active_crows:
            return jsonify({"error": "No active crows found"}), 404

        selected_crow = random.choice(active_crows)

        update_error = None
        history_insert_error = None

        try:
            execute(
                supabase.table("crows")
                .update({"is_crow_of_the_day": True})
                .eq("crow_id", selected_crow.get("crow_id"))
            )
        except Exception as exc:
            update_error = exc

        try:
            execute(
                supabase.table("crow_of_the_day_history").insert(
                    [{"crow_id": selected_crow.get("crow_id"), "selected_date": today}]
                )
            )
        except Exception as exc:
            history_insert_error = exc

        if update_error or history_insert_error:
            print("Error setting COTD:", update_error or history_insert_error)

        return jsonify(selected_crow)
    except Exception as exc:
        print("Error fetching COTD:", exc)
        return jsonify({"error": "Failed to fetch COTD"}), 500


@app.post("/validate-password")
def validate_password():
    payload = request.get_json(silent=True) or {}
    password = payload.get("password")

    if password == UPLOAD_PASS:
        return "Password validated successfully", 200
    return "Unauthorized: Incorrect password", 401


@app.post("/admin/disable-crow")
def disable_crow():
    payload = request.get_json(silent=True) or {}
    crow_id = payload.get("crow_id")

    if not crow_id:
        return jsonify({"error": "Missing crow_id"}), 400

    try:
        execute(
            supabase.table("crows")
            .update({"active": False, "status": "inactive"})
            .eq("crow_id", crow_id)
        )
        return jsonify({"success": True, "message": "Crow disabled successfully"})
    except Exception as exc:
        print("Error disabling crow:", exc)
        return jsonify({"error": "Failed to disable crow"}), 500


@app.post("/admin/set-crow-status")
def set_crow_status():
    payload = request.get_json(silent=True) or {}
    crow_id = payload.get("crow_id")
    status = payload.get("status")

    if not crow_id or not status:
        return jsonify({"error": "Missing crow_id or status"}), 400

    if status not in VALID_CROW_STATUSES:
        return (
            jsonify(
                {
                    "error": "Invalid status",
                    "allowed": sorted(VALID_CROW_STATUSES),
                }
            ),
            400,
        )

    try:
        execute(
            supabase.table("crows")
            .update({"status": status, "active": status_to_active(status)})
            .eq("crow_id", crow_id)
        )
        return jsonify({"success": True, "crow_id": crow_id, "status": status})
    except Exception as exc:
        print("Error updating crow status:", exc)
        return jsonify({"error": "Failed to update crow status"}), 500


@app.get("/random")
def random_crow():
    try:
        crows = execute(supabase.table("crows").select("*"))
        crows = [crow for crow in (crows or []) if is_public_crow(crow)]
        if not crows:
            return "No data found", 404
        return jsonify(random.choice(crows))
    except Exception as exc:
        print("Error fetching random crow:", exc)
        return "Error fetching random crow", 500


@app.post("/rate")
def rate_crow():
    payload = request.get_json(silent=True) or {}
    crow_id = payload.get("crow_id")
    rating = payload.get("rating")

    if not crow_id or rating is None:
        return "Missing crow_id or rating", 400

    try:
        crow = execute(
            supabase.table("crows").select("*").eq("crow_id", crow_id).single(),
            allow_not_found=True,
        )
        if not crow:
            return "Crow not found", 404

        new_rating_count = (crow.get("rating_count") or 0) + 1
        new_avg_rating = (
            ((crow.get("avg_rating") or 0) * (crow.get("rating_count") or 0)) + rating
        ) / new_rating_count

        execute(
            supabase.table("crows")
            .update({"avg_rating": new_avg_rating, "rating_count": new_rating_count})
            .eq("crow_id", crow_id)
        )
        return "Rating updated successfully", 200
    except Exception as exc:
        print("Error updating rating:", exc)
        return "Error updating rating", 500


@app.post("/upload")
def upload_crow():
    payload = request.get_json(silent=True) or {}
    img_url = payload.get("img_url")
    credit_name = payload.get("credit_name") or "Unknown"
    credit_link = payload.get("credit_link") or "#"

    if not img_url:
        return "Missing img_url", 400

    try:
        crows = execute(supabase.table("crows").select("crow_id"))
        new_crow_id = f"crow_{len(crows) + 1}"

        execute(
            supabase.table("crows").insert(
                [
                    {
                        "crow_id": new_crow_id,
                        "img_url": img_url,
                        "avg_rating": 0,
                        "rating_count": 0,
                        "credit_name": credit_name,
                        "credit_link": credit_link,
                        "active": True,
                        "elo_rating": 1500,
                        "games_played": 0,
                        "wins": 0,
                        "losses": 0,
                        "status": "active",
                    }
                ]
            )
        )

        return (
            jsonify(
                {
                    "crow_id": new_crow_id,
                    "img_url": img_url,
                    "credit_name": credit_name,
                    "credit_link": credit_link,
                }
            ),
            200,
        )
    except Exception as exc:
        print("Error uploading crow:", exc)
        return "Error uploading new crow", 500


@app.get("/leaderboard")
def leaderboard():
    try:
        crows = execute(supabase.table("crows").select("*").order("elo_rating", desc=True))
        crows = [crow for crow in (crows or []) if is_public_crow(crow)]
        top_25_percent = int((len(crows) * 0.25) + 0.999999)
        return jsonify(crows[:top_25_percent])
    except Exception as exc:
        print("Error fetching leaderboard:", exc)
        return "Error fetching leaderboard", 500


@app.get("/top-crows")
def top_crows():
    try:
        limit = max(1, min(200, safe_int(request.args.get("limit"), 50)))
        min_games = max(0, safe_int(request.args.get("min_games"), 10))

        crows = get_public_crows()
        crows = [crow for crow in crows if safe_int(crow.get("games_played"), 0) >= min_games]
        crows.sort(
            key=lambda crow: (
                safe_int(crow.get("elo_rating"), 1500),
                safe_int(crow.get("games_played"), 0),
            ),
            reverse=True,
        )
        return jsonify(crows[:limit])
    except Exception as exc:
        print("Error fetching top crows:", exc)
        return "Error fetching top crows", 500


@app.get("/controversial-crows")
def controversial_crows():
    try:
        limit = max(1, min(200, safe_int(request.args.get("limit"), 50)))
        min_games = max(1, safe_int(request.args.get("min_games"), 10))

        crows = get_public_crows()
        crows = [crow for crow in crows if safe_int(crow.get("games_played"), 0) >= min_games]

        def controversy_key(crow: dict):
            win_rate = crow_win_rate(crow)
            return (
                abs(win_rate - 0.5),
                -safe_int(crow.get("games_played"), 0),
            )

        crows.sort(key=controversy_key)
        return jsonify(crows[:limit])
    except Exception as exc:
        print("Error fetching controversial crows:", exc)
        return "Error fetching controversial crows", 500


@app.get("/new-crows")
def new_crows():
    try:
        limit = max(1, min(200, safe_int(request.args.get("limit"), 50)))

        crows = get_public_crows()
        crows.sort(key=lambda crow: crow.get("created_at") or "", reverse=True)
        return jsonify(crows[:limit])
    except Exception as exc:
        print("Error fetching new crows:", exc)
        return "Error fetching new crows", 500


@app.get("/all-crows")
def all_crows():
    try:
        crows = execute(supabase.table("crows").select("*").order("elo_rating", desc=True))
        crows = [crow for crow in (crows or []) if is_public_crow(crow)]
        if not crows:
            return "No data found", 404
        return jsonify(crows)
    except Exception as exc:
        print("Error fetching all crows:", exc)
        return "Error fetching all crows", 500


@app.get("/crow/<crow_id>")
def get_crow(crow_id: str):
    try:
        include_history_raw = (request.args.get("include_history") or "1").strip().lower()
        include_history = include_history_raw not in {"0", "false", "no"}
        history_limit = max(1, min(100, safe_int(request.args.get("history_limit"), 20)))

        crow = execute(
            supabase.table("crows").select("*").eq("crow_id", crow_id).single(),
            allow_not_found=True,
        )
        if not crow:
            return "Crow not found", 404

        wins = safe_int(crow.get("wins"), 0)
        losses = safe_int(crow.get("losses"), 0)
        games_played = safe_int(crow.get("games_played"), wins + losses)
        win_rate = crow_win_rate(crow)

        response = {
            "crow_id": crow.get("crow_id"),
            "img_url": crow.get("img_url"),
            "elo_rating": safe_int(crow.get("elo_rating"), 1500),
            "games_played": games_played,
            "wins": wins,
            "losses": losses,
            "win_rate": win_rate,
            "credit_name": crow.get("credit_name") or "Unknown",
            "credit_link": crow.get("credit_link") or "#",
            "created_at": crow.get("created_at"),
            "status": crow.get("status") or "active",
            "avg_rating": crow.get("avg_rating"),
            "rating_count": crow.get("rating_count"),
            "name": crow.get("name") or "Unnamed Crow",
        }

        if include_history:
            response["match_history"] = crow_match_history(crow_id, history_limit)

        return jsonify(response)
    except Exception as exc:
        print("Error fetching crow by ID:", exc)
        return "Error fetching crow", 500


@app.post("/new-name")
def new_name():
    payload = request.get_json(silent=True) or {}
    crow_id = payload.get("crow_id")
    name = payload.get("name")

    if not crow_id or not name:
        return "Missing crow_id or name", 400

    try:
        name_id = f"name_{int(datetime.now(timezone.utc).timestamp() * 1000)}"
        execute(
            supabase.table("names").insert(
                [{"crow_id": crow_id, "name_id": name_id, "name": name, "upvotes": 0, "downvotes": 0}]
            )
        )
        return "Name added successfully", 201
    except Exception as exc:
        print("Error adding new name:", exc)
        return "Error adding new name", 500


@app.post("/name-vote")
def name_vote():
    payload = request.get_json(silent=True) or {}
    crow_id = payload.get("crow_id")
    name_id = payload.get("name_id")
    vote_type = payload.get("vote_type")

    if not crow_id or not name_id or not vote_type:
        return "Missing crow_id, name_id, or vote_type", 400

    try:
        name_row = execute(
            supabase.table("names")
            .select("*")
            .eq("crow_id", crow_id)
            .eq("name_id", name_id)
            .single(),
            allow_not_found=True,
        )

        if not name_row:
            return "Name not found for this crow", 404

        updated_votes = (
            {"upvotes": (name_row.get("upvotes") or 0) + 1}
            if vote_type == "upvote"
            else {"downvotes": (name_row.get("downvotes") or 0) + 1}
        )

        execute(
            supabase.table("names")
            .update(updated_votes)
            .eq("crow_id", crow_id)
            .eq("name_id", name_id)
        )

        return "Vote added successfully", 200
    except Exception as exc:
        print("Error voting on name:", exc)
        return "Error voting on name", 500


@app.post("/names")
def names():
    payload = request.get_json(silent=True) or {}
    crow_id = payload.get("crow_id")

    if not crow_id:
        return "Missing crow_id", 400

    try:
        rows = execute(
            supabase.table("names")
            .select("name, upvotes, downvotes, name_id")
            .eq("crow_id", crow_id)
            .order("upvotes", desc=True)
        )
        return jsonify(rows or [])
    except Exception as exc:
        print("Error fetching names for crow:", exc)
        return "Error fetching names for crow", 500


def send_verification_email(email: str, subscription_type: str, verification_key: str):
    if not RESEND_API_KEY:
        raise RuntimeError("RESEND_API_KEY is not set")

    verification_url = f"https://ratethiscrow.site/crowmail/verify?key={verification_key}"
    html = f"""
    <body style=\"font-family: monospace; background-color: #f9f8ec; padding: 30px; text-align: center; color: #333;\">
      <div style=\"max-width: 600px; margin: auto; background: #ffffff; border-radius: 10px; padding: 40px; box-shadow: 0 4px 12px rgba(0,0,0,0.1);\">
        <h1 style=\"color: #2d5d63;\">Welcome to CrowMail!</h1>
        <p style=\"font-size: 16px;\">Hey there,</p>
        <p style=\"font-size: 16px;\">You've just taken the first step toward receiving magnificent crow pictures {subscription_type}.</p>
        <p style=\"font-size: 16px;\">Please confirm your crowing by clicking below:</p>
        <a href=\"{verification_url}\" style=\"display: inline-block; margin-top: 20px; padding: 12px 24px; background-color: #2d5d63; color: white; text-decoration: none; border-radius: 8px; font-size: 16px;\">Confirm Crowing</a>
        <p style=\"margin-top: 30px; font-size: 14px; color: #777;\">If you didn't sign up for <a href=\"https://ratethiscrow.site\" style=\"color: #777; text-decoration: underline; font-size: 14px;\">CrowMail</a>, you can ignore this message.</p>
      </div>
    </body>
    """

    response = requests.post(
        "https://api.resend.com/emails",
        headers={
            "Authorization": f"Bearer {RESEND_API_KEY}",
            "Content-Type": "application/json",
        },
        json={
            "from": "CrowMail <crowmail@ratethiscrow.site>",
            "to": email,
            "subject": "Verify Your CrowMail Sign Up",
            "html": html,
        },
        timeout=20,
    )
    response.raise_for_status()


@app.post("/crowmail/subscribe")
def crowmail_subscribe():
    payload = request.get_json(silent=True) or {}
    email = payload.get("email")
    subscription_type = payload.get("type")

    if not email or not subscription_type:
        return "Missing email or subscription type", 400

    try:
        existing_subscription = execute(
            supabase.table("crowmail").select("*").eq("email", email).single(),
            allow_not_found=True,
        )
        if existing_subscription:
            return "Email already subscribed", 400
    except Exception as exc:
        print("Error signing up:", exc)
        return "Error signing up for CrowMail", 500

    try:
        existing_key = execute(
            supabase.table("verification_keys").select("*").eq("email", email).single(),
            allow_not_found=True,
        )
        if existing_key:
            return (
                "This email is already registered. Please check your inbox for the verification email.",
                400,
            )
    except Exception as exc:
        print("Error checking existing verification key:", exc)
        return "Error checking existing verification key", 500

    try:
        verification_key = str(uuid.uuid4())
        expires_at = (datetime.now(timezone.utc) + timedelta(days=1)).isoformat()

        execute(
            supabase.table("verification_keys").insert(
                [
                    {
                        "key": verification_key,
                        "email": email,
                        "type": subscription_type,
                        "expires_at": expires_at,
                    }
                ]
            )
        )

        send_verification_email(email, subscription_type, verification_key)
        return "Verification email sent successfully", 200
    except requests.RequestException as exc:
        print("Error sending verification email:", exc)
        return "Error sending verification email", 500
    except Exception as exc:
        print("Error generating verification key:", exc)
        return "Error generating verification key", 500


@app.post("/crowmail/verify")
def crowmail_verify():
    key = request.args.get("key")

    if not key:
        return "Missing verification key", 400

    try:
        verification_key = execute(
            supabase.table("verification_keys").select("*").eq("key", key).single(),
            allow_not_found=True,
        )

        if not verification_key:
            return "Invalid or expired verification key", 400

        email = verification_key.get("email")
        subscription_type = verification_key.get("type")

        execute(supabase.table("crowmail").insert([{"email": email, "type": subscription_type}]))
        execute(supabase.table("verification_keys").delete().eq("key", key))

        return "Email verified successfully", 200
    except Exception as exc:
        print("Error verifying email:", exc)
        return "Error verifying email", 500


@app.post("/crowmail/unsubscribe")
def crowmail_unsubscribe():
    payload = request.get_json(silent=True) or {}
    user_id = payload.get("user_id")

    if not user_id:
        return "Missing user_id", 400

    try:
        existing_user = execute(
            supabase.table("crowmail").select("*").eq("user_id", user_id).single(),
            allow_not_found=True,
        )

        if not existing_user:
            return "User not found in subscription list", 404

        execute(supabase.table("crowmail").delete().eq("user_id", user_id))
        return "Unsubscribed successfully", 200
    except Exception as exc:
        print("Error unsubscribing user:", exc)
        return "Error unsubscribing user", 500


@app.get("/health")
def health():
    return "OK", 200


if __name__ == "__main__":
    port = int(os.getenv("PORT", "3000"))
    app.run(host="0.0.0.0", port=port)
