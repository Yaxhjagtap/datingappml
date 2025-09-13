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
const io = new Server(server, { cors: { origin: '*' }, transports: ['websocket', 'polling'] });

const PORT = process.env.PORT || 4000;
const MONGO_URI = process.env.MONGO_URI;
const JWT_SECRET = process.env.JWT_SECRET;
const ML_MODEL_URL = process.env.ML_MODEL_URL; // e.g., https://mlforward.onrender.com/predict

// MongoDB connection
mongoose.connect(MONGO_URI, { })
  .then(() => console.log('MongoDB connected'))
  .catch(err => console.error('MongoDB error', err));

const authenticateToken = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  if (!token) return res.status(401).json({ message: 'Access token required' });
  jwt.verify(token, JWT_SECRET, (err, decoded) => {
    if (err) return res.status(403).json({ message: 'Invalid or expired token' });
    req.user = decoded;
    next();
  });
};

function makeRoomId(userId1, userId2) {
  const [a, b] = [userId1.toString(), userId2.toString()].sort();
  return `${a}__${b}`;
}

// Auth endpoints
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
    console.error(err);
    res.status(500).json({ message: 'Server error' });
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
    console.error(err);
    res.status(500).json({ message: 'Server error' });
  }
});

app.get('/api/users', authenticateToken, async (req, res) => {
  try {
    const users = await User.find({}, { passwordHash: 0 }).limit(100);
    res.json({ users });
  } catch (err) {
    res.status(500).json({ message: 'Server error' });
  }
});

app.get('/api/messages/:targetId', authenticateToken, async (req, res) => {
  try {
    const { targetId } = req.params;
    const currentId = req.user.id;
    const roomId = makeRoomId(currentId, targetId);
    const messages = await Message.find({ roomId })
      .populate('from', 'name email')
      .sort({ createdAt: 1 })
      .limit(200);
    const formatted = messages.map(m => ({
      id: m._id,
      text: m.text,
      createdAt: m.createdAt,
      from: {
        id: m.from._id.toString(),
        name: m.from.name,
        email: m.from.email,
      },
    }));
    res.json({ messages: formatted });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Server error' });
  }
});

app.get('/api/me', authenticateToken, async (req, res) => {
  try {
    const user = await User.findById(req.user.id, { passwordHash: 0 });
    if (!user) return res.status(401).json({ message: 'User not found' });
    res.json({ user });
  } catch (err) {
    res.status(500).json({ message: 'Server error' });
  }
});

const behaviorBuffers = {};

async function forwardToModelAndBroadcast(roomId) {
  const buf = behaviorBuffers[roomId];
  if (!buf) {
    console.log(`[ML] No buffer for room ${roomId}`);
    return;
  }
  const allParams = [];
  for (const sid of Object.keys(buf)) {
    const arr = buf[sid] || [];
    if (arr.length) allParams.push(...arr);
  }
  if (allParams.length === 0) {
    console.log(`[ML] No params to send for room ${roomId}`);
    return;
  }

  // Calculate aggregates matching your required ML input exactly
  const aggregate = allParams.reduce((acc, p) => {
    acc.avg_pause_duration_ms += Number(p.pause_duration_ms || 0);
    acc.avg_scroll_depth_pct += Number(p.scroll_depth_pct || 0);
    acc.avg_typing_speed_min += Number(p.typing_speed_min || p.typing_speed || p.typing_speed_chars_per_min || 0);
    acc.avg_response_time += Number(p.response_time || p.response_time_ms || 0);
    return acc;
  }, {
    avg_pause_duration_ms: 0,
    avg_scroll_depth_pct: 0,
    avg_typing_speed_min: 0,
    avg_response_time: 0,
  });

  const n = allParams.length;

  const features = {
    avg_pause_duration_ms: Math.round(aggregate.avg_pause_duration_ms / n),
    avg_scroll_depth_pct: Math.round(aggregate.avg_scroll_depth_pct / n),
    avg_typing_speed_min: Math.round(aggregate.avg_typing_speed_min / n),
    avg_response_time: Math.round(aggregate.avg_response_time / n),
    sample_count: n,
  };

  console.log(`[ML] Sending features to model for room ${roomId}:`, features);

  behaviorBuffers[roomId] = {};

  try {
    const res = await axios.post(ML_MODEL_URL, features, { timeout: 15000 });
    const mlData = res.data;
    console.log(`[ML] Received data from model for room ${roomId}:`, mlData);
    io.to(roomId).emit('ml_analysis', { roomId, features, mlData, ts: Date.now() });
  } catch (error) {
    console.error(`[ML] Error sending data to model for room ${roomId}:`, error.message || error);
    io.to(roomId).emit('ml_error', { roomId, message: 'ML model error' });
  }
}

io.on('connection', (socket) => {
  console.log(`Socket connected: ${socket.id}`);

  socket.on('authenticate', async (data) => {
    try {
      if (!data?.token) {
        socket.emit('unauthorized');
        return socket.disconnect();
      }
      const decoded = jwt.verify(data.token, JWT_SECRET);
      const user = await User.findById(decoded.id);
      if (!user) {
        socket.emit('unauthorized');
        return socket.disconnect();
      }
      socket.user = { id: user._id.toString(), name: user.name, email: user.email };
      socket.emit('authenticated', { user: socket.user });
      console.log(`Socket authenticated: ${socket.user.email}`);
    } catch (err) {
      socket.emit('unauthorized');
      return socket.disconnect();
    }
  });

  socket.on('join_room', ({ targetId }) => {
    if (!socket.user) return socket.emit('error', { message: 'Unauthorized' });
    const roomId = makeRoomId(socket.user.id, targetId);
    socket.join(roomId);
    socket.roomId = roomId;
    socket.targetId = targetId;
    io.to(roomId).emit('system_message', { text: `${socket.user.name} joined chat`, ts: Date.now() });
    if (!behaviorBuffers[roomId]) behaviorBuffers[roomId] = {};
    console.log(`User ${socket.user.name} joined room ${roomId}`);
  });

  socket.on('chat_message', async ({ text }) => {
    if (!socket.user || !socket.roomId) {
      return socket.emit('error', { message: 'Unauthorized or no room joined' });
    }
    try {
      const msg = await Message.create({ from: socket.user.id, text, roomId: socket.roomId });
      const populated = await Message.findById(msg._id).populate('from', 'name email');
      io.to(socket.roomId).emit('chat_message', {
        id: populated._id,
        text: populated.text,
        createdAt: populated.createdAt,
        from: {
          id: populated.from._id.toString(),
          name: populated.from.name,
          email: populated.from.email,
        }
      });
    } catch (e) {
      console.error('Failed to save chat message:', e);
      socket.emit('error', { message: 'Failed to save message' });
    }
  });

  socket.on('behavior_params', ({ params }) => {
    if (!socket.user || !socket.roomId) {
      return socket.emit('error', { message: 'Unauthorized or no room joined' });
    }
    if (!Array.isArray(params)) return;
    const roomId = socket.roomId;
    if (!behaviorBuffers[roomId]) behaviorBuffers[roomId] = {};
    if (!behaviorBuffers[roomId][socket.id]) behaviorBuffers[roomId][socket.id] = [];
    behaviorBuffers[roomId][socket.id].push(...params.slice(-10));
    if (behaviorBuffers[roomId][socket.id].length > 30) {
      behaviorBuffers[roomId][socket.id].splice(0, behaviorBuffers[roomId][socket.id].length - 30);
    }

    forwardToModelAndBroadcast(roomId).catch(err => {
      console.error("Error forwarding to ML model:", err);
    });
  });

  socket.on('disconnect', () => {
    if (socket.roomId && behaviorBuffers[socket.roomId]) {
      delete behaviorBuffers[socket.roomId][socket.id];
    }
    console.log(`Socket disconnected: ${socket.id}`);
  });
});

server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
