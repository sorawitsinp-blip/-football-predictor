import "dotenv/config";
import express from "express";
import cors from "cors";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

const FOOTBALL_API_KEY = process.env.FOOTBALL_DATA_API_KEY;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const CLAUDE_MODEL = process.env.CLAUDE_MODEL || "claude-sonnet-5";
const FOOTBALL_API_BASE = "https://api.football-data.org/v4";

// AiScore API (via Parse) — used only for last-5-match team form stats
const PARSE_API_KEY = process.env.PARSE_API_KEY;
const AISCORE_BASE_URL =
  process.env.AISCORE_BASE_URL ||
  "https://api.parse.bot/scraper/4159e902-84d5-4812-bcee-311effc7486d";

// ---------- Helpers ----------

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

async function fetchFixtures(date) {
  if (!FOOTBALL_API_KEY) {
    throw new Error(
      "ยังไม่ได้ตั้งค่า FOOTBALL_DATA_API_KEY ใน .env (สมัครฟรีที่ https://www.football-data.org/client/register)"
    );
  }
  const url = `${FOOTBALL_API_BASE}/matches?dateFrom=${date}&dateTo=${date}`;
  const res = await fetch(url, {
    headers: { "X-Auth-Token": FOOTBALL_API_KEY },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`football-data.org error ${res.status}: ${text}`);
  }
  const data = await res.json();
  return (data.matches || []).map((m) => ({
    id: m.id,
    competition: m.competition?.name || "ไม่ทราบรายการ",
    utcDate: m.utcDate,
    status: m.status,
    homeTeam: m.homeTeam?.name || "ทีมเหย้า",
    awayTeam: m.awayTeam?.name || "ทีมเยือน",
    homeForm: m.homeTeam?.form || null,
    awayForm: m.awayTeam?.form || null,
  }));
}

// ---------- AiScore (Parse) helpers — fixtures come from football-data.org,
// but team-form stats (goals scored/conceded, last 5 games) come from here ----------

function normalizeTeamName(name) {
  return (name || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "") // strip accents
    .replace(/[^a-z0-9\s]/g, "")
    .split(/\s+/)
    .filter(Boolean)
    .filter((w) => !["fc", "cf", "afc", "sc", "ac", "cd", "ud", "club", "calcio", "the"].includes(w));
}

function tokenOverlapScore(aTokens, bTokens) {
  if (!aTokens.length || !bTokens.length) return 0;
  const setA = new Set(aTokens);
  const setB = new Set(bTokens);
  let common = 0;
  for (const t of setA) if (setB.has(t)) common++;
  return common / Math.max(setA.size, setB.size);
}

// Finds the best-matching AiScore fixture for a football-data.org fixture,
// by comparing normalized home/away team name tokens. Returns null if no
// confident match is found (kickoff-time-only date filtering means the two
// providers may use slightly different team name spellings).
function findAiScoreMatch(aiscoreFixtures, homeTeam, awayTeam) {
  const homeTokens = normalizeTeamName(homeTeam);
  const awayTokens = normalizeTeamName(awayTeam);
  let best = null;
  let bestScore = 0;
  for (const fx of aiscoreFixtures) {
    const homeScore = tokenOverlapScore(homeTokens, normalizeTeamName(fx.home_team));
    const awayScore = tokenOverlapScore(awayTokens, normalizeTeamName(fx.away_team));
    const score = (homeScore + awayScore) / 2;
    if (score > bestScore) {
      bestScore = score;
      best = fx;
    }
  }
  return bestScore >= 0.5 ? best : null;
}

async function fetchAiScoreFixtures(dateCompact) {
  if (!PARSE_API_KEY) return [];
  const url = `${AISCORE_BASE_URL}/get_scheduled_fixtures?date=${dateCompact}`;
  const res = await fetch(url, { headers: { "X-API-Key": PARSE_API_KEY } });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`AiScore fixtures error ${res.status}: ${text}`);
  }
  const data = await res.json();
  return data.fixtures || [];
}

async function fetchAiScoreTeamForm(matchId, homeSlug, awaySlug) {
  const url =
    `${AISCORE_BASE_URL}/get_match_team_form?match_id=${encodeURIComponent(matchId)}` +
    `&home_slug=${encodeURIComponent(homeSlug)}&away_slug=${encodeURIComponent(awaySlug)}`;
  const res = await fetch(url, { headers: { "X-API-Key": PARSE_API_KEY } });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`AiScore form error ${res.status}: ${text}`);
  }
  return res.json();
}

function formatFormStats(form) {
  if (!form || !form.home_team_stats || !form.away_team_stats) return null;
  const h = form.home_team_stats;
  const a = form.away_team_stats;
  return (
    `ฟอร์ม 5 นัดล่าสุด (จาก AiScore) — ` +
    `${form.home_team || "ทีมเหย้า"}: ยิงเฉลี่ย ${h.goals_scored_per_game} เสียเฉลี่ย ${h.goals_conceded_per_game} ต่อเกม ` +
    `(ครึ่งแรก ยิง ${h.first_half_goals_scored_per_game} เสีย ${h.first_half_goals_conceded_per_game}); ` +
    `${form.away_team || "ทีมเยือน"}: ยิงเฉลี่ย ${a.goals_scored_per_game} เสียเฉลี่ย ${a.goals_conceded_per_game} ต่อเกม ` +
    `(ครึ่งแรก ยิง ${a.first_half_goals_scored_per_game} เสีย ${a.first_half_goals_conceded_per_game})`
  );
}

async function askClaude(prompt, maxTokens = 700) {
  if (!ANTHROPIC_API_KEY) {
    throw new Error("ยังไม่ได้ตั้งค่า ANTHROPIC_API_KEY ใน .env");
  }
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: CLAUDE_MODEL,
      max_tokens: maxTokens,
      messages: [{ role: "user", content: prompt }],
    }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Anthropic API error ${res.status}: ${text}`);
  }
  const data = await res.json();
  const textBlock = data.content?.find((c) => c.type === "text");
  return textBlock ? textBlock.text : "";
}

function buildAnalysisPrompt({ homeTeam, awayTeam, competition, extra }) {
  return `คุณเป็นนักวิเคราะห์ฟุตบอลมืออาชีพ กำลังวิเคราะห์คู่ต่อไปนี้:

รายการ: ${competition || "ไม่ระบุ"}
ทีมเหย้า: ${homeTeam}
ทีมเยือน: ${awayTeam}
${extra ? `ข้อมูลเพิ่มเติมที่ผู้ใช้ให้มา: ${extra}` : ""}

โปรดตอบกลับเป็น JSON เท่านั้น ห้ามมีข้อความอื่นนอก JSON ห้ามใส่ \`\`\` ครอบ ใช้โครงสร้างนี้:
{
  "predictedScore": "เช่น 2-1",
  "outcome": "home | draw | away",
  "confidence": ตัวเลข 1-100 (ความมั่นใจของการวิเคราะห์ ไม่ใช่ความแน่นอนของผล),
  "keyPoints": ["เหตุผลสั้นๆ ข้อ 1", "เหตุผลสั้นๆ ข้อ 2", "เหตุผลสั้นๆ ข้อ 3"],
  "summary": "สรุปการวิเคราะห์ 2-3 ประโยค",
  "riskNote": "ข้อควรระวังสั้นๆ เช่น ข้อมูลผู้เล่นบาดเจ็บที่ไม่แน่นอน หรือความผันผวนของฟอร์ม"
}

ข้อควรระวัง: นี่คือการวิเคราะห์เพื่อการศึกษาเท่านั้น ไม่ใช่การการันตีผล ฟุตบอลมีความไม่แน่นอนสูง ให้ความมั่นใจ (confidence) อย่างสมเหตุสมผล อย่าให้สูงเกินจริง`;
}

function safeParseJSON(text) {
  const cleaned = text.replace(/```json|```/g, "").trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    return { raw: cleaned };
  }
}

// ---------- Routes ----------

app.get("/api/fixtures", async (req, res) => {
  try {
    const date = req.query.date || todayISO();
    const fixtures = await fetchFixtures(date);
    res.json({ date, count: fixtures.length, fixtures });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/analyze", async (req, res) => {
  try {
    const { homeTeam, awayTeam, competition, extra } = req.body;
    if (!homeTeam || !awayTeam) {
      return res.status(400).json({ error: "ต้องระบุ homeTeam และ awayTeam" });
    }
    const prompt = buildAnalysisPrompt({ homeTeam, awayTeam, competition, extra });
    const text = await askClaude(prompt);
    res.json(safeParseJSON(text));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Daily picks: fetch fixtures for the day, analyze each (capped), return sorted by confidence
app.get("/api/daily-picks", async (req, res) => {
  try {
    const date = req.query.date || todayISO();
    const limit = Math.min(parseInt(req.query.limit || "8", 10), 15);
    const fixtures = await fetchFixtures(date);
    const toAnalyze = fixtures.slice(0, limit);

    // Pull AiScore's fixture list once per day (2 credits) so each match below
    // can be matched to it for a real form-stats lookup (1 credit each).
    let aiscoreFixtures = [];
    let aiscoreError = null;
    if (PARSE_API_KEY) {
      try {
        aiscoreFixtures = await fetchAiScoreFixtures(date.replace(/-/g, ""));
      } catch (err) {
        aiscoreError = err.message;
        console.warn("AiScore fixtures fetch failed:", err.message);
      }
    }

    const results = [];
    for (const fx of toAnalyze) {
      const extraParts = [];
      if (fx.homeForm || fx.awayForm) {
        extraParts.push(`ฟอร์ม (W/D/L ล่าสุด) เหย้า: ${fx.homeForm || "-"} เยือน: ${fx.awayForm || "-"}`);
      }

      let aiscoreMatched = false;
      if (aiscoreFixtures.length) {
        const match = findAiScoreMatch(aiscoreFixtures, fx.homeTeam, fx.awayTeam);
        if (match) {
          try {
            const form = await fetchAiScoreTeamForm(match.match_id, match.home_team_slug, match.away_team_slug);
            const formatted = formatFormStats(form);
            if (formatted) {
              extraParts.push(formatted);
              aiscoreMatched = true;
            }
          } catch (err) {
            console.warn(`AiScore form fetch failed for ${fx.homeTeam} vs ${fx.awayTeam}:`, err.message);
          }
        }
      }

      try {
        const prompt = buildAnalysisPrompt({
          homeTeam: fx.homeTeam,
          awayTeam: fx.awayTeam,
          competition: fx.competition,
          extra: extraParts.length ? extraParts.join(" | ") : null,
        });
        const text = await askClaude(prompt, 500);
        const analysis = safeParseJSON(text);
        results.push({ ...fx, aiscoreMatched, analysis });
      } catch (err) {
        results.push({ ...fx, aiscoreMatched, analysis: { error: err.message } });
      }
    }

    results.sort((a, b) => (b.analysis?.confidence || 0) - (a.analysis?.confidence || 0));
    res.json({
      date,
      totalFixtures: fixtures.length,
      analyzed: results.length,
      aiscoreEnabled: Boolean(PARSE_API_KEY),
      aiscoreError,
      picks: results,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Football predictor running on http://localhost:${PORT}`);
});
