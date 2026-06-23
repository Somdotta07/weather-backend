import express from "express";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import crypto from "crypto";
import User from "../model/User.js";
import { sendPasswordResetEmail } from "../services/mailService.js";

const router = express.Router();

const isValidEmail = (email) => {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
};

/* REGISTER */
router.post("/register", async (req, res) => {
  try {
    const name = req.body.name?.trim();
    const email = req.body.email?.trim().toLowerCase();
    const password = req.body.password;

    if (!name) {
      return res.status(400).json({ error: "Please enter your name." });
    }

    if (!email) {
      return res
        .status(400)
        .json({ error: "Please enter your email address." });
    }

    if (!isValidEmail(email)) {
      return res
        .status(400)
        .json({ error: "Please enter a valid email address." });
    }

    if (!password) {
      return res.status(400).json({ error: "Please enter a password." });
    }

    if (password.length < 6) {
      return res.status(400).json({
        error: "Password must be at least 6 characters long.",
      });
    }

    const existingUser = await User.findOne({ email });

    if (existingUser) {
      return res.status(409).json({
        error:
          "An account already exists with this email. Please log in instead.",
      });
    }

    const passwordHash = await bcrypt.hash(password, 10);

    await User.create({
      name,
      email,
      passwordHash,
    });

    return res.status(201).json({
      message: "Account created successfully. Please log in.",
    });
  } catch (err) {
    console.error("REGISTER ERROR:", err);
    return res.status(500).json({
      error: "Registration failed. Please try again later.",
    });
  }
});

/* LOGIN */
router.post("/login", async (req, res) => {
  try {
    const email = req.body.email?.trim().toLowerCase();
    const password = req.body.password;

    if (!email) {
      return res
        .status(400)
        .json({ error: "Please enter your email address." });
    }

    if (!isValidEmail(email)) {
      return res
        .status(400)
        .json({ error: "Please enter a valid email address." });
    }

    if (!password) {
      return res.status(400).json({ error: "Please enter your password." });
    }

    const user = await User.findOne({ email });

    if (!user) {
      return res.status(404).json({
        error:
          "No account found with this email. Please check your email or create an account.",
      });
    }

    const isMatch = await bcrypt.compare(password, user.passwordHash);

    if (!isMatch) {
      return res.status(401).json({
        error: "Incorrect password. Please try again.",
      });
    }

    if (!process.env.JWT_SECRET) {
      console.error("JWT_SECRET is missing");
      return res.status(500).json({
        error:
          "Login service is temporarily unavailable. Please try again later.",
      });
    }

    const token = jwt.sign({ id: user._id }, process.env.JWT_SECRET, {
      expiresIn: "7d",
    });

    return res.json({
      message: "Login successful.",
      token,
    });
  } catch (err) {
    console.error("LOGIN ERROR:", err);
    return res.status(500).json({
      error: "Login failed. Please try again later.",
    });
  }
});

/* FORGOT PASSWORD */
router.post("/forgot-password", async (req, res) => {
  try {
    const email = req.body.email?.trim().toLowerCase();

    if (!email) {
      return res
        .status(400)
        .json({ error: "Please enter your email address." });
    }

    if (!isValidEmail(email)) {
      return res
        .status(400)
        .json({ error: "Please enter a valid email address." });
    }

    const user = await User.findOne({ email });

    // Do not reveal whether account exists
    if (!user) {
      return res.json({
        message:
          "Email is not registered. Please enter a valid email address or create an account.",
      });
    }

    const rawToken = crypto.randomBytes(32).toString("hex");
    const hashedToken = crypto
      .createHash("sha256")
      .update(rawToken)
      .digest("hex");

    user.passwordResetToken = hashedToken;
    user.passwordResetExpires = Date.now() + 15 * 60 * 1000; // 15 minutes
    await user.save();

    const resetUrl = `${process.env.FRONTEND_RESET_URL}?token=${rawToken}&email=${encodeURIComponent(email)}`;
    // await sendPasswordResetEmail({
    //   to: email,
    //   resetUrl,
    // });

    return res.json({
      message:
        "Reset link generated. Please create a new password.",
        resetUrl, // Include the reset URL in the response for testing purposes
    });
  } catch (err) {
    console.error("FORGOT PASSWORD ERROR FULL:", err);
    console.error("MESSAGE:", err?.message);
    return res.status(500).json({
      error: "Password reset request failed. Please try again later.",
    });
  }
});

/* RESET PASSWORD */
router.post("/reset-password", async (req, res) => {
  try {
    const { token, email, newPassword } = req.body;

    if (!email) {
      return res.status(400).json({ error: "Email is required." });
    }

    if (!token) {
      return res.status(400).json({ error: "Reset token is required." });
    }

    if (!newPassword) {
      return res.status(400).json({ error: "Please enter a new password." });
    }

    if (newPassword.length < 6) {
      return res.status(400).json({
        error: "Password must be at least 6 characters long.",
      });
    }

    const hashedToken = crypto.createHash("sha256").update(token).digest("hex");

    const user = await User.findOne({
      email: email.trim().toLowerCase(),
      passwordResetToken: hashedToken,
      passwordResetExpires: { $gt: Date.now() },
    });

    if (!user) {
      return res.status(400).json({
        error: "Reset link is invalid or expired. Please request a new one.",
      });
    }

    user.passwordHash = await bcrypt.hash(newPassword, 10);
    user.passwordResetToken = null;
    user.passwordResetExpires = null;

    await user.save();

    return res.json({
      message:
        "Password reset successful. Please log in with your new password.",
    });
  } catch (err) {
    console.error("RESET PASSWORD ERROR:", err);
    return res.status(500).json({
      error: "Password reset failed. Please try again later.",
    });
  }
});

export default router;
