require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');

const authRoutes = require('../src/routes/auth');
const userRoutes = require('../src/routes/user');
const adminRoutes = require('../src/routes/admin');
const groupRoutes = require('../src/routes/group');

const app = express();

/* Middleware */
app.use(express.json());
app.use(cors({
  origin: '*',
  credentials: true
}));

/* Routes */
app.use('/api/auth', authRoutes);
app.use('/api/user', userRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/group', groupRoutes);

/* Mongo connection (cached) */
let isConnected = false;

async function connectDB() {
  if (isConnected) return;
  await mongoose.connect(process.env.MONGO_URI);
  isConnected = true;
  console.log('Mongo connected');
}

app.use(async (req, res, next) => {
  try {
    await connectDB();
    next();
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'DB connection failed' });
  }
});

/* EXPORT — NO app.listen() */
module.exports = app;

app.get('/', (req, res) => {
  res.json({
    status: 'OK',
    service: 'Secret Santa Backend',
    time: new Date().toISOString()
  });
});
