import mongoose from "mongoose";

const userSchema = new mongoose.Schema({
  email: {
    type: String,
    required: true,
    unique: true
  },
  passwordHash: {
    type: String,
    required: true
  },
  plan: {
    type: String,
    enum: ["free", "standard", "premium"],
    default: "free"
  },
  subscriptionStatus: {
    type: String,
    enum: ["inactive", "active", "expired"],
    default: "inactive"
  },
  subscriptionExpiry: Date
}, { timestamps: true });

export default mongoose.model("User", userSchema);
