import express from "express";
import axios from "axios";
import cors from "cors";
import dotenv from "dotenv";
dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;
const WP_BASE= process.env.WP_BASE_URL ;
const API_KEY = process.env.WP_API_KEY;

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

/* Call to WP API */
const callWordPress = async (endpoint, query = {}) => {
  return axios.get(`${WP_BASE}/maltaweather/v1/${endpoint}`, {
    headers: {
      "api-key": API_KEY,
      "Accept": "application/json",
      "User-Agent": "Mozilla/5.0"
    },
    params: query
  });
};

/**
 * Generic Proxy Route
 */
app.get("/api/:endpoint", async (req, res) => {
  try {
    const { endpoint } = req.params;
    const queryParams = req.query;

    const response = await callWordPress(endpoint, queryParams);

    res.json(response.data);
  } catch (error) {
    console.error("WP ERROR:", error.response?.data || error.message);

    res.status(error.response?.status || 500).json({
      error: "Failed to fetch data"
    });
  }
});

/**
 * Health Check
 */
app.get("/", (req, res) => {
  res.json({ status: "Backend running" });
});

