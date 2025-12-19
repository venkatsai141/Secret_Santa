require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');

const authRoutes = require('./src/routes/auth');
const userRoutes = require('./src/routes/user');
const adminRoutes = require('./src/routes/admin');
const groupRoutes = require('./src/routes/group');

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

app.get('/', (req, res) => {
  res.json({
    status: 'OK',
    service: 'Secret Santa Backend',
    time: new Date().toISOString()
  });
});

/* Mongo connection and server startup */
const PORT = process.env.PORT || 4000;

async function startServer() {
  try {
    // Connect to MongoDB first
    await mongoose.connect(process.env.MONGO_URI, {
      serverSelectionTimeoutMS: 5000,
    });
    console.log('✅ Mongo connected');
    
    // Start server only after DB connection
    app.listen(PORT, () => {
      console.log(`🚀 Server running on port ${PORT}`);
    });
  } catch (err) {
    console.error('❌ Failed to start server:', err.message);
    console.error('Full error:', err);
    process.exit(1);
  }
}

// Handle connection errors after initial connection
mongoose.connection.on('error', err => {
  console.error('❌ MongoDB connection error:', err);
});

mongoose.connection.on('disconnected', () => {
  console.log('⚠️ MongoDB disconnected');
});

startServer();

module.exports = app;