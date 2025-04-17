const express = require("express");
const cors = require("cors");
const Filter = require("bad-words");
const swearify = require("swearify");
const { createClient } = require("@supabase/supabase-js");
const redis = require("redis");
const { promisify } = require("util");
const { v4: uuidv4 } = require("uuid");
const dotenv = require("dotenv");
const Mailtrap = require("mailtrap");

// Load environment variables
dotenv.config();

// Initialize Redis client
const redisClient = redis.createClient();
const setAsync = promisify(redisClient.set).bind(redisClient);
const getAsync = promisify(redisClient.get).bind(redisClient);
const delAsync = promisify(redisClient.del).bind(redisClient);

// Initialize Express app
const app = express();

// Initialize Supabase client
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// Configure Mailtrap Client
const TOKEN = process.env.MAILTRAP_API_TOKEN; // Your Mailtrap API token
const SENDER_EMAIL = "no-reply@oscarmcglone.com"; // Sender email address
const client = new Mailtrap.Client({ token: TOKEN }); // Initialize Mailtrap client

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

// Random crow endpoint
app.get("/random", async (req, res) => {
  try {
    const { data: crows, error } = await supabase.from("crows").select("*");

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

// Rate a crow endpoint
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
    const newAvgRating =
      (crow.avg_rating * crow.rating_count + rating) / newRatingCount;

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

// Upload a new crow endpoint
app.post("/upload", async (req, res) => {
  const { img_url, credit_name = "Unknown", credit_link = "#" } = req.body;

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
      .insert([
        {
          crow_id: newCrowId,
          img_url,
          avg_rating: 0,
          rating_count: 0,
          credit_name,
          credit_link,
        },
      ]);

    if (insertError) throw insertError;

    res.json({ crow_id: newCrowId, img_url, credit_name, credit_link });
  } catch (error) {
    console.error("Error uploading crow:", error);
    res.status(500).send("Error uploading new crow");
  }
});

// CrowMail subscription endpoint
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
        email: "no-reply@oscarmcglone.com",
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

// Verification endpoint
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
      .insert([{ email, type }]);

    if (error) throw error;

    // Remove the key from Redis
    await delAsync(key);

    res.status(200).send("Email verified successfully");
  } catch (error) {
    console.error("Error verifying email:", error);
    res.status(500).send("Error verifying email");
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