const axios = require('axios');

const ML_MODEL_URL = process.env.ML_MODEL_URL;

exports.forwardToModel = async (paramsArray) => {
  // paramsArray is expected to be an array of parameter objects
  // Basic validation
  if (!Array.isArray(paramsArray)) {
    throw new Error('params must be an array');
  }

  // Example: we can compute aggregate features to send to the ML model
  // Here we calculate averages — you can replace with more advanced detection logic
  const aggregate = paramsArray.reduce((acc, p) => {
    acc.pause_duration_ms += p.pause_duration_ms || 0;
    acc.scroll_depth_pct += p.scroll_depth_pct || 0;
    acc.typing_speed_chars_per_min += p.typing_speed_chars_per_min || 0;
    acc.response_time_ms += p.response_time_ms || 0;
    return acc;
  }, { pause_duration_ms: 0, scroll_depth_pct: 0, typing_speed_chars_per_min: 0, response_time_ms: 0 });

  const n = paramsArray.length || 1;
  const features = {
    avg_pause_duration_ms: aggregate.pause_duration_ms / n,
    avg_scroll_depth_pct: aggregate.scroll_depth_pct / n,
    avg_typing_speed_chars_per_min: aggregate.typing_speed_chars_per_min / n,
    avg_response_time_ms: aggregate.response_time_ms / n,
    raw: paramsArray
  };

  // Send to ML model
  const resp = await axios.post(ML_MODEL_URL, features, { timeout: 10000 });
  return resp.data; // expect the ML model to reply with a JSON structure
};
