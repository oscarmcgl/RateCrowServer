const express = require("express");
const bodyParser = require("body-parser");
const { google } = require("googleapis");
const cors = require("cors");

const app = express(); // Initialize the Express app

// CORS configuration
const allowedOrigins = [
  "https://oscarmcglone.com", 
  "https://duck.oscarmcglone.com", 
  "https://ratethiscrow.oscarmcglone.com",
  "http://127.0.0.1:5500",
  "http://localhost:5500",
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

app.use(bodyParser.json()); 

const SPREADSHEET_ID = "1nHVC5ahA0qOj4uE05YKWb3Fn3BjGSu_Uq8_ZXJ4cm_0";
const SHEET_NAME = "RateThisCrow";

// Authenticate with the service account
const auth = new google.auth.GoogleAuth({
  credentials: JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_KEY), 
  scopes: ["https://www.googleapis.com/auth/spreadsheets"],
});


// Return random crow_id, img_url, avg_rating, and rating_count from the sheet
app.get("/random", async (req, res) => {
    try {
      const sheets = google.sheets({ version: "v4", auth });
      const response = await sheets.spreadsheets.values.get({
        spreadsheetId: SPREADSHEET_ID,
        range: SHEET_NAME,
      });
  
      const rows = response.data.values;
      if (!rows || rows.length <= 1) {
        return res.status(404).send("No data found");
      }
  
      const randomIndex = Math.floor(Math.random() * (rows.length - 1)) + 1;
      const [crow_id, img_url, avg_rating, rating_count] = rows[randomIndex];
  
      res.json({ crow_id, img_url, avg_rating: parseFloat(avg_rating), rating_count: parseInt(rating_count) });
    } catch (error) {
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
      const sheets = google.sheets({ version: "v4", auth });
      const response = await sheets.spreadsheets.values.get({
        spreadsheetId: SPREADSHEET_ID,
        range: SHEET_NAME,
      });
  
      const rows = response.data.values;
      const rowIndex = rows.findIndex(row => row[0] === crow_id);
  
      if (rowIndex === -1) {
        return res.status(404).send("Crow not found");
      }
  
      const [_, img_url, avg_rating, rating_count] = rows[rowIndex];
      const newRatingCount = parseInt(rating_count) + 1;
      const newAvgRating = ((parseFloat(avg_rating) * parseInt(rating_count)) + parseFloat(rating)) / newRatingCount;
  
      await sheets.spreadsheets.values.update({
        spreadsheetId: SPREADSHEET_ID,
        range: `${SHEET_NAME}!C${rowIndex + 1}:D${rowIndex + 1}`,
        valueInputOption: "USER_ENTERED",
        requestBody: {
          values: [[newAvgRating.toFixed(2), newRatingCount]],
        },
      });
  
      res.send("Rating updated successfully");
    } catch (error) {
      res.status(500).send("Error updating rating");
    }
  });
  
// Upload a new crow image with img_url creating a new crow_id
app.post("/upload", async (req, res) => {
    const { img_url } = req.body;
  
    if (!img_url) {
      return res.status(400).send("Missing img_url");
    }
  
    try {
      const sheets = google.sheets({ version: "v4", auth });
      const response = await sheets.spreadsheets.values.get({
        spreadsheetId: SPREADSHEET_ID,
        range: SHEET_NAME,
      });
  
      const rows = response.data.values;
      const newCrowId = `crow_${rows.length}`;
      const newRow = [newCrowId, img_url, 0, 0];
  
      await sheets.spreadsheets.values.append({
        spreadsheetId: SPREADSHEET_ID,
        range: SHEET_NAME,
        valueInputOption: "USER_ENTERED",
        requestBody: {
          values: [newRow],
        },
      });
  
      res.json({ crow_id: newCrowId, img_url });
    } catch (error) {
      res.status(500).send("Error uploading new crow");
    }
  });
  
// Return the crow_id, img_url, avg_rating, and rating_count for top leaderboard 3 crows
app.get("/leaderboard", async (req, res) => {
    try {
      const sheets = google.sheets({ version: "v4", auth });
      const response = await sheets.spreadsheets.values.get({
        spreadsheetId: SPREADSHEET_ID,
        range: SHEET_NAME,
      });
  
      const rows = response.data.values;
      if (!rows || rows.length <= 1) {
        return res.status(404).send("No data found");
      }
  
      const leaderboard = rows.slice(1)
        .map(([crow_id, img_url, avg_rating, rating_count]) => ({
          crow_id,
          img_url,
          avg_rating: parseFloat(avg_rating),
          rating_count: parseInt(rating_count),
        }))
        .sort((a, b) => b.avg_rating - a.avg_rating)
        .slice(0, 3);
  
      res.json(leaderboard);
    } catch (error) {
      res.status(500).send("Error fetching leaderboard");
    }
  });

app.get("/crow/:id", async (req, res) => {
    const crowId = req.params.id;

    try {
        const sheets = google.sheets({ version: "v4", auth });
        const response = await sheets.spreadsheets.values.get({
            spreadsheetId: SPREADSHEET_ID,
            range: SHEET_NAME,
        });

        const rows = response.data.values;
        const crow = rows.find(row => row[0] === crowId);

        if (!crow) {
            return res.status(404).send("Crow not found");
        }

        const [id, img_url, avg_rating, rating_count] = crow;

        res.json({
            crow_id: id,
            img_url,
            avg_rating: parseFloat(avg_rating),
            rating_count: parseInt(rating_count, 10),
        });
    } catch (error) {
        console.error("Error fetching crow by ID:", error);
        res.status(500).send("Error fetching crow");
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