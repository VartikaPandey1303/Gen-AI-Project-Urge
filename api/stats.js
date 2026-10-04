import { createClient } from "@supabase/supabase-js";

function getSupabase() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) throw new Error("Missing Supabase credentials");
  return createClient(url, key);
}

export default async function handler(req, res) {
  if (req.method !== "GET") return res.status(405).json({ error: "GET only" });

  try {
    const supabase = getSupabase();

    const { count: totalPlans } = await supabase
      .from("spending_plans")
      .select("id", { count: "exact", head: true });

    const { data: avgData } = await supabase
      .from("spending_plans")
      .select("monthly_amount_identified");

    let avgReduction = 0;
    if (avgData && avgData.length > 0) {
      const sum = avgData.reduce((acc, row) => acc + (row.monthly_amount_identified || 0), 0);
      avgReduction = Math.round(sum / avgData.length);
    }

    const { data: visitorData } = await supabase
      .from("spending_plans")
      .select("visitor_id");
    const uniqueVisitors = visitorData ? new Set(visitorData.map(r => r.visitor_id)).size : 0;

    return res.status(200).json({
      totalPlans: totalPlans || 0,
      avgReduction,
      uniqueVisitors,
    });
  } catch (err) {
    console.error("stats error:", err);
    return res.status(500).json({ error: "Could not fetch stats" });
  }
}
