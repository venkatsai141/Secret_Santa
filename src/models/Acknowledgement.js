const mongoose = require('mongoose');

const acknowledgementSchema = new mongoose.Schema(
  {
    groupId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Group',
      required: true
    },
    santaId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true
    },
    recipientId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true
    },
    sent: {
      type: Boolean,
      default: true
    },
    sentAt: {
      type: Date,
      default: Date.now
    }
  },
  { timestamps: true }
);

/**
 * 🔒 Enforce ONE acknowledgement per santa-recipient-group
 * Even if API is called twice, MongoDB will block it
 */
acknowledgementSchema.index(
  { groupId: 1, santaId: 1, recipientId: 1 },
  { unique: true }
);

module.exports = mongoose.model('Acknowledgement', acknowledgementSchema);
