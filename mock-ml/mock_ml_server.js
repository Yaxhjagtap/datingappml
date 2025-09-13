// mock_ml_server.js
const express = require('express');
const cors = require('cors');
const app = express();

app.use(cors());
app.use(express.json());

app.post('/predict', (req, res) => {
  const f = req.body;
  const raw = Array.isArray(f.raw) && f.raw.length > 0 ? f.raw : [];

  let avg_pause = 0, avg_scroll = 0, avg_typing = 0, avg_response = 0;
  if (raw.length) {
    raw.forEach(r => {
      avg_pause += Number(r.pause_duration_ms) || 0;
      avg_scroll += Number(r.scroll_depth_pct) || 0;
      avg_typing += Number(r.typing_speed_chars_per_min) || 0;
      avg_response += Number(r.response_time_ms) || 0;
    });
    avg_pause /= raw.length;
    avg_scroll /= raw.length;
    avg_typing /= raw.length;
    avg_response /= raw.length;
  } else {
    avg_pause = Number(f.avg_pause_duration_ms) || 0;
    avg_scroll = Number(f.avg_scroll_depth_pct) || 0;
    avg_typing = Number(f.avg_typing_speed_chars_per_min) || 0;
    avg_response = Number(f.avg_response_time_ms) || 0;
  }

  const sample_count = raw.length || Number(f.sample_count) || 1;

  // Improved scoring with wider dynamic range
  const score = 
    Math.max(0, 2000 - avg_pause) * 0.3 +
    avg_scroll * 1.0 +
    avg_typing * 0.2 +
    Math.max(0, 2000 - avg_response) * 0.4;

  const normalized = Math.max(0, Math.min(100, Math.round(score / 20)));

  let suggestion;
  if (normalized > 75) suggestion = "Highly engaged";
  else if (normalized > 60) suggestion = "Interested";
  else if (normalized > 35) suggestion = "Somewhat engaged";
  else suggestion = "Not interested";

  const hints = [];
  if (avg_pause > 1200) hints.push("Try responding faster");
  if (avg_typing > 200) hints.push("Great typing speed!");
  if (avg_scroll > 70) hints.push("High scroll engagement");
  if (avg_response < 1200) hints.push("Quick replies");

  res.status(200).json({
    score: normalized,
    suggestion,
    hints,
    sample_count
  });
});

const port = 5000;
app.listen(port, () => console.log('Mock ML server running on port', port));
