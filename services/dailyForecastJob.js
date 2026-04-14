import cron from "node-cron";
import axios from "axios";
import User from "../model/User.js";
import { sendExpoPushNotification } from "./expoPushService.js";

const WP_BASE = process.env.WP_BASE_URL;
const API_KEY = process.env.WP_API_KEY;

async function callWordPress(endpoint, query = {}) {
  const response = await axios.get(`${WP_BASE}/maltaweather/v1/${endpoint}`, {
    headers: {
      "api-key": API_KEY,
      Accept: "application/json",
      "User-Agent": "Mozilla/5.0",
    },
    params: query,
  });

  return response.data;
}

function parseTemperature(value) {
  if (value == null) return 0;
  return Number(value);
}

function average(nums) {
  if (!nums.length) return 0;
  return nums.reduce((a, b) => a + b, 0) / nums.length;
}

function findHourlyBlock(hourly, label) {
  return hourly?.find((item) => item.time === label);
}

function buildMorningForecastMessage(current) {
  const hourly = current?.hourly ?? [];

  const block1 = findHourlyBlock(hourly, "7AM - 10AM");
  const block2 = findHourlyBlock(hourly, "10AM - 1PM");

  const temps = [block1, block2]
    .filter(Boolean)
    .map((item) => parseTemperature(item.temperature));

  const avgTemp = Math.round(average(temps));
  const description = block1?.description || block2?.description || current?.description || "Weather update";

  return `Today's forecast: ${description}, around ${avgTemp}° on average this morning.`;
}

function buildEveningForecastMessage(current) {
  const hourly = current?.hourly ?? [];

  const block1 = findHourlyBlock(hourly, "4PM - 7PM");
  const block2 = findHourlyBlock(hourly, "7PM - 10PM");

  const temps = [block1, block2]
    .filter(Boolean)
    .map((item) => parseTemperature(item.temperature));

  const avgTemp = Math.round(average(temps));
  const description = block1?.description || block2?.description || current?.description || "Weather update";

  return `This evening's forecast: ${description}, around ${avgTemp}° on average later today.`;
}

async function sendDailyForecastBatch(period) {
  const users = await User.find({
    "weatherAlerts.dailyForecast": true,
    pushPermissionGranted: true,
    expoPushToken: { $ne: null },
    notificationCity: { $ne: null },
  });

  for (const user of users) {
    try {
      const weatherData = await callWordPress("forecast", {
        city: user.notificationCity,
      });

      const current = weatherData?.current;
      if (!current) continue;

      const body =
        period === "morning"
          ? buildMorningForecastMessage(current)
          : buildEveningForecastMessage(current);

      await sendExpoPushNotification({
        to: user.expoPushToken,
        title: "Daily weather forecast",
        body,
        data: {
          type: "daily_forecast",
          period,
          city: user.notificationCity,
        },
      });

      if (period === "morning") {
        user.lastDailyForecastSent.morning = new Date();
      } else {
        user.lastDailyForecastSent.evening = new Date();
      }

      await user.save();
    } catch (err) {
      console.error(
        `DAILY FORECAST SEND ERROR for user ${user._id}:`,
        err.response?.data || err.message
      );
    }
  }
}

export function startDailyForecastJobs() {
  cron.schedule("30 8 * * *", async () => {
    console.log("Running morning daily forecast job...");
    await sendDailyForecastBatch("morning");
  });

  cron.schedule("30 18 * * *", async () => {
    console.log("Running evening daily forecast job...");
    await sendDailyForecastBatch("evening");
  });
}