const express = require("express");
const User = require("../models/User");
const auth = require("../middleware/auth");
const router = express.Router();

router.get("/all", auth, async (req, res) => {
  try {
    const users = await User.find({ _id: { $ne: req.user.id } }).select("name email");
    res.json(users);
  } catch (err) {
    res.status(500).json({ error: "Server error" });
  }
});

module.exports = router;
