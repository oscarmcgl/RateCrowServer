import express from "express";
import cors from "cors";
// import Filter from "bad-words";
// import swearify from "swearify";
import { createClient } from "@supabase/supabase-js";
import { v4 as uuidv4 } from "uuid";
import { Resend } from "resend";


// Initialise Express app
const app = express();

// Initialise Supabase client
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// In-memory cache for session data (avoid repeats)
const sessionCache = new Map();

// CORS configuration
const allowedOrigins = [
  "https://oscarmcglone.com",
  "https://ratethiscrow.oscarmcglone.com",
  "https://crows.oscarmcglone.com",
  "https://ratethiscrow.site",
  "http://127.0.0.1:5500",
  "https://rate.oscarmcglone.com",
];

const corsOptions = {
  origin: (origin, callback) => {
    if (!origin || allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      callback(new Error("Not allowed by CORS"));
    }
  },
  methods: ["GET", "POST", "OPTIONS"],
  allowedHeaders: ["Content-Type"],
  credentials: true,
};

app.use(cors(corsOptions));
app.options("*", cors(corsOptions));

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ============= ELO RATING UTILITY =============
function calculateElo(winnerElo, loserElo, kFactor = 32) {
  const expectedScoreWinner = 1 / (1 + Math.pow(10, (loserElo - winnerElo) / 400));
  const expectedScoreLoser = 1 - expectedScoreWinner;

  const newWinnerElo = Math.round(winnerElo + kFactor * (1 - expectedScoreWinner));
  const newLoserElo = Math.round(loserElo + kFactor * (0 - expectedScoreLoser));

  return { newWinnerElo, newLoserElo, expectedScoreWinner };
}

// Calculate percentile: what % of crows does this crow beat?
async function calculatePercentile(crowId) {
  try {
    const { data: crow, error: crowError } = await supabase
      .from("crows")
      .select("elo_rating")
      .eq("crow_id", crowId)
      .single();

    if (crowError || !crow) return 50;

    const { data: allCrows, error: allError } = await supabase
      .from("crows")
      .select("elo_rating")
      .eq("active", true);

    if (allError || !allCrows) return 50;

    const crowsBetter = allCrows.filter(c => c.elo_rating < crow.elo_rating).length;
    return (crowsBetter / allCrows.length) * 100;
  } catch (error) {
    console.error("Error calculating percentile:", error);
    return 50;
  }
}

// ============= PAIRWISE VOTING ENDPOINTS =============

// GET /pair - Fetch a pair of crows
app.get("/pair", async (req, res) => {
  const { session_id } = req.query;

  if (!session_id) {
    return res.status(400).json({ error: "Missing session_id" });
  }

  try {
    // Ensure session exists in DB to satisfy FK on voting_pairs
    const { error: sessionUpsertError } = await supabase
      .from("voting_sessions")
      .upsert([{ session_id }], { onConflict: "session_id" });

    if (sessionUpsertError) {
      console.error("Error creating session record:", sessionUpsertError);
      return res.status(500).json({ error: "Failed to initialize session" });
    }

    // Create or retrieve session
    if (!sessionCache.has(session_id)) {
      sessionCache.set(session_id, {
        recent_crow_ids: [],
        created_at: new Date(),
      });
    }

    const session = sessionCache.get(session_id);

    // Get all active crows
    const { data: activeCrows, error: crowsError } = await supabase
      .from("crows")
      .select("crow_id, img_url, elo_rating, is_crow_of_the_day, credit_name, credit_link")
      .eq("active", true)
      .order("elo_rating", { ascending: true });

    if (crowsError || !activeCrows || activeCrows.length < 2) {
      return res.status(404).json({ error: "Not enough active crows" });
    }

    // Filter out recent crows to avoid repeats
    const availableCrows = activeCrows.filter(c => !session.recent_crow_ids.includes(c.crow_id));

    if (availableCrows.length < 2) {
      // Reset if we've seen too many
      session.recent_crow_ids = [];
    }

    // Bias selection toward low confidence (lower elo/fewer games)
    // Weighted random selection favoring crows with fewer games or lower confidence
    const weighted = availableCrows.map(c => ({
      ...c,
      weight: 1 / (Math.max(1, c.elo_rating - 1400)), // Lower elo = higher weight
    }));

    const totalWeight = weighted.reduce((sum, c) => sum + c.weight, 0);
    let rand1 = Math.random() * totalWeight;
    let rand2 = Math.random() * totalWeight;

    let crow1 = weighted[0];
    let crow2 = weighted[0];

    for (const crow of weighted) {
      rand1 -= crow.weight;
      if (rand1 <= 0 && !crow1) crow1 = crow;
    }

    for (const crow of weighted) {
      rand2 -= crow.weight;
      if (rand2 <= 0 && crow.crow_id !== crow1.crow_id) {
        crow2 = crow;
        break;
      }
    }

    // Fallback if selection failed
    if (crow1.crow_id === crow2.crow_id) {
      crow2 = availableCrows.find(c => c.crow_id !== crow1.crow_id);
    }

    // Create voting pair record
    const pairId = uuidv4();
    const { error: pairError } = await supabase
      .from("voting_pairs")
      .insert([{
        pair_id: pairId,
        session_id,
        crow1_id: crow1.crow_id,
        crow2_id: crow2.crow_id,
      }]);

    if (pairError) {
      console.error("Error creating pair record:", pairError);
      return res.status(500).json({ error: "Failed to create pair" });
    }

    // Update session recent crows
    session.recent_crow_ids.push(crow1.crow_id, crow2.crow_id);
    if (session.recent_crow_ids.length > 20) {
      session.recent_crow_ids.shift();
    }

    res.json({
      pair_id: pairId,
      crow1: {
        crow_id: crow1.crow_id,
        img_url: crow1.img_url,
        elo_rating: crow1.elo_rating,
        is_crow_of_the_day: crow1.is_crow_of_the_day,
        credit_name: crow1.credit_name || "Unknown",
        credit_link: crow1.credit_link || "#",
      },
      crow2: {
        crow_id: crow2.crow_id,
        img_url: crow2.img_url,
        elo_rating: crow2.elo_rating,
        is_crow_of_the_day: crow2.is_crow_of_the_day,
        credit_name: crow2.credit_name || "Unknown",
        credit_link: crow2.credit_link || "#",
      },
    });
  } catch (error) {
    console.error("Error fetching pair:", error);
    res.status(500).json({ error: "Failed to fetch pair" });
  }
});

// POST /vote - Submit a vote
app.post("/vote", async (req, res) => {
  const { session_id, pair_id, winner_id, loser_id } = req.body;

  if (!session_id || !pair_id || !winner_id || !loser_id) {
    return res.status(400).json({ error: "Missing required fields" });
  }

  try {
    // Ensure pair exists before inserting vote (FK constraint)
    const { data: pairRow, error: pairFetchError } = await supabase
      .from("voting_pairs")
      .select("pair_id")
      .eq("pair_id", pair_id)
      .single();

    if (pairFetchError || !pairRow) {
      return res.status(400).json({ error: "Invalid or missing pair_id" });
    }

    // Fetch winner and loser
    const { data: winner, error: winnerError } = await supabase
      .from("crows")
      .select("*")
      .eq("crow_id", winner_id)
      .single();

    const { data: loser, error: loserError } = await supabase
      .from("crows")
      .select("*")
      .eq("crow_id", loser_id)
      .single();

    if (winnerError || loserError || !winner || !loser) {
      return res.status(404).json({ error: "Crow not found" });
    }

    // Calculate new Elo ratings
    const k = 32; // K-factor
    const { newWinnerElo, newLoserElo, expectedScoreWinner } = calculateElo(
      winner.elo_rating,
      loser.elo_rating,
      k
    );

    // Update crows with new Elo and games_played
    const { error: updateWinnerError } = await supabase
      .from("crows")
      .update({
        elo_rating: newWinnerElo,
        games_played: (winner.games_played || 0) + 1,
      })
      .eq("crow_id", winner_id);

    const { error: updateLoserError } = await supabase
      .from("crows")
      .update({
        elo_rating: newLoserElo,
        games_played: (loser.games_played || 0) + 1,
      })
      .eq("crow_id", loser_id);

    if (updateWinnerError || updateLoserError) {
      throw new Error("Failed to update Elo ratings");
    }

    // Record the vote
    const { error: voteError } = await supabase
      .from("votes")
      .insert([{
        pair_id,
        session_id,
        winner_crow_id: winner_id,
        loser_crow_id: loser_id,
        winner_elo_before: winner.elo_rating,
        loser_elo_before: loser.elo_rating,
        winner_elo_after: newWinnerElo,
        loser_elo_after: newLoserElo,
        k_factor: k,
      }]);

    if (voteError) {
      console.error("Error recording vote:", voteError);
    }

    // Calculate percentile for winner
    const winnerPercentile = await calculatePercentile(winner_id);

    res.json({
      winner_elo_before: winner.elo_rating,
      winner_elo_after: newWinnerElo,
      loser_elo_before: loser.elo_rating,
      loser_elo_after: newLoserElo,
      winner_percentile: winnerPercentile / 100,
    });
  } catch (error) {
    console.error("Error submitting vote:", error);
    res.status(500).json({ error: "Failed to submit vote" });
  }
});

// GET /crow-of-the-day - Get today's featured crow
app.get("/crow-of-the-day", async (req, res) => {
  try {
    const today = new Date().toISOString().split("T")[0];

    // Check if we already have a COTD for today
    const { data: cotdHistory, error: historyError } = await supabase
      .from("crow_of_the_day_history")
      .select("crow_id")
      .eq("selected_date", today)
      .single();

    if (cotdHistory) {
      // Return existing COTD
      const { data: crow, error: crowError } = await supabase
        .from("crows")
        .select("*")
        .eq("crow_id", cotdHistory.crow_id)
        .single();

      if (crowError || !crow) {
        return res.status(500).json({ error: "Failed to fetch COTD" });
      }

      return res.json(crow);
    }

    // Select a new COTD (bias toward lower confidence crows)
    const { data: activeCrows, error: crowsError } = await supabase
      .from("crows")
      .select("*")
      .eq("active", true)
      .order("games_played", { ascending: true })
      .limit(10);

    if (crowsError || !activeCrows || activeCrows.length === 0) {
      return res.status(404).json({ error: "No active crows found" });
    }

    // Random selection from the low-confidence ones
    const selectedCrow = activeCrows[Math.floor(Math.random() * activeCrows.length)];

    // Mark as COTD
    const { error: updateError } = await supabase
      .from("crows")
      .update({ is_crow_of_the_day: true })
      .eq("crow_id", selectedCrow.crow_id);

    // Record in history
    const { error: historyInsertError } = await supabase
      .from("crow_of_the_day_history")
      .insert([{
        crow_id: selectedCrow.crow_id,
        selected_date: today,
      }]);

    if (updateError || historyInsertError) {
      console.error("Error setting COTD:", updateError || historyInsertError);
    }

    res.json(selectedCrow);
  } catch (error) {
    console.error("Error fetching COTD:", error);
    res.status(500).json({ error: "Failed to fetch COTD" });
  }
});

// ============= LEGACY ENDPOINTS (with active filter) =============

// Password validation endpoint
app.post("/validate-password", (req, res) => {
  const { password } = req.body;

  const UPLOAD_PASSWORD = process.env.UPLOAD_PASS;
  if (password === UPLOAD_PASSWORD) {
    res.status(200).send("Password validated successfully");
  } else {
    res.status(401).send("Unauthorized: Incorrect password");
  }
});

// Admin: Disable a crow
app.post("/admin/disable-crow", async (req, res) => {
  const { crow_id } = req.body;

  if (!crow_id) {
    return res.status(400).json({ error: "Missing crow_id" });
  }

  try {
    const { error } = await supabase
      .from("crows")
      .update({ active: false })
      .eq("crow_id", crow_id);

    if (error) throw error;

    res.json({ success: true, message: "Crow disabled successfully" });
  } catch (error) {
    console.error("Error disabling crow:", error);
    res.status(500).json({ error: "Failed to disable crow" });
  }
});

// Return random active crow
app.get("/random", async (req, res) => {
  try {
    const { data: crows, error } = await supabase
      .from("crows")
      .select("*")
      .eq("active", true);

    if (error) throw error;

    if (!crows || crows.length === 0) {
      return res.status(404).send("No data found");
    }

    const randomCrow = crows[Math.floor(Math.random() * crows.length)];
    res.json(randomCrow);
  } catch (error) {
    console.error("Error fetching random crow:", error);
    res.status(500).send("Error fetching random crow");
  }
});
  
// Send a rating (legacy endpoint)
app.post("/rate", async (req, res) => {
  const { crow_id, rating } = req.body;

  if (!crow_id || !rating) {
    return res.status(400).send("Missing crow_id or rating");
  }

  try {
    const { data: crow, error: fetchError } = await supabase
      .from("crows")
      .select("*")
      .eq("crow_id", crow_id)
      .single();

    if (fetchError) throw fetchError;

    if (!crow) {
      return res.status(404).send("Crow not found");
    }

    const newRatingCount = crow.rating_count + 1;
    const newAvgRating = ((crow.avg_rating * crow.rating_count) + rating) / newRatingCount;

    const { error: updateError } = await supabase
      .from("crows")
      .update({ avg_rating: newAvgRating, rating_count: newRatingCount })
      .eq("crow_id", crow_id);

    if (updateError) throw updateError;

    res.send("Rating updated successfully");
  } catch (error) {
    console.error("Error updating rating:", error);
    res.status(500).send("Error updating rating");
  }
});
  
// Upload a new crow image
app.post("/upload", async (req, res) => {
  const { img_url, credit_name = "Unknown", credit_link = "#"} = req.body;

  if (!img_url) {
    return res.status(400).send("Missing img_url");
  }

  try {
    const { data: crows, error: fetchError } = await supabase
      .from("crows")
      .select("crow_id");

    if (fetchError) throw fetchError;

    const newCrowId = `crow_${crows.length + 1}`;

    const { error: insertError } = await supabase
      .from("crows")
      .insert([{
        crow_id: newCrowId,
        img_url,
        avg_rating: 0,
        rating_count: 0,
        credit_name,
        credit_link,
        active: true,
        elo_rating: 1500,
        games_played: 0,
      }]);

    if (insertError) throw insertError;

    res.json({ crow_id: newCrowId, img_url, credit_name, credit_link});
  } catch (error) {
    console.error("Error uploading crow:", error);
    res.status(500).send("Error uploading new crow");
  }
});
  
// Return top 25% of active crows
app.get("/leaderboard", async (req, res) => {
  try {
    const { data: crows, error } = await supabase
      .from("crows")
      .select("*")
      .eq("active", true)
      .order("elo_rating", { ascending: false });

    if (error) throw error;

    const top25Percent = Math.ceil(crows.length * 0.25);
    res.json(crows.slice(0, top25Percent));
  } catch (error) {
    console.error("Error fetching leaderboard:", error);
    res.status(500).send("Error fetching leaderboard");
  }
});

// Return all active crows
app.get("/all-crows", async (req, res) => {
  try {
    const { data: crows, error } = await supabase
      .from("crows")
      .select("*")
      .eq("active", true)
      .order("elo_rating", { ascending: false });

    if (error) throw error;

    if (!crows || crows.length === 0) {
      return res.status(404).send("No data found");
    }

    res.json(crows);
  } catch (error) {
    console.error("Error fetching all crows:", error);
    res.status(500).send("Error fetching all crows");
  }
});

// Get specific crow by ID
app.get("/crow/:id", async (req, res) => {
  const crowId = req.params.id;

  try {
    const { data: crow, error } = await supabase
      .from("crows")
      .select("*")
      .eq("crow_id", crowId)
      .single();

    if (error) throw error;

    if (!crow) {
      return res.status(404).send("Crow not found");
    }

    res.json({
      crow_id: crow.crow_id,
      img_url: crow.img_url,
      avg_rating: crow.avg_rating,
      rating_count: crow.rating_count,
      credit_name: crow.credit_name || "Unknown",
      credit_link: crow.credit_link || "#",
      name: crow.name || "Unnamed Crow",
    });
  } catch (error) {
    console.error("Error fetching crow by ID:", error);
    res.status(500).send("Error fetching crow");
  }
});

// Add a name suggestion for a crow
app.post("/new-name", async (req, res) => {
  const { crow_id, name } = req.body;

  if (!crow_id || !name) {
    return res.status(400).send("Missing crow_id or name");
  }

  try {
    const nameId = `name_${Date.now()}`;
    const { error } = await supabase
      .from("names")
      .insert([{ crow_id, name_id: nameId, name, upvotes: 0, downvotes: 0 }]);

    if (error) throw error;

    res.status(201).send("Name added successfully");
  } catch (error) {
    console.error("Error adding new name:", error);
    res.status(500).send("Error adding new name");
  }
});

// Vote on a name
app.post("/name-vote", async (req, res) => {
  const { crow_id, name_id, vote_type } = req.body;

  if (!crow_id || !name_id || !vote_type) {
    return res.status(400).send("Missing crow_id, name_id, or vote_type");
  }

  try {
    const { data, error: fetchError } = await supabase
      .from("names")
      .select("*")
      .eq("crow_id", crow_id)
      .eq("name_id", name_id)
      .single();

    if (fetchError) throw fetchError;

    if (!data) {
      return res.status(404).send("Name not found for this crow");
    }

    const updatedVotes =
      vote_type === "upvote"
        ? { upvotes: data.upvotes + 1 }
        : { downvotes: data.downvotes + 1 };

    const { error: updateError } = await supabase
      .from("names")
      .update(updatedVotes)
      .eq("crow_id", crow_id)
      .eq("name_id", name_id);

    if (updateError) throw updateError;

    res.send("Vote added successfully");
  } catch (error) {
    console.error("Error voting on name:", error);
    res.status(500).send("Error voting on name");
  }
});

// Fetch names for a crow
app.post("/names", async (req, res) => {
  const { crow_id } = req.body;

  if (!crow_id) {
    return res.status(400).send("Missing crow_id");
  }

  try {
    const { data: names, error } = await supabase
      .from("names")
      .select("name, upvotes, downvotes, name_id")
      .eq("crow_id", crow_id)
      .order("upvotes", { ascending: false });

    if (error) throw error;

    res.json(names || []);
  } catch (error) {
    console.error("Error fetching names for crow:", error);
    res.status(500).send("Error fetching names for crow");
  }
});

// ============= CROWMAIL ENDPOINTS =============

app.post("/crowmail/subscribe", async (req, res) => {
  const { email, type } = req.body;

  if (!email || !type) {
    return res.status(400).send("Missing email or subscription type");
  }

  try {
    const { data: existingSubscription, error: fetchError } = await supabase
      .from("crowmail")
      .select("*")
      .eq("email", email)
      .single();

    if (fetchError && fetchError.code !== "PGRST116") {
      throw fetchError;
    }

    if (existingSubscription) {
      return res.status(400).send("Email already subscribed");
    }
  } catch (error) {
    if (error.code !== "PGRST116") {
      console.error("Error signing up:", error);
      return res.status(500).send("Error signing up for CrowMail");
    }
  }

  try {
    const { data: existingKey, error: fetchError } = await supabase
      .from("verification_keys")
      .select("*")
      .eq("email", email)
      .single();

    if (fetchError && fetchError.code !== "PGRST116") {
      throw fetchError;
    }

    if (existingKey) {
      return res
        .status(400)
        .send("This email is already registered. Please check your inbox for the verification email.");
    }
  } catch (error) {
    if (error.code !== "PGRST116") {
      console.error("Error checking existing verification key:", error);
      return res.status(500).send("Error checking existing verification key");
    }
  }

  try {
    const verificationKey = uuidv4();
    const expiresAt = new Date(Date.now() + 86400 * 1000).toISOString();

    const { error: insertError } = await supabase
      .from("verification_keys")
      .insert([{ key: verificationKey, email, type, expires_at: expiresAt }]);

    if (insertError) throw insertError;

    try {
      const verificationUrl = `https://ratethiscrow.site/crowmail/verify?key=${verificationKey}`;
      const resend = new Resend(process.env.RESEND_API_KEY);

      (async function () {
        const { data, error } = await resend.emails.send({
          from: "CrowMail <crowmail@ratethiscrow.site>",
          to: email,
          subject: "Verify Your CrowMail Sign Up",
          html: `
          <body style="font-family: monospace; background-color: #f9f8ec; padding: 30px; text-align: center; color: #333;">
          <div style="max-width: 600px; margin: auto; background: #ffffff; border-radius: 10px; padding: 40px; box-shadow: 0 4px 12px rgba(0,0,0,0.1);">
          <h1 style="color: #2d5d63;">🐦‍⬛ Welcome to CrowMail!</h1>
          <p style="font-size: 16px;">Hey there,</p>
          <p style="font-size: 16px;">You've just taken the first step toward receiving magnificent crow pictures ${type}.</p>
          <p style="font-size: 16px;">Please confirm your crowing by clicking below:</p>
          <a href="${verificationUrl}" style="display: inline-block; margin-top: 20px; padding: 12px 24px; background-color: #2d5d63; color: white; text-decoration: none; border-radius: 8px; font-size: 16px;">Confirm Crowing</a>
          <p style="margin-top: 30px; font-size: 14px; color: #777;">If you didn't sign up for <a href="https://ratethiscrow.site" style="color: #777; text-decoration: underline; font-size: 14px;">CrowMail</a>, you can ignore this message.</p>
          </div>
          </body>`,
        });

        if (error) {
          return console.error({ error });
        }

        console.log("Email sent successfully:", data);
        res.status(200).send("Verification email sent successfully");
      })();
    } catch (emailError) {
      console.error("Error sending verification email:", emailError);
      res.status(500).send("Error sending verification email");
    }
  } catch (error) {
    console.error("Error generating verification key:", error);
    res.status(500).send("Error generating verification key");
  }
});

app.post("/crowmail/verify", async (req, res) => {
  const { key } = req.query;

  if (!key) {
    return res.status(400).send("Missing verification key");
  }

  try {
    const { data: verificationKey, error: fetchError } = await supabase
      .from("verification_keys")
      .select("*")
      .eq("key", key)
      .single();

    if (fetchError && fetchError.code !== "PGRST116") {
      throw fetchError;
    }

    if (!verificationKey) {
      return res.status(400).send("Invalid or expired verification key");
    }

    const { email, type } = verificationKey;

    const { error: insertError } = await supabase
      .from("crowmail")
      .insert([{ email, type }]);

    if (insertError) throw insertError;

    const { error: deleteError } = await supabase
      .from("verification_keys")
      .delete()
      .eq("key", key);

    if (deleteError) throw deleteError;

    res.status(200).send("Email verified successfully");
  } catch (error) {
    console.error("Error verifying email:", error);
    res.status(500).send("Error verifying email");
  }
});

app.post("/crowmail/unsubscribe", async (req, res) => {
  const { user_id } = req.body;

  if (!user_id) {
    return res.status(400).send("Missing user_id");
  }

  try {
    const { data: existingUser, error: fetchError } = await supabase
      .from("crowmail")
      .select("*")
      .eq("user_id", user_id)
      .single();

    if (fetchError && fetchError.code !== "PGRST116") {
      throw fetchError;
    }

    if (!existingUser) {
      return res.status(404).send("User not found in subscription list");
    }

    const { error: deleteError } = await supabase
      .from("crowmail")
      .delete()
      .eq("user_id", user_id);

    if (deleteError) throw deleteError;

    res.status(200).send("Unsubscribed successfully");
  } catch (error) {
    console.error("Error unsubscribing user:", error);
    res.status(500).send("Error unsubscribing user");
  }
});

// Health check endpoint
app.get("/health", (req, res) => {
  res.status(200).send("OK");
});

// Start the server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
