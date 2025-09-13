// server.js
require('dotenv').config();
const express = require('express');
const http = require('http');
const mongoose = require('mongoose');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const axios = require('axios');

const User = require('./models/User');
const Message = require('./models/Message');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static('public'));
app.use("/api/users", require("./routes/user"));

const server = http.createServer(app);
const { Server } = require('socket.io');
const io = new Server(server, { cors: { origin: '*' } });

const PORT = process.env.PORT || 4000;
const MONGO_URI = process.env.MONGO_URI;
const JWT_SECRET = process.env.JWT_SECRET;
const ML_MODEL_URL = process.env.ML_MODEL_URL; // e.g. http://localhost:5000/predict

// --- Connect MongoDB
mongoose.connect(MONGO_URI, { })
  .then(()=> console.log('MongoDB connected'))
  .catch(err => console.error('MongoDB error', err));

// --- JWT Middleware for protected routes
const authenticateToken = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1]; // Bearer TOKEN

  if (!token) {
    return res.status(401).json({ message: 'Access token required' });
  }

  jwt.verify(token, JWT_SECRET, (err, decoded) => {
    if (err) {
      return res.status(403).json({ message: 'Invalid or expired token' });
    }
    req.user = decoded;
    next();
  });
};

// --- Helper function to create deterministic room ID
function makeRoomId(userId1, userId2) {
  const [a, b] = [userId1.toString(), userId2.toString()].sort();
  return `${a}__${b}`;
}

// --- Auth routes (register/login) - simple
app.post('/api/auth/register', async (req, res) => {
  try {
    const { name, email, password } = req.body;
    if (!name || !email || !password) return res.status(400).json({ message: 'Missing fields' });
    const existing = await User.findOne({ email });
    if (existing) return res.status(400).json({ message: 'User exists' });

    const bcrypt = require('bcryptjs');
    const salt = await bcrypt.genSalt(10);
    const passwordHash = await bcrypt.hash(password, salt);
    const user = await User.create({ name, email, passwordHash });
    const token = jwt.sign({ id: user._id, email: user.email }, JWT_SECRET, { expiresIn: '7d' });
    res.json({ token, user: { id: user._id, name: user.name, email: user.email } });
  } catch (err) {
    console.error(err); res.status(500).json({ message: 'Server error' });
  }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ message: 'Missing fields' });
    const user = await User.findOne({ email });
    if (!user) return res.status(400).json({ message: 'Invalid credentials' });
    const bcrypt = require('bcryptjs');
    const ok = await bcrypt.compare(password, user.passwordHash);
    if (!ok) return res.status(400).json({ message: 'Invalid credentials' });
    const token = jwt.sign({ id: user._id, email: user.email }, JWT_SECRET, { expiresIn: '7d' });
    res.json({ token, user: { id: user._id, name: user.name, email: user.email } });
  } catch (err) {
    console.error(err); res.status(500).json({ message: 'Server error' });
  }
});

// Protected list of users
app.get('/api/users', authenticateToken, async (req, res) => {
  try {
    const users = await User.find({}, { passwordHash: 0 }).limit(100);
    res.json({ users });
  } catch (err) {
    res.status(500).json({ message: 'Server error' });
  }
});

// Get chat history
app.get('/api/messages/:targetUserId', authenticateToken, async (req, res) => {
  try {
    const { targetUserId } = req.params;
    const currentUserId = req.user.id;
    const roomId = makeRoomId(currentUserId, targetUserId);

    const messages = await Message.find({ roomId })
      .populate('from', 'name email')
      .sort({ createdAt: 1 })
      .limit(200);

    const formattedMessages = messages.map(msg => ({
      id: msg._id,
      text: msg.text,
      createdAt: msg.createdAt,
      from: {
        id: msg.from._id.toString(),
        name: msg.from.name,
        email: msg.from.email
      }
    }));

    res.json({ messages: formattedMessages });
  } catch (err) {
    console.error('Get messages error:', err);
    res.status(500).json({ message: 'Server error' });
  }
});

// Protected example
app.get('/api/me', authenticateToken, async (req, res) => {
  try {
    const user = await User.findById(req.user.id, { passwordHash: 0 });
    if (!user) return res.status(401).json({ message: 'User not found' });
    res.json({ user });
  } catch (err) {
    res.status(401).json({ message: 'Server error' });
  }
});

// ----------------- Socket.IO realtime -----------------
const behaviorBuffers = {};

// forward aggregated features to ML model
async function forwardToModelAndBroadcast(roomId) {
  const buf = behaviorBuffers[roomId];
  if (!buf) return;

  const allParams = [];
  for (const sid of Object.keys(buf)) {
    const arr = buf[sid] || [];
    if (arr.length) allParams.push(...arr);
  }
  if (allParams.length === 0) return;

  const aggregate = allParams.reduce((acc, p) => {
    acc.pause_duration_ms += p.pause_duration_ms || 0;
    acc.scroll_depth_pct += p.scroll_depth_pct || 0;
    acc.typing_speed_chars_per_min += p.typing_speed_chars_per_min || 0;
    acc.response_time_ms += p.response_time_ms || 0;
    return acc;
  }, { pause_duration_ms: 0, scroll_depth_pct: 0, typing_speed_chars_per_min: 0, response_time_ms: 0 });

  const n = allParams.length;
  const features = {
    avg_pause_duration_ms: Math.round(aggregate.pause_duration_ms / n),
    avg_scroll_depth_pct: Math.round(aggregate.scroll_depth_pct / n),
    avg_typing_speed_chars_per_min: Math.round(aggregate.typing_speed_chars_per_min / n),
    avg_response_time_ms: Math.round(aggregate.response_time_ms / n),
    sample_count: n,
    raw: allParams.slice(-20)
  };

  // Log payload for clarity
  console.log("📤 Sending payload to ML model:", JSON.stringify(features, null, 2));

  behaviorBuffers[roomId] = {};

  try {
    const resp = await axios.post(ML_MODEL_URL, features, { timeout: 10000 });
    const mlData = resp.data;
    io.to(roomId).emit('ml_analysis', { roomId, features, mlData, ts: Date.now() });
  } catch (err) {
    console.error('ML forward error', err?.message || err);
    io.to(roomId).emit('ml_error', { roomId, message: 'ML model error' });
  }
}

io.on('connection', (socket) => {
  console.log('socket connected', socket.id);

  socket.on('authenticate', async (data) => {
    try {
      const token = data?.token;
      if (!token) { socket.emit('unauthorized'); return socket.disconnect(); }
      const decoded = jwt.verify(token, JWT_SECRET);
      const user = await User.findById(decoded.id);
      if (!user) { socket.emit('unauthorized'); return socket.disconnect(); }
      socket.user = { id: user._id.toString(), name: user.name, email: user.email };
      socket.emit('authenticated', { user: socket.user });
      console.log('socket authenticated', socket.user.email);
    } catch (err) {
      socket.emit('unauthorized');
      return socket.disconnect();
    }
  });

  socket.on('join_room', async ({ targetUserId }) => {
    if (!socket.user) return socket.emit('error', { message: 'Not authenticated' });
    const roomId = makeRoomId(socket.user.id, targetUserId);
    socket.join(roomId);
    socket.roomId = roomId;
    socket.targetUserId = targetUserId;

    io.to(roomId).emit('system_message', { text: `${socket.user.name} joined the chat`, ts: Date.now() });
    if (!behaviorBuffers[roomId]) behaviorBuffers[roomId] = {};
  });

  socket.on('chat_message', async (payload) => {
    if (!socket.user || !socket.roomId) return socket.emit('error', { message: 'Not in room or not auth' });
    try {
      const msg = await Message.create({ from: socket.user.id, text: payload.text, roomId: socket.roomId });
      const populatedMsg = await Message.findById(msg._id).populate('from', 'name email');

      const out = {
        id: populatedMsg._id,
        text: populatedMsg.text,
        createdAt: populatedMsg.createdAt,
        from: {
          id: populatedMsg.from._id.toString(),
          name: populatedMsg.from.name,
          email: populatedMsg.from.email
        }
      };

      io.to(socket.roomId).emit('chat_message', out);
    } catch (err) {
      console.error('save message error', err);
      socket.emit('error', { message: 'Failed to save message' });
    }
  });

  socket.on('behavior_params', async (payload) => {
    if (!socket.user || !socket.roomId) return socket.emit('error', { message: 'Not in room or not auth' });
    const arr = payload.params || [];
    const roomId = socket.roomId;
    if (!behaviorBuffers[roomId]) behaviorBuffers[roomId] = {};
    if (!behaviorBuffers[roomId][socket.id]) behaviorBuffers[roomId][socket.id] = [];
    behaviorBuffers[roomId][socket.id].push(...arr.slice(-10));
    if (behaviorBuffers[roomId][socket.id].length > 30) {
      behaviorBuffers[roomId][socket.id].splice(0, behaviorBuffers[roomId][socket.id].length - 30);
    }

    await forwardToModelAndBroadcast(roomId);
  });

  socket.on('disconnect', () => {
    if (socket.roomId && behaviorBuffers[socket.roomId]) {
      delete behaviorBuffers[socket.roomId][socket.id];
    }
    console.log('socket disconnected', socket.id);
  });
});

server.listen(PORT, () => console.log(`Server listening on ${PORT}`));
