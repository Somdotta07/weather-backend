import express from "express";
import auth from "../middleware/auth.js";
import User from "../model/User.js";

const router = express.Router();

/* GET current user's notification settings */
router.get("/me", auth, async (req, res) => {
  try {
    const user = req.user;

    res.json({
      expoPushToken: user.expoPushToken ?? null,
      pushPermissionGranted: !!user.pushPermissionGranted,
      notificationCity: user.notificationCity ?? null,
      weatherAlerts: {
        rain: !!user.weatherAlerts?.rain,
        severe: !!user.weatherAlerts?.severe,
        dailyForecast: !!user.weatherAlerts?.dailyForecast,
      },
    });
  } catch (err) {
    console.error("GET NOTIFICATION SETTINGS ERROR:", err);
    res.status(500).json({ error: "Failed to fetch notification settings" });
  }
});

/* SAVE current user's notification settings */
router.put("/me", auth, async (req, res) => {
  try {
    const {
      expoPushToken,
      pushPermissionGranted,
      notificationCity,
      weatherAlerts,
    } = req.body;

    const user = req.user;

    user.expoPushToken = expoPushToken ?? null;
    user.pushPermissionGranted = !!pushPermissionGranted;
    user.notificationCity = notificationCity ?? null;

    user.weatherAlerts = {
      rain: !!weatherAlerts?.rain,
      severe: !!weatherAlerts?.severe,
      dailyForecast: !!weatherAlerts?.dailyForecast,
    };

    await user.save();

    res.json({
      message: "Notification settings updated",
      data: {
        expoPushToken: user.expoPushToken,
        pushPermissionGranted: user.pushPermissionGranted,
        notificationCity: user.notificationCity,
        weatherAlerts: user.weatherAlerts,
      },
    });
  } catch (err) {
    console.error("UPDATE NOTIFICATION SETTINGS ERROR:", err);
    res.status(500).json({ error: "Failed to update notification settings" });
  }
});

export default router;