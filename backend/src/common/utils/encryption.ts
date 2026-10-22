import crypto from "crypto";

// ============================================================
// Local application encryption
// Used for encrypting sensitive values stored in our database.
// ============================================================

const ENCRYPTION_KEY_HEX = process.env.ABDM_ENCRYPTION_KEY;

if (!ENCRYPTION_KEY_HEX) {
    throw new Error("ABDM_ENCRYPTION_KEY is not configured");
}

const ENCRYPTION_KEY = Buffer.from(ENCRYPTION_KEY_HEX, "hex");

if (ENCRYPTION_KEY.length !== 32) {
    throw new Error("ABDM_ENCRYPTION_KEY must be exactly 32 bytes (64 hex characters)");
}

const ALGORITHM = "aes-256-gcm";

export const encrypt = (text: string): string => {
    const iv = crypto.randomBytes(12);

    const cipher = crypto.createCipheriv(
        ALGORITHM,
        ENCRYPTION_KEY,
        iv
    );

    const encrypted = Buffer.concat([
        cipher.update(text, "utf8"),
        cipher.final(),
    ]);

    const authTag = cipher.getAuthTag();

    return [
        iv.toString("hex"),
        authTag.toString("hex"),
        encrypted.toString("hex"),
    ].join(":");
};

export const decrypt = (encryptedText: string): string => {
    const parts = encryptedText.split(":");

    if (parts.length !== 3) {
        throw new Error("Invalid encrypted data format");
    }

    const [ivHex, authTagHex, encryptedHex] = parts;

    if (!ivHex || !authTagHex || !encryptedHex) {
        throw new Error("Invalid encrypted data");
    }

    const decipher = crypto.createDecipheriv(
        ALGORITHM,
        ENCRYPTION_KEY,
        Buffer.from(ivHex, "hex")
    );

    decipher.setAuthTag(
        Buffer.from(authTagHex, "hex")
    );

    const decrypted = Buffer.concat([
        decipher.update(Buffer.from(encryptedHex, "hex")),
        decipher.final(),
    ]);

    return decrypted.toString("utf8");
};


// ============================================================
// ABDM public-key encryption
// Used for Aadhaar / OTP / mobile etc. before sending to ABDM.
// ============================================================

export const encryptWithAbdmPublicKey = (
    value: string,
    publicKey: string
): string => {

    // ABDM returns the public key as Base64-encoded DER.
    const publicKeyBuffer = Buffer.from(publicKey, "base64");

    const encrypted = crypto.publicEncrypt(
        {
            key: publicKeyBuffer,
            format: "der",
            type: "spki",
            padding: crypto.constants.RSA_PKCS1_OAEP_PADDING,
            oaepHash: "sha1",
        },
        Buffer.from(value, "utf8")
    );

    return encrypted.toString("base64");
};