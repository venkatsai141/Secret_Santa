const crypto = require('crypto');

const AES_KEY = Buffer.from(process.env.AES_KEY_BASE64, 'base64');
const AES_IV = Buffer.from(process.env.AES_IV_BASE64, 'base64');

if (AES_KEY.length !== 32) throw new Error('AES key must be 32 bytes');
if (AES_IV.length !== 16) throw new Error('AES IV must be 16 bytes');

function encrypt(text) {
  const cipher = crypto.createCipheriv('aes-256-cbc', AES_KEY, AES_IV);
  const encrypted = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  return encrypted.toString('base64');
}

function decrypt(cipherText) {
  const decipher = crypto.createDecipheriv('aes-256-cbc', AES_KEY, AES_IV);
  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(cipherText, 'base64')),
    decipher.final()
  ]);
  return decrypted.toString('utf8');
}

module.exports = { encrypt, decrypt };
