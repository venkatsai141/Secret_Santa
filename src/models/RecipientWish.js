const mongoose = require('mongoose');

const RecipientWishSchema = new mongoose.Schema(
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
      required: true   // recipient
    },
    wishEncrypted: {
      type: String
    },
    wishSetAt: {
      type: Date
    },
    // approval workflow
    status: {
      type: String,
      enum: ['PENDING', 'APPROVED', 'REJECTED'],
      default: 'PENDING'
    },
    approvedAt: {
      type: Date
    },
    approvedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User' // admin id
    }
  },
  { timestamps: true }
);

module.exports = mongoose.model('RecipientWish', RecipientWishSchema);
