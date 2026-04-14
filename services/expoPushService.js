import axios from "axios";

export async function sendExpoPushNotification({
  to,
  title,
  body,
  data = {},
}) {
  if (!to) return null;

  const payload = {
    to,
    sound: "default",
    title,
    body,
    data,
  };

  const response = await axios.post(
    "https://exp.host/--/api/v2/push/send",
    payload,
    {
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
    }
  );

  return response.data;
}