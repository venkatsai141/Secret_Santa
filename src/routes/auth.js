const express = require('express');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const User = require('../models/User');

const router = express.Router();

/* ---------------------------------------
   AUTH: REGISTER
   POST /api/auth/register
---------------------------------------- */
router.post('/register', async (req, res) => {
  try {
    const { name, email, password } = req.body;

    if (!name || !email || !password) {
      return res.status(400).json({ message: "name, email and password are required" });
    }

    const existingUser = await User.findOne({ email });
    if (existingUser) {
      return res.status(409).json({ message: "User already exists" });
    }

    const hash = await bcrypt.hash(password, 10);

    await User.create({
      name,
      email,
      passwordHash: hash
    });

    res.json({ message: "registered" });

  } catch (err) {
    console.error("[auth.register] error:", err);
    res.status(500).json({ message: "Server error" });
  }
});

/* ---------------------------------------
   AUTH: LOGIN
   POST /api/auth/login
---------------------------------------- */
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;

    const user = await User.findOne({ email });
    if (!user || !(await user.verifyPassword(password))) {
      return res.status(401).json({ message: "Invalid credentials" });
    }

    const token = jwt.sign(
      {
        sub: user._id,
        role: user.role
      },
      process.env.JWT_SECRET,
      { expiresIn: '7d' } // optional but recommended
    );

    res.json({
      token,
      role: user.role
    });

  } catch (err) {
    console.error("[auth.login] error:", err);
    res.status(500).json({ message: "Server error" });
  }
});

module.exports = router;
