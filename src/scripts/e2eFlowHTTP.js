/**
 * e2eFlowHTTP.js
 *
 * Pure-HTTP end-to-end flow test. No direct DB writes.
 *
 * Requirements:
 * - Server running on BASE_URL (default http://localhost:4000)
 * - ADMIN_SEED_EMAIL and ADMIN_SEED_PW set in .env (or update consts)
 *
 * Run:
 *   node src/scripts/e2eFlowHTTP.js
 */

require('dotenv').config();
const axios = require('axios');
const mongoose = require('mongoose');

const User = require('../models/User');
const Participation = require('../models/Participation');
const Mapping = require('../models/Mapping');
const RecipientWish = require('../models/RecipientWish');
const Group = require('../models/Group');

const BASE_URL = process.env.BASE_URL || 'http://localhost:4000';
const ADMIN_EMAIL = process.env.ADMIN_SEED_EMAIL;
const ADMIN_PW = process.env.ADMIN_SEED_PW;

if (!ADMIN_EMAIL || !ADMIN_PW) {
  console.error('ADMIN_SEED_EMAIL and ADMIN_SEED_PW must be set in .env for admin login');
  process.exit(1);
}

async function httpRegister(name, email, password) {
  await axios.post(`${BASE_URL}/api/auth/register`, { name, email, password });
  const loginRes = await axios.post(`${BASE_URL}/api/auth/login`, { email, password });
  return loginRes.data; // { token, role }
}

async function httpLogin(email, password) {
  const res = await axios.post(`${BASE_URL}/api/auth/login`, { email, password });
  return res.data;
}

async function httpCreateGroup(token, name) {
  const res = await axios.post(`${BASE_URL}/api/group/create`, { name }, { headers: { Authorization: `Bearer ${token}` } });
  return res.data; // { groupId, joinCode }
}

async function httpJoinGroup(token, joinCode) {
  const res = await axios.post(`${BASE_URL}/api/group/join`, { joinCode }, { headers: { Authorization: `Bearer ${token}` } });
  return res.data;
}

async function httpShuffle(adminToken, groupId) {
  const res = await axios.post(`${BASE_URL}/api/admin/shuffle/${groupId}`, {}, { headers: { Authorization: `Bearer ${adminToken}` } });
  return res.data;
}

async function httpSetWish(token, groupId, wish) {
  const res = await axios.post(`${BASE_URL}/api/user/set-wish/${groupId}`, { wish }, { headers: { Authorization: `Bearer ${token}` } });
  return res.data;
}

async function httpSubmitAddress(token, groupId, address) {
  const res = await axios.post(`${BASE_URL}/api/user/submit-address/${groupId}`, { address }, { headers: { Authorization: `Bearer ${token}` } });
  return res.data;
}

async function httpApproveWish(adminToken, wishId) {
  const res = await axios.post(`${BASE_URL}/api/admin/approve-wish/${wishId}`, {}, { headers: { Authorization: `Bearer ${adminToken}` } });
  return res.data;
}

async function httpApproveAddress(adminToken, groupId, userId) {
  const res = await axios.post(`${BASE_URL}/api/admin/approve-address/${groupId}/${userId}`, {}, { headers: { Authorization: `Bearer ${adminToken}` } });
  return res.data;
}

async function wait(ms) { return new Promise(r => setTimeout(r, ms)); }

async function main() {
  console.log('Starting pure-HTTP E2E test...');
  await mongoose.connect(process.env.MONGO_URI || 'mongodb://localhost:27017/secret_santa_test');

  const createdUserEmails = [];
  let createdGroupId = null;

  try {
    // 1) Admin login
    const adminLogin = await httpLogin(ADMIN_EMAIL, ADMIN_PW);
    const adminToken = adminLogin.token;
    console.log('Admin logged in.');

    // 2) Create owner (host) account
    const ownerEmail = `owner+http+${Date.now()}@example.com`;
    const ownerPass = 'testpass123';
    console.log('Registering owner', ownerEmail);
    const ownerReg = await httpRegister('Owner', ownerEmail, ownerPass);
    const ownerToken = ownerReg.token;
    createdUserEmails.push(ownerEmail);

    // 3) Create participants via HTTP register (we'll do 4 participants)
    const participantCount = 4;
    const participants = [];
    for (let i = 0; i < participantCount; i++) {
      const email = `p${i}+http+${Date.now()}@example.com`;
      const pass = 'testpass123';
      console.log('Registering participant', email);
      const reg = await httpRegister(`Participant${i}`, email, pass);
      participants.push({ email, token: reg.token, password: pass });
      createdUserEmails.push(email);
    }

    // 4) Owner creates group
    console.log('Owner creating group...');
    const { groupId, joinCode } = await httpCreateGroup(ownerToken, `http-test-group-${Date.now()}`);
    createdGroupId = groupId;
    console.log('Group created:', groupId, 'joinCode:', joinCode);

    // 5) Participants join group via HTTP join
    for (const p of participants) {
      console.log('Participant joining:', p.email);
      await httpJoinGroup(p.token, joinCode);
    }
    console.log('All participants joined the group via HTTP.');

    // small wait to ensure DB writes finish
    await wait(500);

    // 6) Admin performs shuffle (uses GroupMember — so participants included)
    console.log('Admin shuffling...');
    await httpShuffle(adminToken, groupId);
    console.log('Shuffle completed.');

    // 7) Each recipient sets a wish. We need to find mapping to know recipients.
    const mappings = await Mapping.find({ groupId }).lean();
    if (!mappings || mappings.length === 0) {
      throw new Error('No mappings found after shuffle');
    }
    console.log(`Mappings created: ${mappings.length}`);

    // For each mapping, recipient sets wish via HTTP
    for (const m of mappings) {
      const recipientUser = await User.findById(m.recipientId).lean();
      const participant = participants.find(p => p.email === recipientUser.email);
      if (!participant) {
        console.warn('Recipient not found among participant tokens, attempting login...');
        const login = await httpLogin(recipientUser.email, 'testpass123');
        participantToken = login.token;
      }
      const token = participant?.token || (await httpLogin(recipientUser.email, 'testpass123')).token;
      const wish = `A special wish for ${recipientUser.email}`;
      console.log('Setting wish for', recipientUser.email);
      await httpSetWish(token, groupId, wish);
    }
    console.log('All recipients submitted wishes (PENDING).');

    // 8) Admin approves all wishes
    console.log('Admin approving wishes...');
    const wishDocs = await RecipientWish.find({ groupId });
    for (const wd of wishDocs) {
      await httpApproveWish(adminToken, wd._id);
    }
    console.log('All wishes approved.');

    // 9) Recipients submit addresses (now allowed)
    console.log('Recipients submitting addresses...');
    for (const m of mappings) {
      const recipientUser = await User.findById(m.recipientId).lean();
      const participant = participants.find(p => p.email === recipientUser.email);
      const token = participant?.token || (await httpLogin(recipientUser.email, 'testpass123')).token;
      const address = `42 HTTP Lane for ${recipientUser.email}`;
      await httpSubmitAddress(token, groupId, address);
    }
    console.log('All recipients submitted addresses (PENDING).');

    // 10) Admin approves addresses — this triggers emails
    console.log('Admin approving addresses and triggering emails...');
    for (const m of mappings) {
      const recipientUserDoc = await User.findById(m.recipientId);
      await httpApproveAddress(adminToken, groupId, recipientUserDoc._id);
      await wait(200);
    }
    console.log('Addresses approved and emails triggered.');

    // 11) Final verification: each santa can fetch assignment via HTTP
    console.log('Verifying assignments for santas...');
    let ok = true;
    for (const m of mappings) {
      const santaUser = await User.findById(m.santaId).lean();
      // login santa
      const login = await httpLogin(santaUser.email, 'testpass123').catch(() => null);
      if (!login) {
        console.error('Could not login santa', santaUser.email);
        ok = false;
        continue;
      }
      try {
        const res = await axios.get(`${BASE_URL}/api/user/my-assignment/${groupId}`, { headers: { Authorization: `Bearer ${login.token}` } });
        if (!res.data || !res.data.wish || !res.data.address) {
          console.error('Santa cannot fetch assignment for', santaUser.email);
          ok = false;
        } else {
          console.log(`Santa ${santaUser.email} fetched assignment successfully.`);
        }
      } catch (e) {
        console.error('Error fetching assignment for', santaUser.email, e.response?.data || e.message);
        ok = false;
      }
    }

    if (ok) console.log('\nPURE-HTTP E2E FLOW PASSED ✅');
    else console.error('\nPURE-HTTP E2E FLOW FAILED ❌');

  } catch (err) {
    console.error('E2E HTTP test error:', err.response?.data || err.message || err);
  } finally {
    // cleanup created test users/groups/wishes/mappings (best-effort)
    try {
      console.log('Cleaning up test artifacts...');
      if (createdGroupId) {
        await Mapping.deleteMany({ groupId: createdGroupId });
        await Participation.deleteMany({ groupId: createdGroupId });
        await RecipientWish.deleteMany({ groupId: createdGroupId });
        await Group.deleteOne({ _id: createdGroupId });
      }
      for (const email of createdUserEmails) {
        await User.deleteOne({ email });
      }
    } catch (cleanupErr) {
      console.error('Cleanup error:', cleanupErr);
    }
    await mongoose.disconnect();
    console.log('E2E HTTP test finished.');
    process.exit(0);
  }
}

main();
