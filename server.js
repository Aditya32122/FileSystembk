// Main Server
const express = require("express");
const multer = require("multer");

const AWS = require("aws-sdk");

const crypto = require("crypto");
const axios = require("axios");
const connectDB = require("./db");
const { FilePrimary } = require("./File");
require("dotenv").config();
const cors = require("cors");
const FormData = require("form-data");
const { Storage } = require("@google-cloud/storage");

const PORT = process.env.PORT || 3000;
const KEY_HEX = process.env.SECRET_KEY_HEX;
const basicauth = process.env.MFT_BASIC_AUTH; // Base64 encoded 'username:password'

if (!KEY_HEX || KEY_HEX.length !== 64) {
  console.error("SECRET_KEY_HEX is missing or invalid");
  process.exit(1);
}

const KEY = Buffer.from(KEY_HEX, "hex");

AWS.config.update({
  region: 'ap-south-1', // replace with your region
  accessKeyId: process.env.AWS_ACCESS_KEY_ID,   // you can set these as environment variables
  secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY
});


// Create an S3 service object
const s3 = new AWS.S3();



const upload = multer({ storage: multer.memoryStorage() });
const app = express();
app.use(express.json());
app.use(cors());

// ---------- ENCRYPT / DECRYPT HELPERS ----------
function encryptBuffer(plain) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", KEY, iv);
  const ciphertext = Buffer.concat([cipher.update(plain), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, ciphertext, tag]);
}

function decryptBuffer(enc) {
  const iv = enc.slice(0, 12);
  const tag = enc.slice(enc.length - 16);
  const ciphertext = enc.slice(12, enc.length - 16);
  const decipher = crypto.createDecipheriv("aes-256-gcm", KEY, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

function sha256Hex(buf) {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

// ---------- UPLOAD TO webMethods ----------
async function uploadToExternal(filename, buffer) {
  console.log("Sending encrypted file to webMethods MFT (fire & forget)...");

  const form = new FormData();
  form.append("file", buffer, { filename });

  // DO NOT await. DO NOT let errors stop flow.
  axios.post(
    "https://superipaashandsonlab.mft-aw-de.webmethods.io:8443/fl_student001/",
    form,
    {
      headers: {
        ...form.getHeaders(),
        "Authorization": `Basic ${basicauth}`,
      },
      timeout: 10000,            // prevent hang
      validateStatus: () => true, // accept any status
    }
  ).catch(err => {
    console.warn("MFT upload error ignored:", err.message);
  });

  // Immediately return without waiting
  return true;
}



// ---------- DOWNLOAD FROM GCP ----------
// async function downloadFromExternal(filename) {
//   const storage = new Storage();
//   const bucket = storage.bucket("file-storage-server");
//   const file = bucket.file(filename);

//   const [exists] = await file.exists();
//   if (!exists) throw new Error("File not found in GCP bucket");

//   const [data] = await file.download();
//   return Buffer.from(data);
// }


// Function to download the file from AWS S3 bucket
async function downloadFromExternal(filename) {
  const params = {
    Bucket: "file-store-vq", // replace with your S3 bucket name
    Key: filename,  // The S3 file key (storage path)
  };

  try {
    // Get the file from S3
    const data = await s3.getObject(params).promise();

    // Return the file data as a Buffer
    return Buffer.from(data.Body);
  } catch (err) {
    console.error("Error fetching file from S3:", err);
    throw new Error("File not found in S3 bucket");
  }
}

// Function to download file from backup bucket
async function downloadFromBackupBucket(filename) {
  const params = {
    Bucket: "file-store-wm-2",
    Key: filename,
  };

  try {
    const data = await s3.getObject(params).promise();
    return Buffer.from(data.Body);
  } catch (err) {
    console.error("Error fetching file from backup S3 bucket:", err);
    throw new Error("File not found in backup S3 bucket");
  }
}

// DOWNLOAD FROM BACKUP BUCKET
app.get("/files-backup/:id", async (req, res) => {
  const id = req.params.id;

  console.log(`[GET /files-backup/${id}]`);

  const meta = await FilePrimary.findOne({ id });
  if (!meta) return res.status(404).json({ error: "not found" });

  try {
    const encrypted = await downloadFromBackupBucket(meta.storage_path);
    const now = sha256Hex(encrypted);

    if (now !== meta.checksum) {
      return res.status(500).json({ error: "Checksum mismatch" });
    }

    const plain = decryptBuffer(encrypted);
    res.setHeader("Content-Disposition", `attachment; filename="${meta.filename}"`);
    return res.send(plain);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "read error" });
  }
});



// ---------- ROUTES ----------

app.get("/", (req, res) => {
  res.json({ status: "ok" });
});

// UPLOAD (no replica)
app.post("/upload", upload.single("file"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "file required" });

    const id = crypto.randomUUID();
    const origName = req.file.originalname;

    console.log(`[UPLOAD] Encrypting file '${origName}'...`);
    const encrypted = encryptBuffer(req.file.buffer);
    const checksum = sha256Hex(encrypted);

    const filename = `${id}.enc`;

    console.log(`[UPLOAD] Uploading encrypted file to webMethods...`);
    await uploadToExternal(filename, encrypted);

    console.log("[UPLOAD] Saving metadata...");
    await FilePrimary.create({
      id,
      filename: origName,
      storage_path: filename,
      checksum,
    });

    return res.json({ id, filename: origName });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "upload failed" });
  }
});

// DOWNLOAD
app.get("/files/:id", async (req, res) => {
  const id = req.params.id;

  console.log(`[GET /files/${id}]`);

  const meta = await FilePrimary.findOne({ id });
  if (!meta) return res.status(404).json({ error: "not found" });

  try {
    const encrypted = await downloadFromExternal(meta.storage_path);
    const now = sha256Hex(encrypted);

    if (now !== meta.checksum) {
      return res.status(500).json({ error: "Checksum mismatch" });
    }

    const plain = decryptBuffer(encrypted);
    res.setHeader("Content-Disposition", `attachment; filename="${meta.filename}"`);
    return res.send(plain);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "read error" });
  }
});

// LIST
app.get("/list", async (req, res) => {
  const rows = await FilePrimary.find({}, "id filename created_at -_id")
    .sort({ created_at: -1 })
    .lean();

  res.json(rows);
});

// DELETE
app.delete("/files/:id", async (req, res) => {
  const id = req.params.id;

  console.log(`[DELETE /files/${id}]`);

  const meta = await FilePrimary.findOne({ id });
  if (!meta) return res.status(404).json({ error: "File not found" });

  await FilePrimary.deleteOne({ id });

  return res.json({ message: "File deleted successfully" });
});



connectDB().then(() => {
  app.listen(PORT, () => console.log(`Main server running on port ${PORT}`));
});
