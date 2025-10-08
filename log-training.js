export default async function handler(req, res) {
  if (req.method === "GET" || req.method === "HEAD") {
    res.setHeader("Content-Type", "application/json");
    if (req.method === "HEAD") return res.status(200).end();
    return res.status(200).json({ status: "alive" });
  }
  return res.status(405).json({ error: "Method Not Allowed" });
}
