// ---------- Tabs ----------
const tabButtons = document.querySelectorAll(".tabs__btn");
const tabPanels = document.querySelectorAll(".tab-panel");

tabButtons.forEach((btn) => {
  btn.addEventListener("click", () => {
    tabButtons.forEach((b) => b.classList.remove("is-active"));
    tabPanels.forEach((p) => p.classList.remove("is-active"));
    btn.classList.add("is-active");
    document.getElementById(`tab-${btn.dataset.tab}`).classList.add("is-active");
  });
});

// ---------- Header date ----------
const todayDateEl = document.getElementById("today-date");
const dateInput = document.getElementById("date-input");

function formatThaiDate(isoDate) {
  const d = new Date(isoDate + "T00:00:00");
  return d.toLocaleDateString("th-TH", { weekday: "long", day: "numeric", month: "long", year: "numeric" });
}

const todayISO = new Date().toISOString().slice(0, 10);
dateInput.value = todayISO;
todayDateEl.textContent = formatThaiDate(todayISO);

dateInput.addEventListener("change", () => {
  todayDateEl.textContent = formatThaiDate(dateInput.value);
});

// ---------- Daily picks ----------
const loadPicksBtn = document.getElementById("load-picks-btn");
const dailyStatus = document.getElementById("daily-status");
const fixtureList = document.getElementById("fixture-list");
const fixtureCountEl = document.getElementById("fixture-count");

function outcomeLabel(outcome) {
  if (outcome === "home") return { text: "เจ้าบ้านชนะ", cls: "outcome-home" };
  if (outcome === "away") return { text: "ทีมเยือนชนะ", cls: "outcome-away" };
  return { text: "เสมอ", cls: "outcome-draw" };
}

function renderAnalysisBlock(analysis) {
  if (!analysis || analysis.error) {
    return `<div class="analysis-summary">วิเคราะห์ไม่สำเร็จ: ${analysis?.error || "ไม่ทราบสาเหตุ"}</div>`;
  }
  if (analysis.raw) {
    return `<div class="analysis-summary">${analysis.raw}</div>`;
  }
  const out = outcomeLabel(analysis.outcome);
  const points = (analysis.keyPoints || []).map((p) => `<li>${p}</li>`).join("");
  return `
    <div class="analysis-score">
      ${analysis.predictedScore || "-"}
      <span class="analysis-outcome ${out.cls}">${out.text}</span>
    </div>
    <ul class="analysis-points">${points}</ul>
    <div class="analysis-summary">${analysis.summary || ""}</div>
    ${analysis.riskNote ? `<div class="analysis-risk">⚠ ${analysis.riskNote}</div>` : ""}
  `;
}

function renderFixtures(picks) {
  fixtureList.innerHTML = "";
  picks.forEach((fx, idx) => {
    const li = document.createElement("li");
    li.className = "fixture";
    const time = new Date(fx.utcDate).toLocaleTimeString("th-TH", { hour: "2-digit", minute: "2-digit" });
    const confidence = fx.analysis?.confidence;

    li.innerHTML = `
      <div class="fixture__row" data-idx="${idx}">
        <div class="fixture__time">${time}</div>
        <div class="fixture__teams">
          <span class="comp">${fx.competition}${fx.aiscoreMatched ? ' · <span class="badge-form">มีสถิติฟอร์ม AiScore</span>' : ""}</span>
          <span class="names">${fx.homeTeam} vs ${fx.awayTeam}</span>
        </div>
        <div class="fixture__confidence">
          <div class="num">${confidence != null ? confidence + "%" : "-"}</div>
          <div class="lbl">ความมั่นใจ</div>
        </div>
      </div>
      <div class="fixture__analysis" id="analysis-${idx}">
        ${renderAnalysisBlock(fx.analysis)}
      </div>
    `;
    fixtureList.appendChild(li);
  });

  document.querySelectorAll(".fixture__row").forEach((row) => {
    row.addEventListener("click", () => {
      const idx = row.dataset.idx;
      document.getElementById(`analysis-${idx}`).classList.toggle("is-open");
    });
  });
}

async function loadDailyPicks() {
  const date = dateInput.value || todayISO;
  dailyStatus.textContent = "กำลังดึงคู่บอลและให้ AI วิเคราะห์... อาจใช้เวลาสักครู่";
  dailyStatus.classList.remove("is-error");
  fixtureList.innerHTML = "";
  fixtureCountEl.textContent = "--";

  try {
    const res = await fetch(`/api/daily-picks?date=${date}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "โหลดข้อมูลไม่สำเร็จ");

    fixtureCountEl.textContent = data.totalFixtures;
    if (data.picks.length === 0) {
      dailyStatus.textContent = "ไม่พบคู่บอลในวันที่เลือก";
      return;
    }
    dailyStatus.textContent = `วิเคราะห์แล้ว ${data.analyzed} จาก ${data.totalFixtures} คู่ (คลิกที่คู่บอลเพื่อดูรายละเอียด)`;
    renderFixtures(data.picks);
  } catch (err) {
    dailyStatus.textContent = `เกิดข้อผิดพลาด: ${err.message}`;
    dailyStatus.classList.add("is-error");
  }
}

loadPicksBtn.addEventListener("click", loadDailyPicks);
loadDailyPicks();

// ---------- Manual analyzer ----------
const analyzeForm = document.getElementById("analyze-form");
const analyzerStatus = document.getElementById("analyzer-status");
const analyzerResult = document.getElementById("analyzer-result");

analyzeForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const homeTeam = document.getElementById("homeTeam").value.trim();
  const awayTeam = document.getElementById("awayTeam").value.trim();
  const competition = document.getElementById("competition").value.trim();
  const extra = document.getElementById("extra").value.trim();

  analyzerStatus.textContent = "กำลังวิเคราะห์...";
  analyzerStatus.classList.remove("is-error");
  analyzerResult.innerHTML = "";

  try {
    const res = await fetch("/api/analyze", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ homeTeam, awayTeam, competition, extra }),
    });
    const analysis = await res.json();
    if (!res.ok) throw new Error(analysis.error || "วิเคราะห์ไม่สำเร็จ");

    analyzerStatus.textContent = "";
    analyzerResult.innerHTML = `
      <div class="fixture__analysis is-open" style="margin-top:0;">
        <div style="font-family:'Kanit',sans-serif;font-size:1.1rem;margin-bottom:8px;">
          ${homeTeam} vs ${awayTeam}
        </div>
        ${renderAnalysisBlock(analysis)}
      </div>
    `;
  } catch (err) {
    analyzerStatus.textContent = `เกิดข้อผิดพลาด: ${err.message}`;
    analyzerStatus.classList.add("is-error");
  }
});
