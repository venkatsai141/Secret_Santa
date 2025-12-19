const mongoose = require('mongoose');

const MappingSchema = new mongoose.Schema(
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
    santaId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true
    },
    recipientId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true
    }
  },
  { timestamps: true }
);

// 🔒 Ensure a Santa can only have ONE recipient per event per group
MappingSchema.index(
  { eventId: 1, groupId: 1, santaId: 1 },
  { unique: true }
);

module.exports = mongoose.model('Mapping', MappingSchema);
