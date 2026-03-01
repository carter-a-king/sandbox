import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.0";

const OPENAI_API_KEY = Deno.env.get("OPENAI_API_KEY") ?? "";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SUPABASE_SERVICE_ROLE_KEY =
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

interface AnalysisPayload {
  sql: string;
  analysis: {
    statement_type: string;
    is_destructive: boolean;
    has_where: boolean;
    has_select_star: boolean;
    has_limit: boolean;
    risk_score: string;
    flags: string[];
  };
}

interface AISummary {
  summary: string;
  risk_level: string;
  flags: string[];
  suggested_safe_sql: string | null;
}

serve(async (req: Request) => {
  // Handle CORS preflight
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const { sql, analysis } = (await req.json()) as AnalysisPayload;

    let aiSummary: AISummary;

    try {
      aiSummary = await callLLM(sql, analysis);
    } catch (err) {
      console.error("LLM call failed, using deterministic fallback:", err);
      aiSummary = {
        summary: `Deterministic analysis: ${analysis.flags.join("; ")}`,
        risk_level: analysis.risk_score,
        flags: analysis.flags,
        suggested_safe_sql: null,
      };
    }

    // Persist to query_logs table
    const { error: dbError } = await supabase.from("query_logs").insert({
      sql_text: sql,
      statement_type: analysis.statement_type,
      risk_score: analysis.risk_score,
      is_destructive: analysis.is_destructive,
      deterministic_flags: analysis.flags,
      ai_summary: aiSummary.summary,
      ai_risk_level: aiSummary.risk_level,
      ai_flags: aiSummary.flags,
      suggested_safe_sql: aiSummary.suggested_safe_sql,
    });

    if (dbError) {
      console.error("Failed to persist query log:", dbError);
    }

    return new Response(JSON.stringify(aiSummary), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    return new Response(
      JSON.stringify({ error: (err as Error).message }),
      {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }
    );
  }
});

async function callLLM(
  sql: string,
  analysis: AnalysisPayload["analysis"]
): Promise<AISummary> {
  const prompt = `You are a helpful SQL assistant. Describe what this SQL query does in plain, conversational English. Talk directly to the user (use "You are..."). Be specific about which columns and tables are involved.

SQL: ${sql}

Context:
- Statement type: ${analysis.statement_type}
- Has WHERE clause: ${analysis.has_where}
- Has LIMIT: ${analysis.has_limit}

Return ONLY valid JSON with this exact structure:
{
  "summary": "A clear, friendly 1-2 sentence description of what this query does, e.g. 'You are viewing all FirstName values from the Employees table'",
  "risk_level": "LOW" | "MEDIUM" | "HIGH",
  "flags": ["array of any warnings, or empty if safe"],
  "suggested_safe_sql": null
}`;

  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: prompt }],
      temperature: 0.2,
      response_format: { type: "json_object" },
    }),
  });

  if (!response.ok) {
    throw new Error(`OpenAI API error: ${response.status}`);
  }

  const data = await response.json();
  const content = data.choices[0].message.content;
  const parsed = JSON.parse(content) as AISummary;

  // Validate structure
  if (!parsed.summary || !parsed.risk_level || !Array.isArray(parsed.flags)) {
    throw new Error("Invalid AI response structure");
  }

  return parsed;
}
