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
console.log("WP_BASE:", WP_BASE);
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

app.get("/api/proxy-image", async (req, res) => {
  try {
    const imageUrl = req.query.url;

    if (!imageUrl) {
      return res.status(400).send("Missing image URL");
    }

    console.log("Fetching image:", imageUrl);

    const response = await axios.get(imageUrl, {
      responseType: "arraybuffer",
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36",
        "Accept":
          "image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
        "Referer": "https://maltaweather.com/",
        "Origin": "https://maltaweather.com",
      },
    });

    res.set("Content-Type", response.headers["content-type"]);
    res.send(response.data);
  } catch (error) {
    console.error(
      "IMAGE PROXY ERROR:",
      error.response?.status,
      error.response?.data || error.message
    );
    res.status(500).send("Image fetch error");
  }
});



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

