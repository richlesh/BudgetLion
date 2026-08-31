// License key validation, adapted from the NeuroPanther Chat pattern.
// A key is the first 16 hex chars (uppercased) of HMAC-SHA256(salt, email).
const nodeCrypto = require("crypto");
const { LICENSE_SALT } = require("./license.cjs");

function expectedLicenseKey(userName) {
  const hmac = nodeCrypto.createHmac("sha256", LICENSE_SALT);
  hmac.update(userName.toLowerCase().trim());
  return hmac.digest("hex").slice(0, 16).toUpperCase();
}

function isValidLicense(key, userName) {
  if (!key || !userName) return false;
  return key.toUpperCase() === expectedLicenseKey(userName);
}

module.exports = { expectedLicenseKey, isValidLicense };
