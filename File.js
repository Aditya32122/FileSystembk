// models/File.js — Mongoose schema for file metadata
const mongoose = require('mongoose');

const fileSchema = new mongoose.Schema({
  id: { type: String, required: true, index: true, unique: true },
  filename: { type: String, required: true },
  storage_path: { type: String, required: true },
  checksum: { type: String, required: true },
  created_at: { type: Date, default: Date.now }
});

exports.FilePrimary = mongoose.model('FilePrimary', fileSchema, 'files_primary');
exports.FileReplica = mongoose.model('FileReplica', fileSchema, 'files_replica');