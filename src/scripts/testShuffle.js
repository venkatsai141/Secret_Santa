/**
 * testShuffle.js
 *
 * Usage:
 *   MONGO_URI="mongodb://localhost:27017/secret_santa_dev" node src/scripts/testShuffle.js
 *
 * This script will:
 *  - create a temporary group
 *  - create N users and Participation entries (submitted = true)
 *  - run the derangement shuffle (same logic as your admin shuffle)
 *  - insert mappings
 *  - validate correctness
 *  - cleanup created docs
 */

require('dotenv').config();
const mongoose = require('mongoose');

const User = require('../models/User');
const Group = require('../models/Group');
const Participation = require('../models/Participation');
const Mapping = require('../models/Mapping');

async function connect() {
  if (!process.env.MONGO_URI) {
    console.error('Please set MONGO_URI in env');
    process.exit(1);
  }

  try {
    // modern mongoose: just pass the URI
    await mongoose.connect(process.env.MONGO_URI);
    console.log('Connected to Mongo');
  } catch (err) {
    console.error('Failed to connect to Mongo:', err.message);
    throw err;
  }
}

function generateDerangement(arr) {
  const n = arr.length;
  if (n <= 1) throw new Error('Need at least 2 participants');

  const perm = Array.from({ length: n }, (_, i) => i);
  for (let i = n - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [perm[i], perm[j]] = [perm[j], perm[i]];
  }

  // collect fixed points
  const fixed = [];
  for (let i = 0; i < n; i++) {
    if (perm[i] === i) fixed.push(i);
  }

  if (fixed.length === 1) {
    const i = fixed[0];
    const swapWith = (i === 0) ? 1 : 0;
    [perm[i], perm[swapWith]] = [perm[swapWith], perm[i]];
  } else if (fixed.length > 1) {
    const vals = fixed.map(idx => perm[idx]);
    for (let k = 0; k < fixed.length; k++) {
      perm[fixed[k]] = vals[(k + 1) % fixed.length];
    }
  }

  return perm.map(idx => arr[idx]);
}

async function runTestForSize(n, testTag) {
  console.log(`\n=== Running test for n=${n} (${testTag}) ===`);

  // create group
  const group = await Group.create({
    name: `test-group-${testTag}-${n}-${Date.now()}`,
    ownerId: null,
    joinCode: `jc-${Date.now()}-${Math.floor(Math.random() * 1000)}`
  });

  // Create users and participations
  const users = [];
  for (let i = 0; i < n; i++) {
    const u = await User.create({
      name: `test-user-${testTag}-${n}-${i}-${Date.now()}`,
      email: `test+${testTag}-${n}-${i}-${Date.now()}@example.com`,
      passwordHash: 'irrelevant-for-test'
    });
    users.push(u);
    await Participation.create({
      eventId: 'default',
      groupId: group._id,
      userId: u._id,
      submitted: true,
      addressEncrypted: 'stub' // we don't need real encryption here
    });
  }

  // run derangement
  const userIds = users.map(u => u._id.toString());
  const recipients = generateDerangement(userIds);

  const mappings = userIds.map((santaId, idx) => ({
    eventId: 'default',
    groupId: group._id,
    // use `new mongoose.Types.ObjectId(...)` to avoid constructor issues
    santaId: new mongoose.Types.ObjectId(santaId),
    recipientId: new mongoose.Types.ObjectId(recipients[idx])
  }));

  // cleanup any existing mapping for this group/event just in case
  await Mapping.deleteMany({ groupId: group._id, eventId: 'default' });

  await Mapping.insertMany(mappings);

  // Validation
  const inserted = await Mapping.find({ groupId: group._id, eventId: 'default' });

  const errors = [];

  if (inserted.length !== n) {
    errors.push(`Expected ${n} mappings, found ${inserted.length}`);
  }

  const santaSet = new Set();
  const recipientSet = new Set();

  for (const m of inserted) {
    const s = m.santaId.toString();
    const r = m.recipientId.toString();

    if (s === r) {
      errors.push(`Self-assignment found: santa ${s} -> recipient ${r}`);
    }
    santaSet.add(s);
    recipientSet.add(r);
  }

  if (santaSet.size !== n) {
    errors.push(`Expected ${n} unique santas, found ${santaSet.size}`);
  }
  if (recipientSet.size !== n) {
    errors.push(`Expected ${n} unique recipients, found ${recipientSet.size}`);
  }

  if (errors.length === 0) {
    console.log(`PASS: n=${n}`);
  } else {
    console.error(`FAIL: n=${n}`);
    errors.forEach(e => console.error(' -', e));
  }

  // cleanup: mappings, participations, users, group
  await Mapping.deleteMany({ groupId: group._id, eventId: 'default' });
  await Participation.deleteMany({ groupId: group._id });
  const userIdsToDelete = users.map(u => u._id);
  await User.deleteMany({ _id: { $in: userIdsToDelete } });
  await Group.deleteOne({ _id: group._id });

  return errors.length === 0;
}

async function main() {
  try {
    await connect();

    // List of sizes to test (including odd and even)
    const sizes = [2, 3, 5, 6, 11];

    let allPassed = true;
    for (const n of sizes) {
      const ok = await runTestForSize(n, `auto`);
      if (!ok) allPassed = false;
    }

    if (allPassed) {
      console.log('\nALL TESTS PASSED ✅');
    } else {
      console.error('\nSOME TESTS FAILED ❌ - check output above for details');
    }
  } catch (err) {
    console.error('Script error:', err);
  } finally {
    await mongoose.disconnect();
    console.log('Disconnected from Mongo');
    process.exit(0);
  }
}

main();
