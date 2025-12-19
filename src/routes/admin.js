// routes/admin.js
const express = require('express');
const mongoose = require('mongoose');
const auth = require('../middleware/auth');

const Participation = require('../models/Participation');
const User = require('../models/User');
const Mapping = require('../models/Mapping');
const Group = require('../models/Group');
const GroupMember = require('../models/GroupMember');
const Acknowledgement = require('../models/Acknowledgement');
const RevealRequest = require('../models/RevealRequest');
const RecipientWish = require('../models/RecipientWish');

const { sendSantaEmail } = require('../utils/email');
const { decrypt } = require('../utils/cryptoUtil');

const router = express.Router();

/* ---------------------------------------
   1. ADMIN: VIEW PARTICIPANTS
   GET /api/admin/participants
---------------------------------------- */
router.get('/participants', auth('ADMIN'), async (req, res) => {
  try {
    const users = await User.find().lean();
    const list = [];

    for (const u of users) {
      const p = await Participation.findOne({ userId: u._id }).lean();
      list.push({
        _id: u._id,
        name: u.name,
        email: u.email,
        submitted: !!p?.submitted,
        addressStatus: p?.addressStatus || 'NONE'
      });
    }

    res.json({ participants: list });
  } catch (err) {
    console.error("[admin.participants] error:", err);
    res.status(500).json({ message: "Failed to fetch participants" });
  }
});

/* ---------------------------------------
   2. ADMIN: SECRET SANTA SHUFFLE (GROUP BASED)
   POST /api/admin/shuffle/:groupId
   body: { eventId?: string }
---------------------------------------- */
router.post('/shuffle/:groupId', auth('ADMIN'), async (req, res) => {
  const debug = process.env.NODE_ENV !== 'production';
  try {
    const { groupId } = req.params;
    const eventId = req.body.eventId || 'default';

    if (!groupId) {
      return res.status(400).json({ message: "Missing groupId" });
    }
    if (!mongoose.Types.ObjectId.isValid(groupId)) {
      return res.status(400).json({ message: "Invalid groupId" });
    }

    const groupObjectId = new mongoose.Types.ObjectId(groupId);
    const groupExists = await Group.exists({ _id: groupObjectId });
    if (!groupExists) {
      return res.status(404).json({ message: "Group not found" });
    }

    // Fetch members who joined
    const members = await GroupMember.find({ groupId: groupObjectId }).lean();
    if (!members || members.length < 2) {
      return res.status(400).json({ message: "At least 2 group members required to shuffle", memberCount: members?.length || 0 });
    }

    const userIds = members.map(m => String(m.userId));

    // Derangement generator (no self assignment)
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
      for (let i = 0; i < n; i++) if (perm[i] === i) fixed.push(i);

      if (fixed.length === 1) {
        const i = fixed[0], swapWith = (i === 0) ? 1 : 0;
        [perm[i], perm[swapWith]] = [perm[swapWith], perm[i]];
      } else if (fixed.length > 1) {
        const vals = fixed.map(idx => perm[idx]);
        for (let k = 0; k < fixed.length; k++) perm[fixed[k]] = vals[(k + 1) % fixed.length];
      }

      return perm.map(idx => arr[idx]);
    }

    const recipients = generateDerangement(userIds);

    const mappings = userIds.map((santaId, index) => ({
      eventId,
      groupId: groupObjectId,
      santaId: new mongoose.Types.ObjectId(santaId),
      recipientId: new mongoose.Types.ObjectId(recipients[index])
    }));

    // remove existing mappings for this group+event
    await Mapping.deleteMany({ groupId: groupObjectId, eventId });

    // InsertMany with ordered:false so a single duplicate won't abort the entire batch
    try {
      await Mapping.insertMany(mappings, { ordered: false });
    } catch (insertErr) {
      // If duplicate-key or partial failure happens, log & continue
      console.error('[admin.shuffle] Mapping insert error (non-fatal):', insertErr && insertErr.message ? insertErr.message : insertErr);
      if (debug) console.error(insertErr);
    }

    return res.json({ message: "Group shuffle completed", mappingsInserted: mappings.length });

  } catch (err) {
    console.error('[admin.shuffle] fatal error:', err && err.stack ? err.stack : err);
    const payload = { message: "Shuffle failed", error: err.message || String(err) };
    if (process.env.NODE_ENV !== 'production') payload.stack = err.stack;
    return res.status(500).json(payload);
  }
});

/* ---------------------------------------
   3. ADMIN: GROUP STATUS (mappings, wishes, addresses, acknowledgements)
   GET /api/admin/group-status/:groupId
---------------------------------------- */
router.get("/group-status/:groupId", auth('ADMIN'), async (req, res) => {
  const start = Date.now();
  try {
    const groupIdParam = req.params?.groupId;
    if (!groupIdParam) {
      return res.status(400).json({ message: "Missing groupId param" });
    }
    if (!mongoose.Types.ObjectId.isValid(groupIdParam)) {
      return res.status(400).json({ message: "Invalid groupId param" });
    }

    const groupObjectId = new mongoose.Types.ObjectId(groupIdParam);

    // 1) mappings
    const mappingsRaw = await Mapping.find({ groupId: groupObjectId }).lean();

    // Collect user ids for population
    const userIdSet = new Set();
    mappingsRaw.forEach(m => {
      if (m.santaId) userIdSet.add(String(m.santaId));
      if (m.recipientId) userIdSet.add(String(m.recipientId));
    });

    // 2) wishes
    const wishesRaw = await RecipientWish.find({ groupId: groupObjectId }).lean();
    wishesRaw.forEach(w => { if (w.userId) userIdSet.add(String(w.userId)); });

    // 3) participations (addresses / acknowledgement info)
    const participations = await Participation.find({ groupId: groupObjectId }).lean();
    participations.forEach(p => { if (p.userId) userIdSet.add(String(p.userId)); });

    // Batch fetch users
    const userIds = Array.from(userIdSet).map(id => new mongoose.Types.ObjectId(id));
    const users = userIds.length > 0 ? await User.find({ _id: { $in: userIds } }).lean() : [];
    const userById = users.reduce((acc, u) => { acc[String(u._id)] = u; return acc; }, {});

    // Normalize mappings (attach emails if possible)
    const mappings = (mappingsRaw || []).map(m => {
      const sId = String(m.santaId);
      const rId = String(m.recipientId);
      return {
        _id: m._id,
        groupId: m.groupId,
        santaId: m.santaId,
        recipientId: m.recipientId,
        santaEmail: m.santaEmail || userById[sId]?.email || null,
        recipientEmail: m.recipientEmail || userById[rId]?.email || null,
        eventId: m.eventId || null,
      };
    });

    // Normalize wishes
    const wishes = (wishesRaw || []).map(w => {
      const uid = String(w.userId || w.user || w.userId);
      return {
        _id: w._id,
        userId: w.userId || w.user || null,
        userEmail: w.userEmail || userById[uid]?.email || null,
        status: w.status || "PENDING",
        wishEncrypted: w.wishEncrypted || null,
        wishSetAt: w.wishSetAt || null,
        approvedAt: w.approvedAt || null,
        approvedBy: w.approvedBy || null
      };
    });

    // Normalize addresses from participations
    const addresses = (participations || [])
      .filter(p => p.addressEncrypted || p.addressStatus)
      .map(p => {
        const uid = String(p.userId || p.user || p._id);
        return {
          userId: p.userId || p.user || p._id,
          userEmail: p.userEmail || p.email || userById[uid]?.email || null,
          addressEncrypted: p.addressEncrypted || null,
          status: p.addressStatus || "PENDING",
          addressSubmittedAt: p.addressSubmittedAt || null,
          addressApprovedAt: p.addressApprovedAt || null,
          addressApprovedBy: p.addressApprovedBy || null
        };
      });

    // Acknowledgements (from Acknowledgement collection)
    const ackDocs = await Acknowledgement.find({ groupId: groupObjectId }).lean();
    const acksFromParticipation = (participations || [])
      .filter(p => p.acknowledgedAt || p.giftSentAt || p.ack)
      .map(p => ({
        userId: p.userId || p.user || p._id,
        userEmail: p.userEmail || p.email || (userById[String(p.userId)]?.email) || null,
        sentAt: p.giftSentAt || p.acknowledgedAt || (p.ack && p.ack.sentAt) || null,
      }));

    const acknowledgements = (ackDocs || []).map(a => ({
      userId: a.santaId || a.userId,
      recipientId: a.recipientId || null,
      userEmail: userById[String(a.santaId)]?.email || null,
      sentAt: a.sentAt || null
    })).concat(acksFromParticipation);

    console.info(`[admin.group-status] found mappings=${mappings.length} wishes=${wishes.length} addresses=${addresses.length} acks=${acknowledgements.length}; completed in ${Date.now() - start}ms`);

    return res.json({ mappings, wishes, addresses, acknowledgements });
  } catch (err) {
    console.error("[admin.group-status] error:", err && err.stack ? err.stack : err);
    return res.status(500).json({ message: "Failed to fetch group status", error: err?.message || String(err) });
  }
});

/* ---------------------------------------
   4. ADMIN: VIEW REVEAL REQUESTS
   GET /api/admin/reveal-requests
---------------------------------------- */
router.get('/reveal-requests', auth('ADMIN'), async (req, res) => {
  try {
    const requests = await RevealRequest.find().populate('userId').lean();

    const result = requests.map(r => ({
      requestId: r._id,
      santaId: r.userId?._id || null,
      santaName: r.userId?.name || null,
      santaEmail: r.userId?.email || null,
      status: r.status,
      requestedAt: r.requestedAt,
      approvedAt: r.approvedAt
    }));

    res.json({ requests: result });

  } catch (err) {
    console.error("[admin.reveal-requests] error:", err);
    res.status(500).json({ message: "Failed to fetch reveal requests" });
  }
});

/* ---------------------------------------
   5. ADMIN: APPROVE REVEAL
   POST /api/admin/approve-reveal/:requestId
---------------------------------------- */
router.post('/approve-reveal/:requestId', auth('ADMIN'), async (req, res) => {
  try {
    const { requestId } = req.params;

    if (!mongoose.Types.ObjectId.isValid(requestId)) {
      return res.status(400).json({ message: "Invalid requestId" });
    }

    const request = await RevealRequest.findById(requestId);
    if (!request) {
      return res.status(404).json({ message: "Reveal request not found" });
    }

    if (request.status === 'APPROVED') {
      return res.status(400).json({ message: "Reveal request already approved" });
    }

    request.status = "APPROVED";
    request.approvedAt = new Date();
    await request.save();

    res.json({ message: "Reveal request approved" });

  } catch (err) {
    console.error("[admin.approve-reveal] error:", err);
    res.status(500).json({ message: "Reveal approval failed" });
  }
});

/* ---------------------------------------
   6. ADMIN: FETCH GROUPS - ADMIN GETS ALL GROUPS
   GET /api/admin/my-groups
---------------------------------------- */
router.get('/my-groups', auth('ADMIN'), async (req, res) => {
  try {
    const groups = await Group.find().select('name joinCode ownerId createdAt').lean();
    res.json(groups);
  } catch (err) {
    console.error("[admin.my-groups] error:", err);
    res.status(500).json({ message: "Failed to fetch admin groups" });
  }
});

/* ---------------------------------------
   7. ADMIN: APPROVE WISH
---------------------------------------- */
router.post('/approve-wish/:wishId', auth('ADMIN'), async (req, res) => {
  try {
    const { wishId } = req.params;
    if (!mongoose.Types.ObjectId.isValid(wishId)) {
      return res.status(400).json({ message: "Invalid wishId" });
    }

    const wish = await RecipientWish.findById(wishId);
    if (!wish) return res.status(404).json({ message: "Wish not found" });

    // Prevent double approval
    if (wish.status === 'APPROVED') {
      return res.status(400).json({ message: "Wish already approved" });
    }

    wish.status = 'APPROVED';
    wish.approvedAt = new Date();
    wish.approvedBy = req.user.sub;
    await wish.save();

    res.json({ message: "Wish approved" });
  } catch (err) {
    console.error("[admin.approve-wish] error:", err);
    res.status(500).json({ message: "Wish approval failed" });
  }
});

/* ---------------------------------------
   8. ADMIN: APPROVE ADDRESS & SEND EMAILS
---------------------------------------- */
router.post('/approve-address/:groupId/:userId', auth('ADMIN'), async (req, res) => {
  try {
    const { groupId, userId } = req.params;

    if (!mongoose.Types.ObjectId.isValid(groupId) || !mongoose.Types.ObjectId.isValid(userId)) {
      return res.status(400).json({ message: "Invalid groupId or userId" });
    }

    const groupObjectId = new mongoose.Types.ObjectId(groupId);
    const userObjectId = new mongoose.Types.ObjectId(userId);

    // find participation
    const participation = await Participation.findOne({ groupId: groupObjectId, userId: userObjectId });
    if (!participation || !participation.addressEncrypted) {
      return res.status(404).json({ message: "Address not found for this participant" });
    }

    // Prevent double approval
    if (participation.addressStatus === 'APPROVED') {
      return res.status(400).json({ message: "Address already approved" });
    }

    participation.addressStatus = 'APPROVED';
    participation.addressApprovedAt = new Date();
    participation.addressApprovedBy = req.user.sub;
    await participation.save();

    // send emails to assigned santas
    const mappingDocs = await Mapping.find({ groupId: groupObjectId, recipientId: userObjectId }).populate('santaId');

    const wishDoc = await RecipientWish.findOne({ groupId: groupObjectId, userId: userObjectId });

    const wishEncrypted = wishDoc?.wishEncrypted;
    const addressEncrypted = participation.addressEncrypted;

    let decryptedWish = 'No wish found';
    let decryptedAddress = 'No address found';
    try {
      if (wishEncrypted) decryptedWish = decrypt(wishEncrypted);
      if (addressEncrypted) decryptedAddress = decrypt(addressEncrypted);
    } catch (e) {
      console.error('[admin.approve-address] Decryption failed while preparing emails:', e);
    }

    for (const m of mappingDocs) {
      const santa = m.santaId;
      if (!santa || !santa.email) continue;
      try {
        await sendSantaEmail(santa.email, decryptedWish, decryptedAddress);
      } catch (emailErr) {
        console.error(`[admin.approve-address] Failed to send email to ${santa.email}:`, emailErr);
      }
    }

    res.json({ message: "Address approved and emails sent to assigned Santa(s) (content not exposed to admin)" });

  } catch (err) {
    console.error("[admin.approve-address] error:", err);
    res.status(500).json({ message: "Address approval failed" });
  }
});

module.exports = router;
