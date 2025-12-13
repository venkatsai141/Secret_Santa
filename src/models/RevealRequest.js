const mongoose = require('mongoose');

const RevealRequestSchema = new mongoose.Schema({
  eventId: { type: String, default: "default" },
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }, // the santa
  status: { type: String, enum: ['PENDING', 'APPROVED'], default: 'PENDING' },
  requestedAt: { type: Date, default: Date.now },
  approvedAt: Date
});

module.exports = mongoose.model('RevealRequest', RevealRequestSchema);
