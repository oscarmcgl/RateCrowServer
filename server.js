import express from "express";
import cors from "cors";
// import Filter from "bad-words";
// import swearify from "swearify";
import { createClient } from "@supabase/supabase-js";
import { v4 as uuidv4 } from "uuid";
import axios from "axios";


// Initialize Express app
const app = express();

// Initialize Supabase client
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// CORS configuration
const allowedOrigins = [
  "https://oscarmcglone.com",
  "https://ratethiscrow.oscarmcglone.com",
  "https://crows.oscarmcglone.com",
  "https://ratethiscrow.site",
  "http://127.0.0.1:5500",
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

// Return random crow_id, img_url, avg_rating, and rating_count from the sheet
app.get("/random", async (req, res) => {
  try {
    const { data: crows, error } = await supabase
      .from("crows")
      .select("*");

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
  
// Send a rating with crow_id and rating to sheet
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
  
// Upload a new crow image with img_url creating a new crow_id
app.post("/upload", async (req, res) => {
  const { img_url, credit_name = "Unknown", credit_link = "#"} = req.body;

  if (!img_url) {
    return res.status(400).send("Missing img_url");
  }

  try {
    // Fetch all existing rows to determine the next crow_id
    const { data: crows, error: fetchError } = await supabase
      .from("crows")
      .select("crow_id");

    if (fetchError) throw fetchError;

    // Generate the new crow_id based on the number of rows
    const newCrowId = `crow_${crows.length + 1}`;

    // Insert the new crow into the database
    const { error: insertError } = await supabase
      .from("crows")
      .insert([{ crow_id: newCrowId, img_url, avg_rating: 0, rating_count: 0, credit_name, credit_link }]);

    if (insertError) throw insertError;

    res.json({ crow_id: newCrowId, img_url, credit_name, credit_link});
  } catch (error) {
    console.error("Error uploading crow:", error);
    res.status(500).send("Error uploading new crow");
  }
});
  
// Return the crow_id, img_url, avg_rating, and rating_count for top leaderboard 25%
app.get("/leaderboard", async (req, res) => {
  try {
    const { data: crows, error } = await supabase
      .from("crows")
      .select("*")
      .order("avg_rating", { ascending: false });

    if (error) throw error;

    const top25Percent = Math.ceil(crows.length * 0.25);
    res.json(crows.slice(0, top25Percent));
  } catch (error) {
    console.error("Error fetching leaderboard:", error);
    res.status(500).send("Error fetching leaderboard");
  }
});

// Return the crow_id, img_url, avg_rating, and rating_count for all crows in lb fashion 
app.get("/all-crows", async (req, res) => {
  try {
    const { data: crows, error } = await supabase
      .from("crows")
      .select("*")
      .order("avg_rating", { ascending: false });

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

app.post("/new-name", async (req, res) => {
  const { crow_id, name } = req.body;

  if (!crow_id || !name) {
    return res.status(400).send("Missing crow_id or name");
  }

  try {
    const nameId = `name_${Date.now()}`; // Generate a unique name_id
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

app.post("/name-vote", async (req, res) => {
  const { crow_id, name_id, vote_type } = req.body; // `vote_type` should be "upvote" or "downvote"

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

    // Return an empty array if no names are found
    res.json(names || []);
  } catch (error) {
    console.error("Error fetching names for crow:", error);
    res.status(500).send("Error fetching names for crow");
  }
});

/* const filter = new Filter();
filter.addWords(); //! to later

function normaliseInput(name) {
  return name.trim().toLowerCase();
}

function isValidCrowName(name) {
  if (!name || typeof name !== 'string') return false;

  const normalised = normaliseInput(name);

  if (normalised.length < 2 || normalised.length > 30) return false;
  if (filter.isProfane(normalised)) return false;
  if (swearify(normalised)) return false;

  return true;
}

app.post("/validate-name", (req, res) => {
  const { name } = req.body;

  const valid = isValidCrowName(name);
  res.json({ valid });
  }); */

  app.post("/crowmail/subscribe", async (req, res) => {
    const { email, type } = req.body;
  
    if (!email || !type) {
      return res.status(400).send("Missing email or subscription type");
    }

    
  try {
    // Check if the email is already subscribed
    const { data: existingSubscription, error: fetchError } = await supabase
      .from("crowmail")
      .select("*")
      .eq("email", email)
      .single();

    if (fetchError && fetchError.code !== "PGRST116") {
      // If the error is not "No rows found", throw it
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
    // If no rows are found, continue to the next step
  }

  try {
    // Check if the email already exists in the verification_keys table
    const { data: existingKey, error: fetchError } = await supabase
      .from("verification_keys")
      .select("*")
      .eq("email", email)
      .single();

    if (fetchError && fetchError.code !== "PGRST116") {
      // If the error is not "No rows found", throw it
      throw fetchError;
    }

    if (existingKey) {
      return res
        .status(400)
        .send(
          "This email is already registered. Please check your inbox for the verification email."
        );
    }
  } catch (error) {
    if (error.code !== "PGRST116") {
      console.error("Error checking existing verification key:", error);
      return res
        .status(500)
        .send("Error checking existing verification key");
    }
    // If no rows are found, continue to the next step
  }

    try {
      // Generate a unique verification key
      const verificationKey = uuidv4();
  
      // Calculate expiration time (24 hours from now)
      const expiresAt = new Date(Date.now() + 86400 * 1000).toISOString();
  
      // Store the key, email, type, and expiration in Supabase
      const { error: insertError } = await supabase
        .from("verification_keys")
        .insert([{ key: verificationKey, email, type, expires_at: expiresAt }]);
  
      if (insertError) throw insertError;
  
      try {
        // Generate the verification URL
        const verificationUrl = `https://crows.oscarmcglone.com/crowmail/verify?key=${verificationKey}`;
      
        const MAILTRAP_API_TOKEN = process.env.MAILTRAP_TOKEN;
      
        const response = await axios.post(
          "https://send.api.mailtrap.io/api/send", // Correct endpoint
          {
        from: {
          email: "no-reply@oscarmcglone.com",
          name: "CrowMail",
        },
        to: [
          {
            email: email,
          },
        ],
        subject: "Verify Your CrowMail Sign Up",
        html: `
        <body style="font-family: monospace; background-color: #f9f8ec; padding: 30px; text-align: center; color: #333;">
        <div style="max-width: 600px; margin: auto; background: #ffffff; border-radius: 10px; padding: 40px; box-shadow: 0 4px 12px rgba(0,0,0,0.1);">
        <h1 style="color: #2d5d63;">🐦‍⬛ Welcome to CrowMail!</h1>
        <p style="font-size: 16px;">Hey there,</p>
        <p style="font-size: 16px;">You’ve just taken the first step toward receiving magnificent crow pictures ${type}.</p>
        <p style="font-size: 16px;">Please confirm your crowing by clicking below:</p>
        <a href="${verificationUrl}">${verificationUrl}" style="display: inline-block; margin-top: 20px; padding: 12px 24px; background-color: #2d5d63; color: white; text-decoration: none; border-radius: 8px; font-size: 16px;">Confirm Crowing</a>
        <p style="margin-top: 30px; font-size: 14px; color: #777;">If you didn't sign up for <a href="https://crows.oscarmcglone.com style="color: #777; text-decoration: none; font-size: 14px;">CrowMail</a>, you can ignore this message.</p>
          </div>
        </body>`,
          },
          {
        headers: {
          "Api-Token": MAILTRAP_API_TOKEN, // Correct header for API token
          "Content-Type": "application/json",
        },
          }
        );
      
        if (response.status === 200) {
          console.log("Verification email sent successfully");
          res.status(200).send("Verification email sent successfully");
        } else {
          throw new Error("Failed to send email");
        }
      } catch (error) {
        console.error("Error sending verification email:", error);
            res.status(500).send("Error sending verification email");
          }
        } catch (error) {
          console.error("Error processing subscription:", error);
          res.status(500).send("Error processing subscription");
        }
      });

  app.post("/crowmail/verify", async (req, res) => {
  const { key } = req.query;

  if (!key) {
    return res.status(400).send("Missing verification key");
  }

  try {
    // Retrieve the key from Supabase
    const { data: verificationKey, error: fetchError } = await supabase
      .from("verification_keys")
      .select("*")
      .eq("key", key)
      .single();

    if (fetchError && fetchError.code !== "PGRST116") {
      // If the error is not "No rows found", throw it
      throw fetchError;
    }

    if (!verificationKey) {
      return res.status(400).send("Invalid or expired verification key");
    }

    const { email, type } = verificationKey;

    // Add the verified email to the database
    const { error: insertError } = await supabase
      .from("crowmail")
      .insert([{ email, type }]);

    if (insertError) throw insertError;

    // Delete the key from Supabase
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
      // If the error is not "No rows found", throw it
      throw fetchError;
    }

    if (!existingUser) {
      return res.status(404).send("User not found in subscription list");
    }

    // Delete the user from the crowmail table
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