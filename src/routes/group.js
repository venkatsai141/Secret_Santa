const express = require('express');
const auth = require('../middleware/auth');
const Group = require('../models/Group');
const GroupMember = require('../models/GroupMember');
const Participation = require('../models/Participation');
const crypto = require('crypto');
const mongoose = require('mongoose');

const router = express.Router();

/* ? CREATE GROUP (No overwrite if group exists) */
router.post('/create', auth('USER'), async (req, res) => {
  try {
    const { name } = req.body;

    // Check if a group with this name already exists for this owner
    const existingGroup = await Group.findOne({
      name,
      ownerId: req.user.sub
    });

    if (existingGroup) {
      return res.status(400).json({
        message: "A group with this name already exists"
      });
    }

    const joinCode = crypto.randomBytes(3).toString('hex');

    const group = await Group.create({
      name,
      ownerId: req.user.sub,
      joinCode
    });

    // create group member for owner
    await GroupMember.create({
      groupId: group._id,
      userId: req.user.sub
    });

    // also create a Participation record for the owner (submitted: false)
    await Participation.findOneAndUpdate(
      { groupId: group._id, userId: req.user.sub },
      { groupId: group._id, userId: req.user.sub, submitted: false, eventId: 'default' },
      { upsert: true }
    );

    res.json({ groupId: group._id, joinCode });

  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Server error", error: err.message });
  }
});

/* ? JOIN GROUP (prevent joining same group twice) */
router.post('/join', auth('USER'), async (req, res) => {
  try {
    const { joinCode } = req.body;
    if (!joinCode) return res.status(400).json({ message: "joinCode is required" });

    const group = await Group.findOne({ joinCode: joinCode });
    if (!group) return res.status(404).json({ message: "Group not found" });

    // Check if the user is already a member of this group
    const existingMember = await GroupMember.findOne({
      groupId: group._id,
      userId: req.user.sub
    });

    if (existingMember) {
      return res.status(409).json({ message: "User is already a member of this group" });
    }

    await GroupMember.create({
      groupId: group._id,
      userId: req.user.sub
    });

    // create Participation record (submitted false initially) so later user can submit address
    await Participation.findOneAndUpdate(
      { groupId: group._id, userId: req.user.sub },
      { groupId: group._id, userId: req.user.sub, submitted: false, eventId: 'default' },
      { upsert: true }
    );

    res.json({ message: "Joined group successfully" });
  } catch (err) {
    console.error("Join group error:", err);
    res.status(500).json({ message: "Server error", error: err.message });
  }
});

module.exports = router;
