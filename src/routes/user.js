// routes/user.js
const express = require('express');
const auth = require('../middleware/auth');
const Participation = require('../models/Participation');
const RecipientWish = require('../models/RecipientWish');
const Mapping = require('../models/Mapping');
const Acknowledgement = require('../models/Acknowledgement');
const mongoose = require('mongoose');
const { encrypt, decrypt } = require('../utils/cryptoUtil');

const router = express.Router();

/* ---------------------------------------
   USER: Set / Re-set wish
   (BLOCK if admin already APPROVED)
   POST /api/user/set-wish/:groupId
---------------------------------------- */
router.post('/set-wish/:groupId', auth('USER'), async (req, res) => {
  try {
    const { groupId } = req.params;
    if (!mongoose.Types.ObjectId.isValid(groupId)) {
      return res.status(400).json({ message: "Invalid groupId" });
    }

    const groupObjectId = new mongoose.Types.ObjectId(groupId);

    // user must be recipient in this group
    const mapping = await Mapping.findOne({
      groupId: groupObjectId,
      recipientId: req.user.sub
    });

    if (!mapping) {
      return res.status(403).json({ message: "You are not allowed to set a wish" });
    }

    // If an approved wish already exists, block edits
    const existingWish = await RecipientWish.findOne({ groupId: groupObjectId, userId: req.user.sub });
    if (existingWish && existingWish.status === 'APPROVED') {
      return res.status(403).json({ message: "Wish already approved by admin; you cannot modify it." });
    }

    const { wish } = req.body;
    if (!wish) {
      return res.status(400).json({ message: "wish is required" });
    }

    const wishEncrypted = encrypt(wish);

    // create/update (if present and not approved)
    await RecipientWish.findOneAndUpdate(
      { groupId: groupObjectId, userId: req.user.sub },
      {
        wishEncrypted,
        wishSetAt: new Date(),
        // keep PENDING so admin can approve
        status: 'PENDING',
        approvedAt: null,
        approvedBy: null
      },
      { upsert: true }
    );

    res.json({ message: "Wish submitted and awaiting admin approval" });

  } catch (err) {
    console.error("set-wish error:", err);
    res.status(500).json({ message: "Server error" });
  }
});

/* ---------------------------------------
   USER: Submit / Re-submit address
   (BLOCK if admin already APPROVED)
   POST /api/user/submit-address/:groupId
---------------------------------------- */
router.post('/submit-address/:groupId', auth('USER'), async (req, res) => {
  try {
    const { groupId } = req.params;
    if (!mongoose.Types.ObjectId.isValid(groupId)) {
      return res.status(400).json({ message: 'Invalid groupId' });
    }
    const groupObjectId = new mongoose.Types.ObjectId(groupId);

    // Ensure user is participant in the group
    const participationCheck = await Participation.findOne({ groupId: groupObjectId, userId: req.user.sub });
    if (!participationCheck) {
      return res.status(403).json({ message: 'You are not a participant in this group' });
    }

    // Ensure user's wish is APPROVED before submitting address
    const wishDoc = await RecipientWish.findOne({ groupId: groupObjectId, userId: req.user.sub });
    if (!wishDoc || wishDoc.status !== 'APPROVED') {
      return res.status(403).json({ message: 'Wish must be approved by admin before submitting address' });
    }

    // If address has already been approved by admin, block re-submission
    const existingParticipation = await Participation.findOne({ groupId: groupObjectId, userId: req.user.sub });
    if (existingParticipation && existingParticipation.addressStatus === 'APPROVED') {
      return res.status(403).json({ message: "Address already approved by admin; you cannot modify it." });
    }

    const { address } = req.body;
    if (!address) return res.status(400).json({ message: 'address is required' });

    const addressEncrypted = encrypt(address);

    // create/update participation (only allowed when not already approved)
    await Participation.findOneAndUpdate(
      { groupId: groupObjectId, userId: req.user.sub },
      {
        submitted: true,
        addressEncrypted,
        addressSubmittedAt: new Date(),
        // keep PENDING for admin approval
        addressStatus: 'PENDING',
        addressApprovedAt: null,
        addressApprovedBy: null
      },
      { upsert: true }
    );

    res.json({ message: "Address submitted and awaiting admin approval" });
  } catch (err) {
    console.error("submit-address error:", err);
    res.status(500).json({ message: 'Server error' });
  }
});

/* ---------------------------------------
   USER: Get assignment by group
   GET /api/user/my-assignment/:groupId
---------------------------------------- */
router.get('/my-assignment/:groupId', auth('USER'), async (req, res) => {
  try {
    const { groupId } = req.params;

    if (!mongoose.Types.ObjectId.isValid(groupId)) {
      return res.status(400).json({ message: "Invalid groupId" });
    }

    const groupObjectId = new mongoose.Types.ObjectId(groupId);

    // Check if THIS user is a Santa in this group
    const mapping = await Mapping.findOne({
      groupId: groupObjectId,
      santaId: req.user.sub
    });

    if (!mapping) {
      return res.status(404).json({ message: "You are not assigned as Santa in this group" });
    }

    const wishDoc = await RecipientWish.findOne({
      groupId: groupObjectId,
      userId: mapping.recipientId
    });

    if (!wishDoc || wishDoc.status !== 'APPROVED') {
      return res.status(404).json({ message: "Recipient has not set an approved wish yet" });
    }

    const participation = await Participation.findOne({
      groupId: groupObjectId,
      userId: mapping.recipientId
    });

    if (!participation || participation.addressStatus !== 'APPROVED') {
      return res.status(404).json({ message: "Recipient's address is not approved yet" });
    }

    const wish = decrypt(wishDoc.wishEncrypted);
    const address = decrypt(participation.addressEncrypted);

    res.json({
      wish,
      address,
      recipientNameHidden: true
    });

  } catch (err) {
    console.error("my-assignment (group) error:", err);
    res.status(500).json({ message: "Server error" });
  }
});

/* ---------------------------------------
   USER: Acknowledge (mark sent) - unchanged
   POST /api/user/acknowledge/:groupId
---------------------------------------- */
router.post('/acknowledge/:groupId', auth('USER'), async (req, res) => {
  try {
    const { groupId } = req.params;

    if (!mongoose.Types.ObjectId.isValid(groupId)) {
      return res.status(400).json({ message: "Invalid groupId" });
    }

    const groupObjectId = new mongoose.Types.ObjectId(groupId);

    // Check if THIS user is a Santa in this group
    const mapping = await Mapping.findOne({
      groupId: groupObjectId,
      santaId: req.user.sub
    });

    if (!mapping) {
      return res.status(403).json({ message: "You are not a Santa in this group" });
    }

    // Prevent double acknowledgement
    const AcknowledgementModel = require('../models/Acknowledgement');
    const existingAck = await AcknowledgementModel.findOne({
      groupId: groupObjectId,
      santaId: req.user.sub,
      recipientId: mapping.recipientId
    });

    if (existingAck) {
      return res.status(400).json({ message: "Gift already acknowledged" });
    }

    await AcknowledgementModel.create({
      groupId: groupObjectId,
      santaId: req.user.sub,
      recipientId: mapping.recipientId,
      sent: true,
      sentAt: new Date()
    });

    res.json({ message: "Gift marked as sent" });

  } catch (err) {
    console.error("acknowledge error:", err);
    res.status(500).json({ message: "Server error" });
  }
});

/* ---------------------------------------
   USER: Fetch all groups of logged-in user
   GET /api/user/my-groups
---------------------------------------- */
router.get('/my-groups', auth('USER'), async (req, res) => {
  try {
    const userId = new mongoose.Types.ObjectId(req.user.sub);

    // Find all group participations
    const participations = await Participation.find({ userId });

    const groupIds = participations.map(p => p.groupId);

    const Group = require('../models/Group');

    const groups = await Group.find({ _id: { $in: groupIds } }).select('name joinCode');

    res.json(groups);

  } catch (err) {
    console.error("my-groups error:", err);
    res.status(500).json({ message: "Failed to fetch user groups" });
  }
});

module.exports = router;
