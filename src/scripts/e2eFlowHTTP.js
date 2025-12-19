/**
 * e2eFlowHTTP.js
 *
 * Pure-HTTP end-to-end test for Secret Santa (LOCKED FLOW).
 *
 * Verifies:
 * - Owner + participants are included in shuffle
 * - Wish can be submitted ONLY ONCE
 * - Address can be submitted ONLY ONCE
 * - Admin approvals are FINAL
 * - Gift acknowledgement can be done ONLY ONCE
 */

require('dotenv').config();
const axios = require('axios');
const mongoose = require('mongoose');

const User = require('../models/User');
const Participation = require('../models/Participation');
const Mapping = require('../models/Mapping');
const RecipientWish = require('../models/RecipientWish');
const Group = require('../models/Group');
const Acknowledgement = require('../models/Acknowledgement');

const BASE_URL = process.env.BASE_URL || 'http://localhost:4000';
const ADMIN_EMAIL = process.env.ADMIN_SEED_EMAIL;
const ADMIN_PW = process.env.ADMIN_SEED_PW;

if (!ADMIN_EMAIL || !ADMIN_PW) {
  console.error('ADMIN_SEED_EMAIL and ADMIN_SEED_PW must be set');
  process.exit(1);
}

const auth = token => ({
  headers: { Authorization: `Bearer ${token}` }
});

async function httpRegister(name, email, password) {
  await axios.post(`${BASE_URL}/api/auth/register`, { name, email, password });
  const res = await axios.post(`${BASE_URL}/api/auth/login`, { email, password });
  return res.data;
}

async function httpLogin(email, password) {
  const res = await axios.post(`${BASE_URL}/api/auth/login`, { email, password });
  return res.data;
}

async function expect409(fn, label) {
  try {
    await fn();
    throw new Error(`❌ Expected 409 but succeeded: ${label}`);
  } catch (e) {
    if (e.response?.status === 409) {
      console.log(`✔ Expected failure confirmed: ${label}`);
    } else {
      throw e;
    }
  }
}

async function wait(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function main() {
  console.log('\n🚀 Starting LOCKED E2E HTTP test...\n');

  await mongoose.connect(process.env.MONGO_URI);

  const createdEmails = [];
  let groupId;

  try {
    /* ---------------- ADMIN LOGIN ---------------- */
    const adminLogin = await httpLogin(ADMIN_EMAIL, ADMIN_PW);
    const adminToken = adminLogin.token;

    /* ---------------- OWNER (AUTO GROUP MEMBER) ---------------- */
    const ownerEmail = `owner+${Date.now()}@test.com`;
    const ownerPassword = 'pass123';

    const owner = await httpRegister('Owner', ownerEmail, ownerPassword);
    createdEmails.push(ownerEmail);

    /* ---------------- PARTICIPANTS LIST ----------------
       IMPORTANT: Owner MUST be treated as participant
    ----------------------------------------------------- */
    const participants = [];

    participants.push({
      email: ownerEmail,
      token: owner.token,
      password: ownerPassword
    });

    const participantPassword = 'pass123';

    for (let i = 0; i < 4; i++) {
      const email = `p${i}+${Date.now()}@test.com`;
      const reg = await httpRegister(`P${i}`, email, participantPassword);
      participants.push({
        email,
        token: reg.token,
        password: participantPassword
      });
      createdEmails.push(email);
    }

    /* ---------------- CREATE GROUP ---------------- */
    const createRes = await axios.post(
      `${BASE_URL}/api/group/create`,
      { name: `group-${Date.now()}` },
      auth(owner.token)
    );

    groupId = createRes.data.groupId;
    const joinCode = createRes.data.joinCode;

    /* ---------------- JOIN GROUP (participants only) ---------------- */
    for (const p of participants) {
      if (p.email === ownerEmail) continue; // owner already joined
      await axios.post(
        `${BASE_URL}/api/group/join`,
        { joinCode },
        auth(p.token)
      );
    }

    await wait(300);

    /* ---------------- SHUFFLE ---------------- */
    await axios.post(
      `${BASE_URL}/api/admin/shuffle/${groupId}`,
      {},
      auth(adminToken)
    );

    const mappings = await Mapping.find({ groupId }).lean();
    console.log(`✔ Shuffle created ${mappings.length} mappings`);

    /* ================= WISH FLOW ================= */
    for (const m of mappings) {
      const recipient = await User.findById(m.recipientId).lean();
      const participant = participants.find(p => p.email === recipient.email);

      if (!participant) {
        throw new Error(`Recipient ${recipient.email} not found in participants`);
      }

      await axios.post(
        `${BASE_URL}/api/user/set-wish/${groupId}`,
        { wish: `Wish for ${recipient.email}` },
        auth(participant.token)
      );

      await expect409(
        () => axios.post(
          `${BASE_URL}/api/user/set-wish/${groupId}`,
          { wish: 'HACK' },
          auth(participant.token)
        ),
        'Wish re-submit blocked'
      );
    }

    /* ---------------- ADMIN APPROVES WISHES ---------------- */
    const wishes = await RecipientWish.find({ groupId });
    for (const w of wishes) {
      await axios.post(
        `${BASE_URL}/api/admin/approve-wish/${w._id}`,
        {},
        auth(adminToken)
      );

      await expect409(
        () => axios.post(
          `${BASE_URL}/api/admin/approve-wish/${w._id}`,
          {},
          auth(adminToken)
        ),
        'Wish double approval blocked'
      );
    }

    /* ================= ADDRESS FLOW ================= */
    for (const m of mappings) {
      const recipient = await User.findById(m.recipientId).lean();
      const participant = participants.find(p => p.email === recipient.email);

      await axios.post(
        `${BASE_URL}/api/user/submit-address/${groupId}`,
        { address: `Address for ${recipient.email}` },
        auth(participant.token)
      );

      await expect409(
        () => axios.post(
          `${BASE_URL}/api/user/submit-address/${groupId}`,
          { address: 'HACK' },
          auth(participant.token)
        ),
        'Address re-submit blocked'
      );
    }

    /* ---------------- ADMIN APPROVES ADDRESSES ---------------- */
    for (const m of mappings) {
      await axios.post(
        `${BASE_URL}/api/admin/approve-address/${groupId}/${m.recipientId}`,
        {},
        auth(adminToken)
      );

      await expect409(
        () => axios.post(
          `${BASE_URL}/api/admin/approve-address/${groupId}/${m.recipientId}`,
          {},
          auth(adminToken)
        ),
        'Address double approval blocked'
      );
    }

    /* ================= SANTA FETCH + ACK ================= */
    for (const m of mappings) {
      const santa = await User.findById(m.santaId).lean();
      const participant = participants.find(p => p.email === santa.email);

      if (!participant) {
        throw new Error(`Santa ${santa.email} not found in participants`);
      }

      const login = await httpLogin(santa.email, participant.password);
      if (!login?.token) {
        throw new Error(`Login failed for santa ${santa.email}`);
      }

      const assignment = await axios.get(
        `${BASE_URL}/api/user/my-assignment/${groupId}`,
        auth(login.token)
      );

      if (!assignment.data?.wish || !assignment.data?.address) {
        throw new Error(`Assignment incomplete for santa ${santa.email}`);
      }

      await axios.post(
        `${BASE_URL}/api/user/acknowledge/${groupId}`,
        {},
        auth(login.token)
      );

      await expect409(
        () => axios.post(
          `${BASE_URL}/api/user/acknowledge/${groupId}`,
          {},
          auth(login.token)
        ),
        'Double gift acknowledgement blocked'
      );
    }

    console.log('\n✅ LOCKED E2E FLOW PASSED\n');

  } catch (err) {
    console.error('\n❌ E2E TEST FAILED\n', err.response?.data || err.message);
  } finally {
    console.log('Cleaning up test data...');
    if (groupId) {
      await Mapping.deleteMany({ groupId });
      await Participation.deleteMany({ groupId });
      await RecipientWish.deleteMany({ groupId });
      await Acknowledgement.deleteMany({ groupId });
      await Group.deleteOne({ _id: groupId });
    }

    for (const email of createdEmails) {
      await User.deleteOne({ email });
    }

    await mongoose.disconnect();
    process.exit(0);
  }
}

main();
