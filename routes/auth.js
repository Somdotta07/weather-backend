import express from "express";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import User from "../model/User.js";

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
      return res.status(400).json({ error: "Please enter your email address." });
    }

    if (!isValidEmail(email)) {
      return res.status(400).json({ error: "Please enter a valid email address." });
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
        error: "An account already exists with this email. Please log in instead.",
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
      return res.status(400).json({ error: "Please enter your email address." });
    }

    if (!isValidEmail(email)) {
      return res.status(400).json({ error: "Please enter a valid email address." });
    }

    if (!password) {
      return res.status(400).json({ error: "Please enter your password." });
    }

    const user = await User.findOne({ email });

    if (!user) {
      return res.status(404).json({
        error: "No account found with this email. Please check your email or create an account.",
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
        error: "Login service is temporarily unavailable. Please try again later.",
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

export default router;