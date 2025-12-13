const mongoose = require('mongoose');

const ParticipationSchema = new mongoose.Schema({
  eventId: { type: String, default: 'default' },
  groupId: { type: mongoose.Schema.Types.ObjectId, ref: 'Group' },
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  submitted: { type: Boolean, default: false },
  addressEncrypted: String,
  // NEW: approval workflow for addresses
  addressStatus: { type: String, enum: ['NONE', 'PENDING', 'APPROVED', 'REJECTED'], default: 'NONE' },
  addressSubmittedAt: Date,
  addressApprovedAt: Date,
  addressApprovedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' } // admin id
});

module.exports = mongoose.model('Participation', ParticipationSchema);
