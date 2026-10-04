import { GoogleGenAI } from "@google/genai";
import { createClient } from "@supabase/supabase-js";

const CATEGORIES = ["Rent & Utilities", "Food & Dining", "Transport", "Shopping & Quick Commerce", "Entertainment & Subscriptions"];
const CATEGORY_KEYS = ["rent", "food", "transport", "shopping", "entertainment"];
const PCT_KEYS = ["rent_pct", "food_pct", "transport_pct", "shopping_pct", "entertainment_pct"];

function getSupabase() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) throw new Error("Missing Supabase credentials");
  return createClient(url, key);
}

function validate(body) {
  const { takeHomePay, rent, food, transport, shopping, entertainment, visitorId } = body;
  if (!visitorId || typeof visitorId !== "string") return "Missing visitorId";
  if (!Number.isInteger(takeHomePay) || takeHomePay < 5000 || takeHomePay > 1000000)
    return "Salary must be between \u20B95,000 and \u20B910,00,000";
  const pcts = [rent, food, transport, shopping, entertainment];
  for (const p of pcts) {
    if (!Number.isInteger(p) || p < 0 || p > 100) return "Each percentage must be 0\u2013100";
  }
  const sum = pcts.reduce((a, b) => a + b, 0);
  if (sum > 100) return "Percentages must sum to 100 or less";
  return null;
}

const SYSTEM_PROMPT = `You are Urge's spending plan engine. Urge is a spending fuel gauge app that helps young professionals in India control impulse spending on food delivery, quick commerce, and small online purchases.

You will receive the user's monthly take-home pay and their spending split across five categories as rupee amounts (pre-calculated by the server).

Your job:
1. Recommend a weekly impulse budget — look at their Food & Dining + Shopping & Quick Commerce spending and suggest a realistic weekly cap for discretionary impulse spending within those categories.
2. Identify exactly TWO specific cuts. Each cut must name one of the five spending categories and suggest a concrete behavioral change with a specific monthly rupee reduction (e.g., "Cook dinner twice a week instead of ordering").
3. Write a short summary paragraph (2-3 sentences) explaining their spending situation and the recommended Urge budget.
4. Write one fuel-gauge context line.

REFUSAL RULES:
- REFUSE to name any specific investment product, mutual fund, stock, insurance scheme, or SIP. If asked, say: "Urge focuses on spending awareness, not investment advice."
- REFUSE to give tax filing advice, legal advice, or any advice on loans, EMIs, or credit.
- Never recommend spending less than \u20B90 on any category.
- Each monthlyReduction must be less than the current spending in that category.

Keep the response concise. Be specific with rupee amounts. Tone: direct, practical, non-judgmental — like a sharp friend who's good with money.`;

const RESPONSE_SCHEMA = {
  type: "object",
  properties: {
    summary: { type: "string" },
    weeklyImpulseBudget: { type: "integer" },
    cuts: {
      type: "array",
      items: {
        type: "object",
        properties: {
          category: { type: "string" },
          action: { type: "string" },
          monthlyReduction: { type: "integer" }
        },
        required: ["category", "action", "monthlyReduction"]
      }
    },
    fuelGaugeLine: { type: "string" },
    disclaimer: { type: "string" }
  },
  required: ["summary", "weeklyImpulseBudget", "cuts", "fuelGaugeLine", "disclaimer"]
};

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

  try {
    const body = req.body;
    const validationError = validate(body);
    if (validationError) return res.status(400).json({ error: validationError });

    const { takeHomePay, rent, food, transport, shopping, entertainment, visitorId } = body;
    const pcts = [rent, food, transport, shopping, entertainment];

    const supabase = getSupabase();

    // Per-visitor cap
    const { count, error: countErr } = await supabase
      .from("spending_plans")
      .select("id", { count: "exact", head: true })
      .eq("visitor_id", visitorId);
    if (countErr) throw countErr;
    if (count >= 5) return res.status(429).json({ error: "You've used all 5 free plans." });

    // Server-side calculations
    const amounts = pcts.map(p => Math.round(takeHomePay * p / 100));
    const totalAllocated = amounts.reduce((a, b) => a + b, 0);
    const unallocated = takeHomePay - totalAllocated;

    const userPrompt = `Monthly take-home pay: \u20B9${takeHomePay.toLocaleString("en-IN")}

Spending breakdown:
- Rent & Utilities: \u20B9${amounts[0].toLocaleString("en-IN")} (${rent}%)
- Food & Dining: \u20B9${amounts[1].toLocaleString("en-IN")} (${food}%)
- Transport: \u20B9${amounts[2].toLocaleString("en-IN")} (${transport}%)
- Shopping & Quick Commerce: \u20B9${amounts[3].toLocaleString("en-IN")} (${shopping}%)
- Entertainment & Subscriptions: \u20B9${amounts[4].toLocaleString("en-IN")} (${entertainment}%)

Total allocated: \u20B9${totalAllocated.toLocaleString("en-IN")} (${pcts.reduce((a,b)=>a+b,0)}%)
Unallocated: \u20B9${unallocated.toLocaleString("en-IN")}`;

    // Call Gemini
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) return res.status(500).json({ error: "Gemini API key not configured" });

    const model = process.env.GEMINI_MODEL || "gemini-2.5-flash-lite";
    const ai = new GoogleGenAI({ apiKey });

    const response = await ai.models.generateContent({
      model,
      contents: userPrompt,
      config: {
        systemInstruction: SYSTEM_PROMPT,
        maxOutputTokens: 300,
        responseMimeType: "application/json",
        responseSchema: RESPONSE_SCHEMA,
        temperature: 0.7,
      },
    });

    // Extract token usage
    const usage = response.usageMetadata || {};
    const inputTokens = usage.promptTokenCount || 0;
    const outputTokens = usage.candidatesTokenCount || 0;

    // Parse and validate Gemini output
    let plan;
    try {
      plan = JSON.parse(response.text);
    } catch {
      return res.status(502).json({ error: "Invalid response from AI model" });
    }

    // Validate response structure
    if (typeof plan.weeklyImpulseBudget !== "number" || plan.weeklyImpulseBudget < 0) {
      return res.status(502).json({ error: "Invalid AI response: bad weeklyImpulseBudget" });
    }
    if (!Array.isArray(plan.cuts) || plan.cuts.length !== 2) {
      return res.status(502).json({ error: "Invalid AI response: expected exactly 2 cuts" });
    }
    for (const cut of plan.cuts) {
      if (typeof cut.monthlyReduction !== "number" || cut.monthlyReduction < 0) {
        return res.status(502).json({ error: "Invalid AI response: bad monthlyReduction" });
      }
      // Validate category name matches one of the five
      if (!CATEGORIES.includes(cut.category)) {
        return res.status(502).json({ error: `Invalid AI response: unknown category "${cut.category}"` });
      }
      // Validate reduction is less than spending in that category
      const catIdx = CATEGORIES.indexOf(cut.category);
      if (cut.monthlyReduction >= amounts[catIdx]) {
        // Clamp it to be safe rather than rejecting
        cut.monthlyReduction = Math.max(0, amounts[catIdx] - 1);
      }
    }

    // Server-calculated values
    const monthlyAmountIdentified = plan.cuts[0].monthlyReduction + plan.cuts[1].monthlyReduction;
    const dailyImpulseBudget = Math.round(plan.weeklyImpulseBudget / 7);

    // Store in Supabase
    const { error: insertErr } = await supabase.from("spending_plans").insert({
      visitor_id: visitorId,
      take_home_pay: takeHomePay,
      rent_pct: rent,
      food_pct: food,
      transport_pct: transport,
      shopping_pct: shopping,
      entertainment_pct: entertainment,
      ai_output: JSON.stringify(plan),
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      monthly_amount_identified: monthlyAmountIdentified,
    });
    if (insertErr) console.error("Supabase insert error:", insertErr);

    // Fetch updated stats
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
      plan: {
        ...plan,
        dailyImpulseBudget,
        monthlyAmountIdentified,
      },
      stats: {
        totalPlans: totalPlans || 0,
        avgReduction,
        uniqueVisitors,
      },
    });
  } catch (err) {
    console.error("generate-plan error:", err);
    return res.status(500).json({ error: "Something went wrong. Please try again." });
  }
}
