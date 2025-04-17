const express = require("express");
const cors = require("cors");
const Filter = require("bad-words");
const swearify = require("swearify");

const app = express(); // Initialize the Express app

const { createClient } = require("@supabase/supabase-js");

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

const redis = require("redis");
const { promisify } = require("util");

const redisClient = redis.createClient();
const setAsync = promisify(redisClient.set).bind(redisClient);
const getAsync = promisify(redisClient.get).bind(redisClient);
const delAsync = promisify(redisClient.del).bind(redisClient);

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
  credentials: true                   
};


app.use(cors(corsOptions));
app.options("*", cors(corsOptions)); 

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

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

const filter = new Filter();
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
  });

// CROWMAIL 

import pkg from "mailtrap";
const { MailtrapClient } = pkg;

import { v4 as uuidv4 } from "uuid";

// Configure Mailtrap Client
const TOKEN = process.env.MAILTRAP_API_TOKEN; // Your Mailtrap API token
const SENDER_EMAIL = "no-reply@oscarmcglone.com"; // Sender email address
const client = new MailtrapClient({ token: TOKEN });

app.post("/crowmail/subscribe", async (req, res) => {
  const { email, type } = req.body;

  if (!email || !type) {
    return res.status(400).send("Missing email or subscription type");
  }

  try {
    // Generate a unique verification key
    const verificationKey = uuidv4();

    // Store the key and email in Redis with a 24-hour expiration
    await setAsync(verificationKey, JSON.stringify({ email, type }), "EX", 86400);

    // Generate the verification URL
    const verificationUrl = `https://crows.oscarmcglone.com/crowmail/verify?key=${verificationKey}`;

    // Send the verification email using Mailtrap
    await client.send({
      from: {
        email: SENDER_EMAIL,
        name: "CrowMail",
      },
      to: [
        {
          email: email,
        },
      ],
      subject: "Verify Your CrowMail Sign Up",
      html: `<p>Click the link below to verify your sign up:</p>
             <a href="${verificationUrl}">${verificationUrl}</a>`,
    });

    res.status(200).send("Verification email sent");
  } catch (error) {
    console.error("Error sending verification email:", error);
    res.status(500).send("Error sending verification email");
  }
});

app.get("/crowmail/verify", async (req, res) => {
  const { key } = req.query;

  if (!key) {
    return res.status(400).send("Missing verification key");
  }

  try {
    // Retrieve the email and type from Redis
    const data = await getAsync(key);

    if (!data) {
      return res.status(400).send("Invalid or expired verification key");
    }

    const { email, type } = JSON.parse(data);

    // Add the verified email to the database
    const { error } = await supabase
      .from("crowmail")
      .insert([{ email, type}]);

    if (error) throw error;

    // Remove the key from Redis
    await delAsync(key);

    res.status(200).send("Email verified successfully");
  } catch (error) {
    console.error("Error verifying email:", error);
    res.status(500).send("Error verifying email");
  }
});





//Health Check for Uptime Robot
app.get("/health", (req, res) => {
  res.status(200).send("OK");
});

// Start the server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});