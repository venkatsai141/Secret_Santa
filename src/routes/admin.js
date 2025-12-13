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
    const users = await User.find();
    const list = [];

    for (const u of users) {
      const p = await Participation.findOne({ userId: u._id });
      list.push({
        name: u.name,
        email: u.email,
        submitted: !!p?.submitted,
        addressStatus: p?.addressStatus || 'NONE'
      });
    }

    res.json({ participants: list });
  } catch (err) {
    console.error("participants error:", err);
    res.status(500).json({ message: "Failed to fetch participants" });
  }
});

/* ---------------------------------------
   2. ADMIN: SECRET SANTA SHUFFLE (GROUP BASED)
   Uses GroupMember (members who joined), so shuffle can be run just after join.
   POST /api/admin/shuffle/:groupId
   body: { eventId?: string }
---------------------------------------- */
/* ---------------------------------------
   2. ADMIN: SECRET SANTA SHUFFLE (GROUP BASED) - hardened + verbose error logs
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

    // Confirm the group actually exists
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
      // If duplicate-key or partial failure happens, log & continue: mappings may still be partially inserted
      console.error('Mapping insert error (non-fatal):', insertErr && insertErr.message ? insertErr.message : insertErr);
      if (debug) console.error(insertErr);
    }

    return res.json({ message: "Group shuffle completed", mappingsInserted: mappings.length });

  } catch (err) {
    // Always log detailed server-side stack
    console.error('Shuffle handler fatal error:', err && err.stack ? err.stack : err);

    // Return friendly message to client; show stack only in non-production to help debugging
    const payload = { message: "Shuffle failed", error: err.message || String(err) };
    if (process.env.NODE_ENV !== 'production') payload.stack = err.stack;
    return res.status(500).json(payload);
  }
});

/* ---------------------------------------
   3. ADMIN: GIFT STATUS (GROUP BASED)
   GET /api/admin/gift-status/:groupId
---------------------------------------- */
// near top, inside router file
// GET /api/admin/group-status/:groupId
router.get("/group-status/:groupId", auth('ADMIN'), async (req, res) => {
  const start = Date.now();
  const debug = process.env.NODE_ENV !== 'production';
  try {
    const groupIdParam = req.params?.groupId;
    console.info(`[admin.group-status] request start for groupId=${groupIdParam} by user=${req.user?.sub}`);

    if (!groupIdParam) {
      return res.status(400).json({ message: "Missing groupId param" });
    }
    if (!mongoose.Types.ObjectId.isValid(groupIdParam)) {
      return res.status(400).json({ message: "Invalid groupId param" });
    }

    const groupObjectId = new mongoose.Types.ObjectId(groupIdParam);

    // 1) mappings
    const mappingsRaw = await Mapping.find({ groupId: groupObjectId }).lean();

    // Collect user ids that need population (from mappings + wishes + participations)
    const userIdSet = new Set();
    mappingsRaw.forEach(m => {
      if (m.santaId) userIdSet.add(String(m.santaId));
      if (m.recipientId) userIdSet.add(String(m.recipientId));
    });

    // 2) wishes for this group
    // Ensure we query by ObjectId
    const wishesRaw = await RecipientWish.find({ groupId: groupObjectId }).lean();
    wishesRaw.forEach(w => {
      if (w.userId) userIdSet.add(String(w.userId));
    });

    // 3) participations (addresses / acknowledgement info)
    const participations = await Participation.find({ groupId: groupObjectId }).lean();
    participations.forEach(p => {
      if (p.userId) userIdSet.add(String(p.userId));
    });

    // Batch fetch all involved users
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

    // Normalize wishes: include userEmail, status, createdAt, _id
    const wishes = (wishesRaw || []).map(w => {
      const uid = String(w.userId || w.user || w.userId);
      return {
        _id: w._id,
        userId: w.userId || w.user || null,
        userEmail: w.userEmail || userById[uid]?.email || null,
        status: w.status || w.state || "PENDING",
        createdAt: w.createdAt || w.createdAt,
        updatedAt: w.updatedAt || w.updatedAt,
        // keep raw encrypted fields so admin doesn't see decrypted content
        wishEncrypted: w.wishEncrypted || null,
        note: w.note || null,
      };
    });

    // Normalize addresses from participations (email + status)
    const addresses = (participations || [])
      .filter(p => p.address || p.addressEncrypted || p.addressStatus)
      .map(p => {
        const uid = String(p.userId || p.user);
        return {
          userId: p.userId || p.user || null,
          userEmail: p.userEmail || p.email || userById[uid]?.email || null,
          address: p.address || null,
          addressEncrypted: p.addressEncrypted || null,
          status: p.addressStatus || p.addressState || "PENDING",
          createdAt: p.addressCreatedAt || p.updatedAt || p.createdAt || null,
        };
      });

    // Acknowledgements / gift sent statuses (from participation)
    const acknowledgements = (participations || [])
      .filter(p => p.acknowledgedAt || p.giftSentAt || p.ack)
      .map(p => ({
        userId: p.userId || p.user || p._id,
        userEmail: p.userEmail || p.email || (userById[String(p.userId)]?.email) || null,
        sentAt: p.giftSentAt || p.acknowledgedAt || (p.ack && p.ack.sentAt) || null,
      }));

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
    const requests = await RevealRequest.find().populate('userId');

    const result = requests.map(r => ({
      requestId: r._id,
      santaName: r.userId.name,
      santaEmail: r.userId.email,
      status: r.status,
      requestedAt: r.requestedAt,
      approvedAt: r.approvedAt
    }));

    res.json({ requests: result });

  } catch (err) {
    console.error("reveal-requests error:", err);
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

    request.status = "APPROVED";
    request.approvedAt = new Date();
    await request.save();

    res.json({ message: "Reveal request approved" });

  } catch (err) {
    console.error("approve-reveal error:", err);
    res.status(500).json({ message: "Reveal approval failed" });
  }
});

/* ---------------------------------------
   6. ADMIN: FETCH GROUPS - ADMIN GETS ALL GROUPS
   GET /api/admin/my-groups
---------------------------------------- */
router.get('/my-groups', auth('ADMIN'), async (req, res) => {
  try {
    // For admins, return all groups in the system
    const groups = await Group.find().select('name joinCode ownerId createdAt');
    res.json(groups);
  } catch (err) {
    console.error("admin my-groups error:", err);
    res.status(500).json({ message: "Failed to fetch admin groups" });
  }
});

/* ---------------------------------------
   7. ADMIN: APPROVE WISH (metadata only)
   POST /api/admin/approve-wish/:wishId
---------------------------------------- */
router.post('/approve-wish/:wishId', auth('ADMIN'), async (req, res) => {
  try {
    const { wishId } = req.params;
    if (!mongoose.Types.ObjectId.isValid(wishId)) {
      return res.status(400).json({ message: "Invalid wishId" });
    }

    const wish = await RecipientWish.findById(wishId);
    if (!wish) return res.status(404).json({ message: "Wish not found" });

    wish.status = 'APPROVED';
    wish.approvedAt = new Date();
    wish.approvedBy = req.user.sub;
    await wish.save();

    res.json({ message: "Wish approved" });
  } catch (err) {
    console.error("approve-wish error:", err);
    res.status(500).json({ message: "Wish approval failed" });
  }
});

/* ---------------------------------------
   8. ADMIN: APPROVE ADDRESS (metadata only) & send emails to santa(s)
   POST /api/admin/approve-address/:groupId/:userId
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

    // set approval metadata (admin cannot read content through this API)
    participation.addressStatus = 'APPROVED';
    participation.addressApprovedAt = new Date();
    participation.addressApprovedBy = req.user.sub;
    await participation.save();

    // Now send email(s) to santa(s) assigned to this recipient in this group
    const mappingDocs = await Mapping.find({ groupId: groupObjectId, recipientId: userObjectId }).populate('santaId');

    // Load wish to include in email (server decrypts for email)
    const wishDoc = await RecipientWish.findOne({ groupId: groupObjectId, userId: userObjectId });

    const wishEncrypted = wishDoc?.wishEncrypted;
    const addressEncrypted = participation.addressEncrypted;

    let decryptedWish = 'No wish found';
    let decryptedAddress = 'No address found';
    try {
      if (wishEncrypted) decryptedWish = decrypt(wishEncrypted);
      if (addressEncrypted) decryptedAddress = decrypt(addressEncrypted);
    } catch (e) {
      console.error('Decryption failed while preparing emails:', e);
    }

    // Send email to each santa assigned
    for (const m of mappingDocs) {
      const santa = m.santaId;
      if (!santa || !santa.email) continue;
      try {
        await sendSantaEmail(santa.email, decryptedWish, decryptedAddress);
      } catch (emailErr) {
        console.error(`Failed to send email to ${santa.email}:`, emailErr);
      }
    }

    res.json({ message: "Address approved and emails sent to assigned Santa(s) (content not exposed to admin)" });

  } catch (err) {
    console.error("approve-address error:", err);
    res.status(500).json({ message: "Address approval failed" });
  }
});


// GET /api/admin/group-status/:groupId
// Returns an object: { mappings, wishes, addresses, acknowledgements }
router.get("/group-status/:groupId", auth, async (req, res) => {
  try {
    if (!req.user || req.user.role !== "ADMIN") {
      return res.status(403).json({ message: "Forbidden" });
    }

    const groupId = req.params?.groupId;
    if (!groupId) {
      return res.status(400).json({ message: "Missing groupId param" });
    }

    // 1) mappings: who is santa for who
    // Assumes Mapping model has fields: groupId, santaId, recipientId
    const mappingsRaw = await Mapping.find({ groupId }).lean();

    // Normalize mappings for frontend convenience
    const mappings = await Promise.all(
      mappingsRaw.map(async (m) => {
        // attempt to resolve emails if stored as ObjectId refs
        let santaEmail = m.santaEmail || null;
        let recipientEmail = m.recipientEmail || null;

        // if fields are ids, populate
        try {
          if (!santaEmail && m.santaId) {
            const u = await User.findById(m.santaId).lean();
            santaEmail = u?.email || null;
          }
          if (!recipientEmail && m.recipientId) {
            const u2 = await User.findById(m.recipientId).lean();
            recipientEmail = u2?.email || null;
          }
        } catch (e) {
          // ignore population errors, still return IDs
        }

        return {
          _id: m._id,
          groupId: m.groupId,
          santaId: m.santaId,
          recipientId: m.recipientId,
          santaEmail,
          recipientEmail,
        };
      })
    );

    // 2) Recipient wishes (pending/approved etc.)
    // Assumes RecipientWish model has: groupId, userId (recipient), status, createdAt
    const wishes = await RecipientWish.find({ groupId }).lean();

    // 3) Addresses: try Participation (or a dedicated address model)
    // This tries Participation.first: (Participation likely stores address and status)
    const participations = await Participation.find({ groupId }).lean();
    // normalize addresses list from participation documents that have address
    const addresses = participations
      .filter((p) => p.address || p.addressEncrypted || p.addressStatus)
      .map((p) => ({
        userId: p.userId || p.user || p._user || p._id,
        userEmail: p.userEmail || p.email || null,
        address: p.address || null,
        status: p.addressStatus || p.addressState || "PENDING",
        createdAt: p.addressCreatedAt || p.updatedAt || p.createdAt || null,
      }));

    // 4) Acknowledgements / gift sent statuses
    // If you store acknowledgements in Participation (e.g. ackSent boolean/time), detect it.
    const acknowledgements = participations
      .filter((p) => p.acknowledgedAt || p.giftSentAt || p.ack)
      .map((p) => ({
        userId: p.userId || p.user || p._id,
        sentAt: p.giftSentAt || p.acknowledgedAt || p.ack?.sentAt || null,
      }));

    return res.json({ mappings, wishes, addresses, acknowledgements });
  } catch (err) {
    console.error("[admin.group-status] error:", err);
    return res.status(500).json({ message: "Failed to fetch group status", error: err.message });
  }
});


module.exports = router;
