import jwt from "jsonwebtoken";
import User from "../model/User.js";

export default async function auth(req, res, next) {
  try {
    const token = req.headers.authorization?.split(" ")[1];
    if (!token)
      return res.status(401).json({ error: "No token provided" });

    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const user = await User.findById(decoded.id);
    if (!user)
      return res.status(401).json({ error: "User not found" });

    req.user = user;

    next();
  } catch (err) {
    res.status(401).json({ error: "Unauthorized" });
  }
}
