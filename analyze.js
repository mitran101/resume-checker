// api/analyze.js
// Vercel serverless function. This runs on the server, NOT in the browser,
// so your Anthropic API key never reaches the page the user loads.
// Set ANTHROPIC_API_KEY in your Vercel project's Environment Variables.

const SYSTEM_PROMPT = `You are an elite technical recruiter and resume reviewer who has screened thousands of resumes for top companies. You are sharp, specific, and honest, never generic. You judge a resume against a specific job and tell the candidate exactly where they stand and what to fix.

Analyze the resume against the target job description and return ONLY a single valid JSON object. No markdown, no code fences, no preamble, no trailing text. The JSON must match this schema exactly:

{
  "match_score": <integer 0-100, an honest, calibrated fit for THIS specific job>,
  "tier": <one of: "Needs work", "Solid", "Strong", "Exceptional">,
  "headline": <one punchy sentence, max 14 words, capturing the overall impression>,
  "strengths": [ { "title": <3-5 words>, "detail": <one specific sentence referencing the resume> } ],
  "gaps": [ { "title": <3-5 words>, "detail": <one specific, actionable sentence> } ],
  "missing_keywords": [ <up to 8 short skills or keywords from the job description the resume is missing> ],
  "rewrites": [ { "before": <a weak line paraphrased from the resume, max 16 words>, "after": <a stronger rewrite tailored to the job, max 24 words> } ],
  "verdict": <one candid but encouraging next-step sentence, max 24 words>
}

Rules: provide exactly 3 strengths and exactly 3 gaps (most important gap first). Provide 3 to 5 rewrites. Reference real details from the resume. Keep every field tight. Be honest with the score, do not inflate.`;

async function readJsonBody(req) {
  if (req.body && typeof req.body === "object") return req.body;
  const raw = await new Promise((resolve, reject) => {
    let d = "";
    req.on("data", (c) => (d += c));
    req.on("end", () => resolve(d));
    req.on("error", reject);
  });
  return raw ? JSON.parse(raw) : {};
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Use POST." });
    return;
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    res.status(500).json({
      error:
        "Server is missing ANTHROPIC_API_KEY. Add it in your Vercel project's Environment Variables, then redeploy.",
    });
    return;
  }

  let body;
  try {
    body = await readJsonBody(req);
  } catch {
    res.status(400).json({ error: "Could not read the request." });
    return;
  }

  const jobDescription = (body.jobDescription || "").trim();
  const resume = body.resume || {};

  if (!jobDescription) {
    res.status(400).json({ error: "Add a target job description." });
    return;
  }
  if (!resume.data) {
    res.status(400).json({ error: "Add a resume to check." });
    return;
  }

  const resumeBlock =
    resume.kind === "pdf"
      ? {
          type: "document",
          source: { type: "base64", media_type: "application/pdf", data: resume.data },
        }
      : { type: "text", text: String(resume.data) };

  const content = [
    {
      type: "text",
      text:
        "TARGET JOB DESCRIPTION:\n" +
        jobDescription +
        "\n\nCANDIDATE RESUME" +
        (resume.kind === "pdf" ? " (attached as a PDF):" : ":"),
    },
    resumeBlock,
    { type: "text", text: "Now return ONLY the JSON object described in your instructions." },
  ];

  try {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-opus-4-8",
        max_tokens: 4000,
        system: SYSTEM_PROMPT,
        messages: [{ role: "user", content }],
      }),
    });

    const data = await r.json();

    if (!r.ok) {
      const msg = (data && data.error && data.error.message) || `Anthropic returned an error (${r.status}).`;
      res.status(r.status).json({ error: msg });
      return;
    }

    const text = (data.content || [])
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("");

    let parsed = null;
    try {
      parsed = JSON.parse(text);
    } catch {
      const s = text.indexOf("{");
      const e = text.lastIndexOf("}");
      if (s !== -1 && e !== -1) {
        try {
          parsed = JSON.parse(text.slice(s, e + 1));
        } catch {}
      }
    }

    if (!parsed || typeof parsed.match_score === "undefined") {
      res.status(502).json({ error: "Got a response but couldn't read it as a result. Try running it again." });
      return;
    }

    res.status(200).json(parsed);
  } catch {
    res.status(500).json({ error: "Couldn't reach Anthropic. Check your connection and try again." });
  }
}
