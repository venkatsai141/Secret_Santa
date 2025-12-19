const mongoose = require('mongoose');

const ParticipationSchema = new mongoose.Schema(
  {
    eventId: {
      type: String,
      default: 'default'
    },
    groupId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Group',
      required: true
    },
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true
    },
    submitted: {
      type: Boolean,
      default: false
    },
    addressEncrypted: {
      type: String
    },
    // approval workflow for addresses
    addressStatus: {
      type: String,
      enum: ['NONE', 'PENDING', 'APPROVED', 'REJECTED'],
      default: 'NONE'
    },
    addressSubmittedAt: {
      type: Date
    },
    addressApprovedAt: {
      type: Date
    },
    addressApprovedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User' // admin id
    }
  },
  { timestamps: true }
);

module.exports = mongoose.model('Participation', ParticipationSchema);
