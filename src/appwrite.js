const sdk = require("node-appwrite");
const { InputFile } = require("node-appwrite/file");
const { ID, Permission, Role } = require("node-appwrite");

// Mirrors karavan-office-backend's Appwrite usage so the URLs we return look
// identical to the ones the backend already stores for IAAI/invoice files.

function getStorage() {
  const client = new sdk.Client()
    .setEndpoint(process.env.APPWRITE_ENDPOINT)
    .setProject(process.env.APPWRITE_PROJECT_ID)
    .setKey(process.env.APPWRITE_API_TOKEN);
  return new sdk.Storage(client);
}

function getBucketId() {
  return (
    process.env.APPWRITE_STORAGE_BUCKET_ID ||
    process.env.APPWRITE_AUCTION_BUCKET_ID ||
    process.env.APPWRITE_INVOICE_BUCKET_ID
  );
}

function buildFileViewUrl(fileId) {
  // File view URLs must use the public endpoint so the frontend/backend can
  // fetch them directly (the API endpoint may differ, e.g. fra.cloud...).
  const publicEndpoint =
    process.env.APPWRITE_PUBLIC_URL || "https://cloud.appwrite.io/v1";
  const projectId = process.env.APPWRITE_PROJECT_ID;
  const bucketId = getBucketId();
  return `${publicEndpoint}/storage/buckets/${bucketId}/files/${fileId}/view?project=${projectId}`;
}

function mimeFor(filename) {
  const ext = (filename.split(".").pop() || "jpg").toLowerCase();
  if (ext === "png") return "image/png";
  if (ext === "webp") return "image/webp";
  return "image/jpeg";
}

/**
 * Upload an array of { filename, buffer } images to Appwrite storage with
 * public read access. Returns the public view URLs, in order. Failures on
 * individual files are logged and skipped rather than aborting the batch.
 */
async function uploadImages(images, lotNumber) {
  if (!images.length) return [];
  if (!process.env.APPWRITE_ENDPOINT || !process.env.APPWRITE_PROJECT_ID) {
    throw new Error("Appwrite is not configured (APPWRITE_* env vars missing)");
  }

  const storage = getStorage();
  const bucketId = getBucketId();
  const urls = [];

  for (let i = 0; i < images.length; i++) {
    const { filename, buffer } = images[i];
    const name = `copart-${lotNumber}-${String(i + 1).padStart(2, "0")}-${filename}`;
    try {
      const uploaded = await storage.createFile(
        bucketId,
        ID.unique(),
        InputFile.fromBuffer(buffer, name, mimeFor(filename)),
        [Permission.read(Role.any())],
      );
      urls.push(buildFileViewUrl(uploaded.$id));
    } catch (err) {
      console.error(`[appwrite] upload failed for ${name}: ${err.message}`);
    }
  }

  return urls;
}

module.exports = { uploadImages, buildFileViewUrl };
