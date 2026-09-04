const ENDPOINT_ACCESS = {
  "weather-forecast": "free",
  "moon-phases": "free",
  "adverts": "free",
  "forecast": "free",           // used by dailyForecastJob
  "marine-forecast": "standard",
  "webcams": "standard",
  "jellyfish-map": "jellyfish",
};

const PLAN_GRANTS = {
  free: ["free"],
  standard: ["free", "standard"],
  jellyfish: ["free", "jellyfish"],
  premium: ["free", "standard", "jellyfish", "premium"],
};

export default function requirePlan(req, res, next) {
  const required = ENDPOINT_ACCESS[req.params.endpoint];

  if (!required) {
    return res.status(404).json({ error: "Unknown endpoint" });
  }
  if (required === "free") return next();

  const plan = req.user.effectivePlan();

  if (!PLAN_GRANTS[plan]?.includes(required)) {
    return res.status(403).json({
      error: "subscription_required",
      requiredPlan: required,
      currentPlan: plan,
    });
  }
  next();
}