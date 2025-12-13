require('dotenv').config();
const mongoose = require('mongoose');
const bcrypt = require('bcrypt');
const User = require('../models/User');

(async () => {
  await mongoose.connect(process.env.MONGO_URI);

  const exists = await User.findOne({ email: process.env.ADMIN_SEED_EMAIL });
  if (exists) return console.log('Admin exists');

  const hash = await bcrypt.hash(process.env.ADMIN_SEED_PW, 10);

  await User.create({
    name: 'Admin',
    email: process.env.ADMIN_SEED_EMAIL,
    passwordHash: hash,
    role: 'ADMIN'
  });

  console.log('Admin created');
  process.exit();
})();
