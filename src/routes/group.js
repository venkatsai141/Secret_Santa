const express = require('express');
const auth = require('../middleware/auth');
const Group = require('../models/Group');
const GroupMember = require('../models/GroupMember');
const Participation = require('../models/Participation');
const crypto = require('crypto');
const mongoose = require('mongoose');

const router = express.Router();

/* ---------------------------------------
   CREATE GROUP
   POST /api/group/create
---------------------------------------- */
router.post('/create', auth('USER'), async (req, res) => {
  try {
    const { name } = req.body;
    if (!name) {
      return res.status(400).json({ message: "Group name is required" });
    }

    // prevent duplicate group names per owner
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

    // owner is also a group member
    await GroupMember.create({
      groupId: group._id,
      userId: req.user.sub
    });

    // create Participation record for owner
    await Participation.findOneAndUpdate(
      { groupId: group._id, userId: req.user.sub },
      {
        eventId: 'default',
        groupId: group._id,
        userId: req.user.sub,
        submitted: false,
        addressStatus: 'NONE'
      },
      { upsert: true }
    );

    res.json({ groupId: group._id, joinCode });

  } catch (err) {
    console.error("[group.create] error:", err);
    res.status(500).json({ message: "Server error" });
  }
});

/* ---------------------------------------
   JOIN GROUP
   POST /api/group/join
---------------------------------------- */
router.post('/join', auth('USER'), async (req, res) => {
  try {
    const { joinCode } = req.body;
    if (!joinCode) {
      return res.status(400).json({ message: "joinCode is required" });
    }

    const group = await Group.findOne({ joinCode });
    if (!group) {
      return res.status(404).json({ message: "Group not found" });
    }

    // prevent duplicate membership
    const existingMember = await GroupMember.findOne({
      groupId: group._id,
      userId: req.user.sub
    });

    if (existingMember) {
      return res.status(409).json({ message: "User already in this group" });
    }

    await GroupMember.create({
      groupId: group._id,
      userId: req.user.sub
    });

    // create Participation record
    await Participation.findOneAndUpdate(
      { groupId: group._id, userId: req.user.sub },
      {
        eventId: 'default',
        groupId: group._id,
        userId: req.user.sub,
        submitted: false,
        addressStatus: 'NONE'
      },
      { upsert: true }
    );

    res.json({ message: "Joined group successfully" });

  } catch (err) {
    console.error("[group.join] error:", err);
    res.status(500).json({ message: "Server error" });
  }
});

module.exports = router;
