const mongoose = require('mongoose');

const RecipientWishSchema = new mongoose.Schema({
  eventId: { type: String, default: 'default' },
  groupId: { type: mongoose.Schema.Types.ObjectId, ref: 'Group' },
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },   // Recipient
  wishEncrypted: String,
  wishSetAt: Date,
  // NEW: approval workflow for wishes
  status: { type: String, enum: ['PENDING', 'APPROVED', 'REJECTED'], default: 'PENDING' },
  approvedAt: Date,
  approvedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' } // admin id (optional)
});

module.exports = mongoose.model('RecipientWish', RecipientWishSchema);
