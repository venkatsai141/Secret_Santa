const mongoose = require('mongoose');

const MappingSchema = new mongoose.Schema({
  eventId: { type: String, default: 'default' },
  groupId: { type: mongoose.Schema.Types.ObjectId, ref: 'Group' },
  santaId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  recipientId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true }
});

// Ensure a santa cannot have 2 mappings in the same event/group
MappingSchema.index({ eventId: 1, groupId: 1, santaId: 1 }, { unique: true });

module.exports = mongoose.model('Mapping', MappingSchema);
