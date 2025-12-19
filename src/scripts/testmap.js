// scripts/showMappings.js
require('dotenv').config();
const mongoose = require('mongoose');
const fs = require('fs');
const Mapping = require('../models/Mapping');
const User = require('../models/User');

async function main() {
  const args = process.argv.slice(2);
  if (args.length < 1) {
    console.error('Usage: node scripts/showMappings.js <GROUP_ID> [output.csv]');
    process.exit(1);
  }
  const groupId = args[0];
  const outFile = args[1]; // optional csv filename

  if (!mongoose.Types.ObjectId.isValid(groupId)) {
    console.error('Invalid GROUP_ID');
    process.exit(1);
  }

  if (!process.env.MONGO_URI) {
    console.error('Please set MONGO_URI in .env');
    process.exit(1);
  }

  await mongoose.connect(process.env.MONGO_URI, {});

  try {
    const mappingsRaw = await Mapping.find({ groupId }).lean();

    // collect user ids
    const userIds = new Set();
    mappingsRaw.forEach(m => {
      if (m.santaId) userIds.add(String(m.santaId));
      if (m.recipientId) userIds.add(String(m.recipientId));
    });

    const userIdList = Array.from(userIds).map(id => new mongoose.Types.ObjectId(id));
    const users = userIdList.length > 0 ? await User.find({ _id: { $in: userIdList } }).lean() : [];
    const userById = users.reduce((acc, u) => { acc[String(u._id)] = u; return acc; }, {});

    const enriched = (mappingsRaw || []).map(m => {
      const sId = String(m.santaId);
      const rId = String(m.recipientId);
      return {
        mappingId: m._id,
        eventId: m.eventId || 'default',
        groupId: m.groupId,
        santaId: m.santaId,
        santaEmail: userById[sId]?.email || m.santaEmail || null,
        recipientId: m.recipientId,
        recipientEmail: userById[rId]?.email || m.recipientEmail || null,
        createdAt: m.createdAt || null,
        updatedAt: m.updatedAt || null
      };
    });

    // Print JSON to stdout
    console.log(JSON.stringify(enriched, null, 2));

    // Optionally write CSV
    if (outFile && outFile.endsWith('.csv')) {
      const escapeCsv = (v) => {
        if (v === null || v === undefined) return '';
        const s = String(v);
        if (s.includes('"') || s.includes(',') || s.includes('\n') || s.includes('\r')) {
          return `"${s.replace(/"/g, '""')}"`;
        }
        return s;
      };

      const rows = [];
      rows.push(['mappingId','eventId','groupId','santaId','santaEmail','recipientId','recipientEmail','createdAt','updatedAt'].join(','));

      for (const m of enriched) {
        const row = [
          escapeCsv(m.mappingId),
          escapeCsv(m.eventId),
          escapeCsv(m.groupId),
          escapeCsv(m.santaId),
          escapeCsv(m.santaEmail),
          escapeCsv(m.recipientId),
          escapeCsv(m.recipientEmail),
          escapeCsv(m.createdAt || ''),
          escapeCsv(m.updatedAt || '')
        ].join(',');
        rows.push(row);
      }

      fs.writeFileSync(outFile, rows.join('\n'), 'utf8');
      console.log(`CSV written to ${outFile}`);
    }

  } catch (err) {
    console.error('Error fetching mappings:', err);
  } finally {
    await mongoose.disconnect();
    process.exit(0);
  }
}

main();
